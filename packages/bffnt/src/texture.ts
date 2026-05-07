/**
 * Texture-format decoders for BFFNT TGLP sheets.
 *
 * The format codes used by Switch BFFNT TGLP sections (`sheetImageFormat`)
 * map to a small set of simple texture formats. We only support the
 * ones observed in real-world Switch fonts:
 *
 *   0x07  RGBA8       4 bpp, uncompressed
 *   0x08  R8 / A8     1 bpp, uncompressed alpha-only luminance
 *   0x0a  RG8 / LA8   2 bpp, luminance+alpha
 *   0x0c  BC4         0.5 bpp, 4×4 block-compressed alpha-only
 *
 * Other formats (BC1/BC3 colour blocks, RGB565, RGBA4, ETC1, etc.) are
 * theoretically possible but I haven't observed them in actual Switch
 * BFFNTs — they're inherited from the BCFNT (3DS) format codes. We
 * surface a clear "unsupported format" error if we encounter one.
 *
 * Output format: every decoder produces an `RGBA8` Uint8Array (4 bytes
 * per pixel, top-to-bottom row-major, premultiplied alpha not used).
 * Single-channel formats become opaque grayscale (R=G=B=value, A=255)
 * by default — but for glyph rendering you want the value in the
 * alpha channel, so callers can pass `singleChannelTo='alpha'` to map
 * the source byte to RGBA's alpha and leave RGB white.
 */

export type SingleChannelMode = 'rgb' | 'alpha';

export interface DecodedTexture {
	width: number;
	height: number;
	/** RGBA8 pixels, row-major. */
	pixels: Uint8Array;
}

/**
 * Bytes per pixel/block for a given format code, plus the block
 * dimensions. Used by the deswizzler to compute correct byte
 * addresses.
 */
export function textureFormatInfo(formatCode: number): {
	bytesPerBlock: number;
	blkWidth: number;
	blkHeight: number;
} {
	switch (formatCode) {
		case 0x07:
			return { bytesPerBlock: 4, blkWidth: 1, blkHeight: 1 };
		case 0x08:
			return { bytesPerBlock: 1, blkWidth: 1, blkHeight: 1 };
		case 0x0a:
			return { bytesPerBlock: 2, blkWidth: 1, blkHeight: 1 };
		case 0x0c:
			return { bytesPerBlock: 8, blkWidth: 4, blkHeight: 4 };
		default:
			throw new Error(
				`Unsupported BFFNT texture format 0x${formatCode.toString(16)} — only 0x07 (RGBA8), 0x08 (A8), 0x0a (LA8), 0x0c (BC4) are implemented`,
			);
	}
}

/** Friendly name for a format code, for debug / UI labels. */
export function textureFormatName(formatCode: number): string {
	switch (formatCode) {
		case 0x07:
			return 'RGBA8';
		case 0x08:
			return 'A8';
		case 0x0a:
			return 'LA8';
		case 0x0c:
			return 'BC4';
		default:
			return `0x${formatCode.toString(16)}`;
	}
}

/**
 * Decode one already-deswizzled sheet into RGBA8 pixels.
 *
 * `linearBytes` is the deswizzled output from the swizzle module:
 * one `bytesPerBlock`-sized cell per (block-grid) coordinate, in
 * row-major order. For uncompressed formats `bytesPerBlock === bpp`
 * and `blkWidth === blkHeight === 1`, so the bytes are just per-
 * pixel data already. For BC4 it's 8-byte blocks of 4×4 pixels each
 * that we decode in a separate inner loop.
 */
export function decodeTexture(opts: {
	linearBytes: Uint8Array;
	width: number;
	height: number;
	formatCode: number;
	singleChannelTo?: SingleChannelMode;
}): DecodedTexture {
	const { linearBytes, width, height, formatCode } = opts;
	const singleChannel = opts.singleChannelTo ?? 'alpha';
	const out = new Uint8Array(width * height * 4);

	switch (formatCode) {
		case 0x07: {
			// RGBA8 → just copy.
			for (let i = 0; i < width * height; i++) {
				out[i * 4 + 0] = linearBytes[i * 4 + 0];
				out[i * 4 + 1] = linearBytes[i * 4 + 1];
				out[i * 4 + 2] = linearBytes[i * 4 + 2];
				out[i * 4 + 3] = linearBytes[i * 4 + 3];
			}
			return { width, height, pixels: out };
		}
		case 0x08: {
			// Single-channel: alpha-only or grayscale-RGB.
			for (let i = 0; i < width * height; i++) {
				const v = linearBytes[i] ?? 0;
				if (singleChannel === 'alpha') {
					out[i * 4 + 0] = 255;
					out[i * 4 + 1] = 255;
					out[i * 4 + 2] = 255;
					out[i * 4 + 3] = v;
				} else {
					out[i * 4 + 0] = v;
					out[i * 4 + 1] = v;
					out[i * 4 + 2] = v;
					out[i * 4 + 3] = 255;
				}
			}
			return { width, height, pixels: out };
		}
		case 0x0a: {
			// LA8 → channel 0 luminance, channel 1 alpha.
			for (let i = 0; i < width * height; i++) {
				const l = linearBytes[i * 2] ?? 0;
				const a = linearBytes[i * 2 + 1] ?? 0;
				out[i * 4 + 0] = l;
				out[i * 4 + 1] = l;
				out[i * 4 + 2] = l;
				out[i * 4 + 3] = a;
			}
			return { width, height, pixels: out };
		}
		case 0x0c: {
			decodeBC4(linearBytes, width, height, out, singleChannel);
			return { width, height, pixels: out };
		}
		default:
			throw new Error(
				`Unsupported BFFNT texture format 0x${formatCode.toString(16)}`,
			);
	}
}

