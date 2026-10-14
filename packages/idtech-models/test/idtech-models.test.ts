import { describe, expect, it } from 'vitest';

import { Md5Pose, parseBmd5anim, parseBmd5mesh, parseBproc, parseBrm, sampleBmd5anim } from '../src/index.js';

/** Writer for BFG's mixed-endian binary files. */
class W {
	parts: number[] = [];
	u8(v: number) { this.parts.push(v & 0xff); return this; }
	bool(v: boolean) { return this.u8(v ? 1 : 0); }
	i32be(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, false); this.parts.push(...b); return this; }
	u32be(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, false); this.parts.push(...b); return this; }
	u16be(v: number) { this.parts.push((v >> 8) & 0xff, v & 0xff); return this; }
	f32be(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, false); this.parts.push(...b); return this; }
	f32le(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.parts.push(...b); return this; }
	i32le(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.parts.push(...b); return this; }
	time() { return this.u32be(0).u32be(0x5cc8c70b); }
	str(s: string) { this.i32le(s.length); for (const c of s) this.u8(c.charCodeAt(0)); return this; }
	bytes() { return new Uint8Array(this.parts); }
}

const HALF_HALF = 0x3800; // 0.5
const HALF_ONE = 0x3c00;

/** idDrawVert: position, half UV, normal, tangent, colour, colour2. */
function vert(w: W, p: number[], bigXyz: boolean, color = [255, 255, 255, 255], color2 = [0, 0, 0, 0]) {
	for (const v of p) (bigXyz ? w.f32be(v) : w.f32le(v));
	w.u16be(HALF_HALF).u16be(HALF_ONE);
	[128, 128, 255, 0].forEach((b) => w.u8(b));
	[255, 128, 128, 255].forEach((b) => w.u8(b));
	color.forEach((b) => w.u8(b));
	color2.forEach((b) => w.u8(b));
}

/** Static BRMl model with one triangle surface (or none). */
function writeStatic(w: W, withTri: boolean) {
	w.u32be(0x42524d6c).time();
	w.i32be(withTri ? 1 : 0);
	if (withTri) {
		w.i32be(0).str('textures/test/wall').bool(true);
		[0, 0, 0, 1, 1, 1].forEach((v) => w.f32le(v));
		w.i32be(0).bool(false).bool(true).bool(false).bool(false);
		w.i32be(3).i32be(3);
		vert(w, [0, 0, 0], false);
		vert(w, [1, 0, 0], false);
		vert(w, [0, 1, 0], false);
		w.i32be(0); // shadow verts
		w.i32be(3).u16be(0).u16be(1).u16be(2);
		w.i32be(0); // sil indexes
		w.i32be(0).i32be(0).i32be(0); // mirrored, dup, sil edges
		w.bool(false); // dominant tris
		w.i32be(0).i32be(0).i32be(0);
	}
	[0, 0, 0, 1, 1, 1].forEach((v) => w.f32le(v));
	w.i32be(0).i32be(0).i32be(0).str('models/test.lwo');
	for (let i = 0; i < 9; i++) w.bool(false);
}

