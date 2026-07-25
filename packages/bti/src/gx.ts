/**
 * Nintendo GameCube (GX) texture decoders.
 *
 * The GameCube's "GX" graphics processor (Flipper, and its Wii
 * successor Hollywood) does not read textures as linear scanlines.
 * Instead every texture format is stored as a grid of small
 * rectangular *blocks* (Nintendo's docs call them "tiles"), and the
 * blocks are laid out in the file one after another: block row by
 * block row, and left-to-right within each row. Inside a block the
 * texels are linear — row by row, left to right.
 *
 * Why blocks? The texture unit fetches texture memory through a
 * read-only cache whose line size is **32 bytes**, and bilinear
 * filtering of a single texel needs a 2x2 neighbourhood. With linear
 * scanlines a 2x2 fetch straddles two rows and therefore two widely
 * separated cache lines, so a magnified texture would miss the cache
 * on nearly every pixel. Choosing each format's block dimensions so
 * that one block is exactly one 32-byte cache line makes the 2x2
 * neighbourhood almost always resident:
 *
 *   4 bpp  → 8x8 block  = 32 bytes   (I4, C4, and CMPR)
 *   8 bpp  → 8x4 block  = 32 bytes   (I8, IA4, C8)
 *   16 bpp → 4x4 block  = 32 bytes   (IA8, RGB565, RGB5A3, C14X2)
 *   32 bpp → 4x4 block  = 64 bytes   (RGBA32 — two cache lines)
 *
 * RGBA32 is the one format that cannot fit a 4x4 block in a single
 * line, so it is split into *two* 32-byte half-blocks: the first line
 * holds the 16 (A,R) pairs for the block and the second line holds
 * the 16 (G,B) pairs. This keeps each half a clean cache line, and
 * lets the hardware skip the second fetch entirely when it only needs
 * alpha (e.g. for an alpha-only pass).
 *
 * Because the layout is block-based, the stored image is always padded
 * out to whole blocks: a 5x5 CMPR texture still occupies one complete
 * 8x8 block (32 bytes). Decoders must consume the padding texels from
 * the stream but must not write them to the output, which is why every
 * loop below advances the source pointer unconditionally and
 * bounds-checks only the destination.
 *
 * Colour-channel expansion uses the usual "replicate the high bits"
 * rule so that an all-ones source maps to 0xFF:
 *
 *   3 → 8 bits: (v << 5) | (v << 2) | (v >> 1)
 *   4 → 8 bits: v * 0x11
 *   5 → 8 bits: (v << 3) | (v >> 2)
 *   6 → 8 bits: (v << 2) | (v >> 4)
 *
 * All multi-byte values in GX texture data are **big-endian**; the
 * console's PowerPC "Gekko" CPU is big-endian and Nintendo's tooling
 * wrote textures out in native byte order.
 *
 * References:
 *   - Dolphin, Source/Core/VideoCommon/TextureDecoder_Generic.cpp
 *   - YAGCD (Yet Another GameCube Documentation), section on TX
 *   - http://wiki.tockdom.com/wiki/Image_Formats
 */

/** GX texture formats, as stored in the `format` byte of a BTI/TEX1 entry. */
export const GxTextureFormat = {
	I4: 0x00,
	I8: 0x01,
	IA4: 0x02,
	IA8: 0x03,
	RGB565: 0x04,
	RGB5A3: 0x05,
	RGBA32: 0x06,
	C4: 0x08,
	C8: 0x09,
	C14X2: 0x0a,
	CMPR: 0x0e,
} as const;

export type GxTextureFormatValue =
	(typeof GxTextureFormat)[keyof typeof GxTextureFormat];

/**
 * Palette entry formats, used by the paletted (`C*`) texture formats.
 * Every entry is a 16-bit big-endian value regardless of format.
 */
export const GxPaletteFormat = {
	IA8: 0x00,
	RGB565: 0x01,
	RGB5A3: 0x02,
} as const;

export type GxPaletteFormatValue =
	(typeof GxPaletteFormat)[keyof typeof GxPaletteFormat];

/** Description of where a texture's palette lives, for `C4`/`C8`/`C14X2`. */
export interface GxPalette {
	/** Buffer holding the palette entries. */
	data: Uint8Array;
	/** Byte offset of the first entry within {@link GxPalette.data}. */
	offset: number;
	/** One of {@link GxPaletteFormat}. */
	format: number;
	/** Number of 16-bit entries. */
	count: number;
}

