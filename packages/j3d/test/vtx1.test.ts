import { describe, expect, it } from 'vitest';

import {
	GxAttr,
	GxColorCompType,
	GxCompType,
	VTX1_FORMAT_ENTRY_SIZE,
	VTX1_SLOT_COUNT,
	parseJ3d,
	parseVtx1,
	vtx1Array,
	vtx1SlotForAttribute,
	type Vtx1,
} from '../src/index.js';
import {
	buildChunk,
	buildContainer,
	buildVtx1,
	f32Bytes,
	rgb565,
	s16Bytes,
	s8Bytes,
	u16Bytes,
	type ChunkOptions,
	type VtxArraySpec,
} from './fixtures.js';

/** Parse a standalone VTX1 chunk the way the container would hand it to us. */
function parse(specs: VtxArraySpec[], opts: ChunkOptions = {}): Vtx1 | null {
	const chunk = buildVtx1(specs, opts);
	return parseVtx1(chunk, { magic: 'VTX1', offset: 0, size: chunk.length });
}

const POS_XYZ_F32 = {
	attribute: GxAttr.POS,
	componentCount: 1,
	componentType: GxCompType.F32,
} as const;

describe('VTX1 header', () => {
	it('has 13 offset slots, indexed by attribute - GX_VA_POS', () => {
		// The layout assertion the whole slot-mapping argument rests on: the
		// header is one u32 for the format table plus 13 u32 slots, so the format
		// table lands at chunk-relative 0x40 in a freshly-built chunk.
		expect(VTX1_SLOT_COUNT).toBe(13);
		const chunk = buildVtx1([{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) }]);
		const view = new DataView(chunk.buffer);
		expect(view.getUint32(0x08, false)).toBe(0x40);
		// GX_VA_POS is slot 0, so its offset lives at chunk-relative 0x0C.
		expect(view.getUint32(0x0c, false)).toBe(
			0x40 + VTX1_FORMAT_ENTRY_SIZE * 2, // one entry plus the terminator
		);
	});

	it('puts each attribute in slot `attribute - 9`', () => {
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(1, 2, 3) },
			{
				attribute: GxAttr.NRM,
				componentCount: 0,
				componentType: GxCompType.F32,
				data: f32Bytes(0, 1, 0),
			},
			{
				attribute: GxAttr.CLR0,
				componentCount: 1,
				componentType: GxColorCompType.RGBA8,
				data: new Uint8Array([1, 2, 3, 4]),
			},
			{
				attribute: GxAttr.TEX0,
				componentCount: 1,
				componentType: GxCompType.F32,
				data: f32Bytes(0.25, 0.5),
			},
			{
				attribute: GxAttr.TEX7,
				componentCount: 1,
				componentType: GxCompType.F32,
				data: f32Bytes(0.75, 0.125),
			},
		]);
		expect(vtx1).not.toBeNull();
		// The NBT slot sits at index 2, so everything from CLR0 on is one slot
		// later than a naive `attribute - GX_VA_POS` would put it. Confirmed
		// against retail Wind Waker models, which declare POS/NRM/TEX0 and carry
		// their dataOffsets at indices 0, 1 and 5.
		expect(vtx1!.arrays.map((a) => [a.attribute, a.slot])).toEqual([
			[GxAttr.POS, 0],
			[GxAttr.NRM, 1],
			[GxAttr.CLR0, 3],
			[GxAttr.TEX0, 5],
			[GxAttr.TEX7, 12],
		]);
	});

	it('maps every attribute to its dataOffsets slot, skipping the NBT slot', () => {
		// Exhaustive statement of the mapping, so a regression here fails loudly
		// rather than silently dropping texture coordinates for a whole game.
		expect(vtx1SlotForAttribute(GxAttr.POS)).toBe(0);
		expect(vtx1SlotForAttribute(GxAttr.NRM)).toBe(1);
		// Slot 2 is NBT and has no GX attribute id of its own.
		expect(vtx1SlotForAttribute(GxAttr.CLR0)).toBe(3);
		expect(vtx1SlotForAttribute(GxAttr.CLR1)).toBe(4);
		expect(vtx1SlotForAttribute(GxAttr.TEX0)).toBe(5);
		expect(vtx1SlotForAttribute(GxAttr.TEX7)).toBe(12);
		// The matrix-index attributes have no vertex array at all.
		expect(vtx1SlotForAttribute(GxAttr.PNMTXIDX)).toBe(-1);
		expect(vtx1SlotForAttribute(GxAttr.NULL)).toBe(-1);
		// Exactly 13 slots, all distinct, all in range.
		const slots = [GxAttr.POS, GxAttr.NRM, GxAttr.CLR0, GxAttr.CLR1];
		for (let a = GxAttr.TEX0; a <= GxAttr.TEX7; a++) slots.push(a);
		const mapped = slots.map(vtx1SlotForAttribute);
		expect(new Set(mapped).size).toBe(mapped.length);
		expect(Math.max(...mapped)).toBe(VTX1_SLOT_COUNT - 1);
	});

	it('rejects a format table with no terminator', () => {
		const chunk = buildChunk('VTX1', (w) => {
			w.u32(0);
			const slots = w.length;
			for (let i = 0; i < 13; i++) w.u32(0);
			w.patchU32(0x08, w.length);
			// One entry, then the chunk simply ends.
			w.u32(GxAttr.POS).u32(1).u32(GxCompType.F32).u8(0).fill(3);
			w.patchU32(slots + 0, w.length);
			w.bytes(f32Bytes(0, 0, 0));
		});
		expect(parseVtx1(chunk, { magic: 'VTX1', offset: 0, size: chunk.length })).toBeNull();
	});

	it('rejects a format offset outside the chunk', () => {
		const chunk = buildChunk('VTX1', (w) => {
			w.u32(0xdeadbeef);
			for (let i = 0; i < 13; i++) w.u32(0);
		});
		expect(parseVtx1(chunk, { magic: 'VTX1', offset: 0, size: chunk.length })).toBeNull();
	});

	it('rejects a chunk too small to hold the header', () => {
		const chunk = buildChunk('VTX1', (w) => w.u32(0x40));
		expect(parseVtx1(chunk, { magic: 'VTX1', offset: 0, size: chunk.length })).toBeNull();
	});
});