/**
 * BC4 (a.k.a. ATI1, "block-compressed alpha") decoder.
 *
 * Each 4×4 pixel block is 8 bytes:
 *   [0]    palette[0]  (uint8)
 *   [1]    palette[1]  (uint8)
 *   [2..7] 16 × 3-bit palette indices, packed into 6 bytes
 *
 * The palette is built from the two endpoints:
 *   - if palette[0] > palette[1]: 8-color interpolation
 *   - else: 6-color interpolation + {0, 255}
 *
 * Pixel index 0 = palette[0], 1 = palette[1], 2-7 = interpolated.
 *
 * Per-pixel value goes to the alpha channel (or RGB grayscale per
 * `mode`). RGB stays white when in alpha-mode so the glyph blits
 * correctly with `globalCompositeOperation = 'source-over'`.
 */
function decodeBC4(
	src: Uint8Array,
	width: number,
	height: number,
	dst: Uint8Array,
	mode: SingleChannelMode,
): void {
	const blocksWide = Math.ceil(width / 4);
	const blocksTall = Math.ceil(height / 4);
	for (let by = 0; by < blocksTall; by++) {
		for (let bx = 0; bx < blocksWide; bx++) {
			const blockOff = (by * blocksWide + bx) * 8;
			if (blockOff + 8 > src.length) continue;
			const r0 = src[blockOff];
			const r1 = src[blockOff + 1];
			const palette = new Uint8Array(8);
			palette[0] = r0;
			palette[1] = r1;
			if (r0 > r1) {
				palette[2] = Math.round((6 * r0 + 1 * r1) / 7);
				palette[3] = Math.round((5 * r0 + 2 * r1) / 7);
				palette[4] = Math.round((4 * r0 + 3 * r1) / 7);
				palette[5] = Math.round((3 * r0 + 4 * r1) / 7);
				palette[6] = Math.round((2 * r0 + 5 * r1) / 7);
				palette[7] = Math.round((1 * r0 + 6 * r1) / 7);
			} else {
				palette[2] = Math.round((4 * r0 + 1 * r1) / 5);
				palette[3] = Math.round((3 * r0 + 2 * r1) / 5);
				palette[4] = Math.round((2 * r0 + 3 * r1) / 5);
				palette[5] = Math.round((1 * r0 + 4 * r1) / 5);
				palette[6] = 0;
				palette[7] = 255;
			}
			// Read 16 × 3-bit indices from the next 6 bytes (LE).
			// Combine bytes [2..7] into a 48-bit integer; we use two
			// 24-bit halves to stay within JS safe-integer math.
			const lo24 =
				src[blockOff + 2] |
				(src[blockOff + 3] << 8) |
				(src[blockOff + 4] << 16);
			const hi24 =
				src[blockOff + 5] |
				(src[blockOff + 6] << 8) |
				(src[blockOff + 7] << 16);
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const idx = py * 4 + px;
					const bit = idx * 3;
					let v: number;
					if (bit < 24) {
						v = (lo24 >> bit) & 0x07;
					} else {
						v = (hi24 >> (bit - 24)) & 0x07;
					}
					const pixVal = palette[v];
					const x = bx * 4 + px;
					const y = by * 4 + py;
					if (x >= width || y >= height) continue;
					const dpos = (y * width + x) * 4;
					if (mode === 'alpha') {
						dst[dpos + 0] = 255;
						dst[dpos + 1] = 255;
						dst[dpos + 2] = 255;
						dst[dpos + 3] = pixVal;
					} else {
						dst[dpos + 0] = pixVal;
						dst[dpos + 1] = pixVal;
						dst[dpos + 2] = pixVal;
						dst[dpos + 3] = 255;
					}
				}
			}
		}
	}
}
