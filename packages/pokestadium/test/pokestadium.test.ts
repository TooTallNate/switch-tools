import { describe, expect, it } from 'vitest';
import {
	buildStadiumModel,
	decodeStadiumAsset,
	decodeStadiumTexture,
	findModelRoot,
	fragmentImage,
	parseStadiumArchive,
	stadium2ModelName,
	stadiumBindMatrices,
	stadiumRecordBytes,
	STADIUM2_SPECIES,
} from '../src/index.js';

/** Big-endian byte writer. */
class W {
	b: Uint8Array;
	constructor(size: number) {
		this.b = new Uint8Array(size);
	}
	u8(o: number, v: number) {
		this.b[o] = v & 0xff;
	}
	u16(o: number, v: number) {
		this.b[o] = (v >> 8) & 0xff;
		this.b[o + 1] = v & 0xff;
	}
	u32(o: number, v: number) {
		this.u16(o, v >>> 16);
		this.u16(o + 2, v & 0xffff);
	}
	str(o: number, s: string) {
		for (let i = 0; i < s.length; i++) this.b[o + i] = s.charCodeAt(i);
	}
}

const BASE = 0x8ff00000;

/**
 * A minimal Pokémon module: entry code that builds the root address,
 * a root struct, one joint (translated +10 Y) with a pushed child
 * level, a 2×1 RGBA16 texture, and one display list drawing a triangle.
 */
function moduleFixture(): Uint8Array {
	const w = new W(0x400);
	w.str(8, 'FRAGMENT');
	w.u32(0x14, 0x400); // relocations start at the end
	w.u32(0x18, 0x400);
	w.u32(0x1c, 0x400);
	const ROOT = 0x100, LIST = 0x120, LAYOUT = 0x140, TEX = 0x200, TEXELS = 0x220, DL = 0x240, VTX = 0x280;
	// lui a0, 0x8FF0 ; addiu a0, a0, ROOT
	w.u32(0x20, (0x0f << 26) | (4 << 16) | 0x8ff0);
	w.u32(0x24, (0x09 << 26) | (4 << 21) | (4 << 16) | ROOT);
	w.u16(ROOT, 25); // species
	w.u32(ROOT + 8, BASE + LIST);
	w.u32(LIST, BASE + LAYOUT);
	let o = LAYOUT;
	// 0x17 tables: 1 texture, 0 TLUTs
	w.u8(o, 0x17);
	w.u16(o + 2, 1);
	w.u32(o + 8, BASE + TEX);
	o += 0x14;
	// 0x1C root scale 0.5
	w.u8(o, 0x1c);
	for (let k = 0; k < 3; k++) w.u32(o + 4 + k * 4, 0x8000);
	o += 0x10;
	// 0x1D joint: translate (0, 10, 0), unit scale
	w.u8(o, 0x1d);
	w.u8(o + 1, 7);
	w.u16(o + 6, 10);
	for (let k = 0; k < 3; k++) w.u32(o + 0x10 + k * 4, 0x10000);
	o += 0x1c;
	w.u8(o, 0x05); // push: draws below bind to the joint
	o += 4;
	w.u8(o, 0x23); // material: texture 0, no TLUT, no material DL
	w.u16(o + 8, 0);
	w.u16(o + 0xa, 0xffff);
	o += 0x10;
	w.u8(o, 0x22);
	w.u32(o + 4, BASE + DL);
	o += 8;
	w.u8(o, 0x06);
	o += 4;
	w.u8(o, 0x01); // return
	// texture: RGBA16 2×1, red then green
	w.u8(TEX, 0);
	w.u8(TEX + 1, 2);
	w.u16(TEX + 2, 2);
	w.u16(TEX + 4, 1);
	w.u32(TEX + 8, BASE + TEXELS);
	w.u16(TEXELS, 0xf801);
	w.u16(TEXELS + 2, 0x07c1);
	// DL: G_VTX 3 @ 0, G_TRI1 0 1 2, G_ENDDL
	w.u32(DL, 0x01003006);
	w.u32(DL + 4, BASE + VTX);
	w.u32(DL + 8, 0x05000204);
	w.u32(DL + 16, 0xdf000000);
	const verts = [
		[0, 0, 0, 0, 0],
		[4, 0, 0, 64, 0],
		[0, 4, 0, 0, 32],
	];
	verts.forEach(([x, y, z, s, t], i) => {
		const p = VTX + i * 16;
		w.u16(p, x!);
		w.u16(p + 2, y!);
		w.u16(p + 4, z!);
		w.u16(p + 8, s!);
		w.u16(p + 10, t!);
		w.u8(p + 14, 119); // +Z normal (length 119/127)
		w.u8(p + 15, 255);
	});
	return w.b;
}

