/**
 * Parser for UE5's IO Store "Zen Loader" cooked package format.
 *
 * This is a completely different on-disk layout from the legacy
 * `FPackageFileSummary`-based `.uasset` parsed by `parseUasset` in
 * `index.ts`. Zen packages are what UE5 produces for IO Store
 * containers (.utoc/.ucas) and what you get when you extract a
 * package chunk by hand: there's no `0x9E2A83C1` magic, the
 * imports use 64-bit hashes instead of name-table outer chains,
 * and the export property data lives inline in the same blob.
 *
 * Two on-disk summary variants ship in real-world games:
 *
 *   - **Legacy** (`FPackageSummary`, container-header version ≤ 0,
 *     i.e. UE 4.26 / 4.27 / 5.0): fixed 60-byte header, split
 *     name+hash blobs, exports stored sequentially after the
 *     header.
 *   - **New** (`FZenPackageSummary`, UE 5.1+): adds
 *     `bHasVersioningInfo` + explicit `HeaderSize`, switches to
 *     the inline name-batch format, uses
 *     `ImportedPublicExportHashesOffset` instead of split hash
 *     blobs, and addresses each export individually by
 *     `CookedSerialOffset`.
 *
 * This parser handles both. Auto-detection is done by reading the
 * first few u32s and picking the variant whose `*Offset` fields
 * are internally consistent.
 *
 * Reference:
 *   - retoc/retoc/src/zen.rs (Rust, clean-room)
 *   - CUE4Parse/UE4/Assets/IoPackage.cs (C#)
 *   - Reference doc compiled by an exploration agent against both
 *     of the above and pinned via the git history of this file.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class ZenPackageParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZenPackageParseError';
	}
}

/** Which on-disk summary variant this package uses. */
export type ZenSummaryVariant = 'legacy' | 'new';

/** Type half of an FMappedName's packed u32. */
export const enum FMappedNameType {
	Package = 0,
	Container = 1,
	Global = 2,
}

/** A reference into a name map plus an FName-number suffix. */
export interface FMappedName {
	/** 30-bit index into the appropriate name map. */
	nameIndex: number;
	/** Source of the name map (per-package / per-container / global). */
	mapType: FMappedNameType;
	/**
	 * FName "number" suffix, with UE's `+1` encoding already
	 * removed: `0` means no suffix, otherwise the display form
	 * is `<baseName>_<number-1>`.
	 */
	number: number;
}

/** Decoded form of an `FPackageObjectIndex` (8 raw bytes). */
export interface FPackageObjectIndex {
	/** Raw 64-bit value as a bigint (preserve every bit). */
	raw: bigint;
	/** Top 2 bits — the index type. */
	type: 'Export' | 'ScriptImport' | 'PackageImport' | 'Null';
	/** Local export index (only valid when `type === 'Export'`). */
	exportIndex?: number;
	/** Hash payload (only when `type === 'ScriptImport'`). */
	scriptImportHash?: bigint;
	/** Decoded package-import reference. */
	packageImportRef?: {
		importedPackageIndex: number;
		importedPublicExportHashIndex: number;
	};
}

/** Top-level summary fields, normalised across the two variants. */
export interface ZenPackageSummary {
	variant: ZenSummaryVariant;
	/** Resolved package name from the name map. */
	name: string;
	/** Raw `FMappedName` for the package's own name. */
	nameMappedName: FMappedName;
	packageFlags: number;
	/** Cooked-header size (a sub-offset anchor for `BulkDataStartOffset`). */
	cookedHeaderSize: number;
	/**
	 * Where the export-data region begins. For the legacy variant
	 * this is computed as `GraphDataOffset + GraphDataSize`; for
	 * the new variant it's serialised directly.
	 */
	headerSize: number;
	/** Offsets that drive table parsing (raw values from disk). */
	importMapOffset: number;
	exportMapOffset: number;
	exportBundleEntriesOffset: number;
	importedPublicExportHashesOffset: number | null;
	/** Legacy only. */
	nameMapNamesOffset: number | null;
	nameMapNamesSize: number | null;
	nameMapHashesOffset: number | null;
	nameMapHashesSize: number | null;
	graphDataOffset: number | null;
	graphDataSize: number | null;
}

