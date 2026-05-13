/**
 * UDataTable / UCurveTable readers.
 *
 * Both classes serialise their per-row payloads the same way: the
 * top of the export is a normal tagged-property stream (for
 * UDataTable this carries the `RowStruct` ObjectProperty; UCurveTable
 * is empty), terminated by `None`. After that comes the row table:
 *
 *   u32      bSerializeGuid           (UObject::Serialize tail prefix)
 *   u8[16]   FGuid                    (only when bSerializeGuid != 0)
 *   i32      NumRows
 *   repeat NumRows times:
 *     FName  RowName                  (u32 nameIdx + u32 number)
 *     ...    tagged property stream   (terminated by `None`)
 *
 * The row payload is the row struct's serialised tags:
 *   - UDataTable rows: `RowStruct`'s tagged properties.
 *     `RowStruct` is whatever UScriptStruct the asset references via
 *     the top-of-export `RowStruct` ObjectProperty.
 *   - UCurveTable rows: always an FRichCurve, which serialises as a
 *     tagged stream itself (its `Keys : TArray<FRichCurveKey>` is
 *     what the user cares about).
 *
 * Both forms have been stable since UE 4.x; modern UE5 still writes
 * them this way for legacy cooked packages.
 *
 * References:
 *   - `Engine/Source/Runtime/Engine/Private/DataTable.cpp`
 *     (`UDataTable::Serialize`, `LoadStructData`)
 *   - `Engine/Source/Runtime/Engine/Private/CurveTable.cpp`
 *     (`UCurveTable::Serialize`)
 */

import type { ParsedUasset } from './index.js';
import { resolveFName, resolvePackageIndex } from './index.js';
import {
	readExportProperties,
	readTaggedPropertyStream,
	type UProperty,
} from './properties.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One DataTable row: a name + its decoded tagged-property stream. */
export interface DataTableRow {
	name: string;
	properties: UProperty[];
}

/** Decoded UDataTable contents. */
export interface ParsedDataTable {
	/**
	 * Header properties from the export's main tag stream. Carries
	 * `RowStruct` and any other table-level metadata.
	 */
	headerProperties: UProperty[];
	/**
	 * Resolved row-struct identifier as a string (e.g.
	 * `BMTapItemData`). `null` when the RowStruct couldn't be
	 * resolved — the row tags are still decoded but their structure
	 * is unverified.
	 */
	rowStructName: string | null;
	rowStructPackage: string | null;
	/** All rows, in serialised order. */
	rows: DataTableRow[];
}

/** Decoded UCurveTable contents. Same shape as DataTable for UI parity. */
export interface ParsedCurveTable {
	headerProperties: UProperty[];
	/** Each row is an FRichCurve, decoded as tagged properties. */
	rows: DataTableRow[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class DataTableParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DataTableParseError';
	}
}
export { DataTableParseError };

/** Find the `RowStruct` property's resolved name + package path. */
function extractRowStructInfo(
	headerProperties: UProperty[],
	parsed: ParsedUasset,
): { name: string | null; packagePath: string | null } {
	for (const p of headerProperties) {
		if (p.name !== 'RowStruct') continue;
		if (p.value.kind !== 'object') continue;
		const idx = p.value.index;
		if (idx >= 0) return { name: null, packagePath: null };
		const imp = parsed.imports[-idx - 1];
		if (!imp) return { name: null, packagePath: null };
		const name = parsed.names[imp.objectName.nameIndex]?.value ?? null;
		const packagePath = resolvePackageIndex(
			imp.outerIndex,
			parsed.imports,
			parsed.exports,
			parsed.names,
		);
		return { name, packagePath };
	}
	return { name: null, packagePath: null };
}

/**
 * Locate the first export of a given class in `parsed.exports`.
 * Returns the export index, or -1 when not found.
 */
function findExportByClass(parsed: ParsedUasset, className: string): number {
	for (let i = 0; i < parsed.exports.length; i++) {
		const exp = parsed.exports[i]!;
		if (exp.classIndex >= 0) continue;
		const imp = parsed.imports[-exp.classIndex - 1];
		if (!imp) continue;
		const cn = parsed.names[imp.objectName.nameIndex]?.value;
		if (cn === className) return i;
	}
	return -1;
}

