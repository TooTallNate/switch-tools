/**
 * Cooked-texture binary layout reader for UE Texture2D / TextureCube
 * assets.
 *
 * After a Texture2D's property-tag stream terminates with `None`, UE
 * appends an `FTexturePlatformData` blob that describes the cooked
 * pixel data for the current target platform. The blob lives across
 * two files:
 *
 *   - `.uexp` for inline mips (small ones) and ALL the format metadata
 *     (width, height, pixel format, mip table).
 *   - `.ubulk` for streamed-mips data when the texture is larger than
 *     UE's inline budget. Each `.ubulk` mip's `offset` points into
 *     that file by absolute byte offset.
 *
 * Wire layout (UE 4.20–4.27 — UE5 has variations we don't model yet):
 *
 *   // From UTexture::Serialize → UTexture2D::Serialize:
 *   u8[N]    Some parent FStripDataFlags / GUID bytes (zeros in cooked builds);
 *            we skip ahead to the texture's own strip flags by scanning for
 *            the `01 00 01 00 01 00 00 00` signature.
 *   u16      UTexture::StripFlags (= 0x0001)
 *   u16      UTexture2D::StripFlags (= 0x0001)
 *   u32      bCooked (= 1)
 *
 *   // From FTexturePlatformData::SerializeCooked:
 *   FName    pixelFormatName     (u32 nameIndex + u32 number)
 *   u32      skipOffset          (absolute uexp offset where this PlatformData ends)
 *   u32      (zero, UE 4.20+)
 *   u32      importedWidth
 *   u32      importedHeight
 *   u32      packedData          (bits 0..29 = numSlices, 30 = hasOptData, 31 = isCube)
 *   FString  pixelFormat         ("PF_ASTC_6x6", "PF_BC5", "PF_B8G8R8A8", …)
 *   u32      firstMipToSerialize
 *   u32      mipCount
 *   per mip (FTexture2DMipMap::Serialize):
 *     u32    bCooked (= 1)
 *     u32    bulkFlags
 *     {i32|i64} dataSize        (i64 when BULKDATA_Size64Bit set)
 *     {i32|i64} dataSizeOnDisk  (same value)
 *     i64    offset             (absolute byte offset; in .ubulk for streamed mips,
 *                                in .uexp for inline mips)
 *     bytes  data[dataSize]     (only when BULKDATA_ForceInlinePayload set;
 *                                else the bytes live in .ubulk at `offset`)
 *     u32    width
 *     u32    height
 *     u32    depth              (UE 4.20+)
 *   u32      bIsVirtual         (= 0; non-zero means virtual textures, which we
 *                                don't support)
 *   u64      noneNameId         (= 0)
 *
 * Refs:
 *   - UE source: `Engine/Source/Runtime/Engine/Private/TextureDerivedData.cpp`
 *   - UAssetAPI (MIT): `UAssetAPI/ExportTypes/TextureExport.cs`
 *   - matyalatte/UE4-DDS-Tools (MIT): `src/unreal/utexture.py`, `umipmap.py`
 */

import type { ParsedUasset } from './index.js';
import { readExportProperties } from './properties.js';

/** Subset of UE's `EBulkDataFlags` we actually care about. */
export const BULKDATA_PayloadAtEndOfFile = 1 << 0;
export const BULKDATA_SingleUse = 1 << 3;
export const BULKDATA_Unused = 1 << 5;
export const BULKDATA_ForceInlinePayload = 1 << 6;
export const BULKDATA_PayloadInSeperateFile = 1 << 8;
export const BULKDATA_Size64Bit = 1 << 13;
export const BULKDATA_NoOffsetFixUp = 1 << 16;

/** Where this mip's pixel bytes live. */
export type MipLocation = 'uexp-inline' | 'ubulk' | 'unused';

/**
 * One cooked mipmap level.
 *
 * `bytes` is populated for inline mips (where the data lives inside the
 * .uexp blob). For .ubulk mips it's `null` and the caller must read
 * `[offset, offset+dataSize)` from the matching `.ubulk` file.
 */
export interface TextureMip {
	width: number;
	height: number;
	depth: number;
	dataSize: number;
	/** Absolute byte offset of the payload (in .ubulk for streamed, in .uexp for inline). */
	offset: number;
	location: MipLocation;
	bulkFlags: number;
	/** Mip payload bytes, only populated when `location === 'uexp-inline'`. */
	bytes: Uint8Array | null;
}

/**
 * Decoded `FTexturePlatformData` describing one cooked platform's
 * texture data — pixel format, dimensions, mip pyramid.
 */