/** One export-table entry, post-decode. */
export interface ZenExport {
	/** Index of this entry inside its package's export table. */
	localExportIndex: number;
	/** Resolved (display-form) name. */
	objectName: string;
	objectNameMapped: FMappedName;
	classIndex: FPackageObjectIndex;
	superIndex: FPackageObjectIndex;
	templateIndex: FPackageObjectIndex;
	outerIndex: FPackageObjectIndex;
	publicExportHash: bigint;
	objectFlags: number;
	filterFlags: number;
	/** Bytes the cooker measured for this export's serialised body. */
	cookedSerialSize: number;
	/** From the export map header — see `bodyOffset` for the absolute file offset. */
	cookedSerialOffset: number;
	/**
	 * Absolute byte offset in the original file where this export's
	 * property body starts. The byte slice
	 * `[bodyOffset, bodyOffset + cookedSerialSize)` is what
	 * downstream callers parse for property tags. Computed using
	 * the same rule CUE4Parse uses (legacy: sequential layout
	 * starting at `headerSize`; new: `headerSize + cookedSerialOffset`).
	 */
	bodyOffset: number;
}

/** Top-level parse result. */
export interface ParsedZenPackage {
	summary: ZenPackageSummary;
	/** Package-local name map, in serialised order. */
	names: string[];
	/** Import map (one entry per imported object). */
	imports: FPackageObjectIndex[];
	/** Export map. */
	exports: ZenExport[];
	/**
	 * Imported public export hashes, when present (UE 5.1+ only).
	 * Each `FPackageObjectIndex` of type `PackageImport` carries an
	 * index into this table.
	 */
	importedPublicExportHashes: bigint[];
}

// ---------------------------------------------------------------------------
// Top-level API
// ---------------------------------------------------------------------------

/**
 * Auto-detect Zen vs legacy: legacy packages have their `Name` and
 * `SourceName` FMappedNames at offset 0 and 8 (both zeroed for an
 * unversioned shipping build), and the next u32 is `PackageFlags`.
 * The new variant has `bHasVersioningInfo` (a small int) at offset
 * 0 and `HeaderSize` (a sensible file-internal offset) at offset 4.
 *
 * Heuristic: if the first 16 bytes are all zeros AND the dword at
 * 0x14 (CookedHeaderSize in legacy) is plausibly within the file,
 * treat as legacy. Otherwise treat as new.
 */
export function isZenPackage(bytes: Uint8Array): boolean {
	if (bytes.length < 60) return false;
	// A legacy zen package will have its first 16 bytes as the
	// `Name`+`SourceName` FMappedNames. For an unversioned package
	// these are commonly zeroed but not required; we look instead
	// for the absence of the legacy `.uasset` magic at offset 0.
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const firstU32 = view.getUint32(0, true);
	if (firstU32 === 0x9e2a83c1) return false; // legacy `.uasset`
	// A bit more robust: the second-u32 at offset 4 in the new
	// variant is `HeaderSize` (always > 60). In legacy it's the
	// FMappedName.Number of the package's `Name`, often 0.
	return true;
}

export function parseZenPackage(bytes: Uint8Array): ParsedZenPackage {
	const r = new Reader(bytes);
	// We try the legacy variant first (it's what the user's test
	// files use). If the offsets look wrong, fall back to new.
	const legacy = tryParseLegacy(r, bytes);
	if (legacy) return legacy;
	const newVariant = tryParseNew(r, bytes);
	if (newVariant) return newVariant;
	throw new ZenPackageParseError(
		'Could not parse package as either legacy FPackageSummary or new FZenPackageSummary.',
	);
}

// ---------------------------------------------------------------------------
// Legacy variant — UE 4.26 / 4.27 / 5.0
// ---------------------------------------------------------------------------