describe('VTX1 positions', () => {
	it('reads f32 XYZ', () => {
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(1, 2, 3, -4, -5, -6) },
		]);
		const pos = vtx1Array(vtx1, GxAttr.POS)!;
		expect(pos.numComponents).toBe(3);
		expect(pos.elementSize).toBe(12);
		expect(pos.count).toBe(2);
		expect(Array.from(pos.values)).toEqual([1, 2, 3, -4, -5, -6]);
	});

	it('reads XY positions as two components', () => {
		const vtx1 = parse([
			{
				attribute: GxAttr.POS,
				componentCount: 0, // XY
				componentType: GxCompType.F32,
				data: f32Bytes(1, 2, 3, 4),
			},
		]);
		const pos = vtx1Array(vtx1, GxAttr.POS)!;
		expect(pos.numComponents).toBe(2);
		expect(pos.elementSize).toBe(8);
		expect(pos.count).toBe(2);
		expect(Array.from(pos.values)).toEqual([1, 2, 3, 4]);
	});

	it('divides s16 components by 2**decimalPoint', () => {
		// The classic 256x-too-big bug: raw 256 with 8 fractional bits is 1.0.
		const vtx1 = parse([
			{
				attribute: GxAttr.POS,
				componentCount: 1,
				componentType: GxCompType.S16,
				decimalPoint: 8,
				data: s16Bytes(256, 512, 128, 64, 1, 0),
			},
		]);
		const pos = vtx1Array(vtx1, GxAttr.POS)!;
		expect(pos.decimalPoint).toBe(8);
		expect(pos.count).toBe(2);
		expect(Array.from(pos.values)).toEqual([1, 2, 0.5, 0.25, 1 / 256, 0]);
	});

	it('ignores decimalPoint for f32 components', () => {
		const vtx1 = parse([
			{ ...POS_XYZ_F32, decimalPoint: 13, data: f32Bytes(1.5, 2.5, 3.5) },
		]);
		expect(Array.from(vtx1Array(vtx1, GxAttr.POS)!.values)).toEqual([
			1.5, 2.5, 3.5,
		]);
	});

	it('sign-extends s16 negatives', () => {
		const vtx1 = parse([
			{
				attribute: GxAttr.POS,
				componentCount: 1,
				componentType: GxCompType.S16,
				decimalPoint: 14,
				data: s16Bytes(-32768, -16384, 16384),
			},
		]);
		expect(Array.from(vtx1Array(vtx1, GxAttr.POS)!.values)).toEqual([-2, -1, 1]);
	});

	it('sign-extends s8 negatives', () => {
		const vtx1 = parse([
			{
				attribute: GxAttr.POS,
				componentCount: 1,
				componentType: GxCompType.S8,
				decimalPoint: 6,
				data: s8Bytes(-128, -64, 64),
			},
		]);
		expect(Array.from(vtx1Array(vtx1, GxAttr.POS)!.values)).toEqual([-2, -1, 1]);
	});

	it('treats u8 and u16 as unsigned', () => {
		const u8 = parse([
			{
				attribute: GxAttr.POS,
				componentCount: 1,
				componentType: GxCompType.U8,
				decimalPoint: 7,
				data: new Uint8Array([128, 255, 0]),
			},
		]);
		expect(Array.from(vtx1Array(u8, GxAttr.POS)!.values)).toEqual([
			1, 255 / 128, 0,
		]);
		const u16 = parse([
			{
				attribute: GxAttr.POS,
				componentCount: 1,
				componentType: GxCompType.U16,
				decimalPoint: 15,
				data: u16Bytes(32768, 65535, 0),
			},
		]);
		expect(Array.from(vtx1Array(u16, GxAttr.POS)!.values)).toEqual([
			1, 65535 / 32768, 0,
		]);
	});
});

