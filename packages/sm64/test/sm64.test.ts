import { describe, expect, it } from 'vitest';
import {
	buildSm64Geo,
	findSm64AnimationTables,
	findSm64Animations,
	findSm64Entry,
	sm64MarioPoseOptions,
	sm64ModelName,
	walkSm64Scripts,
	type Sm64GeoNode,
} from '../src/index.js';

/**
 * A ROM with `level_script_entry` at 0x100, which loads 0x400–0x600 raw
 * into segment 7, registers model 0x17 from a geo layout at 0x07000000
 * and an area from the same layout, then exits. The geo layout
 * translates +10 Y and draws one triangle.
 */
function romFixture(): Uint8Array {
	const rom = new Uint8Array(0x800);
	const dv = new DataView(rom.buffer);
	let o = 0x100;
	const w = (...words: number[]) => words.forEach((x) => (dv.setUint32(o, x >>> 0), (o += 4)));
	w(0x1b040000, 0x03040002, 0x34040000, 0x13040000); // entry opening
	// EXECUTE(0x14, …) is part of the signature; point it at a tiny script.
	w(0x00100014, 0x00000200, 0x00000300, 0x14000000);
	// script at 0x200 (segment 0x14): LOAD_RAW(7, 0x400, 0x600); LOAD_MODEL_FROM_GEO(0x17, 0x07000000); AREA(1, 0x07000000); EXIT
	o = 0x200;
	w(0x170c0007, 0x400, 0x600, 0x22080017, 0x07000000, 0x1f080100, 0x07000000, 0x02040000);
	// geo at 0x400: GEO_TRANSLATE_WITH_DL(layer 1, 0, 10, 0, dl); GEO_END
	o = 0x400;
	w(0x10910000, 0x000a0000, 0x07000040, 0x01000000);
	// dl at 0x440 (F3D): G_VTX 3 @ 0 (0x04 | (n-1)<<4), G_TRI1 0 10 20 ×10, G_ENDDL
	o = 0x440;
	w(0x04200030, 0x07000080, 0xbf000000, 0x00000a14, 0xb8000000, 0);
	[[0, 0, 0], [4, 0, 0], [0, 4, 0]].forEach(([x, y, z], i) => {
		dv.setInt16(0x480 + i * 16, x!);
		dv.setInt16(0x482 + i * 16, y!);
		dv.setInt16(0x484 + i * 16, z!);
	});
	return rom;
}

describe('level scripts', () => {
	it('finds the entry and records models and areas with their segments', () => {
		const rom = romFixture();
		expect(findSm64Entry(rom)).toBe(0x100);
		const w = walkSm64Scripts(rom)!;
		expect(w.models).toHaveLength(1);
		expect(w.models[0]).toMatchObject({ modelId: 0x17, geo: 0x07000000 });
		expect(w.models[0]!.segments.get(7)).toEqual({ romStart: 0x400, romEnd: 0x600, mio0: false });
		expect(w.areas).toHaveLength(1);
	});
});

describe('geo layouts', () => {
	it('draws display lists under their transform nodes', () => {
		const rom = romFixture();
		const w = walkSm64Scripts(rom)!;
		const m = buildSm64Geo(rom, w.models[0]!.segments, 0x07000000);
		expect(Array.from(m.positions)).toEqual([0, 10, 0, 4, 10, 0, 0, 14, 0]);
	});
});

describe('animations', () => {
	it('finds an animation by its index-to-header gap and samples frame 0', () => {
		// segment 5: values at 0x00, index at 0x10 (1 part → 6 channels × 4 bytes), header at 0x28
		const b = new Uint8Array(0x60);
		const dv = new DataView(b.buffer);
		[0, 0, 0, 100, 200, 300].forEach((v, i) => dv.setInt16(i * 2, v));
		for (let k = 0; k < 6; k++) {
			dv.setUint16(0x10 + k * 4, 1); // maxFrame
			dv.setUint16(0x12 + k * 4, k); // offset
		}
		dv.setUint32(0x28 + 0x0c, 0x05000000);
		dv.setUint32(0x28 + 0x10, 0x05000010);
		const [a] = findSm64Animations(b, 5, 1);
		expect(a!.offset).toBe(0x28);
		expect(Array.from(a!.channels)).toEqual([0, 0, 0, 100, 200, 300]);
	});
});

/**
 * Segment 7 at ROM 0: `geo` words at 0, one triangle display list at
 * 0x200 (vertices at 0x280: (0,0,0) (4,0,0) (0,4,0)), a second at 0x240
 * drawing the same triangle shifted +100 X.
 */
function geoFixture(geo: number[]) {
	const rom = new Uint8Array(0x400);
	const dv = new DataView(rom.buffer);
	geo.forEach((w, i) => dv.setUint32(i * 4, w >>> 0));
	[0x04200030, 0x07000280, 0xbf000000, 0x00000a14, 0xb8000000, 0].forEach((w, i) => dv.setUint32(0x200 + i * 4, w));
	[0x04200030, 0x070002c0, 0xbf000000, 0x00000a14, 0xb8000000, 0].forEach((w, i) => dv.setUint32(0x240 + i * 4, w));
	[[0, 0, 0], [4, 0, 0], [0, 4, 0]].forEach(([x, y, z], i) => {
		dv.setInt16(0x280 + i * 16, x!);
		dv.setInt16(0x282 + i * 16, y!);
		dv.setInt16(0x284 + i * 16, z!);
		dv.setInt16(0x2c0 + i * 16, x! + 100);
		dv.setInt16(0x2c2 + i * 16, y!);
		dv.setInt16(0x2c4 + i * 16, z!);
	});
	return { rom, segments: new Map([[7, { romStart: 0, romEnd: 0x400, mio0: false }]]) };
}