/** Wrap bytes in PERS-SZP + an all-literal Yay0 stream. */
function persSzp(data: Uint8Array): Uint8Array {
	const maskWords = Math.ceil(data.length / 32);
	const yay0Len = 16 + maskWords * 4 + data.length;
	const w = new W(16 + yay0Len);
	w.str(0, 'PERS-SZP');
	w.u32(8, 16);
	const y = 16;
	w.str(y, 'Yay0');
	w.u32(y + 4, data.length);
	w.u32(y + 8, 16 + maskWords * 4); // link stream (unused)
	w.u32(y + 12, 16 + maskWords * 4); // chunk stream
	for (let i = 0; i < maskWords; i++) w.u32(y + 16 + i * 4, 0xffffffff);
	w.b.set(data, y + 16 + maskWords * 4);
	return w.b;
}

describe('archive', () => {
	it('parses a cattbl archive and decodes PERS-SZP records', () => {
		const payload = persSzp(new Uint8Array([1, 2, 3, 4, 5]));
		const padded = Math.ceil(payload.length / 16) * 16;
		const w = new W(0x30 + padded);
		w.u32(8, 0x30 + padded);
		w.u32(12, 2);
		w.u32(0x10, 0x30); // record 0
		w.u32(0x14, padded);
		w.u32(0x20, 0); // record 1: empty
		w.b.set(payload, 0x30);
		const a = parseStadiumArchive(w.b)!;
		expect(a.records.map((r) => r.size)).toEqual([padded, 0]);
		expect(Array.from(decodeStadiumAsset(stadiumRecordBytes(w.b, a.records[0]!)))).toEqual([1, 2, 3, 4, 5]);
	});

	it('rejects tables that break the invariants', () => {
		const w = new W(0x40);
		w.u32(0, 1); // bad tag
		w.u32(8, 0x40);
		w.u32(12, 1);
		expect(parseStadiumArchive(w.b)).toBeNull();
	});
});

describe('fragment', () => {
	it('finds the root from the lui/addiu pair and zero-fills BSS', () => {
		const m = moduleFixture();
		expect(findModelRoot(m)).toBe(BASE + 0x100);
		const big = new Uint8Array(m);
		new DataView(big.buffer).setUint32(0x1c, 0x500);
		expect(fragmentImage(big).length).toBe(0x500);
	});
});

describe('buildStadiumModel', () => {
	it('draws joint-local vertices in the bind pose, with textures and UVs', () => {
		const m = buildStadiumModel(moduleFixture());
		expect(m.species).toBe(25);
		expect(m.bones).toHaveLength(1);
		expect(m.primitives).toHaveLength(1);
		const p = m.primitives[0]!;
		// Joint +10 Y, then root scale 0.5.
		expect(Array.from(p.positions)).toEqual([0, 5, 0, 2, 5, 0, 0, 7, 0]);
		expect(p.normals).not.toBeNull();
		expect(p.normals![2]).toBeCloseTo(1);
		// s/32 / width: 64/32/2 = 1; t: 32/32/1 = 1.
		expect(Array.from(p.uvs)).toEqual([0, 0, 1, 0, 0, 1]);
		expect(m.textures[0]!.width).toBe(2);
		expect(Array.from(m.textures[0]!.rgba)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	it('composes rotations Z·Y·X and accumulates scale', () => {
		const { draw } = stadiumBindMatrices([
			{ parent: -1, id: 0, translation: [0, 0, 0], rotation: [0, 0, 16384], scale: [2, 2, 2] },
			{ parent: 0, id: 1, translation: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
		]);
		// A 90° Z turn maps the child's +X offset (scaled ×2 by the parent) onto +Y.
		expect(draw[1]![3]).toBeCloseTo(0);
		expect(draw[1]![7]).toBeCloseTo(2);
	});
});

describe('texture', () => {
	it('decodes CI4 through the selected palette bank', () => {
		const d = new Uint8Array(0x100);
		d[0] = 0x10; // texels 1, 0
		// palette bank 1 (offset 32): entry 1 = opaque blue
		d[32 + 2] = 0x00;
		d[32 + 3] = 0x3f;
		const px = decodeStadiumTexture(d, { fmt: 2, siz: 0, width: 2, height: 1, data: 0 }, 0, 1);
		expect(Array.from(px.subarray(0, 4))).toEqual([0, 0, 255, 255]);
	});
});

describe('names', () => {
	it('labels the model-table records', () => {
		expect(STADIUM2_SPECIES).toHaveLength(252);
		expect(stadium2ModelName(25)).toBe('Pikachu');
		expect(stadium2ModelName(251)).toBe('Celebi');
		expect(stadium2ModelName(201)).toBe('Unown A');
		expect(stadium2ModelName(254)).toBe('Unown B');
		expect(stadium2ModelName(252)).toBe('Substitute');
		expect(stadium2ModelName(0)).toBeNull();
	});
});