describe('VTX1 normals and texture coordinates', () => {
	it('reads s16 normals with 14 fractional bits', () => {
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.NRM,
				componentCount: 0,
				componentType: GxCompType.S16,
				decimalPoint: 14,
				data: s16Bytes(16384, 0, 0, 0, -16384, 0),
			},
		]);
		const nrm = vtx1Array(vtx1, GxAttr.NRM)!;
		expect(nrm.numComponents).toBe(3);
		expect(nrm.count).toBe(2);
		expect(Array.from(nrm.values)).toEqual([1, 0, 0, 0, -1, 0]);
	});

	it('reads NBT normals as nine components', () => {
		const nine = f32Bytes(0, 1, 0, 1, 0, 0, 0, 0, 1);
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.NRM,
				componentCount: 1, // NBT
				componentType: GxCompType.F32,
				data: nine,
			},
		]);
		const nrm = vtx1Array(vtx1, GxAttr.NRM)!;
		expect(nrm.numComponents).toBe(9);
		expect(nrm.elementSize).toBe(36);
		expect(nrm.count).toBe(1);
		expect(Array.from(nrm.values.subarray(0, 3))).toEqual([0, 1, 0]);
	});

	it('reads ST and S-only texture coordinates', () => {
		const st = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.TEX0,
				componentCount: 1, // ST
				componentType: GxCompType.S16,
				decimalPoint: 8,
				data: s16Bytes(256, 512, 0, 256),
			},
		]);
		const tex = vtx1Array(st, GxAttr.TEX0)!;
		expect(tex.numComponents).toBe(2);
		expect(tex.count).toBe(2);
		expect(Array.from(tex.values)).toEqual([1, 2, 0, 1]);

		const sOnly = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.TEX0,
				componentCount: 0, // S
				componentType: GxCompType.F32,
				data: f32Bytes(0.5, 0.25),
			},
		]);
		const s = vtx1Array(sOnly, GxAttr.TEX0)!;
		expect(s.numComponents).toBe(1);
		expect(s.count).toBe(2);
	});
});

describe('VTX1 colours', () => {
	it('reads RGBA8 as normalised RGBA', () => {
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.CLR0,
				componentCount: 1,
				componentType: GxColorCompType.RGBA8,
				data: new Uint8Array([255, 0, 0, 255, 0, 128, 255, 64]),
			},
		]);
		const clr = vtx1Array(vtx1, GxAttr.CLR0)!;
		expect(clr.numComponents).toBe(4);
		expect(clr.elementSize).toBe(4);
		expect(clr.count).toBe(2);
		expect(Array.from(clr.values.subarray(0, 4))).toEqual([1, 0, 0, 1]);
		// Float32 rounding, so compare approximately for the fractional channels.
		expect(clr.values[4]).toBe(0);
		expect(clr.values[5]).toBeCloseTo(128 / 255, 6);
		expect(clr.values[6]).toBe(1);
		expect(clr.values[7]).toBeCloseTo(64 / 255, 6);
	});

	it('expands RGB565 by replicating high bits, with alpha forced to 1', () => {
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.CLR0,
				componentCount: 0,
				componentType: GxColorCompType.RGB565,
				data: u16Bytes(rgb565(255, 255, 255), rgb565(0, 0, 0), rgb565(255, 0, 0)),
			},
		]);
		const clr = vtx1Array(vtx1, GxAttr.CLR0)!;
		expect(clr.elementSize).toBe(2);
		expect(clr.count).toBe(3);
		// All-ones must expand to exactly 1.0, not 0.99...
		expect(Array.from(clr.values.subarray(0, 4))).toEqual([1, 1, 1, 1]);
		expect(Array.from(clr.values.subarray(4, 8))).toEqual([0, 0, 0, 1]);
		expect(Array.from(clr.values.subarray(8, 12))).toEqual([1, 0, 0, 1]);
	});

	it('reads RGB8 (3 bytes) and RGBX8 (4 bytes) with the right stride', () => {
		const rgb8 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.CLR0,
				componentCount: 0,
				componentType: GxColorCompType.RGB8,
				data: new Uint8Array([255, 0, 0, 0, 255, 0]),
			},
		]);
		const a = vtx1Array(rgb8, GxAttr.CLR0)!;
		expect(a.elementSize).toBe(3);
		expect(a.count).toBe(2);
		expect(Array.from(a.values)).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);

		const rgbx8 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.CLR1,
				componentCount: 0,
				componentType: GxColorCompType.RGBX8,
				// The fourth byte is padding, *not* alpha.
				data: new Uint8Array([255, 0, 0, 0]),
			},
		]);
		const b = vtx1Array(rgbx8, GxAttr.CLR1)!;
		expect(b.elementSize).toBe(4);
		expect(b.count).toBe(1);
		expect(Array.from(b.values)).toEqual([1, 0, 0, 1]);
	});

	it('reads RGBA4 and RGBA6', () => {
		const rgba4 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.CLR0,
				componentCount: 1,
				componentType: GxColorCompType.RGBA4,
				data: u16Bytes(0xf00f),
			},
		]);
		expect(Array.from(vtx1Array(rgba4, GxAttr.CLR0)!.values)).toEqual([
			1, 0, 0, 1,
		]);

		const rgba6 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0) },
			{
				attribute: GxAttr.CLR0,
				componentCount: 1,
				componentType: GxColorCompType.RGBA6,
				// 6 bits each, packed into 24: r=63 g=0 b=0 a=63
				data: new Uint8Array([0xfc, 0x00, 0x3f]),
			},
		]);
		const c = vtx1Array(rgba6, GxAttr.CLR0)!;
		expect(c.elementSize).toBe(3);
		expect(Array.from(c.values)).toEqual([1, 0, 0, 1]);
	});
});

