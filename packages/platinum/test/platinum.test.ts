import { describe, expect, it } from 'vitest';

import {
	buildWmbMesh,
	decodeWtaTexture,
	parseDat,
	parseMot,
	parsePkz,
	parseWmb,
	parseWta,
	pghalf,
	pkzHeaderSize,
	trsMatrix,
	WmbPose,
	xt1FormatName,
} from '../src/index.js';

/** Little-endian byte writer for building fixtures. */
class W {
	buf = new Uint8Array(0x10000);
	dv = new DataView(this.buf.buffer);
	u8(o: number, v: number) { this.buf[o] = v; }
	u16(o: number, v: number) { this.dv.setUint16(o, v, true); }
	i16(o: number, v: number) { this.dv.setInt16(o, v, true); }
	u32(o: number, v: number) { this.dv.setUint32(o, v, true); }
	i32(o: number, v: number) { this.dv.setInt32(o, v, true); }
	f32(o: number, v: number) { this.dv.setFloat32(o, v, true); }
	u64(o: number, v: number) { this.dv.setBigUint64(o, BigInt(v), true); }
	str(o: number, s: string) { for (let i = 0; i < s.length; i++) this.buf[o + i] = s.charCodeAt(i); }
	bytes(n: number) { return this.buf.slice(0, n); }
}

/** IEEE binary16 encoder for exact values. */
function half(v: number): number {
	if (v === 0) return 0;
	const s = v < 0 ? 0x8000 : 0;
	const a = Math.abs(v);
	const e = Math.floor(Math.log2(a));
	const m = Math.round((a / 2 ** e - 1) * 1024);
	return s | ((e + 15) << 10) | m;
}

describe('PKZ', () => {
	it('lists entries, with flags in the name field high word', () => {
		const w = new W();
		w.str(0, 'pkzl');
		w.u32(4, 0x00020000);
		w.u32(0x10, 2);
		w.u32(0x14, 0x20);
		w.u32(0x18, 0x30);
		w.u32(0x1c, 0x1000);
		const names = 0x20 + 2 * 32;
		w.str(names, 'OodleKraken');
		w.str(names + 0x10, 'pl/pl0001.dat');
		w.str(names + 0x20, 'pl/pl0001.dtt');
		w.u32(0x20, 0x10);
		w.u64(0x28, 100);
		w.u64(0x30, 0x1000);
		w.u64(0x38, 60);
		w.u32(0x40, 0x20);
		w.u32(0x44, 0x10);
		w.u64(0x48, 8);
		w.u64(0x50, 0x2000);
		w.u64(0x58, 8);
		const head = w.bytes(0x20);
		expect(pkzHeaderSize(head)).toBe(names + 0x30);
		const p = parsePkz(w.bytes(names + 0x30));
		expect(p.compression).toBe('OodleKraken');
		expect(p.entries.map((e) => e.name)).toEqual(['pl/pl0001.dat', 'pl/pl0001.dtt']);
		expect(p.entries[1]).toMatchObject({ flags: 0x10, size: 8, offset: 0x2000, compressedSize: 8 });
	});
});

describe('DAT', () => {
	it('lists named entries', () => {
		const w = new W();
		w.str(0, 'DAT\0');
		w.u32(4, 2);
		w.u32(8, 0x20); // offsets
		w.u32(0x0c, 0x28); // extensions
		w.u32(0x10, 0x30); // names
		w.u32(0x14, 0x60); // sizes
		w.u32(0x20, 0x80);
		w.u32(0x24, 0x90);
		w.u32(0x30, 12);
		w.str(0x34, 'a.wmb');
		w.str(0x34 + 12, 'a_0001.mot');
		w.u32(0x60, 4);
		w.u32(0x64, 6);
		w.str(0x80, 'WMB3');
		const d = parseDat(w.bytes(0xa0));
		expect(d).toEqual([
			{ index: 0, name: 'a.wmb', offset: 0x80, size: 4 },
			{ index: 1, name: 'a_0001.mot', offset: 0x90, size: 6 },
		]);
	});

	it('rejects out-of-bounds tables', () => {
		const w = new W();
		w.str(0, 'DAT\0');
		w.u32(4, 5);
		w.u32(8, 0xfff0);
		expect(() => parseDat(w.bytes(0x40))).toThrow();
	});
});

