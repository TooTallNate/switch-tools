import { describe, expect, it } from 'vitest';

import {
	GxAttr,
	GxAttrType,
	GxPrimitive,
	SHP1_SHAPE_SIZE,
	gxPrimitiveName,
	parseShp1,
	primitiveIndex,
	primitiveVertexIndices,
	shapeAttributeSlot,
	shapeTriangleCount,
	triangulate,
	type Shp1,
	type Shp1Shape,
} from '../src/index.js';
import { buildShp1, type ShapeSpec } from './fixtures.js';

function parse(shapes: ShapeSpec[]): Shp1 | null {
	const chunk = buildShp1(shapes);
	return parseShp1(chunk, { magic: 'SHP1', offset: 0, size: chunk.length });
}

/** POS via INDEX16 — the descriptor almost every retail shape uses for hulls. */
const POS16 = { attribute: GxAttr.POS, attrType: GxAttrType.INDEX16 } as const;

describe('triangulate', () => {
	it('splits TRIANGLES into consecutive triples', () => {
		expect(triangulate(GxPrimitive.TRIANGLES, 6)).toEqual([0, 1, 2, 3, 4, 5]);
		// A count that isn't a multiple of three drops the ragged tail.
		expect(triangulate(GxPrimitive.TRIANGLES, 4)).toEqual([0, 1, 2]);
		expect(triangulate(GxPrimitive.TRIANGLES, 2)).toEqual([]);
	});

	it('flips the winding of odd triangles in a strip', () => {
		// This is the assertion that keeps half the model from facing backwards.
		expect(triangulate(GxPrimitive.TRIANGLESTRIP, 5)).toEqual([
			0, 1, 2, // i = 2, even
			2, 1, 3, // i = 3, odd  -> (i-1, i-2, i)
			2, 3, 4, // i = 4, even -> (i-2, i-1, i)
		]);
		expect(triangulate(GxPrimitive.TRIANGLESTRIP, 3)).toEqual([0, 1, 2]);
		expect(triangulate(GxPrimitive.TRIANGLESTRIP, 2)).toEqual([]);
		expect(triangulate(GxPrimitive.TRIANGLESTRIP, 6)).toEqual([
			0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5,
		]);
	});

	it('fans from vertex 0', () => {
		expect(triangulate(GxPrimitive.TRIANGLEFAN, 5)).toEqual([
			0, 1, 2, 0, 2, 3, 0, 3, 4,
		]);
		expect(triangulate(GxPrimitive.TRIANGLEFAN, 2)).toEqual([]);
	});

	it('splits each quad into two triangles', () => {
		expect(triangulate(GxPrimitive.QUADS, 8)).toEqual([
			0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7,
		]);
		// QUADS2 is the same primitive with a different opcode.
		expect(triangulate(GxPrimitive.QUADS2, 4)).toEqual([0, 1, 2, 0, 2, 3]);
		expect(triangulate(GxPrimitive.QUADS, 3)).toEqual([]);
	});

	it('yields no triangles for lines and points, and null for junk', () => {
		expect(triangulate(GxPrimitive.LINES, 4)).toEqual([]);
		expect(triangulate(GxPrimitive.LINESTRIP, 4)).toEqual([]);
		expect(triangulate(GxPrimitive.POINTS, 4)).toEqual([]);
		expect(triangulate(0x00, 4)).toBeNull();
		expect(triangulate(0xc0, 4)).toBeNull();
	});

	it('names primitives for diagnostics', () => {
		expect(gxPrimitiveName(GxPrimitive.TRIANGLESTRIP)).toBe('TRIANGLESTRIP');
		expect(gxPrimitiveName(0xc0)).toBe('UNKNOWN_0xc0');
	});
});

describe('SHP1 shape entries', () => {
	it('reads the fixed fields', () => {
		const shp1 = parse([
			{
				attributes: [POS16],
				packets: [[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }]],
				matrixType: 3,
			},
		]);
		expect(shp1).not.toBeNull();
		expect(SHP1_SHAPE_SIZE).toBe(0x28);
		const shape = shp1!.shapes[0];
		expect(shape.index).toBe(0);
		expect(shape.matrixType).toBe(3);
		expect(shape.packetCount).toBe(1);
		expect(shape.boundingSphereRadius).toBeCloseTo(1.75, 6);
		expect(shape.bboxMin).toEqual([-1, -2, -3]);
		expect(shape.bboxMax).toEqual([1, 2, 3]);
		expect(shp1!.remapTable).toEqual([0]);
		// Retail SHP1 chunks have no name table.
		expect(shp1!.names).toBeNull();
	});

	it('handles a shape count of zero', () => {
		const shp1 = parse([]);
		expect(shp1).not.toBeNull();
		expect(shp1!.shapes).toEqual([]);
	});
});