describe('VTX1 array length inference', () => {
	it('derives each array length from the next array offset', () => {
		// Nothing stores counts, so the position array's length is entirely
		// determined by where the normal array starts.
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(0, 0, 0, 1, 1, 1, 2, 2, 2) },
			{
				attribute: GxAttr.NRM,
				componentCount: 0,
				componentType: GxCompType.S16,
				decimalPoint: 14,
				data: s16Bytes(0, 0, 16384, 0, 0, -16384),
			},
			{
				attribute: GxAttr.TEX0,
				componentCount: 1,
				componentType: GxCompType.F32,
				data: f32Bytes(0, 0, 1, 1),
			},
		]);
		expect(vtx1!.arrays.map((a) => a.count)).toEqual([3, 2, 2]);
		expect(vtx1!.arrays.map((a) => a.byteLength)).toEqual([36, 12, 16]);
		// The offsets really are adjacent, which is what makes the above exact.
		expect(vtx1!.arrays[0].offset + 36).toBe(vtx1!.arrays[1].offset);
		expect(vtx1!.arrays[1].offset + 12).toBe(vtx1!.arrays[2].offset);
	});

	it('over-counts the final array when the chunk is padded, as retail files are', () => {
		// Documented consequence of counts not being stored: trailing chunk
		// alignment looks like more elements. Harmless — the extra elements are
		// never indexed — but worth pinning down so it does not look like a bug.
		const exact = parse([{ ...POS_XYZ_F32, data: f32Bytes(1, 2, 3) }]);
		expect(vtx1Array(exact, GxAttr.POS)!.count).toBe(1);
		const padded = parse([{ ...POS_XYZ_F32, data: f32Bytes(1, 2, 3) }], {
			pad32: true,
		});
		expect(vtx1Array(padded, GxAttr.POS)!.count).toBeGreaterThanOrEqual(1);
		expect(Array.from(vtx1Array(padded, GxAttr.POS)!.values.subarray(0, 3))).toEqual([
			1, 2, 3,
		]);
	});

	it('skips an attribute with an unknown component type', () => {
		const vtx1 = parse([
			{ ...POS_XYZ_F32, data: f32Bytes(1, 2, 3) },
			{
				attribute: GxAttr.NRM,
				componentCount: 0,
				componentType: 99,
				data: new Uint8Array(8),
			},
		]);
		expect(vtx1).not.toBeNull();
		expect(vtx1Array(vtx1, GxAttr.POS)).not.toBeNull();
		expect(vtx1Array(vtx1, GxAttr.NRM)).toBeNull();
	});
});

describe('VTX1 through the container', () => {
	it('resolves chunk-relative offsets against the chunk, not the file', () => {
		// The chunk starts at 0x20 in the file, so every offset inside it is
		// 0x20 lower than the absolute one — the bug this test exists to catch.
		const file = buildContainer([
			buildVtx1([{ ...POS_XYZ_F32, data: f32Bytes(7, 8, 9) }]),
		]);
		const model = parseJ3d(file);
		const pos = vtx1Array(model!.vtx1, GxAttr.POS)!;
		expect(Array.from(pos.values)).toEqual([7, 8, 9]);
		expect(pos.offset).toBeGreaterThan(0x20);
	});
});
