import { describe, expect, it } from 'vitest';

import {
	GxAttr,
	GxAttrType,
	GxColorCompType,
	GxCompType,
	GxPrimitive,
	Inf1NodeType,
	buildJ3dMesh,
	parseJ3d,
	type J3dModel,
} from '../src/index.js';
import {
	buildContainer,
	buildInf1,
	buildShp1,
	buildVtx1,
	f32Bytes,
	s16Bytes,
	type Inf1NodeSpec,
	type ShapeSpec,
	type VtxArraySpec,
} from './fixtures.js';

const POS16 = { attribute: GxAttr.POS, attrType: GxAttrType.INDEX16 } as const;
const NRM16 = { attribute: GxAttr.NRM, attrType: GxAttrType.INDEX16 } as const;
const TEX16 = { attribute: GxAttr.TEX0, attrType: GxAttrType.INDEX16 } as const;
const CLR16 = { attribute: GxAttr.CLR0, attrType: GxAttrType.INDEX16 } as const;

function model(
	arrays: VtxArraySpec[],
	shapes: ShapeSpec[],
	hierarchy?: Inf1NodeSpec[],
): J3dModel {
	const chunks = [buildVtx1(arrays), buildShp1(shapes)];
	if (hierarchy) chunks.unshift(buildInf1(hierarchy));
	const parsed = parseJ3d(buildContainer(chunks));
	expect(parsed).not.toBeNull();
	return parsed!;
}

function positions(values: number[]): VtxArraySpec {
	return {
		attribute: GxAttr.POS,
		componentCount: 1,
		componentType: GxCompType.F32,
		data: f32Bytes(...values),
	};
}

function normals(values: number[]): VtxArraySpec {
	return {
		attribute: GxAttr.NRM,
		componentCount: 0,
		componentType: GxCompType.F32,
		data: f32Bytes(...values),
	};
}

