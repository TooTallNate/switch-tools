import type { BitmapFont, BitmapGlyph } from '../src/index.js';

/** Anti-aliased coverage of a shape, by 8×8 supersampling each pixel. */
export function rasterize(width: number, height: number, inside: (x: number, y: number) => boolean): Uint8Array {
	const out = new Uint8Array(width * height);
	const N = 8;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let hits = 0;
			for (let sy = 0; sy < N; sy++) {
				for (let sx = 0; sx < N; sx++) if (inside(x + (sx + 0.5) / N, y + (sy + 0.5) / N)) hits++;
			}
			out[y * width + x] = Math.round((hits * 255) / (N * N));
		}
	}
	return out;
}

export const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
export const rect = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** A 40 px font with a disc ("o"), a ring ("O"), a square ("I"), a space and kerning. */
export function syntheticFont(): BitmapFont {
	const glyph = (cp: number, w: number, h: number, inside: ((x: number, y: number) => boolean) | null, advance = w + 2): BitmapGlyph => ({
		codepoints: [cp],
		advance,
		x: 1,
		y: 8,
		width: w,
		height: h,
		coverage: inside ? rasterize(w, h, inside) : new Uint8Array(w * h),
	});
	const ring = (x: number, y: number) => disc(15, 15, 14)(x, y) && !disc(15, 15, 8)(x, y);
	return {
		family: 'Synthetic',
		emSize: 40,
		lineHeight: 40,
		base: 32,
		glyphs: [
			glyph(0x6f, 24, 24, disc(12, 12, 11)),
			glyph(0x4f, 30, 30, ring),
			glyph(0x49, 10, 24, rect(2, 0, 8, 24)),
			glyph(0x20, 0, 0, null, 10),
			{ ...glyph(0x1f600, 20, 20, disc(10, 10, 9)) },
		],
		kerning: [{ first: 0x4f, second: 0x49, amount: -3 }],
	};
}
