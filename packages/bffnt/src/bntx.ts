/**
 * Minimal BNTX (Binary NinTeXture) container parser.
 *
 * Switch BFFNT files don't store raw swizzled texture data inside
 * the TGLP section — they embed a full BNTX container holding a
 * texture-array of `sheetCount` layers. We parse just enough of the
 * BNTX envelope to extract the array's dimensions, format, GOB
 * `blockHeightLog2`, image-size and the offset of the actual
 * swizzled bytes.
 *
 * Reference port: aboood40091/BNTX-Editor (`structs.py`,
 * `bntx.py`). We use the same BRTI struct layout he derived from
 * the official Switch graphics SDK headers.
 *
 * Browser-friendly: takes a `Uint8Array` (no Node `fs` required) and
 * uses `DataView` for endian-aware reads.
 */
import type { Endian } from './parser.js';

export const BNTX_MAGIC = 'BNTX';

/** BNTX texture-format codes. The high byte is the family, the low byte the variant. */
export const BNTX_FORMAT_R4G4 = 0x0201; // 1 byte/pixel; on Switch BFFNT used as A8 (anti-aliased single-channel glyph data)
export const BNTX_FORMAT_R8 = 0x0101;
export const BNTX_FORMAT_R8G8 = 0x0901;
export const BNTX_FORMAT_R8G8B8A8 = 0x0b01;
export const BNTX_FORMAT_BC4_UNORM = 0x1d01;
export const BNTX_FORMAT_BC4_SNORM = 0x1d02;

export interface BntxTextureLayer {
	/** Pixel width of the texture (per array layer). */
	width: number;
	/** Pixel height of the texture (per array layer). */
	height: number;
	/** BNTX format code (e.g. 0x1d01 = BC4 UNORM). */
	format: number;
	/** Tegra GOB block-height exponent. `blockHeight = 1 << blockHeightLog2`. */
	blockHeightLog2: number;
	/** Number of array layers (= number of TGLP sheets). */
	arrayLength: number;
	/** Per-layer swizzled-data size in bytes (`imageSize / arrayLength`). */
	layerSize: number;
	/**
	 * Offset (relative to the start of the BNTX blob) of the
	 * texture's mip-0 data. Layer N starts at `mipOffset + N *
	 * layerSize`.
	 */
	mipOffset: number;
}

/** Quick check: does the blob start with the `BNTX` magic? */
export function isBntx(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x42 /* B */ &&
		bytes[1] === 0x4e /* N */ &&
		bytes[2] === 0x54 /* T */ &&
		bytes[3] === 0x58 /* X */
	);
}

/**
 * Parse a BNTX container and return its first texture's metadata.
 * Switch BFFNTs always embed exactly one BNTX texture (a 2D array
 * with one layer per sheet), so we don't bother walking multiple
 * BRTI entries.
 */