describe('SHP1 vertex descriptor and stride', () => {
	it('sums attribute widths to get the display-list vertex stride', () => {
		// PNMTXIDX is DIRECT (1 byte), POS is INDEX16 (2), NRM is INDEX8 (1),
		// TEX0 is INDEX16 (2) => 6 bytes per vertex. Getting this wrong by one
		// byte turns every vertex after the first into noise.
		const shp1 = parse([
			{
				attributes: [
					{ attribute: GxAttr.PNMTXIDX, attrType: GxAttrType.DIRECT },
					POS16,
					{ attribute: GxAttr.NRM, attrType: GxAttrType.INDEX8 },
					{ attribute: GxAttr.TEX0, attrType: GxAttrType.INDEX16 },
				],
				packets: [
					[
						{
							type: GxPrimitive.TRIANGLES,
							verts: [
								[0, 1000, 7, 300],
								[3, 1001, 8, 301],
								[6, 1002, 9, 302],
							],
						},
					],
				],
			},
		]);
		const shape = shp1!.shapes[0];
		expect(shape.attributes.map((a) => a.size)).toEqual([1, 2, 1, 2]);
		expect(shape.vertexStride).toBe(6);
		expect(shapeAttributeSlot(shape, GxAttr.POS)).toBe(1);
		expect(shapeAttributeSlot(shape, GxAttr.NRM)).toBe(2);
		expect(shapeAttributeSlot(shape, GxAttr.CLR0)).toBe(-1);

		// And the indices really did land in the right slots at the right widths.
		const prim = shape.packets[0].primitives[0];
		expect(prim.vertexCount).toBe(3);
		expect(primitiveVertexIndices(prim, 0)).toEqual([0, 1000, 7, 300]);
		expect(primitiveVertexIndices(prim, 1)).toEqual([3, 1001, 8, 301]);
		expect(primitiveVertexIndices(prim, 2)).toEqual([6, 1002, 9, 302]);
		expect(primitiveIndex(prim, 2, 1)).toBe(1002);
	});

	it('reads a 16-bit index that would be truncated by an 8-bit read', () => {
		const shp1 = parse([
			{
				attributes: [POS16],
				packets: [
					[
						{
							type: GxPrimitive.TRIANGLES,
							verts: [[0x0100], [0xfffe], [0x0201]],
						},
					],
				],
			},
		]);
		const prim = shp1!.shapes[0].packets[0].primitives[0];
		expect(Array.from(prim.indices)).toEqual([0x0100, 0xfffe, 0x0201]);
	});

	it('gives NONE-typed attributes zero width', () => {
		const shp1 = parse([
			{
				attributes: [
					POS16,
					{ attribute: GxAttr.CLR1, attrType: GxAttrType.NONE },
				],
				packets: [[{ type: GxPrimitive.TRIANGLES, verts: [[1], [2], [3]] }]],
			},
		]);
		const shape = shp1!.shapes[0];
		expect(shape.vertexStride).toBe(2);
		expect(shape.attributes.map((a) => a.size)).toEqual([2, 0]);
	});

	it('rejects an attribute table with an unknown index type', () => {
		const shp1 = parse([
			{
				attributes: [{ attribute: GxAttr.POS, attrType: 9 }],
				packets: [[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }]],
			},
		]);
		expect(shp1).toBeNull();
	});
});

