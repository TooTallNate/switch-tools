import { describe, expect, it } from 'vitest';
import { applyPose, BattleAnimator, buildBattleMesh, buildFieldMesh, decompressLzs, parseBattleModel, parseBcx } from '../src/index.js';

/** Store `raw` as an all-literal FF7 LZSS stream (control byte 0xFF per 8 bytes). */
function lzsStore(raw: Uint8Array): Uint8Array {
	const body: number[] = [];
	for (let i = 0; i < raw.length; i += 8) {
		body.push(0xff, ...raw.subarray(i, i + 8));
	}
	const out = new Uint8Array(4 + body.length);
	new DataView(out.buffer).setUint32(0, body.length, true);
	out.set(body, 4);
	return out;
}

/** Battle model: one bone (length 100) carrying one coloured triangle; a zeroed 1-frame animation. */
function battleModel(rootMesh = false): Uint8Array {
	const b = new Uint8Array(0x100);
	const dv = new DataView(b.buffer);
	const S = 0x10;
	dv.setUint32(0, 3, true);
	dv.setUint32(4, S, true);
	dv.setUint32(8, 0x80, true);
	dv.setUint32(12, 0x90, true);
	dv.setUint32(S, rootMesh ? 0 : 1, true); // bone count
	const M = 0x30;
	if (rootMesh) {
		dv.setUint32(S + 8, M - S, true); // root record's mesh
	} else {
		dv.setUint16(S + 0xc, 0, true); // parent = root
		dv.setInt16(S + 0xe, 100, true);
		dv.setUint32(S + 0x10, M - S, true);
	}
	dv.setUint32(M, 24, true);
	[[0, 0, 0], [10, 0, 0], [0, -20, 5]].forEach(([x, y, z], i) => {
		dv.setInt16(M + 4 + i * 8, x, true);
		dv.setInt16(M + 6 + i * 8, y, true);
		dv.setInt16(M + 8 + i * 8, z, true);
	});
	let p = M + 4 + 24;
	const group = (count: number) => {
		dv.setUint16(p, count, true);
		p += 4;
	};
	group(0); // textured triangles
	group(0); // textured quads
	group(1); // coloured triangles
	dv.setUint16(p, 0, true);
	dv.setUint16(p + 2, 8, true);
	dv.setUint16(p + 4, 16, true);
	b.set([255, 0, 0, 0x30, 0, 255, 0, 0x30, 0, 0, 255, 0x30], p + 8);
	p += 0x14;
	group(0); // coloured quads
	dv.setUint16(0x90, 1, true); // frames
	dv.setUint16(0x92, 16, true); // stream size
	return b;
}

