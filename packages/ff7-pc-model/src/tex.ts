/**
 * FF7 TEX texture parser.
 *
 * `.tex` is a flexible 1990s texture format used by FF7 PC. It
 * supports both palette-indexed images (with one OR several
 * palettes stored together) and direct RGB(A). The header is a
 * fixed 236-byte (`0xEC`) block; pixels follow, optionally
 * preceded by raw BGRA8 palette data.
 *
 * In practice the FF7 corpus is overwhelmingly:
 *
 *   * 8-bit palette indexed, single 256-color palette, with the
 *     index 0 byte acting as the color-keyed transparent slot.
 *
 * We decode that path first-class; non-paletted variants fall
 * through to a generic R/G/B/A bitmask shuffle.
 */

const HEADER_SIZE = 0xec;

/** Subset of the TEX header that we actually consume. */
export interface ParsedTex {
	version: number;
	width: number;
	height: number;
	/**
	 * Bits per pixel of the on-disk pixel buffer. 8 for palette-
	 * indexed, 16 for RGB555, 24/32 for direct RGB/RGBA.
	 */
	bitsPerPixel: number;
	/** True when the file embeds a palette. */
	paletted: boolean;
	/** Color count per palette (typically 256 for the indexed case). */
	colorsPerPalette: number;
	/** Number of palettes (FF7 chars often have 1..4 for variants). */
	paletteCount: number;
	/** Decoded RGBA8 pixels (top-down, row-major). */
	pixels: Uint8Array;
}

export class TexParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TexParseError';
	}
}

/**
 * Sniff whether a buffer looks like an FF7 TEX file. The format
 * has no real magic — version is always 1 at offset 0 — so we
 * also check that the declared width/height are plausible.
 */
export function isTex(bytes: Uint8Array): boolean {
	if (bytes.byteLength < HEADER_SIZE) return false;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint32(0, true) !== 1) return false;
	const width = v.getUint32(0x3c, true);
	const height = v.getUint32(0x40, true);
	if (width === 0 || height === 0) return false;
	if (width > 4096 || height > 4096) return false;
	const bpp = v.getUint32(0x64, true);
	if (![8, 16, 24, 32].includes(bpp)) return false;
	return true;
}

/**
 * Parse a TEX file and decode the FIRST palette into RGBA8
 * pixels. Files with multiple palettes (some monsters / item
 * icons) only get the first variant decoded; future versions
 * may accept a palette-index argument.
 */