describe('WTA / XT1', () => {
	it('parses XT1 infos and decodes an RGBA8 surface', () => {
		const w = new W();
		w.str(0, 'WTB\0');
		w.u32(4, 3);
		w.u32(8, 1);
		w.u32(0x0c, 0x20);
		w.u32(0x10, 0x24);
		w.u32(0x14, 0x28);
		w.u32(0x18, 0x2c);
		w.u32(0x1c, 0x40);
		w.u32(0x20, 0); // offset into the pixels
		w.u32(0x24, 512);
		w.u32(0x2c, 0xdeadbeef);
		w.str(0x40, 'XT1\0');
		w.u64(0x48, 512);
		w.u32(0x50, 0x38);
		w.u32(0x54, 1);
		w.u32(0x58, 1); // 2D
		w.u32(0x5c, 0x25); // NVN RGBA8
		w.u32(0x60, 16);
		w.u32(0x64, 8);
		w.u32(0x68, 1);
		w.u8(0x70, 0); // block height 1 GOB
		const wta = parseWta(w.bytes(0x80));
		expect(wta.textures[0]).toMatchObject({ id: 0xdeadbeef, size: 512 });
		expect(wta.textures[0]!.xt1).toMatchObject({ format: 0x25, width: 16, height: 8, mipCount: 1 });
		expect(xt1FormatName(0x25)).toMatch(/R8_G8_B8_A8/);
		expect(xt1FormatName(0x8e)).toMatch(/ASTC_8x8/);
		// A uniform surface decodes to the same colour whatever the swizzle.
		const px = new Uint8Array(512);
		for (let i = 0; i < 512; i += 4) px.set([10, 20, 30, 255], i);
		const img = decodeWtaTexture(px, wta.textures[0]!);
		expect(img.width).toBe(16);
		expect([...img.pixels.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
		expect([...img.pixels.subarray(508, 512)]).toEqual([10, 20, 30, 255]);
	});
});

/**
 * A two-bone, one-triangle skinned WMB3: bone 0 at the origin, bone 1
 * (id 5) one unit up; vertex 2 is fully weighted to bone 1.
 */
function buildWmb(): Uint8Array {
	const w = new W();
	w.str(0, 'WMB3');
	w.u32(4, 0x20200824);
	w.u16(0x0c, 0x8); // u32 indices
	const pair = (slot: number, off: number, n: number) => {
		w.u32(0x28 + slot * 8, off);
		w.u32(0x2c + slot * 8, n);
	};
	// Bones (88 bytes each).
	const bones = 0x100;
	pair(0, bones, 2);
	const bone = (i: number, id: number, parent: number, y: number, worldY: number) => {
		const b = bones + i * 88;
		w.i16(b, id);
		w.i16(b + 2, parent);
		w.f32(b + 8, y); // local position y
		w.f32(b + 28, 1);
		w.f32(b + 32, 1);
		w.f32(b + 36, 1); // local scale
		w.f32(b + 44, worldY); // world position y
	};
	bone(0, 0, -1, 0, 0);
	bone(1, 5, 0, 1, 1);
	// Translate table: id 5 → first[0]=0, second[0*16+0]=0, third[0*16+5]=1.
	const tt = 0x300;
	pair(1, tt, 48);
	for (let i = 0; i < 48; i++) w.i16(tt + i * 2, -1);
	w.i16(tt, 0);
	w.i16(tt + 32, 0);
	w.i16(tt + 64 + 5 * 2, 1);
	w.i16(tt + 64, 0);
	// Vertex group, flags 7: 28-byte vertex, 12-byte extra (uv2, normal).
	const vg = 0x400;
	pair(2, vg, 1);
	const vtx = 0x500;
	const ex = 0x600;
	const idx = 0x700;
	w.u32(vg, vtx);
	w.u32(vg + 4, ex);
	w.u32(vg + 16, 28);
	w.u32(vg + 20, 12);
	w.i32(vg + 32, 3);
	w.i32(vg + 36, 7);
	w.u32(vg + 40, idx);
	w.i32(vg + 44, 3);
	const pos = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
	pos.forEach((p, i) => {
		const o = vtx + i * 28;
		w.f32(o, p[0]!);
		w.f32(o + 4, p[1]!);
		w.f32(o + 8, p[2]!);
		w.u16(o + 16, half(i * 0.5));
		w.u16(o + 18, half(0.25));
		w.u8(o + 20, i === 2 ? 1 : 0); // local bone index (into the bone set)
		w.u8(o + 24, 255);
		w.u16(ex + i * 12 + 4 + 4, half(1)); // normal z
	});
	[0, 1, 2].forEach((v, i) => w.u32(idx + i * 4, v));
	// Batch.
	const bat = 0x800;
	pair(3, bat, 1);
	w.u32(bat, 0);
	w.i32(bat + 4, 0);
	w.u32(bat + 16, 3);
	w.u32(bat + 20, 3);
	w.u32(bat + 24, 1);
	// LOD with one batch info.
	const lod = 0x900;
	pair(4, lod, 1);
	w.u32(lod, 0xf00);
	w.str(0xf00, 'LOD0');
	w.u32(lod + 12, 0x920);
	w.u32(lod + 16, 1);
	// Bone map + bone set: local 0 → map 0 → bone 0; local 1 → map 1 → bone 1.
	pair(6, 0xa00, 2);
	w.i32(0xa00, 0);
	w.i32(0xa04, 1);
	pair(7, 0xa40, 1);
	w.u32(0xa40, 0xa50);
	w.u32(0xa44, 2);
	w.i16(0xa50, 0);
	w.i16(0xa52, 1);
	// Material with one albedo texture.
	pair(8, 0xb00, 1);
	w.u32(0xb08, 0xf10);
	w.str(0xf10, 'Body');
	w.u32(0xb18, 0xb40);
	w.u32(0xb1c, 1);
	w.u32(0xb40, 0xf20);
	w.u32(0xb44, 0x1234);
	w.str(0xf20, 'g_AlbedoMap');
	// Mesh.
	pair(9, 0xc00, 1);
	w.u32(0xc00, 0xf30);
	w.str(0xf30, 'Mesh');
	return w.bytes(0x1000);
}

describe('WMB3', () => {
	it('parses bones, materials and the bone id table', () => {
		const wmb = parseWmb(buildWmb());
		expect(wmb.bones).toHaveLength(2);
		expect(wmb.boneIndexForId(5)).toBe(1);
		expect(wmb.boneIndexForId(6)).toBe(-1);
		expect(wmb.materials[0]).toMatchObject({ name: 'Body', textures: [{ name: 'g_AlbedoMap', id: 0x1234 }] });
		expect(wmb.lods[0]!.name).toBe('LOD0');
	});

	it('builds a skinned mesh', () => {
		const bytes = buildWmb();
		const wmb = parseWmb(bytes);
		const m = buildWmbMesh(bytes, wmb);
		expect([...m.indices]).toEqual([0, 1, 2]);
		expect([...m.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		expect(m.uvs[2]).toBeCloseTo(0.5);
		expect(m.normals[2]).toBeCloseTo(1);
		expect(m.skinBones[8]).toBe(1);
		expect(m.skinWeights[8]).toBeCloseTo(1);
		expect(m.sections).toEqual([{ material: 0, mesh: 0, firstIndex: 0, numTriangles: 1 }]);
	});

	it('poses and skins from a clip', () => {
		const bytes = buildWmb();
		const wmb = parseWmb(bytes);
		const m = buildWmbMesh(bytes, wmb);
		const pose = new WmbPose(wmb);
		expect(pose.bindWorld[1]![13]).toBeCloseTo(1);
		// Bone id 5 moves +2 on X.
		const mot = parseMot(buildMot());
		pose.setPose(mot, 0);
		const out = new Float32Array(9);
		pose.skin(m.positions, null, m.skinBones, m.skinWeights, out, null);
		expect(out[6]).toBeCloseTo(2);
		expect(out[7]).toBeCloseTo(1);
		expect(out[0]).toBeCloseTo(0); // bone 0 unanimated
	});
});

/** MOT: bone 5 translate X constant 2; bone 5 rotate Z Hermite 0 → π/2 over 10 frames. */
function buildMot(): Uint8Array {
	const w = new W();
	w.str(0, 'mot\0');
	w.u32(4, 0x20120405);
	w.u16(0x0a, 11);
	w.u32(0x0c, 0x2c);
	w.u32(0x10, 3);
	w.str(0x18, 'test');
	const rec = (i: number, bone: number, ch: number, type: number, n: number, value: number, isFloat: boolean) => {
		const r = 0x2c + i * 12;
		w.i16(r, bone);
		w.u8(r + 2, ch);
		w.u8(r + 3, type & 0xff);
		w.i16(r + 4, n);
		w.i16(r + 6, -1);
		if (isFloat) w.f32(r + 8, value);
		else w.u32(r + 8, value);
	};
	rec(0, 5, 0, 0, 0, 2, true);
	rec(1, 5, 5, 4, 2, 0x100 - (0x2c + 12), false);
	rec(2, 0x7fff, 0, 0xff, 0, 0, false);
	const k = 0x100;
	w.u16(k, 0);
	w.f32(k + 4, 0);
	w.u16(k + 16, 10);
	w.f32(k + 20, Math.PI / 2);
	return w.bytes(0x200);
}

describe('MOT', () => {
	it('samples constants and Hermite keys', () => {
		const mot = parseMot(buildMot());
		expect(mot.name).toBe('test');
		expect(mot.frameCount).toBe(11);
		expect(mot.curves).toHaveLength(2);
		expect(mot.curves[0]!.sample(3)).toBe(2);
		const rz = mot.curves[1]!;
		expect(rz.sample(0)).toBeCloseTo(0);
		expect(rz.sample(5)).toBeCloseTo(Math.PI / 4);
		expect(rz.sample(10)).toBeCloseTo(Math.PI / 2);
		expect(rz.sample(20)).toBeCloseTo(Math.PI / 2);
	});

	it('decodes pghalf', () => {
		expect(pghalf(47 << 9)).toBe(1);
		expect(pghalf((48 << 9) | 256)).toBe(3);
		expect(pghalf(0x8000 | (47 << 9))).toBe(-1);
	});
});

describe('pose math', () => {
	it('applies X, then Y, then Z rotations', () => {
		const m = trsMatrix([0, 0, 0], [Math.PI / 2, 0, Math.PI / 2], [1, 1, 1]);
		// Y → (X rot) Z → (Z rot) Z; Z → (X rot) −Y → (Z rot) X.
		expect(m[8]).toBeCloseTo(1);
		expect(m[9]).toBeCloseTo(0);
		expect(m[10]).toBeCloseTo(0);
		expect(m[4]).toBeCloseTo(0);
		expect(m[6]).toBeCloseTo(1);
	});
});