describe('battle models', () => {
	it('parses and poses a battle model', () => {
		const raw = decompressLzs(lzsStore(battleModel()));
		const model = parseBattleModel(raw);
		expect(model.bones).toEqual([{ parent: 0, length: 100, mesh: 0x30 }]);
		expect(model.animations).toEqual([0x90]);
		const mesh = buildBattleMesh(raw, model);
		expect(mesh.indices.length).toBe(3);
		expect(mesh.groups).toEqual([{ texture: -1, firstIndex: 0, indexCount: 3 }]);
		// PSX Y-down → Y-up (y and z negated).
		expect([...mesh.positions]).toEqual([0, -0, -0, 10, -0, -0, 0, 20, -5]);
		expect([...mesh.colors.subarray(0, 3)]).toEqual([1, 0, 0]);
	});

	it('renders single-mesh models whose root record carries the mesh', () => {
		const raw = battleModel(true);
		const model = parseBattleModel(raw);
		expect(model.bones).toEqual([]);
		expect(model.rootMesh).toBe(0x30);
		expect(buildBattleMesh(raw, model).indices.length).toBe(3);
	});

	it('decodes animation deltas and re-poses the mesh', () => {
		const raw = battleModel();
		// Two frames, no compression. Frame 0: zero translation + 2 × 3 zero
		// angles. Frame 1: zero translation deltas (flag 0 + 7 bits each),
		// root angles unchanged, bone 1 rx += 1 (flag 1, category 1, bit 0), ry/rz unchanged.
		const bits = '0'.repeat(48 + 72) + '0'.repeat(24) + '000' + '1' + '001' + '0' + '00';
		const stream = new Uint8Array(Math.ceil(bits.length / 8));
		for (let i = 0; i < bits.length; i++) if (bits[i] === '1') stream[i >> 3] |= 0x80 >> (i & 7);
		const dv = new DataView(raw.buffer);
		dv.setUint16(0x90, 2, true);
		dv.setUint16(0x92, stream.length, true);
		raw.set(stream, 0x95);
		const model = parseBattleModel(raw);
		const animator = new BattleAnimator(raw, model);
		expect(animator.clips).toEqual([{ name: 'Animation 0', frames: 2 }]);
		expect(animator.pose(0, 0).R[1][4]).toBeCloseTo(1);
		const turn = (Math.PI * 2) / 4096;
		expect(animator.pose(0, 1).R[1][4]).toBeCloseTo(Math.cos(turn), 10);
		expect(animator.pose(0, 1).R[1][7]).toBeCloseTo(Math.sin(turn), 10);
		// Re-posing writes new positions from the bone-local copies.
		const mesh = buildBattleMesh(raw, model);
		const before = [...mesh.positions];
		applyPose(mesh, animator.pose(0, 1));
		expect([...mesh.positions]).not.toEqual(before);
		applyPose(mesh, animator.pose(0, 0));
		expect([...mesh.positions].map((v) => Math.round(v * 1e4) / 1e4)).toEqual(before.map((v) => Math.round(v * 1e4) / 1e4));
	});

	it('rejects other data', () => {
		expect(() => parseBattleModel(new Uint8Array(64))).toThrow();
	});
});

describe('field models (BCX)', () => {
	it('parses and builds a BCX with one flat-coloured triangle', () => {
		const b = new Uint8Array(0xc0);
		const dv = new DataView(b.buffer);
		dv.setUint32(0, b.length, true);
		dv.setUint32(4, 8, true); // H
		b[8 + 2] = 1; // bones
		b[8 + 3] = 1; // parts
		b[8 + 4] = 0; // anims
		dv.setUint16(8 + 0x18, 4, true); // parts after the 4-byte bone
		dv.setUint16(8 + 0x1a, 0x24, true);
		dv.setUint32(8 + 0x1c, 0x80000040, true); // bones at 0x40
		dv.setInt16(0x40, 50, true); // length
		dv.setInt8(0x42, -1); // root
		const part = 0x44;
		b[part + 1] = 0; // bone
		b[part + 2] = 3; // vertices
		b[part + 8] = 1; // one flat triangle (0x20)
		dv.setUint16(part + 0x0e, 4 + 3 * 8, true);
		dv.setUint32(part + 0x18, 0x80000080, true);
		[[0, 0, 0], [8, 0, 0], [0, 8, 0]].forEach(([x, y, z], i) => {
			dv.setInt16(0x84 + i * 8, x, true);
			dv.setInt16(0x86 + i * 8, y, true);
			dv.setInt16(0x88 + i * 8, z, true);
		});
		b.set([0, 1, 2, 0, 0, 0, 255, 0], 0x80 + 28);
		const model = parseBcx(b);
		expect(model.bones).toEqual([{ length: 50, parent: -1 }]);
		expect(model.parts).toHaveLength(1);
		const mesh = buildFieldMesh(b, model);
		expect(mesh.indices.length).toBe(3);
		// The root bone sits at its own length along Z (→ −50 after the Y-up flip).
		expect([...mesh.positions.subarray(0, 3)]).toEqual([0, -0, -50]);
		expect([...mesh.colors.subarray(0, 3)]).toEqual([0, 0, 1]);
	});
});