describe('BRMl static models', () => {
	it('reads a surface', () => {
		const w = new W();
		writeStatic(w, true);
		const m = parseBrm(w.bytes());
		expect(m.name).toBe('models/test.lwo');
		expect(m.surfaces).toHaveLength(1);
		const s = m.surfaces[0]!;
		expect(s.material).toBe('textures/test/wall');
		expect([...s.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		expect([...s.indices]).toEqual([0, 1, 2]);
		expect(s.uvs[0]).toBe(0.5);
		expect(s.uvs[1]).toBe(1);
		expect(s.normals[2]).toBeCloseTo(1);
	});

	it('rejects other data', () => {
		expect(() => parseBrm(new Uint8Array(64))).toThrow();
	});
});

/** MD5 mesh: 2 joints (root, child 10 units up Z), one triangle; vertex 2 follows joint 1. */
function writeMd5(): Uint8Array {
	const w = new W();
	writeStatic(w, false);
	w.u32be(0x35444d6a);
	w.i32be(2).str('origin').i32be(-1).str('arm').i32be(0);
	w.i32be(2);
	[0, 0, 0, 1].forEach((v) => w.f32be(v));
	[0, 0, 0].forEach((v) => w.f32le(v));
	[0, 0, 0, 1].forEach((v) => w.f32be(v));
	[0, 0, 10].forEach((v) => w.f32le(v));
	w.i32be(2);
	[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].forEach((v) => w.f32be(v));
	[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -10].forEach((v) => w.f32be(v));
	w.i32be(1).str('models/test/skin');
	w.i32be(3).i32be(1).i32be(2).u8(0).u8(1).f32be(10);
	w.i32be(3).i32be(3).i32be(3).i32be(0).i32be(0).i32be(0);
	vert(w, [0, 0, 0], true, [0, 0, 0, 0], [255, 0, 0, 0]);
	vert(w, [1, 0, 0], true, [0, 0, 0, 0], [255, 0, 0, 0]);
	vert(w, [0, 0, 10], true, [1, 0, 0, 0], [255, 0, 0, 0]);
	w.u16be(0).u16be(1).u16be(2);
	w.u16be(0).u16be(1).u16be(2); // sil indexes
	w.i32be(0); // surfaceNum
	return w.bytes();
}

/** Anim: 2 frames; joint "arm" rotates 90° about X on frame 1 (qx animated). */
function writeAnim(): Uint8Array {
	const w = new W();
	w.u32be(0x424d4465).time();
	w.i32be(2).i32be(24).i32be(83).i32be(2).i32be(1);
	w.i32be(2);
	for (let i = 0; i < 12; i++) w.f32be(0);
	w.i32be(2).str('origin').i32be(-1).i32be(0).i32be(0).str('arm').i32be(0).i32be(8).i32be(0);
	w.i32be(2);
	[0, 0, 0, 1].forEach((v) => w.f32be(v));
	[0, 0, 0].forEach((v) => w.f32le(v));
	[0, 0, 0, 1].forEach((v) => w.f32be(v));
	[0, 0, 10].forEach((v) => w.f32le(v));
	w.i32be(2).f32le(0).f32le(Math.SQRT1_2).f32le(0); // + pad
	[0, 0, 0].forEach((v) => w.f32le(v));
	return w.bytes();
}

describe('MD5 meshes and animations', () => {
	it('reads joints, the inverse bind and skinned verts', () => {
		const m = parseBmd5mesh(writeMd5());
		expect(m.joints.map((j) => j.name)).toEqual(['origin', 'arm']);
		expect(m.defaultPose[1]!.t).toEqual([0, 0, 10]);
		expect(m.invertedDefaultPose[1]![11]).toBe(-10);
		const mesh = m.meshes[0]!;
		expect(mesh.material).toBe('models/test/skin');
		expect([...mesh.indices]).toEqual([0, 1, 2]);
		expect(mesh.joints[8]).toBe(1);
		expect(mesh.weights[8]).toBeCloseTo(1);
	});

	it('skins the bind pose back onto itself', () => {
		const m = parseBmd5mesh(writeMd5());
		const pose = new Md5Pose(m);
		const out = new Float32Array(9);
		pose.skin(m.meshes[0]!, out, null);
		expect([...out].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 10]);
	});

	it('samples animated components and poses the mesh', () => {
		const a = parseBmd5anim(writeAnim());
		expect(a.numFrames).toBe(2);
		expect(a.frameRate).toBe(24);
		const f1 = sampleBmd5anim(a, 1);
		expect(f1[1]!.q[0]).toBeCloseTo(Math.SQRT1_2);
		expect(f1[1]!.q[3]).toBeCloseTo(Math.SQRT1_2);
		const m = parseBmd5mesh(writeMd5());
		const pose = new Md5Pose(m);
		pose.setPose(a, 0);
		const out = new Float32Array(9);
		pose.skin(m.meshes[0]!, out, null);
		expect(out[8]).toBeCloseTo(10); // frame 0 = rest
		// Bind vertex (0, 0, 10) sits at the arm joint's origin, so it doesn't move.
		pose.setPose(a, 1);
		pose.skin(m.meshes[0]!, out, null);
		expect(out[8]).toBeCloseTo(10);
		expect(pose.world[1]![5]).toBeCloseTo(0); // rotated 90° about X
	});
});

describe('.bproc', () => {
	it('reads models around portal and node blocks', () => {
		const w = new W();
		w.u32be(0x50524f01).i32be(3).str('maps/test.map').time();
		w.str('interAreaPortals').i32be(2).i32be(1).i32be(1).i32be(0).i32be(1);
		[0, 0, 0].forEach((v) => w.f32be(v));
		w.str('shadowModel').str('_area0');
		writeStatic(w, true);
		w.str('nodes').i32be(1);
		for (let i = 0; i < 4; i++) w.f32be(0);
		w.i32be(0).i32be(0);
		const p = parseBproc(w.bytes());
		expect(p.mapName).toBe('maps/test.map');
		expect(p.models.map((m) => m.entryName)).toEqual(['_area0']);
		expect(p.models[0]!.surfaces[0]!.indices.length).toBe(3);
	});
});
