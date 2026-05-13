/**
 * CRI Middleware's `@UTF` table parser.
 *
 * UTF is CRI's row-store binary format used inside .acb, .acf, .cpk
 * headers, etc. Conceptually it's a small relational table:
 *
 *   - A list of **columns** (each typed, named, and optionally
 *     storing its value once at the column level instead of per-row).
 *   - One or more **rows**, each a tuple of typed values.
 *
 * On disk:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 0x00  u32 "@UTF" magic                                       │
 *   │ 0x04  u32be dataSize    (table size, excluding the 8-byte    │
 *   │                          prelude header)                     │
 *   │ 0x08  --- body starts here ---                               │
 *   │ +0x00 u16be unknown     (usually 0)                          │
 *   │ +0x02 u16be valueOffset (offset to per-column values, from   │
 *   │                          body start)                         │
 *   │ +0x04 u32be stringOffset                                     │
 *   │ +0x08 u32be dataOffset                                       │
 *   │ +0x0C u32be nameOffset  (offset into the string section)     │
 *   │ +0x10 u16be elementCount (= number of columns)               │
 *   │ +0x14 u16be valueSize    (per-row value section size)        │
 *   │ +0x16 u16be pageCount    (= number of rows)                  │
 *   │ +0x18 column descriptors × elementCount                       │
 *   │ +...  per-row values (each row is `valueSize` bytes)         │
 *   │ +stringOffset  null-terminated strings (UTF-8)               │
 *   │ +dataOffset    blobs / nested @UTF tables                     │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Each column descriptor is `1 + 4 = 5` bytes:
 *
 *   u8     type-and-method byte:
 *            bits 5..7 → storage method (1 = inlined in the type byte
 *              following the column descriptor, 2 = per-row in the
 *              value section, 3 = column-level constant in the value
 *              section. 0 means the column has no value).
 *            bits 0..4 → value type (see {@link UtfType}).
 *   u32be  offset into the string section, pointing at the column name.
 *
 * Storage method 1 inlines the value immediately after the descriptor
 * — once for the whole column. Method 2 stores `pageCount` values
 * back-to-back in the per-row value section. Method 3 stores a single
 * value at the start of the value section, reused for every row.
 *
 * Refs:
 *   - kohos/CriTools (MIT), src/utf.js
 *   - vgmstream (ISC), src/util/cri_utf.c
 */

export const UTF_MAGIC = 0x40555446; // "@UTF" in big-endian u32

/** Built-in @UTF cell types. */
export enum UtfType {
	S8 = 0x10,
	U8 = 0x11,
	S16 = 0x12,
	U16 = 0x13,
	S32 = 0x14,
	U32 = 0x15,
	S64 = 0x16,
	U64 = 0x17,
	F32 = 0x18,
	F64 = 0x19,
	String = 0x1a,
	/** Variable-size payload. Often a nested @UTF table. */
	Bytes = 0x1b,
}

/**
 * Storage method for a column. Bits 5..7 of the column descriptor's
 * type byte.
 */
export enum UtfStorage {
	/** Column has no value at all — every row's value is the type's zero. */
	None = 0,
	/** Single value inlined immediately after the column descriptor. */
	InlinedConstant = 1,
	/** Each row stores its own value in the per-row section. */
	PerRow = 2,
	/** Single value stored at the start of the per-row section, reused for every row. */
	SharedConstant = 3,
}

/** A decoded UTF table value. */
export type UtfValue =
	| number
	| bigint
	| string
	| Uint8Array
	| ParsedUtf
	| null;

/** A column description as written on disk. */
export interface UtfColumn {
	name: string;
	type: UtfType;
	storage: UtfStorage;
}

/** A parsed UTF table. Behaves like an array of row records. */
export interface ParsedUtf {
	/** The table name (from `nameOffset`). */
	name: string;
	/** Column descriptors in the order they appear on disk. */
	columns: UtfColumn[];
	/** Per-row records, keyed by column name. */
	rows: Array<Record<string, UtfValue>>;
}

class UtfParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UtfParseError';
	}
}
export { UtfParseError };

/** Sniff the `@UTF` magic at the start of `bytes`. */
export function isUtfMagic(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	return (
		bytes[0] === 0x40 &&
		bytes[1] === 0x55 &&
		bytes[2] === 0x54 &&
		bytes[3] === 0x46
	);
}

/**
 * Parse a `@UTF` table from a byte buffer. Cells of type
 * {@link UtfType.Bytes} that happen to themselves be `@UTF` tables
 * are decoded recursively; if the bytes don't parse as a nested
 * table they're surfaced as a `Uint8Array` so the caller can
 * inspect / re-export them.
 */
