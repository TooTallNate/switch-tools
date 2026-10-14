import { describe, expect, it } from 'vitest';
import { buildSm64Geo, findSm64Animations, findSm64Entry, walkSm64Scripts } from '../src/index.js';

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