/** Human-readable name for a GX texture format. */
export function gxFormatName(format: number): string {
	switch (format) {
		case GxTextureFormat.I4:
			return 'I4';
		case GxTextureFormat.I8:
			return 'I8';
		case GxTextureFormat.IA4:
			return 'IA4';
		case GxTextureFormat.IA8:
			return 'IA8';
		case GxTextureFormat.RGB565:
			return 'RGB565';
		case GxTextureFormat.RGB5A3:
			return 'RGB5A3';
		case GxTextureFormat.RGBA32:
			return 'RGBA32';
		case GxTextureFormat.C4:
			return 'C4';
		case GxTextureFormat.C8:
			return 'C8';
		case GxTextureFormat.C14X2:
			return 'C14X2';
		case GxTextureFormat.CMPR:
			return 'CMPR';
		default:
			return `Unknown(0x${(format >>> 0).toString(16).padStart(2, '0')})`;
	}
}

/** Human-readable name for a GX palette format. */
export function gxPaletteFormatName(format: number): string {
	switch (format) {
		case GxPaletteFormat.IA8:
			return 'IA8';
		case GxPaletteFormat.RGB565:
			return 'RGB565';
		case GxPaletteFormat.RGB5A3:
			return 'RGB5A3';
		default:
			return `Unknown(0x${(format >>> 0).toString(16).padStart(2, '0')})`;
	}
}

/** `true` if `format` is one of the formats this module can decode. */
export function gxFormatIsKnown(format: number): boolean {
	return gxBitsPerTexel(format) !== 0;
}

/** `true` if `format` reads its colours through a palette. */
export function gxFormatIsPaletted(format: number): boolean {
	return (
		format === GxTextureFormat.C4 ||
		format === GxTextureFormat.C8 ||
		format === GxTextureFormat.C14X2
	);
}

/** Bits of storage per texel, or `0` for an unknown format. */
export function gxBitsPerTexel(format: number): number {
	switch (format) {
		case GxTextureFormat.I4:
		case GxTextureFormat.C4:
		// CMPR is 4 bpp on average: a 4x4 sub-block costs 8 bytes.
		case GxTextureFormat.CMPR:
			return 4;
		case GxTextureFormat.I8:
		case GxTextureFormat.IA4:
		case GxTextureFormat.C8:
			return 8;
		case GxTextureFormat.IA8:
		case GxTextureFormat.RGB565:
		case GxTextureFormat.RGB5A3:
		case GxTextureFormat.C14X2:
			return 16;
		case GxTextureFormat.RGBA32:
			return 32;
		default:
			return 0;
	}
}

/** Block width in texels, or `0` for an unknown format. */
export function gxBlockWidth(format: number): number {
	switch (format) {
		case GxTextureFormat.I4:
		case GxTextureFormat.C4:
		case GxTextureFormat.CMPR:
		case GxTextureFormat.I8:
		case GxTextureFormat.IA4:
		case GxTextureFormat.C8:
			return 8;
		case GxTextureFormat.IA8:
		case GxTextureFormat.RGB565:
		case GxTextureFormat.RGB5A3:
		case GxTextureFormat.C14X2:
		case GxTextureFormat.RGBA32:
			return 4;
		default:
			return 0;
	}
}

/** Block height in texels, or `0` for an unknown format. */
export function gxBlockHeight(format: number): number {
	switch (format) {
		// 4 bpp: 8x8 texels fills a 32-byte cache line.
		case GxTextureFormat.I4:
		case GxTextureFormat.C4:
		case GxTextureFormat.CMPR:
			return 8;
		// 8 bpp: 8x4 texels fills a 32-byte cache line.
		case GxTextureFormat.I8:
		case GxTextureFormat.IA4:
		case GxTextureFormat.C8:
			return 4;
		// 16/32 bpp: 4x4 texels (one or two cache lines).
		case GxTextureFormat.IA8:
		case GxTextureFormat.RGB565:
		case GxTextureFormat.RGB5A3:
		case GxTextureFormat.C14X2:
		case GxTextureFormat.RGBA32:
			return 4;
		default:
			return 0;
	}
}

/**
 * Size in bytes of one mip level, rounded up to whole blocks.
 *
 * Returns `0` for unknown formats or non-positive dimensions.
 */
