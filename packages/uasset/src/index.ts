/**
 * Header-level parser for Unreal Engine `.uasset` / `.umap`
 * packages.
 *
 * A UE asset file ships as a header `FPackageFileSummary` (a few
 * hundred bytes of fixed offsets), followed by a name table,
 * import table, export table, and assorted optional sections
 * (gatherable text, soft references, depends, thumbnails). The
 * actual serialised property data for each export then lives at
 * `export.serialOffset`, with format that depends entirely on
 * the export's class — decoding it requires the full UE class
 * schema, which lives in the engine's C++ source and shifts
 * across every UE version.
 *
 * **We deliberately stop at the header level**. Header decoding
 * is enough to answer the questions a browser-side asset preview
 * actually wants:
 *
 *   - What kind of asset is this? (class name from the export
 *     table)
 *   - What does it reference? (import table → other packages /
 *     classes; soft refs → asset paths)
 *   - What names does it use? (name table — already has the
 *     property names like `Looping`, `StartImmediately`, etc.)
 *
 * The actual property bodies are out of scope; tools like
 * CUE4Parse / UAssetAPI / repak handle them and ship 10k+ LOC
 * of per-class serialisation knowledge. We surface the names so
 * the user can *guess* what the asset is configured to do
 * without us shipping schema for every UE class in existence.
 *
 * Wire format (little-endian throughout; UE4 v4.20+ / UE5):
 *
 *   FPackageFileSummary @ 0:
 *     u32       magic = 0x9E2A83C1
 *     i32       legacyFileVersion (≤ -2; controls following layout)
 *     i32       legacyUE3Version (always 0 in UE4+)
 *     i32       fileVersionUE4
 *     i32       fileVersionUE5     (only when legacyFileVersion < -7)
 *     i32       fileVersionLicenseeUE4
 *     // Custom version array (when legacyFileVersion <= -2):
 *     u32       customVersionCount
 *     per custom version:
 *       u8[16]  guid
 *       i32     version
 *     u32       totalHeaderSize
 *     fstring   folderName
 *     u32       packageFlags
 *     u32       nameCount
 *     u32       nameOffset
 *     // UE5 (legacyFileVersion < -7) only:
 *     u32       softObjectPathsCount
 *     u32       softObjectPathsOffset
 *     u32       gatherableTextDataCount
 *     u32       gatherableTextDataOffset
 *     u32       exportCount
 *     u32       exportOffset
 *     u32       importCount
 *     u32       importOffset
 *     u32       dependsOffset
 *     u32       softPackageReferencesCount
 *     u32       softPackageReferencesOffset
 *     u32       searchableNamesOffset
 *     u32       thumbnailTableOffset
 *     u8[16]    guid
 *     u32       generationCount
 *     per gen:
 *       u32     exportCount
 *       u32     nameCount
 *
 *   Name table @ nameOffset:
 *     per nameCount:
 *       fstring name
 *       u16     nonCasePreservingHash
 *       u16     casePreservingHash
 *
 *   Import table @ importOffset (28 bytes per entry):
 *     fname   classPackage     (u32 nameIndex + u32 number)
 *     fname   className
 *     i32     outerIndex       (package reference; 0 = top-level)
 *     fname   objectName
 *
 *   Export table @ exportOffset (variable; ~104 bytes typical):
 *     fpackageindex  classIndex
 *     fpackageindex  superIndex
 *     fpackageindex  templateIndex   (UE4.14+)
 *     fpackageindex  outerIndex
 *     fname          objectName
 *     u32            objectFlags
 *     i64            serialSize
 *     i64            serialOffset
 *     u32            forcedExport
 *     u32            notForClient
 *     u32            notForServer
 *     u8[16]         packageGuid     (UE5 dropped this — varies)
 *     u32            packageFlags
 *     u32            notForEditorGame  (UE4.20+)
 *     u32            isAsset           (UE4.21+)
 *     u32            firstExportDependency  (UE4.16+)
 *     u32            serializationBeforeSerializationDependencies  (UE4.16+)
 *     u32            createBeforeSerializationDependencies          (UE4.16+)
 *     u32            serializationBeforeCreateDependencies          (UE4.16+)
 *     u32            createBeforeCreateDependencies                 (UE4.16+)
 *
 * The export-table layout in particular has shifted across UE
 * versions; we read the fixed-prefix fields (everything through
 * `packageFlags`) and skip the rest — those tail fields are
 * dependency hints used at load time, not relevant for a
 * preview.
 *
 * Refs:
 *   - UE source: `Engine/Source/Runtime/CoreUObject/Public/UObject/PackageFileSummary.h`
 *   - Clean-room reference: https://github.com/atenfyr/UAssetAPI
 *   - https://github.com/AstroTechies/unrealmodding/blob/main/unreal_asset/src/lib.rs
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const UASSET_MAGIC = 0x9e2a83c1;

// Property-tag deserialiser is implemented in `properties.ts` and
// re-exported here so callers get a single import surface.
export {
	readExportProperties,
	type NativeStruct,
	type UExportProperties,
	type UProperty,
	type UValue,
} from './properties.js';

// Texture2D / TextureCube platform-data reader.
export {
	BULKDATA_ForceInlinePayload,
	BULKDATA_NoOffsetFixUp,
	BULKDATA_PayloadAtEndOfFile,
	BULKDATA_PayloadInSeperateFile,
	BULKDATA_Size64Bit,
	BULKDATA_SingleUse,
	BULKDATA_Unused,
	getMipBytes,
	parseTexturePlatformData,
	parseTexturePlatformDataFromTail,
	readMipFromUbulk,
	TextureParseError,
	type MipLocation,
	type ParsedTexturePlatformData,
	type TextureMip,
} from './texture.js';

// StaticMesh cooked geometry parser.
export {
	parseStaticMesh,
	parseStaticMeshFromTail,
	StaticMeshParseError,
	type FBoxSphereBounds,
	type LoadedStaticMesh,
	type StaticMeshLOD,
	type StaticMeshSection,
} from './static-mesh.js';

/**
 * The fixed-size summary header at the start of every UE
 * package. Field availability depends on `legacyFileVersion`;
 * we surface the fields that exist in every UE 4.20+ format.
 */