export interface ParsedTexturePlatformData {
	/** Pixel format string from UE, e.g. `"PF_ASTC_6x6"` or `"PF_BC5"`. */
	pixelFormat: string;
	/** Top-mip width in pixels (what the artist authored). */
	importedWidth: number;
	/** Top-mip height in pixels. */
	importedHeight: number;
	/** Number of array slices. For cubemaps this is 6. */
	numSlices: number;
	/** True when packed_data flagged this as a cubemap. */
	isCube: boolean;
	/**
	 * Index of the first mip actually stored. UE skips top mips on
	 * platforms where memory is tight; `mips[0]` is the largest mip
	 * actually present, not the artist-authored size.
	 */
	firstMipToSerialize: number;
	/** All stored mips, largest first. */
	mips: TextureMip[];
}

export class TextureParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TextureParseError';
	}
}

/**
 * Convenience wrapper: parse a Texture2D / TextureCube export end-to-end.
 *
 * Takes the parsed .uasset header plus the matching .uexp bytes,
 * reads the export's property tags (so we know where the platform-data
 * blob starts), then decodes `FTexturePlatformData` from the tail.
 *
 * @param parsed       header parse from `parseUasset`
 * @param uexpBytes    bytes of the matching `.uexp` file
 * @param exportIndex  which export to read (default: 0 — the asset itself)
 */
export function parseTexturePlatformData(
	parsed: ParsedUasset,
	uexpBytes: Uint8Array,
	exportIndex = 0,
): ParsedTexturePlatformData {
	const props = readExportProperties(parsed, uexpBytes, exportIndex);
	return parseTexturePlatformDataFromTail(props.tail);
}

/**
 * Decode an `FTexturePlatformData` blob from the bytes that follow a
 * Texture2D export's property-tag `None` terminator. Use this when you
 * already have the tail bytes (e.g. from a manual `readExportProperties`
 * call you ran for other reasons).
 */
export function parseTexturePlatformDataFromTail(
	tail: Uint8Array,
): ParsedTexturePlatformData {
	const r = new Reader(tail);

	// UE prefixes its strip-flags section with a variable number of
	// bytes from parent UObject `Serialize` overrides (always zeros
	// in cooked builds). Skip ahead by scanning for the canonical
	// `01 00 01 00 01 00 00 00` strip-flags+bCooked signature.
	const stripStart = findStripFlags(tail);
	if (stripStart < 0) {
		throw new TextureParseError(
			'Texture platform-data: could not find the UTexture/UTexture2D strip-flags signature (01 00 01 00 01 00 00 00) in the export tail.',
		);
	}
	r.pos = stripStart;

	const stripFlagsTexture = r.u16();
	const stripFlagsTexture2D = r.u16();
	const bCooked = r.u32();
	if (stripFlagsTexture !== 0x0001 || stripFlagsTexture2D !== 0x0001) {
		throw new TextureParseError(
			`Texture platform-data: unexpected strip flags 0x${stripFlagsTexture.toString(16)} / 0x${stripFlagsTexture2D.toString(16)} (expected 0x0001).`,
		);
	}
	if (bCooked !== 1) {
		throw new TextureParseError(
			`Texture platform-data: bCooked=${bCooked}; only cooked builds are supported.`,
		);
	}

	// FName pixelFormatName (8 bytes) — same field is re-emitted as
	// a length-prefixed FString below, so we don't need to look it up
	// in the name table.
	r.skip(8);
	// skipOffset (UE 4.20+ writes a u32 absolute uexp offset where
	// this platform-data ends; we don't need it for parsing).
	r.skip(4);
	// Extra zero u32 introduced in UE 4.20.
	r.skip(4);

	const importedWidth = r.u32();
	const importedHeight = r.u32();
	const packedData = r.u32();
	const numSlices = packedData & 0x3fffffff;
	const isCube = (packedData & 0x80000000) !== 0;

	const pixelFormat = r.fstring();
	const firstMipToSerialize = r.u32();
	const mipCount = r.u32();
	// Sanity-cap: 32 levels covers a 4 Gpixel texture.
	if (mipCount > 32) {
		throw new TextureParseError(
			`Texture platform-data: implausible mipCount=${mipCount} (probably a parse desync).`,
		);
	}

	const mips: TextureMip[] = [];
	for (let i = 0; i < mipCount; i++) {
		// Per-mip bCooked.
		const mipCooked = r.u32();
		if (mipCooked !== 1) {
			throw new TextureParseError(
				`Texture platform-data: mip ${i} bCooked=${mipCooked}; only cooked mips supported.`,
			);
		}
		const bulkFlags = r.u32();
		const sized64 = (bulkFlags & BULKDATA_Size64Bit) !== 0;
		const dataSize = sized64 ? Number(r.i64()) : r.i32();
		const dataSizeOnDisk = sized64 ? Number(r.i64()) : r.i32();
		void dataSizeOnDisk;
		const offset = Number(r.i64());

		const inline = (bulkFlags & BULKDATA_ForceInlinePayload) !== 0;
		const inUbulk = (bulkFlags & BULKDATA_PayloadInSeperateFile) !== 0;
		const unused = (bulkFlags & BULKDATA_Unused) !== 0;
		let location: MipLocation;
		if (inline) location = 'uexp-inline';
		else if (inUbulk) location = 'ubulk';
		else if (unused) location = 'unused';
		else location = 'ubulk'; // PayloadAtEndOfFile without InSeperateFile

		let bytes: Uint8Array | null = null;
		if (inline) {
			bytes = tail.subarray(r.pos, r.pos + dataSize);
			r.skip(dataSize);
		}
		const width = r.u32();
		const height = r.u32();
		const depth = r.u32();
		mips.push({
			width,
			height,
			depth,
			dataSize,
			offset,
			location,
			bulkFlags,
			bytes,
		});
	}

	const bIsVirtual = r.u32();
	if (bIsVirtual !== 0) {
		throw new TextureParseError(
			'Texture platform-data: virtual textures are not supported (bIsVirtual=1).',
		);
	}
	// Trailing u64 noneNameId — we don't validate it; some titles
	// pack additional fields here for engine-specific extensions.

	return {
		pixelFormat,
		importedWidth,
		importedHeight,
		numSlices,
		isCube,
		firstMipToSerialize,
		mips,
	};
}

