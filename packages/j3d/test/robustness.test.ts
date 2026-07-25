import { describe, expect, it } from 'vitest';

import {
	GxAttr,
	GxAttrType,
	GxCompType,
	GxPrimitive,
	Inf1NodeType,
	buildJ3dMesh,
	parseJ3d,
} from '../src/index.js';
import {
	buildContainer,
	buildDrw1,
	buildEvp1,
	buildInf1,
	buildJnt1,
	buildMat3,
	buildShp1,
	buildTex1,
	buildVtx1,
	f32Bytes,
	rgb565,
	s16Bytes,
	u16Bytes,
} from './fixtures.js';

/**
 * A complete, valid model with every chunk populated — the base the corruption
 * tests below chew on.
 */
function fullModel(): Uint8Array {
	return buildContainer([
		buildInf1([
			{ type: Inf1NodeType.JOINT, index: 0 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 0 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
		]),
		buildVtx1([
			{
				attribute: GxAttr.POS,
				componentCount: 1,
				componentType: GxCompType.S16,
				decimalPoint: 8,
				data: s16Bytes(0, 0, 0, 256, 0, 0, 0, 256, 0, 256, 256, 0),
			},
			{
				attribute: GxAttr.NRM,
				componentCount: 0,
				componentType: GxCompType.F32,
				data: f32Bytes(0, 0, 1),
			},
			{
				attribute: GxAttr.TEX0,
				componentCount: 1,
				componentType: GxCompType.F32,
				data: f32Bytes(0, 0, 1, 0, 0, 1, 1, 1),
			},
		]),
		buildEvp1([{ joints: [0], weights: [1] }]),
		buildDrw1([{ isWeighted: false, value: 0 }]),
		buildJnt1([{ name: 'root' }]),
		buildShp1([
			{
				attributes: [
					{ attribute: GxAttr.PNMTXIDX, attrType: GxAttrType.DIRECT },
					{ attribute: GxAttr.POS, attrType: GxAttrType.INDEX16 },
					{ attribute: GxAttr.NRM, attrType: GxAttrType.INDEX8 },
					{ attribute: GxAttr.TEX0, attrType: GxAttrType.INDEX16 },
				],
				packets: [
					[
						{
							type: GxPrimitive.TRIANGLESTRIP,
							verts: [
								[0, 0, 0, 0],
								[0, 1, 0, 1],
								[0, 2, 0, 2],
								[0, 3, 0, 3],
							],
						},
					],
				],
				padPackets: true,
			},
		]),
		buildMat3([{ name: 'mat', textureSlots: [0] }], [0]),
		buildTex1([
			{
				name: 'tex',
				format: 0x04,
				width: 4,
				height: 4,
				data: u16Bytes(...new Array(16).fill(rgb565(255, 255, 0))),
			},
		]),
	]);
}

/** Deterministic xorshift, so a failure is always reproducible. */
function rng(seed: number): () => number {
	let s = seed | 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 0x100000000;
	};
}

describe('robustness', () => {
	it('parses the fully-populated fixture correctly to begin with', () => {
		const file = fullModel();
		const model = parseJ3d(file)!;
		expect(model).not.toBeNull();
		const mesh = buildJ3dMesh(model)!;
		expect(mesh.numVertices).toBe(4);
		// Fixed point with 8 fractional bits: raw 256 is 1.0.
		expect(Array.from(mesh.positions)).toEqual([
			0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0,
		]);
		expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 2, 1, 3]);
		expect(mesh.sections[0].materialIndex).toBe(0);
		expect(mesh.normals).toBeDefined();
		expect(mesh.uv).toBeDefined();
	});

	it('never throws or hangs on a truncated file', () => {
		const file = fullModel();
		for (let len = 0; len < file.length; len++) {
			const truncated = file.subarray(0, len);
			expect(() => {
				const model = parseJ3d(truncated);
				if (model) buildJ3dMesh(model);
			}).not.toThrow();
		}
	});

	it('never throws or hangs on single-byte corruption', () => {
		const file = fullModel();
		const random = rng(0x5eed);
		for (let trial = 0; trial < 3000; trial++) {
			const copy = file.slice();
			const at = Math.floor(random() * copy.length);
			copy[at] = Math.floor(random() * 256);
			expect(() => {
				const model = parseJ3d(copy);
				if (model) buildJ3dMesh(model);
			}).not.toThrow();
		}
	});

	it('never throws or hangs on wholesale garbage', () => {
		const random = rng(0xc0ffee);
		for (let trial = 0; trial < 200; trial++) {
			const size = Math.floor(random() * 512);
			const bytes = new Uint8Array(size);
			for (let i = 0; i < size; i++) bytes[i] = Math.floor(random() * 256);
			// Give a fraction of them a valid magic so they get past the sniff and
			// exercise the chunk walk and the chunk parsers with nonsense.
			if (size >= 8 && trial % 2 === 0) {
				bytes.set(
					new Uint8Array([0x4a, 0x33, 0x44, 0x32, 0x62, 0x6d, 0x64, 0x33]),
					0,
				);
			}
			expect(() => {
				const model = parseJ3d(bytes);
				if (model) buildJ3dMesh(model);
			}).not.toThrow();
		}
	});
});