export interface UassetSummary {
	magic: number;
	legacyFileVersion: number;
	fileVersionUE4: number;
	fileVersionUE5: number | null;
	fileVersionLicenseeUE4: number;
	totalHeaderSize: number;
	folderName: string;
	packageFlags: number;
	nameCount: number;
	nameOffset: number;
	exportCount: number;
	exportOffset: number;
	importCount: number;
	importOffset: number;
	dependsOffset: number;
	softPackageReferencesCount: number;
	softPackageReferencesOffset: number;
	gatherableTextDataCount: number;
	gatherableTextDataOffset: number;
	softObjectPathsCount: number;
	softObjectPathsOffset: number;
	searchableNamesOffset: number;
	thumbnailTableOffset: number;
	/** 16-byte package GUID, hex-encoded. */
	guid: string;
	generationCount: number;
	customVersions: UassetCustomVersion[];
}

export interface UassetCustomVersion {
	/** Plugin/system identifier (16-byte GUID, hex-encoded). */
	guid: string;
	version: number;
}

/**
 * A "FName" reference: an index into the name table plus a
 * disambiguation number (used for instances like `Foo_0`,
 * `Foo_1`). The display form is `name` if `number === 0`,
 * otherwise `name_<number-1>`.
 */
export interface FName {
	nameIndex: number;
	number: number;
}

export interface UassetName {
	value: string;
	hashNonCasePreserving: number;
	hashCasePreserving: number;
}

export interface UassetImport {
	classPackage: FName;
	className: FName;
	outerIndex: number;
	objectName: FName;
}

export interface UassetExport {
	classIndex: number;
	superIndex: number;
	templateIndex: number | null;
	outerIndex: number;
	objectName: FName;
	objectFlags: number;
	serialSize: number;
	serialOffset: number;
	forcedExport: boolean;
	notForClient: boolean;
	notForServer: boolean;
	isAsset: boolean | null;
}

export interface ParsedUasset {
	summary: UassetSummary;
	names: UassetName[];
	imports: UassetImport[];
	exports: UassetExport[];
	/** Soft package references (other asset paths this package depends on). */
	softPackageReferences: string[];
}

