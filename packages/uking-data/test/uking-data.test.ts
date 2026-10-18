import { describe, expect, it } from 'vitest';
import { parseEco, parseProd, parseRstb, parseStat, parseXlnk, readSortedHashList, renderStat } from '../src/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('STAT', () => {
	it('reads a u16 grid and its name', () => {
		const w = 4;
		const h = 2;
		const b = new Uint8Array(0x38 + w * h * 2 + 4 + 16);
		const v = new DataView(b.buffer);
		b.set(enc('STAT'));
		v.setFloat32(0x10, -5000);
		v.setFloat32(0x14, -4000);
		v.setUint32(0x20, w);
		v.setUint32(0x24, h);
		v.setUint32(0x34, w * h * 2 + 4);
		for (let i = 0; i < w * h; i++) v.setUint16(0x38 + i * 2, i * 10);
		b.set(enc('water_depth'), 0x38 + w * h * 2);
		const s = parseStat(b);
		expect(s.name).toBe('water_depth');
		expect(s.bytesPerCell).toBe(2);
		expect(Array.from(s.values)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
		const img = renderStat(s);
		expect([img.min, img.max, img.distinct]).toEqual([0, 70, 8]);
	});
});

describe('PrOD', () => {
	it('reads meshes and instances', () => {
		const b = new Uint8Array(0x100);
		const v = new DataView(b.buffer);
		b.set(enc('PrOD'));
		v.setUint32(0x14, 1);
		v.setUint32(0x18, 0x60);
		v.setUint32(0x20, 0x20);
		v.setUint32(0x24, 1);
		v.setUint32(0x28, 8);
		[1, 2, 3, 0, 0.5, 0, 2].forEach((x, i) => v.setFloat32(0x30 + i * 4, x));
		v.setUint32(0x60, 1);
		b.set(enc('Obj_Flower'), 0x68);
		expect(parseProd(b).meshes).toEqual([
			{ name: 'Obj_Flower', instances: [{ position: [1, 2, 3], rotation: [0, 0.5, 0], scale: 2 }] },
		]);
	});
});

describe('ecosystem', () => {
	it('decodes shared run-length rows', () => {
		const rows = 3;
		const b = new Uint8Array(0x10 + rows * 4 + 16);
		const v = new DataView(b.buffer);
		v.setUint32(0, 0x00112233, true);
		v.setUint32(4, rows, true);
		v.setUint32(8, 1, true);
		// rows 0 and 2 share runs at 0; row 1 at byte 8 (offset 4 in 2-byte units)
		[0, 4, 0].forEach((o, r) => v.setUint32(0x10 + r * 4, o, true));
		const base = 0x10 + rows * 4;
		[[7, 6], [9, 4], [5, 10]].forEach(([val, len], i) => {
			v.setUint16(base + i * 4, val!, true);
			v.setUint16(base + i * 4 + 2, len!, true);
		});
		const e = parseEco(b);
		expect(e.width).toBe(10);
		expect(e.areas).toEqual([[5, 10], [7, 12], [9, 8]]);
		expect(e.render(1).width).toBe(10);
	});
});

describe('RSTB, XLNK and hash lists', () => {
	it('reads RSTB tables', () => {
		const b = new Uint8Array(0x0c + 8 + 132);
		const v = new DataView(b.buffer);
		b.set(enc('RSTB'));
		v.setUint32(4, 1, true);
		v.setUint32(8, 1, true);
		v.setUint32(0x0c, 0xdeadbeef, true);
		v.setUint32(0x10, 1234, true);
		b.set(enc('Actor/Foo.bxml'), 0x14);
		v.setUint32(0x14 + 128, 99, true);
		expect(parseRstb(b)).toEqual({
			crcEntries: [{ crc: 0xdeadbeef, size: 1234 }],
			nameEntries: [{ name: 'Actor/Foo.bxml', size: 99 }],
		});
	});

	it('reads XLNK users and names', () => {
		const b = new Uint8Array(0x60);
		const v = new DataView(b.buffer);
		b.set(enc('XLNK'));
		v.setUint32(0x08, 0x1c, true);
		v.setUint32(0x3c, 2, true);
		v.setUint32(0x44, 0x50, true);
		v.setUint32(0x48, 5, true);
		v.setUint32(0x4c, 9, true);
		b.set(enc('Hit\0Swing\0'), 0x50);
		const x = parseXlnk(b);
		expect(x.userHashes).toEqual([5, 9]);
		expect(x.names).toEqual(['Hit', 'Swing']);
	});

	it('accepts only ascending hash lists', () => {
		const b = new Uint8Array(16);
		const v = new DataView(b.buffer);
		v.setUint32(0, 2, true);
		v.setUint32(4, 10, true);
		v.setUint32(8, 20, true);
		expect(readSortedHashList(b, 0, true)).toEqual([10, 20]);
		v.setUint32(8, 5, true);
		expect(readSortedHashList(b, 0, true)).toBeNull();
	});
});