export function parseTex(bytes: Uint8Array): ParsedTex {
	if (bytes.byteLength < HEADER_SIZE) {
		throw new TexParseError(`TEX too small (${bytes.byteLength})`);
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = v.getUint32(0, true);
	if (version !== 1) {
		throw new TexParseError(`Unsupported TEX version ${version}`);
	}
	const colorKeyFlag = v.getUint32(0x08, true);
	const paletteCount = v.getUint32(0x30, true);
	const colorsPerPalette = v.getUint32(0x34, true);
	const width = v.getUint32(0x3c, true);
	const height = v.getUint32(0x40, true);
	const paletteFlag = v.getUint32(0x4c, true);
	const paletteSize = v.getUint32(0x58, true);
	const bitsPerPixel = v.getUint32(0x64, true);
	const bytesPerPixel = v.getUint32(0x68, true);
	const paletted = paletteFlag !== 0;

	let cursor = HEADER_SIZE;

	// Palette data (BGRA8 × paletteSize entries).
	let palette: Uint8Array | null = null;
	if (paletted) {
		palette = bytes.subarray(cursor, cursor + paletteSize * 4);
		cursor += paletteSize * 4;
	}

	// Pixel data. Always `width * height * bytesPerPixel` bytes
	// per the spec — the `pitch` field is informational only.
	const pixelByteCount = width * height * bytesPerPixel;
	if (cursor + pixelByteCount > bytes.byteLength) {
		throw new TexParseError(
			`TEX truncated: need ${pixelByteCount} pixel bytes at 0x${cursor.toString(16)}, only ${bytes.byteLength - cursor} available`,
		);
	}
	const pixelData = bytes.subarray(cursor, cursor + pixelByteCount);

	const rgba = new Uint8Array(width * height * 4);
	if (paletted) {
		// Use the first palette. Each entry is BGRA in source memory.
		const p = palette!;
		for (let i = 0; i < width * height; i++) {
			const idx = pixelData[i]!;
			const po = idx * 4;
			rgba[i * 4 + 0] = p[po + 2]!; // R
			rgba[i * 4 + 1] = p[po + 1]!; // G
			rgba[i * 4 + 2] = p[po + 0]!; // B
			rgba[i * 4 + 3] = p[po + 3]!; // A
			// Index 0 doubles as a color-key transparent slot when
			// colorKeyFlag is set. The wiki spec is somewhat fuzzy
			// here — most decoders just force-zero the alpha for
			// idx===0 when colorKeyFlag is non-zero.
			if (colorKeyFlag !== 0 && idx === 0) {
				rgba[i * 4 + 3] = 0;
			}
		}
	} else if (bitsPerPixel === 16) {
		// RGB555 (or RGB565 depending on the masks). Read the
		// pixel-format block at 0x6C..0x88 for the exact bit layout.
		const redMask = v.getUint32(0x7c, true);
		const greenMask = v.getUint32(0x80, true);
		const blueMask = v.getUint32(0x84, true);
		const alphaMask = v.getUint32(0x88, true);
		const redShift = v.getUint32(0x8c, true);
		const greenShift = v.getUint32(0x90, true);
		const blueShift = v.getUint32(0x94, true);
		const alphaShift = v.getUint32(0x98, true);
		const redBits = popcount(redMask);
		const greenBits = popcount(greenMask);
		const blueBits = popcount(blueMask);
		const alphaBits = popcount(alphaMask);
		for (let i = 0; i < width * height; i++) {
			const px =
				pixelData[i * 2]! | (pixelData[i * 2 + 1]! << 8);
			rgba[i * 4 + 0] = scaleBits((px & redMask) >>> redShift, redBits);
			rgba[i * 4 + 1] = scaleBits(
				(px & greenMask) >>> greenShift,
				greenBits,
			);
			rgba[i * 4 + 2] = scaleBits((px & blueMask) >>> blueShift, blueBits);
			rgba[i * 4 + 3] = alphaBits > 0
				? scaleBits((px & alphaMask) >>> alphaShift, alphaBits)
				: 255;
		}
	} else if (bitsPerPixel === 24 || bitsPerPixel === 32) {
		// Direct RGB(A). Assume BGRA-on-disk per the wiki
		// convention.
		for (let i = 0; i < width * height; i++) {
			const o = i * bytesPerPixel;
			rgba[i * 4 + 0] = pixelData[o + 2]!;
			rgba[i * 4 + 1] = pixelData[o + 1]!;
			rgba[i * 4 + 2] = pixelData[o + 0]!;
			rgba[i * 4 + 3] = bitsPerPixel === 32 ? pixelData[o + 3]! : 255;
		}
	} else {
		throw new TexParseError(
			`Unsupported TEX bit depth ${bitsPerPixel} (paletted=${paletted})`,
		);
	}

	return {
		version,
		width,
		height,
		bitsPerPixel,
		paletted,
		colorsPerPalette,
		paletteCount,
		pixels: rgba,
	};
}

function popcount(n: number): number {
	let count = 0;
	let x = n >>> 0;
	while (x) {
		count += x & 1;
		x >>>= 1;
	}
	return count;
}

/**
 * Expand an `n`-bit color channel to 8 bits via the standard
 * "replicate high bits" trick (preserves perceptual brightness
 * better than zero-padding for 5- and 6-bit channels).
 */
function scaleBits(value: number, bits: number): number {
	if (bits === 0) return 0;
	if (bits === 8) return value & 0xff;
	const max = (1 << bits) - 1;
	return Math.round((value / max) * 255);
}
