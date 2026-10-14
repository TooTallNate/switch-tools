import { describe, expect, it } from 'vitest';
import { buildGoldeneyeModel, findGoldeneyeFileTable, findGoldeneyeRoot, goldeneyeFileKind } from '../src/index.js';

class W {
	b: Uint8Array;
	dv: DataView;
	constructor(size: number) {
		this.b = new Uint8Array(size);
		this.dv = new DataView(this.b.buffer);
	}
	u16(o: number, v: number) {
		this.dv.setUint16(o, v);
	}
	u32(o: number, v: number) {
		this.dv.setUint32(o, v >>> 0);
	}
	f32(o: number, v: number) {
		this.dv.setFloat32(o, v);
	}
	str(o: number, s: string) {
		for (let i = 0; i < s.length; i++) this.b[o + i] = s.charCodeAt(i);
	}
}

describe('file table', () => {
	it('finds the indexed table and recovers its string base', () => {
		const names = ['', ...Array.from({ length: 20 }, (_, i) => (i % 2 ? `Gak${i}Z` : `bg/bg_${i}_all_p.seg`))];
		const w = new W(0x1000);
		const strings = 0x800, base = 0x80020000;
		let s = strings + 4;
		const addr: number[] = [];
		for (const n of names) {
			addr.push(base + s);
			w.str(s, n);
			s += n.length + 1;
		}
		const T = 0x100;
		names.forEach((_, i) => {
			w.u32(T + i * 12, i);
			w.u32(T + i * 12 + 4, addr[i]!);
			w.u32(T + i * 12 + 8, 0x100000 + i * 0x1000);
		});
		const files = findGoldeneyeFileTable(w.b, 0x200000)!;
		expect(files).toHaveLength(20);
		expect(files[0]).toMatchObject({ index: 1, name: 'bg/bg_0_all_p.seg', romOffset: 0x101000, romSize: 0x1000, compressed: false });
		expect(files[1]).toMatchObject({ name: 'Gak1Z', compressed: true });
		expect(goldeneyeFileKind('Gak1Z')).toBe('gun');
		expect(goldeneyeFileKind('bg/bg_0_all_p.seg')).toBe('level');
	});
});

/**
 * A header-less model: a group at origin (0, 10, 0) owning matrix 0,
 * whose child display-list node (opcode 4) draws one triangle from its
 * vertex table (segment 4), after selecting matrix 0 via segment 3.
 */
function modelFixture(): Uint8Array {
	const w = new W(0x200);
	const S = (o: number) => 0x05000000 + o;
	const GROUP = 0x40, GDATA = 0x60, DLN = 0x80, DLDATA = 0xa0, DL = 0xc0, VTX = 0x100;
	w.u16(GROUP, 2);
	w.u32(GROUP + 4, S(GDATA));
	w.u32(GROUP + 0x14, S(DLN));
	w.f32(GDATA + 4, 10);
	w.u16(GDATA + 0xe, 0); // MatrixID0
	w.u16(DLN, 4);
	w.u32(DLN + 4, S(DLDATA));
	w.u32(DLN + 8, S(GROUP));
	w.u32(DLDATA, S(DL));
	w.u32(DLDATA + 0xc, S(VTX));
	w.u16(DLDATA + 0x10, 3);
	w.u32(DL, 0x01020040); // G_MTX, segment 3 matrix 0
	w.u32(DL + 4, 0x03000000);
	w.u32(DL + 8, 0x04200030); // G_VTX n=3 v0=0
	w.u32(DL + 12, 0x04000000);
	w.u32(DL + 16, 0xb1000002); // G_TRI4: one triangle (0, 1, 2)
	w.u32(DL + 20, 0x00000010);
	w.u32(DL + 24, 0xb8000000);
	[[0, 0, 0], [4, 0, 0], [0, 4, 0]].forEach(([x, y, z], i) => {
		w.u16(VTX + i * 16, x!);
		w.u16(VTX + i * 16 + 2, y!);
		w.u16(VTX + i * 16 + 4, z!);
		w.b.set([255, 128, 0, 255], VTX + i * 16 + 12);
	});
	return w.b;
}

describe('buildGoldeneyeModel', () => {
	it('finds a header-less root and places joint-local vertices by group origin', () => {
		const d = modelFixture();
		expect(findGoldeneyeRoot(d)).toBe(0x40);
		const m = buildGoldeneyeModel(d);
		expect(m.primitives).toHaveLength(1);
		const p = m.primitives[0]!;
		expect(Array.from(p.positions)).toEqual([0, 10, 0, 4, 10, 0, 0, 14, 0]);
		expect(Array.from(p.indices)).toEqual([0, 1, 2]);
		expect(Array.from(p.colors!.subarray(0, 4))).toEqual([255, 128, 0, 255]);
	});

	it('rejects bytes without a node graph', () => {
		expect(() => buildGoldeneyeModel(new Uint8Array(0x100))).toThrow();
	});
});

import { decodeGoldeneyeTexture, findGoldeneyeTextureOffsets } from '../src/index.js';

describe('textures', () => {
	it('decodes an uncompressed (method 0) RGBA16 bitstring', () => {
		// flags 0; then bits: format 1 (4), width 2 (8), height 1 (8), method 0 (4), 2 × 16-bit pixels.
		const bits = '0001' + '00000010' + '00000001' + '0000' + '1111100000000001' + '0000011111000001';
		const bytes = [0];
		for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).padEnd(8, '0'), 2));
		const t = decodeGoldeneyeTexture(Uint8Array.from(bytes))!;
		expect([t.width, t.height]).toEqual([2, 1]);
		expect(Array.from(t.rgba)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('turns the size table into running offsets', () => {
		const code = new Uint8Array(8 * 600);
		const dv = new DataView(code.buffer);
		for (let i = 0; i < 600; i++) dv.setUint32(i * 8, 0x10 + i);
		const offs = findGoldeneyeTextureOffsets(code)!;
		expect(offs.slice(0, 3)).toEqual([0, 0x10, 0x21]);
		expect(offs).toHaveLength(601);
	});
});