/**
 * Pull the `[offset, offset+dataSize)` window for a single mip out of
 * the matching .ubulk file. Returns `null` for inline mips (their
 * bytes already live on the mip itself).
 */
export function readMipFromUbulk(
	mip: TextureMip,
	ubulkBytes: Uint8Array,
): Uint8Array | null {
	if (mip.location !== 'ubulk') return null;
	if (mip.offset < 0 || mip.offset + mip.dataSize > ubulkBytes.length) {
		throw new TextureParseError(
			`Texture mip: offset ${mip.offset}+${mip.dataSize} is outside the .ubulk range (size=${ubulkBytes.length}).`,
		);
	}
	return ubulkBytes.subarray(mip.offset, mip.offset + mip.dataSize);
}

/**
 * Convenience: resolve the bytes for a single mip from whichever file
 * actually holds them.
 *
 * @returns the mip's encoded pixel bytes, or null if `location === 'unused'`.
 */
export function getMipBytes(
	mip: TextureMip,
	ubulkBytes: Uint8Array | null,
): Uint8Array | null {
	if (mip.location === 'uexp-inline') return mip.bytes;
	if (mip.location === 'ubulk') {
		if (!ubulkBytes) return null;
		return readMipFromUbulk(mip, ubulkBytes);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan forward for the canonical 8-byte strip-flags + bCooked signature
 * that opens every cooked Texture2D platform-data section.
 *
 * The leading bytes between the property `None` and the strip flags
 * are platform-data prefix bytes from parent UObject `Serialize`
 * overrides — usually all zeros, but the exact length varies by UE
 * version. Cap the scan at 64 bytes to fail fast on bad input.
 */
function findStripFlags(buf: Uint8Array): number {
	const limit = Math.min(buf.length - 8, 64);
	for (let i = 0; i <= limit; i++) {
		if (
			buf[i] === 0x01 && buf[i + 1] === 0x00 &&
			buf[i + 2] === 0x01 && buf[i + 3] === 0x00 &&
			buf[i + 4] === 0x01 && buf[i + 5] === 0x00 &&
			buf[i + 6] === 0x00 && buf[i + 7] === 0x00
		) {
			return i;
		}
	}
	return -1;
}

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
	i64(): bigint {
		const v = this.view.getBigInt64(this.pos, true);
		this.pos += 8;
		return v;
	}
	fstring(): string {
		const len = this.i32();
		if (len === 0) return '';
		if (len > 0) {
			const slice = this.#buf.subarray(this.pos, this.pos + len);
			this.pos += len;
			const trimEnd = slice[slice.length - 1] === 0 ? slice.length - 1 : slice.length;
			return new TextDecoder('utf-8').decode(slice.subarray(0, trimEnd));
		}
		const codeUnits = -len;
		const slice = this.#buf.subarray(this.pos, this.pos + codeUnits * 2);
		this.pos += codeUnits * 2;
		const trimEnd =
			slice[slice.length - 2] === 0 && slice[slice.length - 1] === 0
				? slice.length - 2
				: slice.length;
		return new TextDecoder('utf-16le').decode(slice.subarray(0, trimEnd));
	}
}
