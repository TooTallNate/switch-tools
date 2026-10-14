import { describe, expect, it } from 'vitest';

import { decodeTga, isTga } from '../src/index.js';

function header(type: number, w: number, h: number, bpp: number, desc = 0, cmap?: { len: number; bits: number }): number[] {
	return [0, cmap ? 1 : 0, type, 0, 0, cmap?.len ?? 0, 0, cmap?.bits ?? 0, 0, 0, 0, 0, w, 0, h, 0, bpp, desc];
}

describe('TGA', () => {
	it('decodes bottom-up 24-bit true colour', () => {
		// 2×2, bottom row first: blue, green / red, white.
		const b = new Uint8Array([...header(2, 2, 2, 24), 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
		expect(isTga(b)).toBe(true);
		const t = decodeTga(b);
		expect([...t.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]); // top-left red
		expect([...t.pixels.subarray(8, 12)]).toEqual([0, 0, 255, 255]); // bottom-left blue
	});

	it('decodes RLE 32-bit top-down with alpha', () => {
		const b = new Uint8Array([...header(10, 3, 1, 32, 0x28), 0x82, 10, 20, 30, 128]);
		const t = decodeTga(b);
		expect([...t.pixels.subarray(8, 12)]).toEqual([30, 20, 10, 128]);
		expect(t.hasAlpha).toBe(true);
	});

	it('decodes colour-mapped and greyscale', () => {
		const pal = new Uint8Array([...header(1, 2, 1, 8, 0x20, { len: 2, bits: 24 }), 0, 0, 255, 255, 0, 0, 1, 0]);
		expect([...decodeTga(pal).pixels]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
		const g = new Uint8Array([...header(3, 1, 1, 8), 77]);
		expect([...decodeTga(g).pixels]).toEqual([77, 77, 77, 255]);
	});

	it('treats an all-zero 32-bit alpha channel as opaque', () => {
		const b = new Uint8Array([...header(2, 1, 1, 32), 1, 2, 3, 0]);
		expect(decodeTga(b).pixels[3]).toBe(255);
	});
});
