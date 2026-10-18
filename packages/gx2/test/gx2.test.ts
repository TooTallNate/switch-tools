import { describe, expect, it } from 'vitest';
import { decodeGx2Surface, isGx2, parseGx2, untileGx2, type Gx2Surface } from '../src/index.js';

/** A GTX file with one surface block and its image block. */
function buildGtx(width: number, height: number, format: number, tileMode: number, image: Uint8Array): Uint8Array {
	const out = new Uint8Array(0x20 + 0x20 + 0x9c + 0x20 + image.length + 0x20);
	const v = new DataView(out.buffer);
	out.set(new TextEncoder().encode('Gfx2'));
	v.setUint32(4, 0x20);
	v.setUint32(8, 7);
	let o = 0x20;
	const block = (type: number, size: number) => {
		out.set(new TextEncoder().encode('BLK{'), o);
		v.setUint32(o + 4, 0x20);
		v.setUint32(o + 0x10, type);
		v.setUint32(o + 0x14, size);
		o += 0x20;
	};
	block(0x0b, 0x9c);
	[1, width, height, 1, 1, format, 0, 1, image.length, 0, 0, 0, tileMode, 0, 0, width].forEach((x, i) => v.setUint32(o + i * 4, x));
	o += 0x9c;
	block(0x0c, image.length);
	out.set(image, o);
	o += image.length;
	block(0x01, 0);
	return out;
}

const surface = (tileMode: number, w = 64, h = 32): Gx2Surface => ({
	dim: 1,
	width: w,
	height: h,
	depth: 1,
	mipCount: 1,
	format: 0x1a,
	formatName: 'RGBA8',
	imageSize: w * h * 4,
	tileMode,
	swizzle: 0,
	pitch: w,
	image: new Uint8Array(w * h * 4).map((_, i) => i >> 2),
});

describe('gx2', () => {
	it('lists blocks and surfaces', () => {
		const img = new Uint8Array(8 * 8 * 4).fill(7);
		const file = buildGtx(8, 8, 0x1a, 1, img);
		expect(isGx2(file)).toBe(true);
		const p = parseGx2(file);
		expect(p.blocks.map((b) => b.type)).toEqual([0x0b, 0x0c, 0x01]);
		expect(p.surfaces[0]).toMatchObject({ width: 8, height: 8, formatName: 'RGBA8', tileMode: 1 });
		const d = decodeGx2Surface(p.surfaces[0]!);
		expect(d.pixels.length).toBe(8 * 8 * 4);
		expect(d.pixels[0]).toBe(7);
	});

	it('decodes linear R8 to grey', () => {
		const img = new Uint8Array(4 * 4).map((_, i) => i * 10);
		const d = decodeGx2Surface(parseGx2(buildGtx(4, 4, 0x01, 16, img)).surfaces[0]!);
		expect(Array.from(d.pixels.subarray(4, 8))).toEqual([10, 10, 10, 255]);
	});

	// Every element of a tiled surface must come from a distinct source
	// address inside the image: a swizzle bug shows up as collisions.
	for (const mode of [2, 4]) {
		it(`tile mode ${mode} addressing is a bijection`, () => {
			const s = surface(mode);
			// Tag each 4-byte source element with its index.
			const src = new Uint8Array(s.imageSize);
			const sv = new DataView(src.buffer);
			for (let i = 0; i < s.imageSize / 4; i++) sv.setUint32(i * 4, i, true);
			const { data } = untileGx2({ ...s, image: src });
			const dv = new DataView(data.buffer);
			const seen = new Set<number>();
			for (let i = 0; i < data.length / 4; i++) seen.add(dv.getUint32(i * 4, true));
			expect(seen.size).toBe(s.width * s.height);
		});
	}
});