export function parseUtf(bytes: Uint8Array): ParsedUtf {
	if (!isUtfMagic(bytes)) {
		throw new UtfParseError(
			`Bad @UTF magic: got 0x${Array.from(bytes.subarray(0, Math.min(4, bytes.length)))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')}`,
		);
	}
	if (bytes.length < 8) {
		throw new UtfParseError(
			`@UTF header truncated: only ${bytes.length} bytes.`,
		);
	}
	const outerDv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dataSize = outerDv.getUint32(4, false);
	if (8 + dataSize > bytes.length) {
		throw new UtfParseError(
			`@UTF dataSize=${dataSize} exceeds buffer length ${bytes.length}.`,
		);
	}
	// All offsets in the inner header are relative to the start of
	// the body (offset 8 in the original buffer).
	const body = bytes.subarray(8, 8 + dataSize);
	const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

	// We don't use `unknown16` but read it to keep the cursor honest.
	const _unknown = dv.getUint16(0, false);
	const valueOffset = dv.getUint16(2, false);
	const stringOffset = dv.getUint32(4, false);
	const dataOffset = dv.getUint32(8, false);
	const nameOffset = dv.getUint32(12, false);
	const elementCount = dv.getUint16(16, false);
	const valueSize = dv.getUint16(18, false);
	const pageCount = dv.getUint32(20, false);

	if (stringOffset > body.byteLength || dataOffset > body.byteLength) {
		throw new UtfParseError(
			`@UTF offsets out of range: stringOffset=${stringOffset} dataOffset=${dataOffset} bodyLen=${body.byteLength}`,
		);
	}

	const readCString = (absOffset: number): string => {
		let end = absOffset;
		while (end < body.byteLength && body[end] !== 0) end++;
		return new TextDecoder('utf-8', { fatal: false }).decode(
			body.subarray(absOffset, end),
		);
	};

	const name = readCString(stringOffset + nameOffset);

	// Walk the column descriptors once to know their on-disk layout.
	// We re-walk per row to read per-row values, since the row cursor
	// advances through the value section as a function of method.
	let descriptorPos = 24; // body offset to first column descriptor
	const columns: UtfColumn[] = new Array(elementCount);
	const descriptorEntries: Array<{
		col: UtfColumn;
		// For storage=1 (inlined constant) the value sits right here
		// in the column descriptor stream; we capture its body offset
		// once. For storage=2 it advances per row in the value section.
		// For storage=3 it lives at the start of the value section.
		inlinedValueOffset: number | null;
	}> = new Array(elementCount);
	for (let i = 0; i < elementCount; i++) {
		if (descriptorPos + 5 > body.byteLength) {
			throw new UtfParseError(`@UTF column ${i} descriptor out of range`);
		}
		const typeByte = body[descriptorPos]!;
		const colNameOffset = dv.getUint32(descriptorPos + 1, false);
		descriptorPos += 5;
		const storage = (typeByte >>> 5) as UtfStorage;
		const type = (typeByte & 0x1f) as UtfType;
		const colName = readCString(stringOffset + colNameOffset);
		const col: UtfColumn = { name: colName, type, storage };
		let inlinedValueOffset: number | null = null;
		if (storage === UtfStorage.InlinedConstant) {
			inlinedValueOffset = descriptorPos;
			descriptorPos += typeSize(type, body, dataOffset, descriptorPos);
		}
		columns[i] = col;
		descriptorEntries[i] = { col, inlinedValueOffset };
	}

	// Per-row decode. For each storage method, the value cursor
	// advances differently. We re-derive the "shared constant"
	// offset once (it lives at the start of the per-row value section
	// and is the same for every row), and a per-column "per-row"
	// cursor that walks `pageCount` values back-to-back.
	const sharedConstantOffsets: Map<number, number> = new Map();
	let sharedCursor = valueOffset;
	for (let i = 0; i < elementCount; i++) {
		const { col } = descriptorEntries[i]!;
		if (col.storage === UtfStorage.SharedConstant) {
			sharedConstantOffsets.set(i, sharedCursor);
			sharedCursor += typeSize(col.type, body, dataOffset, sharedCursor);
		}
	}

	// Per-row cursor: start at end-of-shared-constants and advance
	// by `valueSize` per row… EXCEPT that's only correct if no
	// shared constants live in the value section. In practice CRI
	// writes shared constants at the front of the value section,
	// then `pageCount` rows of `valueSize` bytes follow.
	const perRowBaseOffset = sharedCursor;

	const rows: Array<Record<string, UtfValue>> = new Array(pageCount);
	for (let r = 0; r < pageCount; r++) {
		const row: Record<string, UtfValue> = {};
		let perRowCursor = perRowBaseOffset + r * valueSize;
		for (let i = 0; i < elementCount; i++) {
			const { col, inlinedValueOffset } = descriptorEntries[i]!;
			let value: UtfValue = null;
			switch (col.storage) {
				case UtfStorage.None:
					value = null;
					break;
				case UtfStorage.InlinedConstant:
					value = readValue(col.type, body, inlinedValueOffset!, stringOffset, dataOffset);
					break;
				case UtfStorage.PerRow: {
					value = readValue(col.type, body, perRowCursor, stringOffset, dataOffset);
					perRowCursor += typeSize(col.type, body, dataOffset, perRowCursor);
					break;
				}
				case UtfStorage.SharedConstant: {
					const off = sharedConstantOffsets.get(i)!;
					value = readValue(col.type, body, off, stringOffset, dataOffset);
					break;
				}
			}
			row[col.name] = value;
		}
		rows[r] = row;
	}

	return { name, columns, rows };
}

