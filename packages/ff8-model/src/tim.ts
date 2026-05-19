/**
 * PSX TIM texture decoder (the texture format embedded inside
 * FFVIII `chara.one` model entries and many other PSX games).
 *
 * Layout:
 *
 *   offset  type  field
 *     0x00  u32   magic           (0x00000010)
 *     0x04  u32   flags           (BPP in low 2 bits, has-CLUT in bit 3)
 *
 * If `hasCLUT`:
 *     0x08  u32   clutSectionSize (total bytes of the CLUT section,
 *                                  including these 12 header bytes)
 *     0x0C  u16   clutDX          (VRAM x; ignored for decode)
 *     0x0E  u16   clutDY          (VRAM y; ignored for decode)
 *     0x10  u16   clutWidth       (entries per palette: 16 for 4bpp, 256 for 8bpp)
 *     0x12  u16   clutHeight      (number of palettes)
 *     0x14  u16[clutWidth*clutHeight*2 bytes total] palettes (PSX BGR555)
 *
 * Image section (immediately after CLUT or at 0x08 if no CLUT):
 *     +0x00  u32   imageSectionSize  (total bytes including these 12)
 *     +0x04  u16   dx                (VRAM x; ignored)
 *     +0x06  u16   dy                (VRAM y; ignored)
 *     +0x08  u16   width             (width in HALFWORDS — multiply by
 *                                     bpp-dependent factor to get pixels)
 *     +0x0A  u16   height            (height in pixels)
 *     +0x0C  u8[]  pixels            (raw, top-down)
 *
 * BPP table:
 *     0 = 4bpp paletted   (2 pixels per byte; widthPixels = halfwords * 4)
 *     1 = 8bpp paletted   (1 pixel per byte;  widthPixels = halfwords * 2)
 *     2 = 16bpp direct    (BGR555 + STP;      widthPixels = halfwords)
 *     3 = 24bpp direct    (RGB888 packed;     widthPixels = halfwords * 2 / 3)
 *
 * 16bpp pixels are PSX BGR555; we decode to RGBA8888 by
 * scaling each 5-bit channel to 8 bits (`(c << 3) | (c >> 2)`).
 * Pixel `(0,0,0,STP=0)` is conventionally transparent in PSX
 * but the spec doesn't require us to honor that; we emit
 * black-with-alpha-255 for it and let the caller decide.
 *
 * Only palette 0 is decoded (FF8 chara models reference per-
 * polygon palette indices, but the TIM stores all of them in
 * order; callers that need a specific palette can re-decode
 * with `paletteIndex`).
 */

export class TimParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TimParseError';
	}
}

export const TIM_MAGIC = 0x00000010;

export type TimBpp = 4 | 8 | 16 | 24;

export interface ParsedTim {
	width: number;
	height: number;
	bpp: TimBpp;
	/**
	 * Number of CLUT palettes (only meaningful for 4/8 bpp).
	 * Undefined for 16/24 bpp.
	 */
	paletteCount?: number;
	/**
	 * Decoded RGBA8 pixels, row-major, top-down,
	 * `width * height * 4` bytes.
	 *
	 * For paletted TIMs this uses `paletteIndex` (default 0).
	 */
	pixels: Uint8Array;
}

export interface TimDecodeOptions {
	/**
	 * For paletted TIMs (4/8 bpp): which CLUT palette to apply.
	 * Default 0. Ignored for direct-colour formats.
	 */
	paletteIndex?: number;
}

/**
 * Quick sniff: a TIM starts with `10 00 00 00` and a flags
 * dword whose BPP field is in `{0,1,2,3}` and reserved bits
 * are zero.
 */
export function isTim(bytes: Uint8Array): boolean {
	if (bytes.length < 8) return false;
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	if (view.getUint32(0, true) !== TIM_MAGIC) return false;
	const flags = view.getUint32(4, true);
	// Bits 0-1: bpp (0..3). Bit 3: hasCLUT. Other bits should be 0.
	if (flags & ~0xb) return false;
	return true;
}

/** Convert a PSX BGR555 halfword into a 4-byte RGBA tuple. */
function bgr555ToRgba(hw: number): [number, number, number, number] {
	const r5 = hw & 0x1f;
	const g5 = (hw >> 5) & 0x1f;
	const b5 = (hw >> 10) & 0x1f;
	const r = (r5 << 3) | (r5 >> 2);
	const g = (g5 << 3) | (g5 >> 2);
	const b = (b5 << 3) | (b5 >> 2);
	return [r, g, b, 0xff];
}

