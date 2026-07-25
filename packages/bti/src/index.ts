/**
 * BTI ("Binary Texture Image") decoder.
 *
 * BTI is the standalone-file form of the texture descriptor that
 * Nintendo's GameCube engines embed in model archives — the `TEX1`
 * section of a J3D `.bmd`/`.bdl` file is literally an array of these
 * same 0x20-byte structures. Because the struct is identical, a `.bti`
 * on disc is just "one TEX1 entry, plus its pixels", which is why the
 * offsets inside the header are relative to the header itself rather
 * than to the start of the file: the very same bytes work whether the
 * struct sits alone in a file or in the middle of a much larger
 * archive.
 *
 * There is no magic number. The header opens straight into the format
 * byte, so identification has to be heuristic — see {@link isBti}.
 *
 * Header layout (0x20 bytes, all multi-byte fields big-endian, because
 * the GameCube's PowerPC "Gekko" CPU is big-endian):
 *
 *   0x00 u8   format          GX texture format (see `GxTextureFormat`)
 *   0x01 u8   alphaMode       0 = opaque, 1 = alpha, 2 = "special"
 *
 * That `alphaMode` byte is worth calling out, because it is *not* the boolean
 * it is usually documented as. JUTTexture treats it as an enum, and retail data
 * bears that out: of the 1810 BTI files inside Wind Waker's archives, 1205 store
 * the value 2. Validating it as 0-or-1 rejects two thirds of the real corpus, so
 * we accept the documented tri-state instead.
 *   0x02 u16  width
 *   0x04 u16  height
 *   0x06 u8   wrapS           0 = clamp, 1 = repeat, 2 = mirror
 *   0x07 u8   wrapT
 *   0x08 u8   paletteEnabled
 *   0x09 u8   paletteFormat   see `GxPaletteFormat`
 *   0x0A u16  paletteCount    number of 16-bit palette entries
 *   0x0C u32  paletteOffset   relative to the start of this header
 *   0x10 u32  borderColor
 *   0x14 u8   minFilter
 *   0x15 u8   magFilter
 *   0x16 u16  unknown
 *   0x18 u8   mipmapCount     1 = no mips
 *   0x19 u8   unknown
 *   0x1A u16  lodBias         fixed point, 1/100 units
 *   0x1C u32  dataOffset      relative to the start of this header
 *
 * The `wrapS`/`wrapT`/`minFilter`/`magFilter`/`borderColor`/`lodBias`
 * fields are not sampler *state* in the modern sense — they are the
 * literal values the engine pokes into the GX `TX_SETMODE0`/`1`
 * registers when the texture is bound, so they are stored here rather
 * than in the material.
 *
 * This module only decodes mip level 0. Mip levels follow level 0 in
 * the data section, each a quarter of the area of the previous one,
 * every level padded out to whole blocks of its own.
 *
 * References:
 *   - http://wiki.tockdom.com/wiki/BTI_(File_Format)
 *   - YAGCD, section on the TX (texture) unit
 *   - noclib/noclip.website, src/Common/JSYSTEM/JUTTexture.ts
 */

import {
	decodeGxTexture,
	gxFormatIsKnown,
	gxFormatIsPaletted,
	gxFormatName,
	gxImageSize,
	type GxPalette,
} from './gx.js';

export * from './gx.js';

/** Size of the BTI header in bytes. */
export const BTI_HEADER_SIZE = 0x20;

/** Texture coordinate wrap modes, as stored in `wrapS`/`wrapT`. */
/**
 * Values of the header's alpha byte.
 *
 * `SPECIAL` is by far the most common value in retail data and appears to mean
 * "this texture participates in blending in a way the material decides"; we
 * only need it to round-trip and to not be mistaken for corruption.
 */
export const BtiAlphaMode = {
	OPAQUE: 0,
	ALPHA: 1,
	SPECIAL: 2,
} as const;

export const BtiWrapMode = {
	CLAMP: 0,
	REPEAT: 1,
	MIRROR: 2,
} as const;

/** The subset of the BTI header that callers actually need. */
export interface BtiHeader {
	format: number;
	formatName: string;
	/** {@link BtiAlphaMode}: how the game intends to blend this texture. */
	alphaMode: number;
	width: number;
	height: number;
	wrapS: number;
	wrapT: number;
	paletteFormat: number;
	paletteCount: number;
	/** Byte offset of the palette, relative to the start of the header. */
	paletteOffset: number;
	mipmapCount: number;
	/** Byte offset of the image data, relative to the start of the header. */
	dataOffset: number;
}

/**
 * Largest dimension we consider plausible. GX itself caps textures at
 * 1024x1024, but we allow a bit of headroom for oddball tools.
 */
const MAX_DIMENSION = 4096;

/**
 * Heuristic sniff for a BTI header at `offset`.
 *
 * BTI has no magic number, so this checks that every field which has a
 * small, well-known domain actually falls inside it, and that the two
 * self-relative offsets point somewhere inside the buffer:
 *
 *   - `format` is a GX format we recognise,
 *   - `width` and `height` are non-zero and no larger than 4096,
 *   - `paletteEnabled` is boolean (0 or 1), `alphaMode` is a tri-state,
 *   - `wrapS`/`wrapT` are 0..2,
 *   - `paletteFormat` is 0..2,
 *   - `dataOffset` is at least 0x20 (it cannot point into the header)
 *     and lands inside the buffer,
 *   - when a palette is present, `paletteOffset` does the same and
 *     `paletteCount` is non-zero,
 *   - when the format is paletted, a palette must actually be present.
 *
 * Deliberately *not* checked: that the full image payload fits. BTIs
 * are frequently sniffed inside a larger archive where the caller
 * hands us a buffer that stops early, and `decodeBti()` re-checks the
 * payload length anyway.
 */