export function parseBntx(bytes: Uint8Array): BntxTextureLayer {
	if (!isBntx(bytes)) {
		throw new Error('Not a BNTX blob (missing magic)');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// Endian: 0xFFFE = little (typical for Switch), 0xFEFF = big.
	const bom = view.getUint16(0x0c, false);
	const endian: Endian = bom === 0xfeff ? 'big' : 'little';
	const le = endian === 'little';

	// TexContainer starts at 0x20 (after 32-byte BNTX header).
	//   0x20 target[4]  ("NX  " on Switch, "Gen " on Wii U)
	//   0x24 count
	//   0x28 infoPtrsAddr (u64)  → array of u64 BRTI pointers
	//   0x30 dataBlkAddr  (u64)
	const count = view.getUint32(0x24, le);
	if (count < 1) {
		throw new Error('BNTX has no textures');
	}
	const infoPtrsAddr = Number(view.getBigUint64(0x28, le));

	// First BRTI's offset (u64 pointer at infoPtrsAddr).
	const brtiOffset = Number(view.getBigUint64(infoPtrsAddr, le));
	if (
		bytes[brtiOffset] !== 0x42 ||
		bytes[brtiOffset + 1] !== 0x52 ||
		bytes[brtiOffset + 2] !== 0x54 ||
		bytes[brtiOffset + 3] !== 0x49
	) {
		throw new Error(`Expected BRTI at offset ${brtiOffset}`);
	}
	// BRTI section: 16-byte block header, then TextureInfo payload.
	const ti = brtiOffset + 0x10;

	// Field offsets within TextureInfo (relative to `ti`, derived
	// from AboodXD's `2B4H2x2I3i3I20x3IB3x8q` struct format):
	//   0x00 flags (u8)        0x01 dim (u8)
	//   0x02 tileMode (u16)    0x04 swizzle (u16)
	//   0x06 numMips (u16)     0x08 numSamples (u16, +2 pad)
	//   0x0c format (u32)
	//   0x10 accessFlags (u32)
	//   0x14 width (s32)       0x18 height (s32)    0x1c depth (s32)
	//   0x20 arrayLength (u32)
	//   0x24 textureLayout (u32)  → bits 0-2 = blockHeightLog2
	//   0x28 textureLayout2 (u32)
	//   (20 bytes padding)
	//   0x40 imageSize (u32)
	//   0x44 alignment (u32)
	//   0x48 _compSel (u32)
	//   0x4c imgDim (u8, +3 pad)
	//   0x50 nameAddr (s64)
	//   0x58 parentAddr (s64)
	//   0x60 ptrsAddr (s64)    → list of `numMips` u64 mip-data offsets
	const format = view.getUint32(ti + 0x0c, le);
	const width = view.getInt32(ti + 0x14, le);
	const height = view.getInt32(ti + 0x18, le);
	const arrayLength = view.getUint32(ti + 0x20, le);
	const textureLayout = view.getUint32(ti + 0x24, le);
	const blockHeightLog2 = textureLayout & 0x07;
	const imageSize = view.getUint32(ti + 0x40, le);
	const ptrsAddr = Number(view.getBigUint64(ti + 0x60, le));
	const mipOffset = Number(view.getBigUint64(ptrsAddr, le));

	const layerSize = arrayLength > 0 ? Math.floor(imageSize / arrayLength) : imageSize;

	return {
		width,
		height,
		format,
		blockHeightLog2,
		arrayLength: Math.max(1, arrayLength),
		layerSize,
		mipOffset,
	};
}

/**
 * Map BNTX format codes to BFFNT texture-format codes (the codes
 * used by `texture.ts`/`textureFormatInfo`). This lets the rest of
 * the pipeline stay in BFFNT-format-code-land regardless of whether
 * the data came from a BNTX or a raw BFFNT TGLP atlas.
 */
export function bntxFormatToBffntFormat(bntxFormat: number): number {
	switch (bntxFormat) {
		case BNTX_FORMAT_R8:
		case BNTX_FORMAT_R4G4:
			// Both are 1-byte-per-pixel single-channel formats. Switch
			// BFFNTs use 0x0201 (R4G4) for the "drop shadow" font
			// variants (e.g. `NormalS_00.bffnt`) — the byte is treated
			// as straight 8-bit alpha by the font system, so we
			// decode it the same as A8.
			return 0x08;
		case BNTX_FORMAT_R8G8:
			return 0x0a; // LA8
		case BNTX_FORMAT_R8G8B8A8:
			return 0x07; // RGBA8
		case BNTX_FORMAT_BC4_UNORM:
		case BNTX_FORMAT_BC4_SNORM:
			return 0x0c; // BC4
		default:
			throw new Error(
				`Unsupported BNTX texture format 0x${bntxFormat.toString(16)} — ` +
					`only BC4 (0x1d01/0x1d02), R8 (0x0101), R4G4 (0x0201), ` +
					`R8G8 (0x0901), R8G8B8A8 (0x0b01) are implemented`,
			);
	}
}