/** Shared row-walking core for both DataTable and CurveTable. */
function readRowTable(
	parsed: ParsedUasset,
	uexpBytes: Uint8Array,
	startOffset: number,
	endOffset: number,
): DataTableRow[] {
	if (startOffset + 4 > endOffset) {
		throw new DataTableParseError(
			'DataTable: tail truncated before bSerializeGuid / NumRows.',
		);
	}
	const dv = new DataView(
		uexpBytes.buffer,
		uexpBytes.byteOffset,
		uexpBytes.byteLength,
	);
	let p = startOffset;
	const bSerializeGuid = dv.getUint32(p, true);
	p += 4;
	if (bSerializeGuid) {
		if (p + 16 > endOffset) {
			throw new DataTableParseError('DataTable: tail truncated mid-FGuid.');
		}
		p += 16;
	}
	if (p + 4 > endOffset) {
		throw new DataTableParseError(
			'DataTable: tail truncated before NumRows.',
		);
	}
	const numRows = dv.getInt32(p, true);
	p += 4;
	if (numRows < 0 || numRows > 1_000_000) {
		throw new DataTableParseError(
			`DataTable: implausible NumRows=${numRows}; refusing to allocate.`,
		);
	}
	const rows: DataTableRow[] = [];
	for (let i = 0; i < numRows; i++) {
		if (p + 8 > endOffset) {
			throw new DataTableParseError(
				`DataTable: row ${i} truncated before FName.`,
			);
		}
		const nameIdx = dv.getUint32(p, true);
		const nameNum = dv.getUint32(p + 4, true);
		p += 8;
		const name = resolveFName(
			{ nameIndex: nameIdx, number: nameNum },
			parsed.names,
		);
		const stream = readTaggedPropertyStream(parsed, uexpBytes, p, endOffset);
		p += stream.consumed;
		rows.push({ name, properties: stream.properties });
	}
	return rows;
}

/**
 * Decode the rows of a `UDataTable` asset.
 *
 * `parsed` must come from {@link parseUasset} (legacy cooked
 * packages) — Zen packages have a different export layout and
 * aren't supported by this reader yet.
 *
 * `uexpBytes` is the matching `.uexp` payload. We locate the first
 * `class === "DataTable"` export, read its top-level tagged
 * properties (which carry `RowStruct`), then walk the row table
 * that follows in the export body.
 */
export function parseDataTable(
	parsed: ParsedUasset,
	uexpBytes: Uint8Array,
): ParsedDataTable {
	const expIdx = findExportByClass(parsed, 'DataTable');
	if (expIdx < 0) {
		throw new DataTableParseError(
			'parseDataTable: no DataTable export found in package.',
		);
	}
	return parseDataTableAtExport(parsed, uexpBytes, expIdx);
}

/**
 * Same as {@link parseDataTable} but with an explicit export index.
 * Handy when the caller has already located the right export.
 */
export function parseDataTableAtExport(
	parsed: ParsedUasset,
	uexpBytes: Uint8Array,
	exportIndex: number,
): ParsedDataTable {
	const props = readExportProperties(parsed, uexpBytes, exportIndex);
	const rowStruct = extractRowStructInfo(props.properties, parsed);
	const exp = parsed.exports[exportIndex]!;
	// `props.tail` is relative to the .uexp buffer. We need its
	// absolute offsets back so the shared row-table reader can walk
	// inside the same buffer.
	const expOffset = exp.serialOffset - parsed.summary.totalHeaderSize;
	const expEnd = Math.min(uexpBytes.length, expOffset + exp.serialSize);
	const tailStart = expOffset + props.consumed;
	const rows = readRowTable(parsed, uexpBytes, tailStart, expEnd);
	return {
		headerProperties: props.properties,
		rowStructName: rowStruct.name,
		rowStructPackage: rowStruct.packagePath,
		rows,
	};
}

/**
 * Decode the rows of a `UCurveTable` asset. Each row is an
 * FRichCurve whose `Keys : TArray<FRichCurveKey>` carries the
 * actual (Time, Value, interp-mode) tuples.
 */
export function parseCurveTable(
	parsed: ParsedUasset,
	uexpBytes: Uint8Array,
): ParsedCurveTable {
	const expIdx = findExportByClass(parsed, 'CurveTable');
	if (expIdx < 0) {
		throw new DataTableParseError(
			'parseCurveTable: no CurveTable export found in package.',
		);
	}
	const props = readExportProperties(parsed, uexpBytes, expIdx);
	const exp = parsed.exports[expIdx]!;
	const expOffset = exp.serialOffset - parsed.summary.totalHeaderSize;
	const expEnd = Math.min(uexpBytes.length, expOffset + exp.serialSize);
	const tailStart = expOffset + props.consumed;
	const rows = readRowTable(parsed, uexpBytes, tailStart, expEnd);
	return { headerProperties: props.properties, rows };
}