describe('buildJ3dMesh basics', () => {
	it('flattens a single triangle', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0])],
			[
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.numVertices).toBe(3);
		expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
		expect(mesh.indices).toBeInstanceOf(Uint16Array);
		expect(mesh.normals).toBeUndefined();
		expect(mesh.uv).toBeUndefined();
		expect(mesh.colors).toBeUndefined();
		expect(mesh.sections).toEqual([
			{ materialIndex: -1, firstIndex: 0, numTriangles: 1, shapeIndex: 0 },
		]);
	});

	it('carries the triangle-strip winding flip into the index buffer', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])],
			[
				{
					attributes: [POS16],
					packets: [
						[
							{
								type: GxPrimitive.TRIANGLESTRIP,
								verts: [[0], [1], [2], [3]],
							},
						],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 2, 1, 3]);
		expect(mesh.sections[0].numTriangles).toBe(2);
	});

	it('emits normals, UVs and colours when the shape supplies them', () => {
		const m = model(
			[
				positions([0, 0, 0, 1, 0, 0, 0, 1, 0]),
				normals([0, 0, 1, 0, 1, 0]),
				{
					attribute: GxAttr.TEX0,
					componentCount: 1,
					componentType: GxCompType.S16,
					decimalPoint: 8,
					data: s16Bytes(0, 0, 256, 0, 0, 256),
				},
				{
					attribute: GxAttr.CLR0,
					componentCount: 1,
					componentType: GxColorCompType.RGBA8,
					data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
				},
			],
			[
				{
					attributes: [POS16, NRM16, TEX16, CLR16],
					packets: [
						[
							{
								type: GxPrimitive.TRIANGLES,
								verts: [
									[0, 0, 0, 0],
									[1, 0, 1, 1],
									[2, 1, 2, 0],
								],
							},
						],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.numVertices).toBe(3);
		expect(Array.from(mesh.normals!)).toEqual([0, 0, 1, 0, 0, 1, 0, 1, 0]);
		expect(Array.from(mesh.uv!)).toEqual([0, 0, 1, 0, 0, 1]);
		expect(Array.from(mesh.colors!)).toEqual([1, 0, 0, 0, 1, 0, 1, 0, 0]);
	});

	it('normalises normals', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals([0, 0, 4])],
			[
				{
					attributes: [POS16, NRM16],
					packets: [
						[
							{
								type: GxPrimitive.TRIANGLES,
								verts: [
									[0, 0],
									[1, 0],
									[2, 0],
								],
							},
						],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(Array.from(mesh.normals!.subarray(0, 3))).toEqual([0, 0, 1]);
	});

	it('leaves Z at zero for a 2-component position array', () => {
		const m = model(
			[
				{
					attribute: GxAttr.POS,
					componentCount: 0, // XY
					componentType: GxCompType.F32,
					data: f32Bytes(1, 2, 3, 4, 5, 6),
				},
			],
			[
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(Array.from(mesh.positions)).toEqual([1, 2, 0, 3, 4, 0, 5, 6, 0]);
	});
});

describe('buildJ3dMesh attribute-tuple de-duplication', () => {
	it('splits vertices that share a position but differ in normal', () => {
		// The whole reason this conversion exists: GX indexes each attribute
		// separately, so one position with two normals must become two vertices.
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals([0, 0, 1, 1, 0, 0])],
			[
				{
					attributes: [POS16, NRM16],
					packets: [
						[
							{
								type: GxPrimitive.TRIANGLES,
								verts: [
									[0, 0],
									[0, 1], // same position, different normal
									[1, 0],
								],
							},
						],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.numVertices).toBe(3);
		expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0]);
		expect(Array.from(mesh.normals!)).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 1]);
		expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
	});

	it('merges vertices whose whole index tuple matches', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals([0, 0, 1, 1, 0, 0])],
			[
				{
					attributes: [POS16, NRM16],
					packets: [
						[
							{
								type: GxPrimitive.TRIANGLES,
								verts: [
									[0, 0],
									[1, 1],
									[2, 0],
									// A second triangle reusing the first two tuples exactly.
									[0, 0],
									[1, 1],
									[1, 0],
								],
							},
						],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		// (0,0) (1,1) (2,0) (1,0) = four distinct tuples out of six vertices.
		expect(mesh.numVertices).toBe(4);
		expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 1, 3]);
		expect(mesh.sections[0].numTriangles).toBe(2);
	});

	it('merges across shapes when the tuples are identical', () => {
		const shape: ShapeSpec = {
			attributes: [POS16],
			packets: [[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }]],
		};
		const m = model([positions([0, 0, 0, 1, 0, 0, 0, 1, 0])], [shape, shape]);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.numVertices).toBe(3);
		expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 1, 2]);
		expect(mesh.sections).toHaveLength(2);
	});

	it('never merges a shape without normals into one with them', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals([0, 0, 1])],
			[
				{
					attributes: [POS16, NRM16],
					packets: [
						[
							{
								type: GxPrimitive.TRIANGLES,
								verts: [
									[0, 0],
									[1, 0],
									[2, 0],
								],
							},
						],
					],
				},
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.numVertices).toBe(6);
		// The normal-less shape's vertices fall back to a zero normal.
		expect(Array.from(mesh.normals!.subarray(9))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it('switches to a 32-bit index buffer past 65535 vertices', () => {
		// 32769 positions, each used with two different normals: 65538 distinct
		// tuples, which a Uint16Array could not address.
		const positionCount = 32769;
		const posValues: number[] = [];
		for (let i = 0; i < positionCount; i++) posValues.push(i, 0, 0);
		const verts: number[][] = [];
		for (let i = 0; i < positionCount * 2; i++) verts.push([i >> 1, i & 1]);
		const half = positionCount; // divisible by 3, so each half is whole triangles
		const m = model(
			[positions(posValues), normals([0, 0, 1, 1, 0, 0])],
			[
				{
					attributes: [POS16, NRM16],
					packets: [
						[
							{ type: GxPrimitive.TRIANGLES, verts: verts.slice(0, half) },
							{ type: GxPrimitive.TRIANGLES, verts: verts.slice(half) },
						],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.numVertices).toBe(65538);
		expect(mesh.indices).toBeInstanceOf(Uint32Array);
		expect(mesh.indices.length).toBe(65538);
		expect(mesh.indices[65537]).toBe(65537);
	});
});

describe('buildJ3dMesh sections', () => {
	it('covers the whole index buffer with contiguous sections', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0])],
			[
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
				},
				{
					attributes: [POS16],
					packets: [
						[
							{
								type: GxPrimitive.TRIANGLESTRIP,
								verts: [[1], [2], [3], [4]],
							},
						],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.sections.map((s) => [s.shapeIndex, s.firstIndex, s.numTriangles])).toEqual([
			[0, 0, 1],
			[1, 3, 2],
		]);
		let covered = 0;
		for (const s of mesh.sections) {
			expect(s.firstIndex).toBe(covered);
			covered += s.numTriangles * 3;
		}
		expect(covered).toBe(mesh.indices.length);
	});

	it('takes materials and draw order from INF1', () => {
		const shape: ShapeSpec = {
			attributes: [POS16],
			packets: [[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }]],
		};
		// joint 0 { material 5 { shape 1 } material 2 { shape 0 } }
		const m = model([positions([0, 0, 0, 1, 0, 0, 0, 1, 0])], [shape, shape], [
			{ type: Inf1NodeType.JOINT, index: 0 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 5 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.SHAPE, index: 1 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 2 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
		]);
		const mesh = buildJ3dMesh(m)!;
		// Sections follow the hierarchy's draw order, not SHP1's index order.
		expect(mesh.sections.map((s) => [s.shapeIndex, s.materialIndex])).toEqual([
			[1, 5],
			[0, 2],
		]);
	});

	it('drops a shape whose primitives yield no triangles', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0])],
			[
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.LINESTRIP, verts: [[0], [1], [2]] }],
					],
				},
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.sections).toHaveLength(1);
		expect(mesh.sections[0].shapeIndex).toBe(1);
	});
});

