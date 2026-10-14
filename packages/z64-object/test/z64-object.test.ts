import { describe, expect, it } from 'vitest';
import {
	OOT_OBJECT_NAMES,
	OOT_SCENE_NAMES,
	findZ64Animations,
	findZ64ObjectTable,
	findZ64Skeletons,
	parseZ64RoomShape,
	parseZ64SceneRooms,
	z64AnimationFrame,
	z64LimbMatrices,
} from '../src/index.js';

const S6 = (o: number) => 0x06000000 + o;

/**
 * A two-limb object: root at (0, 100, 0) with a child at +50 X that
 * carries a display list, plus an animation that turns the root 90°
 * about Z (so the child's +X offset points up).
 */
function objectFixture(): Uint8Array {
	const b = new Uint8Array(0x200);
	const dv = new DataView(b.buffer);
	const L0 = 0x40, L1 = 0x50, TABLE = 0x60, SKEL = 0x70, DL = 0x80, FRAMES = 0xa0, JOINTS = 0xc0, ANIM = 0xd4;
	// limbs: jointPos, child, sibling, dList
	dv.setInt16(L0 + 2, 100);
	b[L0 + 6] = 1;
	b[L0 + 7] = 0xff;
	dv.setInt16(L1, 50);
	b[L1 + 6] = 0xff;
	b[L1 + 7] = 0xff;
	dv.setUint32(L1 + 8, S6(DL));
	dv.setUint32(TABLE, S6(L0));
	dv.setUint32(TABLE + 4, S6(L1));
	dv.setUint32(SKEL, S6(TABLE));
	b[SKEL + 4] = 2;
	dv.setUint32(DL, 0xdf000000); // G_ENDDL
	// frame data: [0, 100, 16384]; joints: root (0,1,0), limb0 rot (0,0,2), limb1 (0,0,0)
	dv.setInt16(FRAMES + 2, 100);
	dv.setInt16(FRAMES + 4, 16384);
	const idx = [0, 1, 0, 0, 0, 2, 0, 0, 0];
	idx.forEach((v, i) => dv.setUint16(JOINTS + i * 2, v));
	dv.setInt16(ANIM, 1); // frameCount
	dv.setUint32(ANIM + 4, S6(FRAMES));
	dv.setUint32(ANIM + 8, S6(JOINTS));
	dv.setUint16(ANIM + 12, 3); // staticIndexMax: all static
	return b;
}

describe('skeletons', () => {
	it('finds a skeleton header structurally', () => {
		const [sk] = findZ64Skeletons(objectFixture());
		expect(sk).toMatchObject({ offset: 0x70, limbCount: 2, flexDListCount: null, limbs: [0x40, 0x50] });
	});

	it('poses limbs from an animation frame (T · Rz · Ry · Rx)', () => {
		const obj = objectFixture();
		const [sk] = findZ64Skeletons(obj);
		const [anim] = findZ64Animations(obj, sk!.limbCount);
		expect(anim!.offset).toBe(0xd4);
		const frame = z64AnimationFrame(obj, anim!, sk!.limbCount, 0);
		expect(Array.from(frame)).toEqual([0, 100, 0, 0, 0, 16384, 0, 0, 0]);
		const mats = z64LimbMatrices(obj, sk!, frame);
		// Root at (0, 100, 0); the child's +50 X, turned 90° about Z, points up.
		expect(Array.from(mats[0]!.slice(12, 15))).toEqual([0, 100, 0]);
		const child = Array.from(mats[1]!.slice(12, 15)).map((v) => Math.round(v));
		expect(child).toEqual([0, 150, 0]);
	});
});

describe('tables', () => {
	it('finds the object table by matching dmadata ranges', () => {
		const files = Array.from({ length: 60 }, (_, i) => ({ vromStart: 0x10000 + i * 0x1000, vromEnd: 0x10800 + i * 0x1000 }));
		const code = new Uint8Array(8 * 64);
		const dv = new DataView(code.buffer);
		files.forEach((f, i) => {
			dv.setUint32((i + 1) * 8, f.vromStart);
			dv.setUint32((i + 1) * 8 + 4, f.vromEnd);
		});
		const table = findZ64ObjectTable(code, files)!;
		expect(table[0]).toBeNull();
		expect(table[1]).toEqual(files[0]);
		expect(OOT_OBJECT_NAMES[1]).toBe('gameplay_keep');
		expect(OOT_SCENE_NAMES[0]).toBe('Deku Tree');
	});
});

describe('scenes', () => {
	it('reads a scene room list and a room mesh header', () => {
		const scene = new Uint8Array(0x40);
		const sv = new DataView(scene.buffer);
		sv.setUint32(0, 0x04010000); // rooms: count 1
		sv.setUint32(4, 0x02000020);
		sv.setUint32(8, 0x14000000); // end
		sv.setUint32(0x20, 0x1000);
		sv.setUint32(0x24, 0x2000);
		expect(parseZ64SceneRooms(scene)).toEqual([{ vromStart: 0x1000, vromEnd: 0x2000 }]);

		const room = new Uint8Array(0x60);
		const rv = new DataView(room.buffer);
		rv.setUint32(0, 0x0a000000); // mesh
		rv.setUint32(4, 0x03000010);
		rv.setUint32(8, 0x14000000);
		rv.setUint32(0x10, 0x00010000); // type 0, 1 entry
		rv.setUint32(0x14, 0x03000020);
		rv.setUint32(0x20, 0x03000040); // opa
		rv.setUint32(0x40, 0xdf000000);
		expect(parseZ64RoomShape(room)).toEqual({ type: 0, displayLists: [0x03000040], backgrounds: [] });
	});
});