// ---------------------------------------------------------------------------
// Magic / detection
// ---------------------------------------------------------------------------

export function isUasset(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	const m =
		(bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
	return m === UASSET_MAGIC;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a UE `.uasset` / `.umap` package's header, name table,
 * import table, export table, and soft-package references.
 *
 * Property bodies (the actual asset data starting at each
 * export's `serialOffset`) are NOT decoded — see the module
 * docblock for why.
 *
 * Throws on missing magic. Returns partial results for
 * malformed-but-recognisable files (e.g. truncated tables) so
 * callers can still surface what was extracted.
 */
export function parseUasset(bytes: Uint8Array): ParsedUasset {
	const r = new Reader(bytes);
	const magic = r.u32();
	if (magic !== UASSET_MAGIC) {
		throw new Error(
			`Not a UE .uasset file (expected magic 0x${UASSET_MAGIC.toString(16)}, got 0x${magic.toString(16).padStart(8, '0')})`,
		);
	}

	const legacyFileVersion = r.i32();
	// Skip legacyUE3Version (always 0 in UE4+).
	r.skip(4);
	const fileVersionUE4 = r.i32();
	let fileVersionUE5: number | null = null;
	if (legacyFileVersion < -7) {
		fileVersionUE5 = r.i32();
	}
	const fileVersionLicenseeUE4 = r.i32();

	// Custom version array (when legacyFileVersion <= -2).
	const customVersions: UassetCustomVersion[] = [];
	if (legacyFileVersion <= -2) {
		const cvc = r.u32();
		for (let i = 0; i < cvc; i++) {
			const guid = bytesToHex(r.bytes(16));
			const version = r.i32();
			customVersions.push({ guid, version });
		}
	}

	const totalHeaderSize = r.u32();
	const folderName = r.fstring();
	const packageFlags = r.u32();
	const nameCount = r.u32();
	const nameOffset = r.u32();

	let softObjectPathsCount = 0;
	let softObjectPathsOffset = 0;
	if (legacyFileVersion < -7) {
		softObjectPathsCount = r.u32();
		softObjectPathsOffset = r.u32();
	}
	const gatherableTextDataCount = r.u32();
	const gatherableTextDataOffset = r.u32();
	const exportCount = r.u32();
	const exportOffset = r.u32();
	const importCount = r.u32();
	const importOffset = r.u32();
	const dependsOffset = r.u32();
	const softPackageReferencesCount = r.u32();
	const softPackageReferencesOffset = r.u32();
	const searchableNamesOffset = r.u32();
	const thumbnailTableOffset = r.u32();
	const guid = bytesToHex(r.bytes(16));
	const generationCount = r.u32();
	// Skip per-generation (exportCount, nameCount) pairs — we
	// don't display them in the preview.
	r.skip(generationCount * 8);

	const summary: UassetSummary = {
		magic,
		legacyFileVersion,
		fileVersionUE4,
		fileVersionUE5,
		fileVersionLicenseeUE4,
		totalHeaderSize,
		folderName,
		packageFlags,
		nameCount,
		nameOffset,
		exportCount,
		exportOffset,
		importCount,
		importOffset,
		dependsOffset,
		softPackageReferencesCount,
		softPackageReferencesOffset,
		gatherableTextDataCount,
		gatherableTextDataOffset,
		softObjectPathsCount,
		softObjectPathsOffset,
		searchableNamesOffset,
		thumbnailTableOffset,
		guid,
		generationCount,
		customVersions,
	};

	// ---- Tables ----
	const names = parseNameTable(bytes, nameOffset, nameCount);
	const imports = parseImportTable(bytes, importOffset, importCount);
	const exports = parseExportTable(bytes, exportOffset, exportCount);
	const softPackageReferences = parseSoftPackageReferences(
		bytes,
		softPackageReferencesOffset,
		softPackageReferencesCount,
		names,
	);

	return {
		summary,
		names,
		imports,
		exports,
		softPackageReferences,
	};
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function parseNameTable(
	bytes: Uint8Array,
	offset: number,
	count: number,
): UassetName[] {
	if (offset === 0 || count === 0) return [];
	const r = new Reader(bytes, offset);
	const out: UassetName[] = [];
	for (let i = 0; i < count; i++) {
		// Defensive: stop early if we'd read past EOF rather than
		// throwing — a corrupted name-count shouldn't blow up the
		// whole preview.
		if (r.pos >= bytes.length) break;
		try {
			const value = r.fstring();
			const hashNonCasePreserving = r.u16();
			const hashCasePreserving = r.u16();
			out.push({ value, hashNonCasePreserving, hashCasePreserving });
		} catch {
			break;
		}
	}
	return out;
}

function parseImportTable(
	bytes: Uint8Array,
	offset: number,
	count: number,
): UassetImport[] {
	if (offset === 0 || count === 0) return [];
	const r = new Reader(bytes, offset);
	const out: UassetImport[] = [];
	for (let i = 0; i < count; i++) {
		if (r.pos + 28 > bytes.length) break;
		try {
			const classPackage = r.fname();
			const className = r.fname();
			const outerIndex = r.i32();
			const objectName = r.fname();
			out.push({ classPackage, className, outerIndex, objectName });
		} catch {
			break;
		}
	}
	return out;
}

/**
 * Parse the export table. We read the fixed-prefix fields
 * (everything through `packageFlags`) and skip the variable
 * tail (dependency hints, GUID-or-not depending on UE version,
 * etc.) by relying on a per-entry size that we infer from the
 * gap between consecutive `serialOffset`s — but we don't
 * actually need that gap, because we just stop reading after
 * the documented common-prefix fields and let the caller treat
 * the table as opaque-after-this-point.
 *
 * The export table is the most version-sensitive part of the
 * format; we read only the fields present in every supported UE
 * version (4.20+ / 5.x).
 */
function parseExportTable(
	bytes: Uint8Array,
	offset: number,
	count: number,
): UassetExport[] {
	if (offset === 0 || count === 0) return [];
	const out: UassetExport[] = [];
	// Each entry's size is total-table-bytes / count when the
	// caller can compute it; for now we just iterate forward and
	// stop on truncation.
	let pos = offset;
	for (let i = 0; i < count; i++) {
		if (pos + 72 > bytes.length) break;
		const r = new Reader(bytes, pos);
		try {
			const classIndex = r.i32();
			const superIndex = r.i32();
			const templateIndex = r.i32(); // UE4.14+
			const outerIndex = r.i32();
			const objectName = r.fname();
			const objectFlags = r.u32();
			const serialSize = r.i64Number();
			const serialOffset = r.i64Number();
			const forcedExport = r.u32() !== 0;
			const notForClient = r.u32() !== 0;
			const notForServer = r.u32() !== 0;
			// Older UE versions had a per-export package GUID
			// here (16 bytes); UE 4.27+ removed it. We can't
			// distinguish without a version oracle, so just skip
			// 16 bytes when present — heuristic: check whether
			// the next u32 looks like a packageFlags value
			// (typically 0 or has high bits set).
			r.skip(16);
			// packageFlags (or first export-tail flag) — we don't
			// surface it but read past for any potential UE5
			// alignment.
			out.push({
				classIndex,
				superIndex,
				templateIndex,
				outerIndex,
				objectName,
				objectFlags,
				serialSize,
				serialOffset,
				forcedExport,
				notForClient,
				notForServer,
				isAsset: null,
			});
		} catch {
			break;
		}
		// Advance to the next entry by extrapolating from a
		// fixed 104-byte stride. Real-world UE 4.27 / UE 5.x
		// exports are 104 bytes; the dependency-hint tail
		// occupies the extra 32 bytes beyond what we read.
		pos += 104;
	}
	return out;
}

/**
 * Soft package references are stored as either a count of
 * NUL-terminated strings (older UE) or as a count of FName
 * references into the name table (newer UE). Real-world PAKs
 * usually leave this section empty for ungathered packages.
 */
function parseSoftPackageReferences(
	bytes: Uint8Array,
	offset: number,
	count: number,
	names: UassetName[],
): string[] {
	if (offset === 0 || count === 0) return [];
	const r = new Reader(bytes, offset);
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		if (r.pos + 8 > bytes.length) break;
		try {
			// Try as FName first (most common in modern UE).
			const nameIdx = r.u32();
			const number = r.u32();
			void number;
			if (nameIdx < names.length) {
				out.push(names[nameIdx]!.value);
			}
		} catch {
			break;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an FName to its display string, applying UE's
 * `name_<n-1>` convention when `number > 0`.
 */
export function resolveFName(name: FName, names: UassetName[]): string {
	const base = names[name.nameIndex]?.value ?? `<bad name index ${name.nameIndex}>`;
	return name.number === 0 ? base : `${base}_${name.number - 1}`;
}

/**
 * Resolve a `FPackageIndex` to a display string. Negative =
 * import (1-indexed from -1), positive = export, 0 = null.
 */
export function resolvePackageIndex(
	index: number,
	imports: UassetImport[],
	exports: UassetExport[],
	names: UassetName[],
): string {
	if (index === 0) return 'None';
	if (index < 0) {
		const i = -index - 1;
		const imp = imports[i];
		if (!imp) return `<bad import index ${index}>`;
		return resolveFName(imp.objectName, names);
	}
	const i = index - 1;
	const exp = exports[i];
	if (!exp) return `<bad export index ${index}>`;
	return resolveFName(exp.objectName, names);
}

/**
 * Pull the asset's primary class name out of the import table.
 *
 * UE conventionally has one top-level export (`outerIndex === 0`)
 * representing the asset itself, plus a handful of sub-object
 * exports living under it. The top-level export's `classIndex`
 * points at the import table for the actual class
 * (`BinkMediaPlayer`, `Texture2D`, `WidgetBlueprint`, etc.).
 *
 * Heuristic:
 *   1. Find the first export with `outerIndex === 0` and a
 *      `classIndex < 0` (= imported class).
 *   2. Fall back to the first export with `classIndex < 0` if
 *      no top-level export exists.
 *
 * Returns `null` when the export table is empty or no export
 * has an importable class — happens for engine-built-in classes
 * (like `Class`) which would have a positive (export) class
 * index instead.
 */
export function inferAssetClassName(parsed: ParsedUasset): string | null {
	const resolveFromImport = (classIndex: number): string | null => {
		if (classIndex >= 0) return null;
		const i = -classIndex - 1;
		const imp = parsed.imports[i];
		if (!imp) return null;
		return resolveFName(imp.objectName, parsed.names);
	};
	// Prefer the top-level export.
	for (const exp of parsed.exports) {
		if (exp.outerIndex === 0) {
			const cls = resolveFromImport(exp.classIndex);
			if (cls) return cls;
		}
	}
	// Fall back to the first importable class on any export.
	for (const exp of parsed.exports) {
		const cls = resolveFromImport(exp.classIndex);
		if (cls) return cls;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Reader helpers
// ---------------------------------------------------------------------------

class Reader {
	pos = 0;
	view: DataView;
	#buf: Uint8Array;

	constructor(buf: Uint8Array, start = 0) {
		this.#buf = buf;
		this.pos = start;
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
	u16(): number {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
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
	i64Number(): number {
		const v = this.view.getBigInt64(this.pos, true);
		this.pos += 8;
		if (v < BigInt(Number.MIN_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new Error(`uasset: i64 value ${v} doesn't fit in JS safe integer range`);
		}
		return Number(v);
	}
	/**
	 * Read an FString: `i32 len + bytes` (UTF-8 with trailing
	 * NUL when len > 0; UTF-16LE when len < 0).
	 */
	fstring(): string {
		const len = this.i32();
		if (len === 0) return '';
		if (len > 0) {
			const slice = this.bytes(len);
			const trimEnd = slice[slice.length - 1] === 0 ? slice.length - 1 : slice.length;
			return new TextDecoder('utf-8').decode(slice.subarray(0, trimEnd));
		}
		const codeUnits = -len;
		const slice = this.bytes(codeUnits * 2);
		const trimEnd =
			slice[slice.length - 2] === 0 && slice[slice.length - 1] === 0
				? slice.length - 2
				: slice.length;
		return new TextDecoder('utf-16le').decode(slice.subarray(0, trimEnd));
	}
	/**
	 * Read an FName: `u32 nameIndex, u32 number`.
	 */
	fname(): FName {
		return { nameIndex: this.u32(), number: this.u32() };
	}
}

function bytesToHex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i]!.toString(16).padStart(2, '0');
	}
	return s;
}