/**
 * Size of one value of the given type starting at `offset` in
 * `body`. For variable-size types (`Bytes`) we read the length
 * field to compute the on-disk size; that's `4 + 4` (offset +
 * size) since the body inlines the descriptor for a blob rather
 * than its bytes.
 */
function typeSize(
	type: UtfType,
	body: Uint8Array,
	_dataOffset: number,
	_offset: number,
): number {
	switch (type) {
		case UtfType.S8:
		case UtfType.U8:
			return 1;
		case UtfType.S16:
		case UtfType.U16:
			return 2;
		case UtfType.S32:
		case UtfType.U32:
		case UtfType.F32:
			return 4;
		case UtfType.S64:
		case UtfType.U64:
		case UtfType.F64:
			return 8;
		case UtfType.String:
			return 4;
		case UtfType.Bytes:
			// 4-byte offset + 4-byte size — the actual blob lives at
			// `dataOffset + offset` in the body section.
			return 8;
		default:
			void body; // satisfy the linter when neither branch needs it
			throw new UtfParseError(
				`unknown @UTF type: 0x${(type as number).toString(16)}`,
			);
	}
}

function readValue(
	type: UtfType,
	body: Uint8Array,
	offset: number,
	stringOffset: number,
	dataOffset: number,
): UtfValue {
	const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
	switch (type) {
		case UtfType.S8:
			return dv.getInt8(offset);
		case UtfType.U8:
			return dv.getUint8(offset);
		case UtfType.S16:
			return dv.getInt16(offset, false);
		case UtfType.U16:
			return dv.getUint16(offset, false);
		case UtfType.S32:
			return dv.getInt32(offset, false);
		case UtfType.U32:
			return dv.getUint32(offset, false);
		case UtfType.S64:
			return dv.getBigInt64(offset, false);
		case UtfType.U64:
			return dv.getBigUint64(offset, false);
		case UtfType.F32:
			return dv.getFloat32(offset, false);
		case UtfType.F64:
			return dv.getFloat64(offset, false);
		case UtfType.String: {
			const strOff = stringOffset + dv.getUint32(offset, false);
			let end = strOff;
			while (end < body.byteLength && body[end] !== 0) end++;
			return new TextDecoder('utf-8', { fatal: false }).decode(
				body.subarray(strOff, end),
			);
		}
		case UtfType.Bytes: {
			const blobStart = dataOffset + dv.getUint32(offset, false);
			const blobLen = dv.getUint32(offset + 4, false);
			if (blobStart + blobLen > body.byteLength) {
				throw new UtfParseError(
					`@UTF blob out of range: start=${blobStart} len=${blobLen} bodyLen=${body.byteLength}`,
				);
			}
			const slice = body.subarray(blobStart, blobStart + blobLen);
			// Heuristic: if the blob is itself a @UTF table, decode
			// it recursively. Otherwise pass the raw bytes through.
			if (isUtfMagic(slice)) {
				try {
					return parseUtf(slice);
				} catch {
					// fall through to raw bytes
				}
			}
			return slice.slice(); // copy so the caller can keep it after the parent buffer is GC'd
		}
		default:
			throw new UtfParseError(
				`unknown @UTF type: 0x${(type as number).toString(16)}`,
			);
	}
}