export function parseTim(
	bytes: Uint8Array,
	opts: TimDecodeOptions = {},
): ParsedTim {
	if (bytes.length < 8) {
		throw new TimParseError(`TIM too short (${bytes.length} bytes)`);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const magic = view.getUint32(0, true);
	if (magic !== TIM_MAGIC) {
		throw new TimParseError(
			`TIM magic mismatch: expected 0x10, got 0x${magic.toString(16)}`,
		);
	}
	const flags = view.getUint32(4, true);
	const bppCode = flags & 0b11;
	const hasCLUT = (flags & 0b1000) !== 0;
	const bpp: TimBpp =
		bppCode === 0 ? 4 : bppCode === 1 ? 8 : bppCode === 2 ? 16 : 24;

	let cursor = 8;
	const paletteIndex = opts.paletteIndex ?? 0;

	// Palette section (4/8 bpp only — 16/24 bpp may technically
	// still have one but we ignore it).
	let palette: Uint16Array | null = null;
	let paletteWidth = 0;
	let paletteCount: number | undefined;
	if (hasCLUT) {
		if (cursor + 12 > bytes.length) {
			throw new TimParseError('TIM truncated in CLUT header');
		}
		const clutBytes = view.getUint32(cursor, true);
		paletteWidth = view.getUint16(cursor + 8, true);
		const paletteHeight = view.getUint16(cursor + 10, true);
		paletteCount = paletteHeight;
		const entries = paletteWidth * paletteHeight;
		const dataStart = cursor + 12;
		if (dataStart + entries * 2 > bytes.length) {
			throw new TimParseError('TIM CLUT data overruns buffer');
		}
		palette = new Uint16Array(entries);
		for (let i = 0; i < entries; i++) {
			palette[i] = view.getUint16(dataStart + i * 2, true);
		}
		cursor += clutBytes;
	}

	if (cursor + 12 > bytes.length) {
		throw new TimParseError('TIM truncated in image header');
	}
	const imageBytes = view.getUint32(cursor, true);
	void imageBytes;
	const widthHalfwords = view.getUint16(cursor + 8, true);
	const height = view.getUint16(cursor + 10, true);
	const pixDataStart = cursor + 12;

	let width: number;
	switch (bpp) {
		case 4:
			width = widthHalfwords * 4;
			break;
		case 8:
			width = widthHalfwords * 2;
			break;
		case 16:
			width = widthHalfwords;
			break;
		case 24:
			width = Math.floor((widthHalfwords * 2) / 3);
			break;
	}

	const pixels = new Uint8Array(width * height * 4);

	if (bpp === 4) {
		if (!palette) {
			throw new TimParseError('4bpp TIM has no CLUT');
		}
		const paletteOffset = paletteIndex * paletteWidth;
		const bytesPerRow = widthHalfwords * 2;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const byte = bytes[pixDataStart + y * bytesPerRow + (x >> 1)] ?? 0;
				const nibble = x & 1 ? (byte >> 4) & 0x0f : byte & 0x0f;
				const entry = palette[paletteOffset + nibble] ?? 0;
				const [r, g, b, a] = bgr555ToRgba(entry);
				const o = (y * width + x) * 4;
				pixels[o + 0] = r;
				pixels[o + 1] = g;
				pixels[o + 2] = b;
				pixels[o + 3] = a;
			}
		}
	} else if (bpp === 8) {
		if (!palette) {
			throw new TimParseError('8bpp TIM has no CLUT');
		}
		const paletteOffset = paletteIndex * paletteWidth;
		const bytesPerRow = widthHalfwords * 2;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const idx = bytes[pixDataStart + y * bytesPerRow + x] ?? 0;
				const entry = palette[paletteOffset + idx] ?? 0;
				const [r, g, b, a] = bgr555ToRgba(entry);
				const o = (y * width + x) * 4;
				pixels[o + 0] = r;
				pixels[o + 1] = g;
				pixels[o + 2] = b;
				pixels[o + 3] = a;
			}
		}
	} else if (bpp === 16) {
		const bytesPerRow = widthHalfwords * 2;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const o16 = pixDataStart + y * bytesPerRow + x * 2;
				const hw = view.getUint16(o16, true);
				const [r, g, b, a] = bgr555ToRgba(hw);
				const o = (y * width + x) * 4;
				pixels[o + 0] = r;
				pixels[o + 1] = g;
				pixels[o + 2] = b;
				pixels[o + 3] = a;
			}
		}
	} else {
		// 24bpp
		const bytesPerRow = widthHalfwords * 2;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const o24 = pixDataStart + y * bytesPerRow + x * 3;
				const r = bytes[o24 + 0] ?? 0;
				const g = bytes[o24 + 1] ?? 0;
				const b = bytes[o24 + 2] ?? 0;
				const o = (y * width + x) * 4;
				pixels[o + 0] = r;
				pixels[o + 1] = g;
				pixels[o + 2] = b;
				pixels[o + 3] = 0xff;
			}
		}
	}

	return { width, height, bpp, paletteCount, pixels };
}