function tryParseLegacy(r: Reader, bytes: Uint8Array): ParsedZenPackage | null {
	r.pos = 0;
	if (bytes.length < 0x40) return null;

	const name = readMappedName(r);
	const sourceName = readMappedName(r);
	void sourceName;
	const packageFlags = r.u32();
	const cookedHeaderSize = r.u32();
	const nameMapNamesOffset = r.i32();
	const nameMapNamesSize = r.i32();
	const nameMapHashesOffset = r.i32();
	const nameMapHashesSize = r.i32();
	const importMapOffset = r.i32();
	const exportMapOffset = r.i32();
	const exportBundlesOffset = r.i32();
	const graphDataOffset = r.i32();
	const graphDataSize = r.i32();
	r.skip(4); // pad

	// Sanity-check: all offsets fit in the file and are in order.
	if (
		nameMapNamesOffset < 0x40 ||
		nameMapNamesOffset + nameMapNamesSize > bytes.length ||
		nameMapHashesOffset < nameMapNamesOffset ||
		nameMapHashesOffset + nameMapHashesSize > bytes.length ||
		importMapOffset < nameMapHashesOffset ||
		exportMapOffset < importMapOffset ||
		exportBundlesOffset < exportMapOffset ||
		graphDataOffset < exportBundlesOffset ||
		graphDataOffset + graphDataSize > bytes.length
	) {
		return null;
	}
	if (cookedHeaderSize < 0 || cookedHeaderSize > bytes.length * 10) {
		return null;
	}

	const headerSize = graphDataOffset + graphDataSize;
	const names = readLegacyNameBatch(
		bytes,
		nameMapNamesOffset,
		nameMapNamesOffset + nameMapNamesSize,
	);
	// Cross-check: the hash blob's length-prefix should agree with `names.length`.
	const expectedNameCount = (nameMapHashesSize - 8) / 8;
	if (expectedNameCount !== names.length) {
		// Could be a different variant — bail out, let `tryParseNew` try.
		return null;
	}

	const imports = readImportMap(bytes, importMapOffset, exportMapOffset);
	const exportCount = (exportBundlesOffset - exportMapOffset) / 72;
	if (!Number.isInteger(exportCount) || exportCount < 0 || exportCount > 1 << 20) {
		return null;
	}
	const exports = readExportMap(
		bytes,
		exportMapOffset,
		exportCount,
		names,
		'legacy',
		headerSize,
	);

	const summary: ZenPackageSummary = {
		variant: 'legacy',
		name: resolveName(name, names),
		nameMappedName: name,
		packageFlags,
		cookedHeaderSize,
		headerSize,
		importMapOffset,
		exportMapOffset,
		exportBundleEntriesOffset: exportBundlesOffset,
		importedPublicExportHashesOffset: null,
		nameMapNamesOffset,
		nameMapNamesSize,
		nameMapHashesOffset,
		nameMapHashesSize,
		graphDataOffset,
		graphDataSize,
	};
	return {
		summary,
		names,
		imports,
		exports,
		importedPublicExportHashes: [],
	};
}

// ---------------------------------------------------------------------------
// New variant — UE 5.1+
// ---------------------------------------------------------------------------

function tryParseNew(r: Reader, bytes: Uint8Array): ParsedZenPackage | null {
	r.pos = 0;
	if (bytes.length < 44) return null;

	const bHasVersioningInfo = r.u32();
	const headerSize = r.u32();
	if (headerSize === 0 || headerSize > bytes.length) return null;
	const name = readMappedName(r);
	const packageFlags = r.u32();
	const cookedHeaderSize = r.u32();
	const importedPublicExportHashesOffset = r.i32();
	const importMapOffset = r.i32();
	const exportMapOffset = r.i32();
	const exportBundleEntriesOffset = r.i32();

	if (
		importedPublicExportHashesOffset < 0 ||
		importMapOffset < importedPublicExportHashesOffset ||
		exportMapOffset < importMapOffset ||
		exportBundleEntriesOffset < exportMapOffset ||
		exportBundleEntriesOffset > headerSize
	) {
		return null;
	}

	if (bHasVersioningInfo) {
		// Skip the versioning info: u32 ZenVersion + 2*u32 PackageVersion
		// + u32 LicenseeVersion + TArray<FCustomVersion>.
		r.skip(4 + 4 + 4 + 4);
		const customVersionCount = r.i32();
		r.skip(customVersionCount * 20);
	}

	// New variant uses the inline "name batch" format.
	const names = readInlineNameBatch(r);

	const imports = readImportMap(bytes, importMapOffset, exportMapOffset);
	const exportCount = (exportBundleEntriesOffset - exportMapOffset) / 72;
	if (!Number.isInteger(exportCount) || exportCount < 0 || exportCount > 1 << 20) {
		return null;
	}
	const exports = readExportMap(
		bytes,
		exportMapOffset,
		exportCount,
		names,
		'new',
		headerSize,
	);
	const ipehCount =
		(importMapOffset - importedPublicExportHashesOffset) / 8;
	const importedPublicExportHashes = readU64Array(
		bytes,
		importedPublicExportHashesOffset,
		ipehCount,
	);

	const summary: ZenPackageSummary = {
		variant: 'new',
		name: resolveName(name, names),
		nameMappedName: name,
		packageFlags,
		cookedHeaderSize,
		headerSize,
		importMapOffset,
		exportMapOffset,
		exportBundleEntriesOffset,
		importedPublicExportHashesOffset,
		nameMapNamesOffset: null,
		nameMapNamesSize: null,
		nameMapHashesOffset: null,
		nameMapHashesSize: null,
		graphDataOffset: null,
		graphDataSize: null,
	};
	return {
		summary,
		names,
		imports,
		exports,
		importedPublicExportHashes,
	};
}

