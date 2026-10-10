import { describe, expect, it } from 'vitest';
import { decodeTim, findTims, timLayout } from '../src/index.js';

function tim(flags: number, clut: number[] | null, w: number, h: number, data: number[]): Uint8Array {
	const parts: number[] = [];
	const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
	const u16 = (v: number) => parts.push(v & 255, (v >> 8) & 255);
	u32(0x10);
	u32(flags);
	if (clut) {
		u32(12 + clut.length * 2);
		u16(0); u16(0); u16(clut.length); u16(1);
		clut.forEach(u16);
	}
	u32(12 + w * h * 2);
	u16(0); u16(0); u16(w); u16(h);
	parts.push(...data);
	return Uint8Array.from(parts);
}

describe('TIM', () => {
	it('decodes 16 bpp with transparent black', () => {
		// 0x001F = red, 0x7C00 = blue, 0x0000 = transparent, 0x8000 = opaque black (STP set).
		const t = decodeTim(tim(2, null, 4, 1, [0x1f, 0, 0x00, 0x7c, 0, 0, 0, 0x80]))!;
		expect([t.width, t.height, t.bpp]).toEqual([4, 1, 16]);
		expect([...t.pixels]).toEqual([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255]);
	});

	it('decodes 4 bpp through its CLUT', () => {
		const clut = Array.from({ length: 16 }, (_, i) => (i === 1 ? 0x03e0 : 0)); // index 1 = green
		const t = decodeTim(tim(8, clut, 1, 1, [0x01, 0x10]))!; // pixels: 1, 0, 0, 1
		expect([t.width, t.bpp, t.paletteCount]).toEqual([4, 4, 1]);
		expect([...t.pixels.subarray(0, 8)]).toEqual([0, 255, 0, 255, 0, 0, 0, 0]);
		expect([...t.pixels.subarray(12, 16)]).toEqual([0, 255, 0, 255]);
	});

	it('finds embedded TIMs and rejects junk', () => {
		const one = tim(2, null, 2, 2, new Array(8).fill(0xff));
		const blob = new Uint8Array(64 + one.length + 32);
		blob.set(one, 64);
		expect(findTims(blob)).toEqual([{ offset: 64, byteLength: one.length, width: 2, height: 2, bpp: 16 }]);
		expect(timLayout(Uint8Array.of(0x10, 0, 0, 0, 0x55, 0, 0, 0))).toBeNull();
	});
});