describe('SHP1 display lists', () => {
	function shapeOf(spec: ShapeSpec): Shp1Shape {
		const shp1 = parse([spec]);
		expect(shp1).not.toBeNull();
		return shp1!.shapes[0];
	}

	it('decodes several primitives in one packet', () => {
		const shape = shapeOf({
			attributes: [POS16],
			packets: [
				[
					{ type: GxPrimitive.TRIANGLESTRIP, verts: [[0], [1], [2], [3]] },
					{ type: GxPrimitive.TRIANGLEFAN, verts: [[4], [5], [6]] },
					{ type: GxPrimitive.QUADS, verts: [[7], [8], [9], [10]] },
				],
			],
		});
		const prims = shape.packets[0].primitives;
		expect(prims.map((p) => p.type)).toEqual([
			GxPrimitive.TRIANGLESTRIP,
			GxPrimitive.TRIANGLEFAN,
			GxPrimitive.QUADS,
		]);
		expect(prims.map((p) => p.vertexCount)).toEqual([4, 3, 4]);
		// strip(4) = 2 triangles, fan(3) = 1, quads(4) = 2.
		expect(shapeTriangleCount(shape)).toBe(5);
	});

	it('skips the GX_NOP padding that keeps a list 32-byte aligned', () => {
		const shape = shapeOf({
			attributes: [POS16],
			packets: [[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }]],
			padPackets: true,
		});
		// The packet is padded out to 32 bytes, all of it NOPs after the 9 real ones.
		expect(shape.packets[0].size % 32).toBe(0);
		expect(shape.packets[0].primitives).toHaveLength(1);
		expect(shape.packets[0].primitives[0].vertexCount).toBe(3);
	});

	it('masks the VAT bits off the opcode', () => {
		const shape = shapeOf({
			attributes: [POS16],
			packets: [
				[{ type: GxPrimitive.TRIANGLES, vat: 5, verts: [[0], [1], [2]] }],
			],
		});
		const prim = shape.packets[0].primitives[0];
		expect(prim.type).toBe(GxPrimitive.TRIANGLES);
		expect(prim.vat).toBe(5);
	});

	it('walks multiple packets per shape', () => {
		const shape = shapeOf({
			attributes: [POS16],
			packets: [
				[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
				[{ type: GxPrimitive.TRIANGLESTRIP, verts: [[3], [4], [5], [6]] }],
				[{ type: GxPrimitive.TRIANGLEFAN, verts: [[7], [8], [9], [10]] }],
			],
		});
		expect(shape.packets).toHaveLength(3);
		expect(shape.packets.map((p) => p.primitives[0].vertexCount)).toEqual([
			3, 4, 4,
		]);
		// 1 + 2 + 2
		expect(shapeTriangleCount(shape)).toBe(5);
		// Each packet gets its own one-entry bone set from the matrix table.
		expect(shape.packets.map((p) => p.matrixTable)).toEqual([[0], [1], [2]]);
	});

	it('keeps multiple shapes and their descriptors apart', () => {
		const shp1 = parse([
			{
				attributes: [POS16],
				packets: [[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }]],
			},
			{
				attributes: [
					POS16,
					{ attribute: GxAttr.TEX0, attrType: GxAttrType.INDEX8 },
				],
				packets: [
					[
						{
							type: GxPrimitive.TRIANGLES,
							verts: [
								[10, 1],
								[11, 2],
								[12, 3],
							],
						},
					],
				],
			},
		]);
		expect(shp1!.shapes).toHaveLength(2);
		expect(shp1!.shapes[0].vertexStride).toBe(2);
		expect(shp1!.shapes[1].vertexStride).toBe(3);
		// The second shape's descriptor lives further into the shared table.
		expect(shp1!.shapes[0].attributeOffset).toBe(0);
		expect(shp1!.shapes[1].attributeOffset).toBe(16);
		expect(
			primitiveVertexIndices(shp1!.shapes[1].packets[0].primitives[0], 1),
		).toEqual([11, 2]);
	});

	it('rejects a truncated packet', () => {
		expect(
			parse([
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
					truncatePacketBy: 2,
				},
			]),
		).toBeNull();
	});

	it('rejects an opcode that is neither a primitive nor a NOP', () => {
		expect(
			parse([
				{
					attributes: [POS16],
					packets: [
						[{ type: GxPrimitive.TRIANGLES, verts: [[0], [1], [2]] }],
					],
					badOpcode: 0x61, // a CP register load; never appears in J3D
				},
			]),
		).toBeNull();
	});

	it('treats an all-zero chunk as zero shapes rather than throwing', () => {
		const zeroes = new Uint8Array(0x80);
		const chunk = { magic: 'SHP1', offset: 0, size: zeroes.length };
		expect(() => parseShp1(zeroes, chunk)).not.toThrow();
		expect(parseShp1(zeroes, chunk)!.shapes).toEqual([]);
	});

	it('rejects a shape count with no tables to back it', () => {
		// shapeCount = 3, every offset still 0 ("absent"), which cannot be honest.
		const bytes = new Uint8Array(0x80);
		new DataView(bytes.buffer).setUint16(0x08, 3, false);
		expect(parseShp1(bytes, { magic: 'SHP1', offset: 0, size: bytes.length })).toBeNull();
	});

	it('rejects a chunk smaller than its own header', () => {
		const tiny = new Uint8Array(16);
		expect(parseShp1(tiny, { magic: 'SHP1', offset: 0, size: tiny.length })).toBeNull();
	});
});