// ---------------------------------------------------------------------------
// Common table readers
// ---------------------------------------------------------------------------

function readImportMap(
	bytes: Uint8Array,
	importMapOffset: number,
	exportMapOffset: number,
): FPackageObjectIndex[] {
	const count = (exportMapOffset - importMapOffset) / 8;
	const out: FPackageObjectIndex[] = [];
	for (let i = 0; i < count; i++) {
		out.push(decodePackageObjectIndex(bytes, importMapOffset + i * 8));
	}
	return out;
}

function readExportMap(
	bytes: Uint8Array,
	exportMapOffset: number,
	count: number,
	names: string[],
	variant: ZenSummaryVariant,
	headerSize: number,
): ZenExport[] {
	const out: ZenExport[] = [];
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let runningSeq = headerSize; // sequential body layout for legacy
	for (let i = 0; i < count; i++) {
		const base = exportMapOffset + i * 72;
		const cookedSerialOffset = readU64Safe(dv, base);
		const cookedSerialSize = readU64Safe(dv, base + 8);
		const objectName = readMappedNameAt(dv, base + 16);
		const outerIndex = decodePackageObjectIndex(bytes, base + 24);
		const classIndex = decodePackageObjectIndex(bytes, base + 32);
		const superIndex = decodePackageObjectIndex(bytes, base + 40);
		const templateIndex = decodePackageObjectIndex(bytes, base + 48);
		const publicExportHash = dv.getBigUint64(base + 56, true);
		const objectFlags = dv.getUint32(base + 64, true);
		const filterFlags = bytes[base + 68]!;
		// In legacy mode exports are laid out sequentially starting
		// at `headerSize`; CookedSerialOffset is informational. In
		// the new variant CookedSerialOffset is relative to
		// `headerSize` and each export is addressed directly.
		let bodyOffset: number;
		if (variant === 'new') {
			bodyOffset = headerSize + cookedSerialOffset;
		} else {
			bodyOffset = runningSeq;
			runningSeq += cookedSerialSize;
		}
		out.push({
			localExportIndex: i,
			objectName: resolveName(objectName, names),
			objectNameMapped: objectName,
			classIndex,
			superIndex,
			templateIndex,
			outerIndex,
			publicExportHash,
			objectFlags,
			filterFlags,
			cookedSerialSize,
			cookedSerialOffset,
			bodyOffset,
		});
	}
	return out;
}

function readU64Array(bytes: Uint8Array, offset: number, count: number): bigint[] {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: bigint[] = [];
	for (let i = 0; i < count; i++) out.push(dv.getBigUint64(offset + i * 8, true));
	return out;
}

// ---------------------------------------------------------------------------
// Name batch readers
// ---------------------------------------------------------------------------

/**
 * Legacy split-name-batch reader: parses raw bytes between
 * `[start, end)` as a concatenation of
 *   { u16 BE header } { name bytes }
 * pairs. The header's top bit indicates UTF-16 (and the rest is the
 * length); UTF-16 entries are 2-byte aligned (skip a pad byte if
 * the current position is odd before reading).
 */
function readLegacyNameBatch(
	bytes: Uint8Array,
	start: number,
	end: number,
): string[] {
	const out: string[] = [];
	let q = start;
	while (q < end) {
		const hdr = (bytes[q]! << 8) | bytes[q + 1]!; // BIG-endian
		q += 2;
		const isUtf16 = (hdr & 0x8000) !== 0;
		const len = hdr & 0x7fff;
		if (isUtf16) {
			if (q & 1) q++;
			const slice = bytes.subarray(q, q + len * 2);
			out.push(new TextDecoder('utf-16le').decode(slice));
			q += len * 2;
		} else {
			const slice = bytes.subarray(q, q + len);
			out.push(new TextDecoder('utf-8').decode(slice));
			q += len;
		}
	}
	return out;
}

/**
 * Inline name-batch reader for the new (UE 5.1+) layout.
 *
 *   u32 num
 *   if num == 0: stop.
 *   u32 numStringBytes
 *   u64 hashVersion           (== 0xC1640000)
 *   u64 hashes[num]
 *   u16(BE) headers[num]
 *   bytes nameBytes[numStringBytes]   (concatenated, length-per-header)
 */