describe('geo layout semantics', () => {
	it('drops the scale above a billboard but keeps its position', () => {
		// SCALE(0.25) { BILLBOARD(0, 40, 0) { DISPLAY_LIST } }
		const { rom, segments } = geoFixture([0x1d000000, 0x00004000, 0x04000000, 0x14000000, 0x00280000, 0x04000000, 0x15040000, 0x07000200, 0x05000000, 0x05000000, 0x01000000]);
		const m = buildSm64Geo(rom, segments, 0x07000000);
		expect(Array.from(m.positions)).toEqual([0, 10, 0, 4, 10, 0, 0, 14, 0]);
	});

	it('draws only the nearest of sibling render ranges, and the chosen switch case', () => {
		// NODE_START { RENDER_RANGE(0, 500) { DL A } RENDER_RANGE(500, 9000) { DL B } }
		const ranges = geoFixture([0x0b000000, 0x04000000, 0x0d000000, 0x000001f4, 0x04000000, 0x15010000, 0x07000200, 0x05000000, 0x0d000000, 0x01f42328, 0x04000000, 0x15010000, 0x07000240, 0x05000000, 0x05000000, 0x01000000]);
		expect(buildSm64Geo(ranges.rom, ranges.segments, 0x07000000).positions[0]).toBe(0);
		// SWITCH_CASE { DL A, DL B }
		const sw = geoFixture([0x0e000002, 0x80000000, 0x04000000, 0x15010000, 0x07000200, 0x15010000, 0x07000240, 0x05000000, 0x01000000]);
		expect(buildSm64Geo(sw.rom, sw.segments, 0x07000000).positions[0]).toBe(0);
		expect(buildSm64Geo(sw.rom, sw.segments, 0x07000000, { selectCase: () => 1 }).positions[0]).toBe(100);
	});

	it('poses animated parts and re-poses them per frame', () => {
		// ANIMATED_PART(layer 1, 0, 0, 0, DL A)
		const { rom, segments } = geoFixture([0x13010000, 0x00000000, 0x07000200, 0x01000000]);
		// Two frames: part rotation Z goes 0 → 0x4000 (90°).
		const values = Int16Array.from([0, 0, 0x4000]);
		const index = Uint16Array.from([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 1]);
		const animation = { offset: 0, flags: 0, animYTransDivisor: 0, startFrame: 0, loopStart: 0, frames: 2, parts: 1, channels: new Int16Array(6), values, index };
		const m = buildSm64Geo(rom, segments, 0x07000000, { animation });
		expect(m.posed).toBe(true);
		expect(Array.from(m.positions.slice(3, 6))).toEqual([4, 0, 0]);
		const out = new Float32Array(m.positions.length);
		m.animator.pose(animation, 1, out);
		expect(Array.from(out.slice(3, 6)).map((v) => Math.round(v))).toEqual([0, 4, 0]);
	});
});

describe('animation tables', () => {
	it('lists a table in order, with clips of another part count as holes', () => {
		const b = new Uint8Array(0x100);
		const dv = new DataView(b.buffer);
		// One-part clip: values 0x00, index 0x10 (24 bytes), header 0x28.
		for (let k = 0; k < 6; k++) dv.setUint16(0x10 + k * 4, 1);
		dv.setUint32(0x28 + 0x0c, 0x05000000);
		dv.setUint32(0x28 + 0x10, 0x05000010);
		// A stub header at 0x40 with valid-looking pointers.
		dv.setUint32(0x40 + 0x0c, 0x05000000);
		dv.setUint32(0x40 + 0x10, 0x05000004);
		// Table at 0x60: [clip, stub, clip].
		[0x05000028, 0x05000040, 0x05000028].forEach((p, i) => dv.setUint32(0x60 + i * 4, p));
		const anims = findSm64Animations(b, 5, 1);
		const [t] = findSm64AnimationTables(b, 5, anims);
		expect(t!.offset).toBe(0x60);
		expect(t!.animations.map((a) => a?.offset ?? null)).toEqual([0x28, null, 0x28]);
	});
});

describe('names', () => {
	it('names models by group, then level, then ID', () => {
		expect(sm64ModelName({ modelId: 0x56, level: 9, group: 4 })).toBe('king_bobomb');
		expect(sm64ModelName({ modelId: 0x55, level: 16, group: 11 })).toBe('yoshi');
		expect(sm64ModelName({ modelId: 0x36, level: 9 })).toBe('chain_chomp_gate');
		expect(sm64ModelName({ modelId: 0x74, level: 9 })).toBe('yellow_coin');
		expect(sm64ModelName({ modelId: 0x56, level: 9 })).toBeNull();
	});
});

describe('Mario', () => {
	const node = (cmd: number, children: Sm64GeoNode[] = []): Sm64GeoNode => ({ cmd, addr: 0, layer: 0, dl: null, translation: null, rotation: null, scale: null, fn: null, param: 0, range: null, children });
	it('picks the metal body, the capless head and the wing cap wings by shape', () => {
		const capOnOff = node(0x0e, [node(0x0e), node(0x0e)]);
		const wing = node(0x10);
		const head = node(0x12, [capOnOff, wing]);
		const effect = node(0x0e, [node(0x13), node(0x13), node(0x13), node(0x13)]);
		const metal = sm64MarioPoseOptions('metal');
		expect(metal.selectCase!(effect, [])).toBe(2);
		expect(metal.hide!(wing, [head])).toBe(true);
		const capless = sm64MarioPoseOptions('cap-off');
		expect(capless.selectCase!(capOnOff, [head])).toBe(1);
		expect(sm64MarioPoseOptions('wing-cap').hide!(wing, [head])).toBe(false);
	});
});