export function isBti(bytes: Uint8Array, offset = 0): boolean {
	if (!Number.isInteger(offset) || offset < 0) return false;
	const available = bytes.length - offset;
	if (available < BTI_HEADER_SIZE) return false;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const format = bytes[offset + 0x00];
	if (!gxFormatIsKnown(format)) return false;

	// Tri-state, not a boolean — see the note in the file header. Anything
	// above 2 is still implausible enough to reject on.
	const alphaMode = bytes[offset + 0x01];
	if (alphaMode > BtiAlphaMode.SPECIAL) return false;

	const width = view.getUint16(offset + 0x02, false);
	const height = view.getUint16(offset + 0x04, false);
	if (width === 0 || height === 0) return false;
	if (width > MAX_DIMENSION || height > MAX_DIMENSION) return false;

	const wrapS = bytes[offset + 0x06];
	const wrapT = bytes[offset + 0x07];
	if (wrapS > BtiWrapMode.MIRROR || wrapT > BtiWrapMode.MIRROR) return false;

	const paletteEnabled = bytes[offset + 0x08];
	if (paletteEnabled > 1) return false;

	const paletteFormat = bytes[offset + 0x09];
	if (paletteFormat > 2) return false;

	const paletteCount = view.getUint16(offset + 0x0a, false);
	const paletteOffset = view.getUint32(offset + 0x0c, false);
	const hasPalette = paletteEnabled === 1 || paletteCount !== 0;
	if (hasPalette) {
		if (paletteCount === 0) return false;
		if (paletteOffset < BTI_HEADER_SIZE) return false;
		if (paletteOffset >= available) return false;
	}
	// A C4/C8/C14X2 texture without a palette is meaningless.
	if (gxFormatIsPaletted(format) && !hasPalette) return false;

	const mipmapCount = bytes[offset + 0x18];
	if (mipmapCount === 0) return false;

	const dataOffset = view.getUint32(offset + 0x1c, false);
	if (dataOffset < BTI_HEADER_SIZE) return false;
	if (dataOffset >= available) return false;

	return true;
}

/**
 * Parse the BTI header at `offset`. Returns `null` if there are fewer
 * than {@link BTI_HEADER_SIZE} bytes available.
 *
 * Unlike {@link isBti} this performs no plausibility checks — it is a
 * plain struct read, so callers that already know they have a BTI (for
 * example a TEX1 section walker) can use it directly.
 */
export function parseBtiHeader(
	bytes: Uint8Array,
	offset = 0,
): BtiHeader | null {
	if (!Number.isInteger(offset) || offset < 0) return null;
	if (bytes.length - offset < BTI_HEADER_SIZE) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const format = bytes[offset + 0x00];
	return {
		format,
		formatName: gxFormatName(format),
		alphaMode: bytes[offset + 0x01],
		width: view.getUint16(offset + 0x02, false),
		height: view.getUint16(offset + 0x04, false),
		wrapS: bytes[offset + 0x06],
		wrapT: bytes[offset + 0x07],
		paletteFormat: bytes[offset + 0x09],
		paletteCount: view.getUint16(offset + 0x0a, false),
		paletteOffset: view.getUint32(offset + 0x0c, false),
		mipmapCount: bytes[offset + 0x18],
		dataOffset: view.getUint32(offset + 0x1c, false),
	};
}

/** Result of {@link decodeBti}: tightly-packed, top-down RGBA8. */
export interface DecodedBti {
	width: number;
	height: number;
	/** `width * height * 4` bytes of RGBA8, top row first. */
	pixels: Uint8Array;
}

/**
 * Decode mip level 0 of the BTI at `offset` into top-down RGBA8.
 *
 * Returns `null` when the header is unreadable, the texture format is
 * one we do not support, a paletted texture has no usable palette, or
 * the pixel data runs past the end of `bytes`.
 */
export function decodeBti(bytes: Uint8Array, offset = 0): DecodedBti | null {
	const header = parseBtiHeader(bytes, offset);
	if (!header) return null;
	if (header.width <= 0 || header.height <= 0) return null;
	if (gxImageSize(header.format, header.width, header.height) === 0) {
		return null;
	}

	let palette: GxPalette | undefined;
	if (gxFormatIsPaletted(header.format)) {
		if (header.paletteCount === 0) return null;
		// Palette offsets are relative to the header, exactly like the
		// image data offset, so that the struct can be relocated.
		palette = {
			data: bytes,
			offset: offset + header.paletteOffset,
			format: header.paletteFormat,
			count: header.paletteCount,
		};
	}

	const pixels = decodeGxTexture(
		bytes,
		offset + header.dataOffset,
		header.width,
		header.height,
		header.format,
		palette,
	);
	if (!pixels) return null;

	return { width: header.width, height: header.height, pixels };
}