export function gxImageSize(
	format: number,
	width: number,
	height: number,
): number {
	const bw = gxBlockWidth(format);
	const bh = gxBlockHeight(format);
	const bpp = gxBitsPerTexel(format);
	if (bw === 0 || bh === 0) return 0;
	if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
	if (width <= 0 || height <= 0) return 0;
	const blocksAcross = Math.ceil(width / bw);
	const blocksDown = Math.ceil(height / bh);
	// bw * bh * bpp is always a whole number of bytes for every GX
	// format (32 bytes, or 64 for RGBA32), so no rounding is needed.
	const bytesPerBlock = (bw * bh * bpp) / 8;
	return blocksAcross * blocksDown * bytesPerBlock;
}

// ---------------------------------------------------------------------------
// Channel expansion
// ---------------------------------------------------------------------------

/** Expand a 3-bit channel to 8 bits (7 → 0xFF). */
function expand3(v: number): number {
	return ((v << 5) | (v << 2) | (v >> 1)) & 0xff;
}

/** Expand a 4-bit channel to 8 bits (15 → 0xFF). */
function expand4(v: number): number {
	return (v * 0x11) & 0xff;
}

/** Expand a 5-bit channel to 8 bits (31 → 0xFF). */
function expand5(v: number): number {
	return ((v << 3) | (v >> 2)) & 0xff;
}

/** Expand a 6-bit channel to 8 bits (63 → 0xFF). */
function expand6(v: number): number {
	return ((v << 2) | (v >> 4)) & 0xff;
}

// ---------------------------------------------------------------------------
// Per-texel writers
//
// Each writer takes the raw stored value for one texel and writes four
// bytes of RGBA8 at `out[o..o+3]`.
// ---------------------------------------------------------------------------

/** `(value, out, o) => void`: expand one stored texel into RGBA8. */
type TexelWriter = (value: number, out: Uint8Array, o: number) => void;

/**
 * I4/I8: a single intensity channel. GX replicates intensity into all
 * four channels, so an I-format texture is *also* an alpha texture —
 * that is what makes I8 usable as a font/decal mask. We match the
 * hardware (and Dolphin) and set alpha = intensity rather than 0xFF.
 */
function writeIntensity(value: number, out: Uint8Array, o: number): void {
	out[o] = value;
	out[o + 1] = value;
	out[o + 2] = value;
	out[o + 3] = value;
}

/** I4: 4-bit intensity in the low nibble of `value`. */
function writeI4(value: number, out: Uint8Array, o: number): void {
	writeIntensity(expand4(value & 0x0f), out, o);
}

/** IA4: low nibble = intensity, high nibble = alpha. */
function writeIA4(value: number, out: Uint8Array, o: number): void {
	const i = expand4(value & 0x0f);
	out[o] = i;
	out[o + 1] = i;
	out[o + 2] = i;
	out[o + 3] = expand4(value >> 4);
}

/** IA8: high byte = alpha, low byte = intensity. */
function writeIA8(value: number, out: Uint8Array, o: number): void {
	const i = value & 0xff;
	out[o] = i;
	out[o + 1] = i;
	out[o + 2] = i;
	out[o + 3] = (value >> 8) & 0xff;
}

/** RGB565: `RRRRRGGG GGGBBBBB`, always opaque. */
function writeRGB565(value: number, out: Uint8Array, o: number): void {
	out[o] = expand5((value >> 11) & 0x1f);
	out[o + 1] = expand6((value >> 5) & 0x3f);
	out[o + 2] = expand5(value & 0x1f);
	out[o + 3] = 0xff;
}

/**
 * RGB5A3: a per-texel choice between "more colour" and "some alpha",
 * selected by the top bit. Note the inversion relative to what you
 * might guess: the top bit being **set** means *opaque* 5:5:5, and
 * being **clear** means 3-bit alpha plus 4:4:4 colour. Nintendo chose
 * it that way so that the common case (fully opaque) is the one that
 * gets the extra colour precision.
 *
 *   1RRRRRGG GGGBBBBB → opaque, 5:5:5
 *   0AAARRRR GGGGBBBB → 3-bit alpha, 4:4:4
 */
