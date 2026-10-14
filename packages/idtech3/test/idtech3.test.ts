import { describe, expect, it } from 'vitest';

import { isGlmHelperSurface, parseBsp, parseGlm, parseMd3, parseSkin } from '../src/index.js';

class W {
	buf = new Uint8Array(4096);
	dv = new DataView(this.buf.buffer);
	str(o: number, s: string) {
		for (let i = 0; i < s.length; i++) this.buf[o + i] = s.charCodeAt(i);
	}
	i32(o: number, v: number) {
		this.dv.setInt32(o, v, true);
	}
	i16(o: number, v: number) {
		this.dv.setInt16(o, v, true);
	}
	f32(o: number, v: number) {
		this.dv.setFloat32(o, v, true);
	}
}

describe('MD3', () => {
	it('reads a surface at frame 0', () => {
		const w = new W();
		w.str(0, 'IDP3');
		w.i32(4, 15);
		w.str(8, 'crate.md3');
		w.i32(76, 1); // frames
		w.i32(84, 1); // surfaces
		w.i32(92, 108); // ofsFrames
		w.i32(100, 200); // ofsSurfaces
		const s = 200;
		w.str(s, 'IDP3');
		w.str(s + 4, 'box');
		w.i32(s + 72, 1);
		w.i32(s + 76, 1); // shaders
		w.i32(s + 80, 3); // verts
		w.i32(s + 84, 1); // tris
		w.i32(s + 88, 108); // ofsTris
		w.i32(s + 92, 120); // ofsShaders
		w.i32(s + 96, 188); // ofsSt
		w.i32(s + 100, 212); // ofsXyz
		w.i32(s + 104, 236); // ofsEnd
		[0, 1, 2].forEach((v, i) => w.i32(s + 108 + i * 4, v));
		w.str(s + 120, 'models/box.tga');
		[0, 0, 1, 0, 0, 1].forEach((v, i) => w.f32(s + 188 + i * 4, v));
		[[0, 0, 0], [64, 0, 0], [0, 128, 0]].forEach((p, v) => p.forEach((c, k) => w.i16(s + 212 + v * 8 + k * 2, c)));
		const m = parseMd3(w.buf);
		expect(m.surfaces).toHaveLength(1);
		expect(m.surfaces[0]!.shader).toBe('models/box.tga');
		expect([...m.surfaces[0]!.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 2, 0]);
		expect([...m.surfaces[0]!.indices]).toEqual([0, 1, 2]);
	});
});

describe('Ghoul2 GLM', () => {
	it('reads surfaces, shaders and packed weights', () => {
		const w = new W();
		w.str(0, '2LGM');
		w.i32(4, 6);
		w.str(72, 'models/players/_humanoid/_humanoid');
		w.i32(140, 2); // bones
		w.i32(144, 1); // lods
		w.i32(148, 600); // ofsLODs
		w.i32(152, 1); // surfaces
		// Hierarchy offset table at 164 → entry at 168.
		w.i32(164, 4);
		w.str(168, 'torso');
		w.str(168 + 68, 'models/players/kyle/torso.tga');
		w.i32(168 + 136, -1);
		// LOD at 600: ofsEnd, then offsets table at 604 → surface at 608.
		w.i32(600, 1000);
		w.i32(604, 4);
		const s = 608;
		w.str(s, '2LGM');
		w.i32(s + 4, 0);
		w.i32(s + 12, 1); // verts
		w.i32(s + 16, 40); // ofsVerts
		w.i32(s + 20, 0);
		w.i32(s + 28, 2); // bone refs
		w.i32(s + 32, 120);
		const v = s + 40;
		w.f32(v + 20, 3); // z
		// Two weights: refs 1 and 0; first weight 0x2ff / 1023 (top bits in packed word).
		const packed = (1 << 30) | (1 << 0) | (0 << 5) | (2 << 20);
		w.dv.setUint32(v + 24, packed >>> 0, true);
		w.buf[v + 28] = 0xff;
		w.f32(v + 32, 0.25); // uv
		w.i32(s + 120, 5);
		w.i32(s + 124, 7);
		const g = parseGlm(w.buf);
		expect(g.animName).toBe('models/players/_humanoid/_humanoid');
		const surf = g.surfaces[0]!;
		expect(surf.name).toBe('torso');
		expect(surf.positions[2]).toBe(3);
		expect(surf.uvs[0]).toBe(0.25);
		expect([...surf.boneIndices.subarray(0, 2)]).toEqual([7, 5]);
		expect(surf.boneWeights[0]).toBeCloseTo(0x2ff / 1023);
		expect(surf.boneWeights[0]! + surf.boneWeights[1]!).toBeCloseTo(1);
		expect(isGlmHelperSurface({ name: '*head_cap', flags: 0 })).toBe(true);
	});
});

describe('.skin', () => {
	it('maps surfaces to textures', () => {
		const s = parseSkin('hips,models/players/kyle/kyle_legs.tga\r\nhead_cap,*off\n');
		expect(s.get('hips')).toBe('models/players/kyle/kyle_legs.tga');
		expect(s.get('head_cap')).toBe('*off');
	});
});

describe('BSP', () => {
	it('reads planar surfaces of a Quake III IBSP', () => {
		const w = new W();
		w.str(0, 'IBSP');
		w.i32(4, 46);
		const lump = (i: number, ofs: number, len: number) => {
			w.i32(8 + i * 8, ofs);
			w.i32(12 + i * 8, len);
		};
		lump(1, 200, 72);
		w.str(200, 'textures/base/floor');
		lump(10, 300, 3 * 44);
		[[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((p, v) => {
			p.forEach((c, k) => w.f32(300 + v * 44 + k * 4, c));
			w.f32(300 + v * 44 + 28 + 8, 1); // normal z
		});
		lump(11, 500, 12);
		[0, 1, 2].forEach((x, i) => w.i32(500 + i * 4, x));
		lump(13, 600, 104);
		w.i32(600, 0);
		w.i32(608, 1); // planar
		w.i32(612, 0);
		w.i32(616, 3);
		w.i32(620, 0);
		w.i32(624, 3);
		const b = parseBsp(w.buf);
		expect(b.variant).toBe('IBSP');
		expect(b.surfaces).toHaveLength(1);
		expect(b.surfaces[0]!.shader).toBe('textures/base/floor');
		expect([...b.surfaces[0]!.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		expect(b.surfaces[0]!.normals[2]).toBe(1);
	});
});