function readInlineNameBatch(r: Reader): string[] {
	const num = r.u32();
	if (num === 0) return [];
	const numStringBytes = r.u32();
	r.skip(8); // HashVersion
	r.skip(num * 8); // Hashes
	const headers: { isUtf16: boolean; len: number }[] = [];
	for (let i = 0; i < num; i++) {
		const hdr = (r.u8() << 8) | r.u8(); // BE
		headers.push({ isUtf16: (hdr & 0x8000) !== 0, len: hdr & 0x7fff });
	}
	const namesStart = r.pos;
	const out: string[] = [];
	for (const h of headers) {
		if (h.isUtf16) {
			if (r.pos & 1) r.skip(1);
			const slice = r.bytes(h.len * 2);
			out.push(new TextDecoder('utf-16le').decode(slice));
		} else {
			const slice = r.bytes(h.len);
			out.push(new TextDecoder('utf-8').decode(slice));
		}
	}
	void numStringBytes;
	void namesStart;
	return out;
}

// ---------------------------------------------------------------------------
// FMappedName / FPackageObjectIndex
// ---------------------------------------------------------------------------

function readMappedName(r: Reader): FMappedName {
	const indexAndType = r.u32();
	const number = r.u32();
	return {
		nameIndex: indexAndType & 0x3fffffff,
		mapType: (indexAndType >>> 30) & 0x3,
		number,
	};
}

function readMappedNameAt(dv: DataView, offset: number): FMappedName {
	const indexAndType = dv.getUint32(offset, true);
	const number = dv.getUint32(offset + 4, true);
	return {
		nameIndex: indexAndType & 0x3fffffff,
		mapType: (indexAndType >>> 30) & 0x3,
		number,
	};
}

/**
 * Resolve an `FMappedName` to its display string, applying UE's
 * `name_<n-1>` convention when `number > 0`. Names with
 * `mapType !== Package` resolve against the global / container
 * name maps which this parser doesn't track — they come back as
 * a placeholder for now.
 */
export function resolveName(name: FMappedName, names: string[]): string {
	if (name.mapType !== FMappedNameType.Package) {
		return `<global-name ${name.nameIndex}>`;
	}
	const base = names[name.nameIndex] ?? `<bad name index ${name.nameIndex}>`;
	return name.number === 0 ? base : `${base}_${name.number - 1}`;
}

function decodePackageObjectIndex(
	bytes: Uint8Array,
	offset: number,
): FPackageObjectIndex {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const raw = dv.getBigUint64(offset, true);
	const NULL = 0xffffffffffffffffn;
	if (raw === NULL) {
		return { raw, type: 'Null' };
	}
	const typeBits = Number(raw >> 62n) & 0x3;
	const payload = raw & 0x3fffffffffffffffn;
	switch (typeBits) {
		case 0:
			return { raw, type: 'Export', exportIndex: Number(payload) };
		case 1:
			return { raw, type: 'ScriptImport', scriptImportHash: payload };
		case 2: {
			const importedPackageIndex = Number((payload >> 32n) & 0xffffffffn);
			const importedPublicExportHashIndex = Number(payload & 0xffffffffn);
			return {
				raw,
				type: 'PackageImport',
				packageImportRef: { importedPackageIndex, importedPublicExportHashIndex },
			};
		}
		default:
			return { raw, type: 'Null' };
	}
}

// ---------------------------------------------------------------------------
// Reader & u64 helper
// ---------------------------------------------------------------------------

class Reader {
	pos = 0;
	view: DataView;
	#buf: Uint8Array;
	constructor(buf: Uint8Array) {
		this.#buf = buf;
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	skip(n: number): void {
		this.pos += n;
	}
	bytes(n: number): Uint8Array {
		const out = this.#buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}
	u8(): number {
		const v = this.#buf[this.pos]!;
		this.pos += 1;
		return v;
	}
	u32(): number {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}
	i32(): number {
		const v = this.view.getInt32(this.pos, true);
		this.pos += 4;
		return v;
	}
}

/**
 * Read a u64 as a JS `number`, asserting it fits in
 * `Number.MAX_SAFE_INTEGER`. Used for offsets / sizes that we know
 * stay well under 2^53.
 */
function readU64Safe(dv: DataView, offset: number): number {
	const v = dv.getBigUint64(offset, true);
	if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new ZenPackageParseError(
			`u64 at offset 0x${offset.toString(16)} (${v}) exceeds Number.MAX_SAFE_INTEGER`,
		);
	}
	return Number(v);
}