describe('buildJ3dMesh failure modes', () => {
	it('returns null without VTX1, SHP1 or positions', () => {
		const noShapes = model([positions([0, 0, 0])], []);
		expect(buildJ3dMesh(noShapes)).toBeNull();

		const shapeOnly = parseJ3d(
			buildContainer([
				buildShp1([
					{
						attributes: [POS16],
						packets: [
							[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
						],
					},
				]),
			]),
		)!;
		expect(shapeOnly.vtx1).toBeNull();
		expect(buildJ3dMesh(shapeOnly)).toBeNull();

		// VTX1 present, but with no position array.
		const noPositions = parseJ3d(
			buildContainer([
				buildVtx1([normals([0, 0, 1])]),
				buildShp1([
					{
						attributes: [POS16],
						packets: [
							[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
						],
					},
				]),
			]),
		)!;
		expect(buildJ3dMesh(noPositions)).toBeNull();
	});

	it('ignores a shape whose position attribute is DIRECT rather than indexed', () => {
		// GX allows inline vertex data; J3D never uses it for positions, and there
		// would be no array to look the value up in, so the shape is skipped.
		const m = model(
			[positions([0, 0, 0, 1, 0, 0, 0, 1, 0])],
			[
				{
					attributes: [
						{ attribute: GxAttr.POS, attrType: GxAttrType.DIRECT },
					],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
				},
			],
		);
		expect(buildJ3dMesh(m)).toBeNull();
	});

	it('clamps an out-of-range index instead of losing the model', () => {
		const m = model(
			[positions([0, 0, 0, 1, 0, 0])],
			[
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [99]] }],
					],
				},
			],
		);
		const mesh = buildJ3dMesh(m)!;
		expect(mesh.numVertices).toBe(3);
		// The clamped vertex reuses the last real position.
		expect(Array.from(mesh.positions.subarray(6))).toEqual([1, 0, 0]);
	});
});