function writeRGB5A3(value: number, out: Uint8Array, o: number): void {
	if (value & 0x8000) {
		out[o] = expand5((value >> 10) & 0x1f);
		out[o + 1] = expand5((value >> 5) & 0x1f);
		out[o + 2] = expand5(value & 0x1f);
		out[o + 3] = 0xff;
	} else {
		out[o] = expand4((value >> 8) & 0x0f);
		out[o + 1] = expand4((value >> 4) & 0x0f);
		out[o + 2] = expand4(value & 0x0f);
		out[o + 3] = expand3((value >> 12) & 0x07);
	}
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/**
 * Expand a palette into a flat RGBA8 lookup table (`count * 4` bytes).
 * Returns `null` if the palette format is unknown or the entries do
 * not fit inside the supplied buffer.
 */
function buildPalette(palette: GxPalette): Uint8Array | null {
	const { data, offset, format, count } = palette;
	if (!Number.isFinite(count) || count <= 0) return null;
	if (!Number.isFinite(offset) || offset < 0) return null;
	// Every palette format is 16 bits per entry.
	if (offset + count * 2 > data.length) return null;

	let write: TexelWriter;
	switch (format) {
		case GxPaletteFormat.IA8:
			write = writeIA8;
			break;
		case GxPaletteFormat.RGB565:
			write = writeRGB565;
			break;
		case GxPaletteFormat.RGB5A3:
			write = writeRGB5A3;
			break;
		default:
			return null;
	}

	const out = new Uint8Array(count * 4);
	for (let i = 0; i < count; i++) {
		const src = offset + i * 2;
		write((data[src] << 8) | data[src + 1], out, i * 4);
	}
	return out;
}

/**
 * Build a {@link TexelWriter} that resolves palette indices.
 *
 * Indices past the end of the palette are written as transparent
 * black: real assets never do this, but a truncated or mismatched
 * palette should not produce garbage read out of a neighbouring
 * allocation.
 */
function makePaletteWriter(pal: Uint8Array, mask: number): TexelWriter {
	const count = pal.length / 4;
	return (value, out, o) => {
		const index = value & mask;
		if (index >= count) {
			out[o] = 0;
			out[o + 1] = 0;
			out[o + 2] = 0;
			out[o + 3] = 0;
			return;
		}
		const src = index * 4;
		out[o] = pal[src];
		out[o + 1] = pal[src + 1];
		out[o + 2] = pal[src + 2];
		out[o + 3] = pal[src + 3];
	};
}

// ---------------------------------------------------------------------------
// Tiled scans
// ---------------------------------------------------------------------------

/**
 * 4 bpp formats (I4, C4): 8x8 blocks, two texels per byte with the
 * **high** nibble holding the left-hand texel.
 */
function decodeTiled4(
	data: Uint8Array,
	offset: number,
	width: number,
	height: number,
	out: Uint8Array,
	write: TexelWriter,
): void {
	let src = offset;
	for (let by = 0; by < height; by += 8) {
		for (let bx = 0; bx < width; bx += 8) {
			for (let y = 0; y < 8; y++) {
				const py = by + y;
				for (let x = 0; x < 8; x += 2) {
					const b = data[src++];
					if (py >= height) continue;
					const rowBase = py * width;
					const px = bx + x;
					if (px < width) write(b >> 4, out, (rowBase + px) * 4);
					if (px + 1 < width) {
						write(b & 0x0f, out, (rowBase + px + 1) * 4);
					}
				}
			}
		}
	}
}

/** 8 bpp formats (I8, IA4, C8): 8x4 blocks, one byte per texel. */
function decodeTiled8(
	data: Uint8Array,
	offset: number,
	width: number,
	height: number,
	out: Uint8Array,
	write: TexelWriter,
): void {
	let src = offset;
	for (let by = 0; by < height; by += 4) {
		for (let bx = 0; bx < width; bx += 8) {
			for (let y = 0; y < 4; y++) {
				const py = by + y;
				for (let x = 0; x < 8; x++) {
					const b = data[src++];
					const px = bx + x;
					if (py < height && px < width) {
						write(b, out, (py * width + px) * 4);
					}
				}
			}
		}
	}
}

/**
 * 16 bpp formats (IA8, RGB565, RGB5A3, C14X2): 4x4 blocks, one
 * big-endian 16-bit word per texel.
 */
function decodeTiled16(
	data: Uint8Array,
	offset: number,
	width: number,
	height: number,
	out: Uint8Array,
	write: TexelWriter,
): void {
	let src = offset;
	for (let by = 0; by < height; by += 4) {
		for (let bx = 0; bx < width; bx += 4) {
			for (let y = 0; y < 4; y++) {
				const py = by + y;
				for (let x = 0; x < 4; x++) {
					const v = (data[src] << 8) | data[src + 1];
					src += 2;
					const px = bx + x;
					if (py < height && px < width) {
						write(v, out, (py * width + px) * 4);
					}
				}
			}
		}
	}
}

/**
 * RGBA32: 4x4 blocks of 64 bytes, stored as two 32-byte half-blocks.
 * The first half holds 16 (A,R) pairs in row-major texel order and the
 * second half holds the matching 16 (G,B) pairs.
 */
function decodeTiledRGBA32(
	data: Uint8Array,
	offset: number,
	width: number,
	height: number,
	out: Uint8Array,
): void {
	let src = offset;
	for (let by = 0; by < height; by += 4) {
		for (let bx = 0; bx < width; bx += 4) {
			for (let t = 0; t < 16; t++) {
				const py = by + (t >> 2);
				const px = bx + (t & 3);
				if (py >= height || px >= width) continue;
				const ar = src + t * 2;
				const gb = src + 32 + t * 2;
				const o = (py * width + px) * 4;
				out[o] = data[ar + 1]; // R
				out[o + 1] = data[gb]; // G
				out[o + 2] = data[gb + 1]; // B
				out[o + 3] = data[ar]; // A
			}
			src += 64;
		}
	}
}

// ---------------------------------------------------------------------------
// CMPR (GameCube's flavour of DXT1)
// ---------------------------------------------------------------------------

/**
 * Decode one 8-byte DXT1 sub-block into a 4x4 patch at (`ox`, `oy`).
 *
 * Two differences from PC DXT1 that will silently produce a wrong
 * image if missed:
 *
 *   1. The two RGB565 endpoints are stored **big-endian** (PC DXT1 is
 *      little-endian), matching the rest of GX.
 *   2. In 3-colour mode (`color0 <= color1`) index 3 is fully
 *      transparent *black*. PC decoders often leave RGB undefined or
 *      keep the interpolated colour there; the GX texture unit
 *      produces RGBA = 0, and CMPR is the console's only compressed
 *      format with any alpha at all, so games rely on it.
 *
 * The 2-bit indices are packed one byte per texel row, most
 * significant bits first, so the left-most texel of a row uses bits
 * 7..6.
 */
function decodeCmprSubBlock(
	data: Uint8Array,
	src: number,
	width: number,
	height: number,
	ox: number,
	oy: number,
	out: Uint8Array,
): void {
	const c0 = (data[src] << 8) | data[src + 1];
	const c1 = (data[src + 2] << 8) | data[src + 3];

	// Endpoint colours, expanded to 8 bits per channel.
	const r0 = expand5((c0 >> 11) & 0x1f);
	const g0 = expand6((c0 >> 5) & 0x3f);
	const b0 = expand5(c0 & 0x1f);
	const r1 = expand5((c1 >> 11) & 0x1f);
	const g1 = expand6((c1 >> 5) & 0x3f);
	const b1 = expand5(c1 & 0x1f);

	// 16 bytes of palette: 4 colours x RGBA.
	const lut = new Uint8Array(16);
	lut[0] = r0;
	lut[1] = g0;
	lut[2] = b0;
	lut[3] = 0xff;
	lut[4] = r1;
	lut[5] = g1;
	lut[6] = b1;
	lut[7] = 0xff;
	if (c0 > c1) {
		// 4-colour mode: two interpolated opaque colours at 1/3 and 2/3.
		// Division is truncating; the DXT1 spec leaves the rounding
		// mode up to the implementation.
		lut[8] = Math.floor((2 * r0 + r1) / 3);
		lut[9] = Math.floor((2 * g0 + g1) / 3);
		lut[10] = Math.floor((2 * b0 + b1) / 3);
		lut[11] = 0xff;
		lut[12] = Math.floor((r0 + 2 * r1) / 3);
		lut[13] = Math.floor((g0 + 2 * g1) / 3);
		lut[14] = Math.floor((b0 + 2 * b1) / 3);
		lut[15] = 0xff;
	} else {
		// 3-colour mode: one midpoint, and index 3 is transparent black.
		lut[8] = Math.floor((r0 + r1) / 2);
		lut[9] = Math.floor((g0 + g1) / 2);
		lut[10] = Math.floor((b0 + b1) / 2);
		lut[11] = 0xff;
		lut[12] = 0;
		lut[13] = 0;
		lut[14] = 0;
		lut[15] = 0;
	}

	for (let y = 0; y < 4; y++) {
		const py = oy + y;
		if (py >= height) continue;
		const bits = data[src + 4 + y];
		for (let x = 0; x < 4; x++) {
			const px = ox + x;
			if (px >= width) continue;
			const index = (bits >> (6 - 2 * x)) & 0x03;
			const o = (py * width + px) * 4;
			const c = index * 4;
			out[o] = lut[c];
			out[o + 1] = lut[c + 1];
			out[o + 2] = lut[c + 2];
			out[o + 3] = lut[c + 3];
		}
	}
}

/**
 * CMPR: 8x8 blocks, each holding four 4x4 DXT1 sub-blocks in the
 * order top-left, top-right, bottom-left, bottom-right. (This extra
 * level of nesting exists purely so that a CMPR block is still one
 * 32-byte cache line like every other format.)
 */
function decodeTiledCmpr(
	data: Uint8Array,
	offset: number,
	width: number,
	height: number,
	out: Uint8Array,
): void {
	let src = offset;
	for (let by = 0; by < height; by += 8) {
		for (let bx = 0; bx < width; bx += 8) {
			decodeCmprSubBlock(data, src, width, height, bx, by, out);
			decodeCmprSubBlock(data, src + 8, width, height, bx + 4, by, out);
			decodeCmprSubBlock(data, src + 16, width, height, bx, by + 4, out);
			decodeCmprSubBlock(
				data,
				src + 24,
				width,
				height,
				bx + 4,
				by + 4,
				out,
			);
			src += 32;
		}
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decode a single GX texture image into tightly-packed, top-down
 * RGBA8 (`width * height * 4` bytes, no row padding).
 *
 * Returns `null` when:
 *
 *   - `format` is not a format we know how to decode,
 *   - `width`/`height` are not positive integers,
 *   - the image data would run past the end of `data`,
 *   - the format is paletted but no usable palette was supplied.
 */
export function decodeGxTexture(
	data: Uint8Array,
	offset: number,
	width: number,
	height: number,
	format: number,
	palette?: GxPalette,
): Uint8Array | null {
	if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
	if (width <= 0 || height <= 0) return null;
	if (!Number.isInteger(offset) || offset < 0) return null;

	const size = gxImageSize(format, width, height);
	if (size === 0) return null;
	if (offset + size > data.length) return null;

	// Paletted formats need their lookup table up front.
	let paletteWriter: TexelWriter | null = null;
	if (gxFormatIsPaletted(format)) {
		if (!palette) return null;
		const pal = buildPalette(palette);
		if (!pal) return null;
		// C4 indexes with 4 bits, C8 with 8, C14X2 with 14 (the top two
		// bits of the 16-bit word are unused padding — that is the "X2").
		const mask =
			format === GxTextureFormat.C4
				? 0x000f
				: format === GxTextureFormat.C8
					? 0x00ff
					: 0x3fff;
		paletteWriter = makePaletteWriter(pal, mask);
	}

	const out = new Uint8Array(width * height * 4);

	switch (format) {
		case GxTextureFormat.I4:
			decodeTiled4(data, offset, width, height, out, writeI4);
			return out;
		case GxTextureFormat.C4:
			decodeTiled4(data, offset, width, height, out, paletteWriter!);
			return out;
		case GxTextureFormat.I8:
			decodeTiled8(data, offset, width, height, out, writeIntensity);
			return out;
		case GxTextureFormat.IA4:
			decodeTiled8(data, offset, width, height, out, writeIA4);
			return out;
		case GxTextureFormat.C8:
			decodeTiled8(data, offset, width, height, out, paletteWriter!);
			return out;
		case GxTextureFormat.IA8:
			decodeTiled16(data, offset, width, height, out, writeIA8);
			return out;
		case GxTextureFormat.RGB565:
			decodeTiled16(data, offset, width, height, out, writeRGB565);
			return out;
		case GxTextureFormat.RGB5A3:
			decodeTiled16(data, offset, width, height, out, writeRGB5A3);
			return out;
		case GxTextureFormat.C14X2:
			decodeTiled16(data, offset, width, height, out, paletteWriter!);
			return out;
		case GxTextureFormat.RGBA32:
			decodeTiledRGBA32(data, offset, width, height, out);
			return out;
		case GxTextureFormat.CMPR:
			decodeTiledCmpr(data, offset, width, height, out);
			return out;
		default:
			// Unreachable: `gxImageSize()` already returned 0 above.
			return null;
	}
}
