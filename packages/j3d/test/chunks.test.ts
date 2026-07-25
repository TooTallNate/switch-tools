import { describe, expect, it } from 'vitest';

import {
	Inf1NodeType,
	JNT1_ROTATION_SCALE,
	MAT3_ENTRY_SIZE,
	TEX1_HEADER_SIZE,
	decodeJ3dTexture,
	materialTextureIndex,
	parseInf1,
	parseJ3d,
	parseJnt1,
	parseMat3,
	parseTex1,
	readJ3dStringTable,
	j3dNameHash,
	type J3dChunk,
} from '../src/index.js';
import {
	Writer,
	buildContainer,
	buildDrw1,
	buildEvp1,
	buildInf1,
	buildJnt1,
	buildMat3,
	buildTex1,
	rgb565,
	u16Bytes,
	writeStringTable,
	type Inf1NodeSpec,
} from './fixtures.js';

/** Wrap a standalone chunk so the individual parsers can be called directly. */
function asChunk(bytes: Uint8Array): J3dChunk {
	let magic = '';
	for (let i = 0; i < 4; i++) magic += String.fromCharCode(bytes[i]);
	return { magic, offset: 0, size: bytes.length };
}

describe('J3D string table', () => {
	it('reads count, offsets and NUL-terminated names', () => {
		const w = new Writer();
		writeStringTable(w, ['alpha', 'b', 'gamma_ray']);
		const bytes = w.toUint8Array();
		expect(readJ3dStringTable(bytes, 0, bytes.length)).toEqual([
			'alpha',
			'b',
			'gamma_ray',
		]);
	});

	it('computes the same hash the files store', () => {
		// Same *3 rule RARC uses; a real table's hash column should match.
		expect(j3dNameHash('')).toBe(0);
		expect(j3dNameHash('a')).toBe(97);
		expect(j3dNameHash('ab')).toBe(97 * 3 + 98);
	});

	it('returns null when the table does not fit', () => {
		const w = new Writer();
		writeStringTable(w, ['a', 'b']);
		const bytes = w.toUint8Array();
		expect(readJ3dStringTable(bytes, 0, 4)).toBeNull();
		expect(readJ3dStringTable(bytes, bytes.length, bytes.length)).toBeNull();
		expect(readJ3dStringTable(bytes, -1, bytes.length)).toBeNull();
	});

	it('yields an empty name for an out-of-range string offset', () => {
		const w = new Writer();
		w.u16(1).u16(0xffff).u16(0).u16(0xf000);
		const bytes = w.toUint8Array();
		expect(readJ3dStringTable(bytes, 0, bytes.length)).toEqual(['']);
	});
});

describe('TEX1', () => {
	/**
	 * A 4x4 RGB565 texture. 16-bit formats use a 4x4 block, so a 4x4 image is
	 * exactly one block and texel (x,y) sits at byte 2 * (y * 4 + x) — no tiling
	 * arithmetic to get wrong in the fixture itself.
	 */
	function rgb565Block(): Uint8Array {
		const texels: number[] = [];
		for (let i = 0; i < 16; i++) texels.push(0);
		texels[0] = rgb565(255, 0, 0); // (0,0) red
		texels[1] = rgb565(0, 255, 0); // (1,0) green
		texels[15] = rgb565(0, 0, 255); // (3,3) blue
		return u16Bytes(...texels);
	}

	it('locates headers and names', () => {
		const chunk = buildTex1([
			{ name: 'grass', format: 0x04, width: 4, height: 4, data: rgb565Block() },
			{ name: 'water_a', format: 0x04, width: 4, height: 4, data: rgb565Block() },
		]);
		const tex1 = parseTex1(chunk, asChunk(chunk));
		expect(tex1).not.toBeNull();
		expect(tex1!.textures.map((t) => t.name)).toEqual(['grass', 'water_a']);
		expect(tex1!.textures[0].header.width).toBe(4);
		expect(tex1!.textures[0].header.height).toBe(4);
		expect(tex1!.textures[0].header.formatName).toBe('RGB565');
		// Headers are adjacent 0x20-byte structs.
		expect(TEX1_HEADER_SIZE).toBe(0x20);
		expect(tex1!.textures[1].headerOffset - tex1!.textures[0].headerOffset).toBe(
			0x20,
		);
	});

	it('handles an empty texture list', () => {
		const chunk = buildTex1([]);
		expect(parseTex1(chunk, asChunk(chunk))!.textures).toEqual([]);
	});

	it('rejects a header array outside the chunk', () => {
		const chunk = buildTex1([
			{ name: 'x', format: 0x04, width: 4, height: 4, data: rgb565Block() },
		]);
		// Point textureHeaderOffset past the end.
		new DataView(chunk.buffer).setUint32(0x0c, 0x10000, false);
		expect(parseTex1(chunk, asChunk(chunk))).toBeNull();
	});

	it('round-trips a tiny texture through @tootallnate/bti', () => {
		const file = buildContainer([
			buildTex1([
				{
					name: 'test_tex',
					format: 0x04,
					width: 4,
					height: 4,
					data: rgb565Block(),
				},
			]),
		]);
		const model = parseJ3d(file)!;
		expect(model.tex1!.textures).toHaveLength(1);
		const decoded = decodeJ3dTexture(model, file, 0)!;
		expect(decoded.name).toBe('test_tex');
		expect(decoded.width).toBe(4);
		expect(decoded.height).toBe(4);
		expect(decoded.pixels.length).toBe(4 * 4 * 4);
		const texel = (x: number, y: number) =>
			Array.from(decoded.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
		expect(texel(0, 0)).toEqual([255, 0, 0, 255]);
		expect(texel(1, 0)).toEqual([0, 255, 0, 255]);
		expect(texel(3, 3)).toEqual([0, 0, 255, 255]);
		expect(texel(2, 2)).toEqual([0, 0, 0, 255]);
	});

	it('returns null for a missing texture index', () => {
		const file = buildContainer([
			buildTex1([
				{ name: 'a', format: 0x04, width: 4, height: 4, data: rgb565Block() },
			]),
		]);
		const model = parseJ3d(file)!;
		expect(decodeJ3dTexture(model, file, -1)).toBeNull();
		expect(decodeJ3dTexture(model, file, 1)).toBeNull();
		expect(decodeJ3dTexture(model, file, 1.5)).toBeNull();
		// A model with no TEX1 at all.
		const bare = parseJ3d(buildContainer([]))!;
		expect(decodeJ3dTexture(bare, file, 0)).toBeNull();
	});
});

describe('MAT3', () => {
	it('follows material -> texture-index table -> TEX1', () => {
		const chunk = buildMat3(
			[
				{ name: 'mat_body', textureSlots: [0] },
				{ name: 'mat_eye', textureSlots: [1] },
			],
			[7, 3],
		);
		const mat3 = parseMat3(chunk, asChunk(chunk));
		expect(mat3).not.toBeNull();
		expect(MAT3_ENTRY_SIZE).toBe(0x14c);
		expect(mat3!.texturesResolved).toBe(true);
		expect(mat3!.materials.map((m) => m.name)).toEqual(['mat_body', 'mat_eye']);
		expect(mat3!.textureIndexTable.slice(0, 2)).toEqual([7, 3]);
		// Slot 0 -> table[0] = 7, slot 1 -> table[1] = 3.
		expect(mat3!.materials[0].textureIndex).toBe(7);
		expect(mat3!.materials[1].textureIndex).toBe(3);
	});

	it('treats 0xFFFF slots as unused', () => {
		const chunk = buildMat3(
			[{ name: 'untextured', textureSlots: [0xffff, 0xffff] }],
			[5],
		);
		const mat3 = parseMat3(chunk, asChunk(chunk))!;
		expect(mat3.materials[0].textureIndices).toEqual([
			-1, -1, -1, -1, -1, -1, -1, -1,
		]);
		expect(mat3.materials[0].textureIndex).toBe(-1);
	});

	it('reads all eight GX texture slots', () => {
		const chunk = buildMat3(
			[{ name: 'multi', textureSlots: [0xffff, 1, 0xffff, 0, 2] }],
			[10, 11, 12],
		);
		const mat3 = parseMat3(chunk, asChunk(chunk))!;
		expect(mat3.materials[0].textureIndices).toEqual([
			-1, 11, -1, 10, 12, -1, -1, -1,
		]);
		// The first *assigned* slot is what a simple viewer binds.
		expect(mat3.materials[0].textureIndex).toBe(11);
	});

	it('shares one entry between materials via the remap table', () => {
		const chunk = buildMat3(
			[
				{ name: 'a', textureSlots: [0] },
				{ name: 'b', textureSlots: [0] },
			],
			[42],
			// Both materials point at entry 0, which is the de-duplication that
			// makes MAT3's entry count differ from its material count.
			{ remap: [0, 0] },
		);
		const mat3 = parseMat3(chunk, asChunk(chunk))!;
		expect(mat3.remapTable).toEqual([0, 0]);
		expect(mat3.materials.map((m) => m.entryIndex)).toEqual([0, 0]);
		expect(mat3.materials.map((m) => m.textureIndex)).toEqual([42, 42]);
	});

	it('reports unresolved textures instead of guessing', () => {
		const chunk = buildMat3([{ name: 'a', textureSlots: [0] }], [1]);
		// Blow away the material-entry offset.
		new DataView(chunk.buffer).setUint32(0x0c, 0xffffff, false);
		const mat3 = parseMat3(chunk, asChunk(chunk))!;
		expect(mat3.texturesResolved).toBe(false);
		expect(mat3.materials[0].name).toBe('a');
		expect(mat3.materials[0].textureIndex).toBe(-1);
	});

	it('exposes the texture index through the model helper', () => {
		const file = buildContainer([
			buildMat3([{ name: 'a', textureSlots: [0] }], [4]),
		]);
		const model = parseJ3d(file)!;
		expect(materialTextureIndex(model, 0)).toBe(4);
		expect(materialTextureIndex(model, 1)).toBe(-1);
		expect(materialTextureIndex(model, -1)).toBe(-1);
		expect(materialTextureIndex(parseJ3d(buildContainer([]))!, 0)).toBe(-1);
	});

	it('rejects a chunk too small for its header', () => {
		const tiny = new Uint8Array(0x20);
		expect(parseMat3(tiny, { magic: 'MAT3', offset: 0, size: tiny.length })).toBeNull();
	});
});

describe('INF1', () => {
	function parse(nodes: Inf1NodeSpec[]) {
		const chunk = buildInf1(nodes, { vertexCount: 123, matrixGroupCount: 2 });
		return parseInf1(chunk, asChunk(chunk));
	}

	it('reads the header fields', () => {
		const inf1 = parse([]);
		expect(inf1).not.toBeNull();
		expect(inf1!.loadFlags).toBe(1);
		expect(inf1!.vertexCount).toBe(123);
		expect(inf1!.matrixGroupCount).toBe(2);
	});

	it('assigns the active material to each shape', () => {
		const inf1 = parse([
			{ type: Inf1NodeType.JOINT, index: 0 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 3 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 7 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.SHAPE, index: 1 },
			{ type: Inf1NodeType.SHAPE, index: 2 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
		])!;
		expect(inf1.drawCalls).toEqual([
			{ shapeIndex: 0, materialIndex: 3, jointIndex: 0 },
			{ shapeIndex: 1, materialIndex: 7, jointIndex: 0 },
			{ shapeIndex: 2, materialIndex: 7, jointIndex: 0 },
		]);
		expect(inf1.shapeMaterials).toEqual([3, 7, 7]);
	});

	it('restores the enclosing material when it closes a level', () => {
		const inf1 = parse([
			{ type: Inf1NodeType.MATERIAL, index: 1 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 2 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.SHAPE, index: 1 },
		])!;
		expect(inf1.shapeMaterials).toEqual([2, 1]);
	});

	it('parents sibling joints to their shared parent, not to each other', () => {
		// The trap: a single "current joint" variable makes joint 2's parent
		// joint 1 instead of joint 0.
		const inf1 = parse([
			{ type: Inf1NodeType.JOINT, index: 0 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.JOINT, index: 1 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.JOINT, index: 3 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.JOINT, index: 2 },
			{ type: Inf1NodeType.UP, index: 0 },
		])!;
		expect(inf1.jointParents).toEqual([-1, 0, 0, 1]);
		expect(inf1.jointRoots).toHaveLength(1);
		expect(inf1.jointRoots[0].jointIndex).toBe(0);
		expect(inf1.jointRoots[0].children.map((c) => c.jointIndex)).toEqual([1, 2]);
		expect(inf1.jointRoots[0].children[0].children.map((c) => c.jointIndex)).toEqual([3]);
	});

	it('keeps both draws when a shape is drawn twice with different materials', () => {
		const inf1 = parse([
			{ type: Inf1NodeType.MATERIAL, index: 1 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 2 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
		])!;
		expect(inf1.drawCalls.map((d) => d.materialIndex)).toEqual([1, 2]);
		// The per-shape summary can only hold one, and keeps the first.
		expect(inf1.shapeMaterials).toEqual([1]);
	});

	it('records the joint a shape hangs off', () => {
		const inf1 = parse([
			{ type: Inf1NodeType.JOINT, index: 0 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.JOINT, index: 4 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.MATERIAL, index: 0 },
			{ type: Inf1NodeType.DOWN, index: 0 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
			{ type: Inf1NodeType.UP, index: 0 },
		])!;
		expect(inf1.drawCalls[0].jointIndex).toBe(4);
	});

	it('stops at the terminator', () => {
		const inf1 = parse([{ type: Inf1NodeType.SHAPE, index: 0 }])!;
		// The builder appends the 0x00 terminator; nodes are the shape plus it.
		expect(inf1.nodes.map((n) => n.type)).toEqual([
			Inf1NodeType.SHAPE,
			Inf1NodeType.END,
		]);
	});

	it('ignores an unknown node type without losing sync', () => {
		const inf1 = parse([
			{ type: 0x55, index: 999 },
			{ type: Inf1NodeType.MATERIAL, index: 6 },
			{ type: Inf1NodeType.SHAPE, index: 0 },
		])!;
		expect(inf1.shapeMaterials).toEqual([6]);
	});

	it('rejects a hierarchy offset outside the chunk', () => {
		const chunk = buildInf1([{ type: Inf1NodeType.SHAPE, index: 0 }]);
		new DataView(chunk.buffer).setUint32(0x14, 0xffff, false);
		expect(parseInf1(chunk, asChunk(chunk))).toBeNull();
	});
});

describe('JNT1', () => {
	it('reads transforms, names and binary-angle rotations', () => {
		const chunk = buildJnt1([
			{ name: 'root', translation: [1, 2, 3] },
			{
				name: 'arm_l',
				scale: [2, 2, 2],
				// 32768 units is a half turn; -16384 is a quarter turn the other way.
				rotation: [32767, -16384, 0],
				translation: [-4, 0, 0],
			},
		]);
		const jnt1 = parseJnt1(chunk, asChunk(chunk));
		expect(jnt1).not.toBeNull();
		expect(jnt1!.joints.map((j) => j.name)).toEqual(['root', 'arm_l']);
		expect(jnt1!.joints[0].translation).toEqual([1, 2, 3]);
		expect(jnt1!.joints[0].scale).toEqual([1, 1, 1]);
		expect(jnt1!.joints[0].inheritScale).toBe(true);
		expect(jnt1!.joints[1].scale).toEqual([2, 2, 2]);
		expect(jnt1!.joints[1].rotationRaw).toEqual([32767, -16384, 0]);
		expect(jnt1!.joints[1].rotation[0]).toBeCloseTo(Math.PI, 3);
		expect(jnt1!.joints[1].rotation[1]).toBeCloseTo(-Math.PI / 2, 6);
		expect(JNT1_ROTATION_SCALE * 32768).toBeCloseTo(Math.PI, 12);
		expect(jnt1!.joints[1].bboxMax).toEqual([1, 1, 1]);
		expect(jnt1!.remapTable).toEqual([0, 1]);
	});

	it('handles an empty joint table', () => {
		const chunk = buildJnt1([]);
		expect(parseJnt1(chunk, asChunk(chunk))!.joints).toEqual([]);
	});

	it('rejects an entry table outside the chunk', () => {
		const chunk = buildJnt1([{ name: 'a' }]);
		new DataView(chunk.buffer).setUint32(0x0c, 0xffff, false);
		expect(parseJnt1(chunk, asChunk(chunk))).toBeNull();
	});
});

describe('EVP1 and DRW1', () => {
	it('slices the concatenated envelope arrays by prefix sum', () => {
		const chunk = buildEvp1([
			{ joints: [0], weights: [1] },
			{ joints: [1, 2, 3], weights: [0.5, 0.25, 0.25] },
			{ joints: [4, 5], weights: [0.75, 0.25] },
		]);
		const file = buildContainer([chunk]);
		const model = parseJ3d(file)!;
		const evp1 = model.evp1!;
		expect(evp1.envelopes.map((e) => e.jointIndices)).toEqual([
			[0],
			[1, 2, 3],
			[4, 5],
		]);
		expect(evp1.envelopes[1].weights).toEqual([0.5, 0.25, 0.25]);
		expect(evp1.envelopes[2].weights).toEqual([0.75, 0.25]);
		// 3x4 matrices: 12 floats each, one per referenced joint (0..5).
		expect(evp1.inverseBindMatrices.length).toBeGreaterThanOrEqual(6 * 12);
		expect(Array.from(evp1.inverseBindMatrices.subarray(0, 4))).toEqual([
			1, 0, 0, 0,
		]);
	});

	it('handles an empty EVP1', () => {
		const model = parseJ3d(buildContainer([buildEvp1([])]))!;
		expect(model.evp1!.envelopes).toEqual([]);
	});

	it('distinguishes rigid from weighted DRW1 entries', () => {
		const model = parseJ3d(
			buildContainer([
				buildDrw1([
					{ isWeighted: false, value: 5 },
					{ isWeighted: true, value: 1 },
					{ isWeighted: false, value: 0 },
				]),
			]),
		)!;
		expect(model.drw1!.entries).toEqual([
			{ index: 0, isWeighted: false, value: 5 },
			{ index: 1, isWeighted: true, value: 1 },
			{ index: 2, isWeighted: false, value: 0 },
		]);
	});
});

describe('whole-model parse', () => {
	it('parses a model with every chunk we understand', () => {
		const file = buildContainer(
			[
				buildInf1([
					{ type: Inf1NodeType.JOINT, index: 0 },
					{ type: Inf1NodeType.DOWN, index: 0 },
					{ type: Inf1NodeType.MATERIAL, index: 0 },
					{ type: Inf1NodeType.DOWN, index: 0 },
					{ type: Inf1NodeType.SHAPE, index: 0 },
					{ type: Inf1NodeType.UP, index: 0 },
					{ type: Inf1NodeType.UP, index: 0 },
				]),
				buildJnt1([{ name: 'root' }]),
				buildEvp1([{ joints: [0], weights: [1] }]),
				buildDrw1([{ isWeighted: false, value: 0 }]),
				buildMat3([{ name: 'mat', textureSlots: [0] }], [0]),
				buildTex1([
					{
						name: 'tex',
						format: 0x04,
						width: 4,
						height: 4,
						data: u16Bytes(...new Array(16).fill(rgb565(0, 0, 255))),
					},
				]),
			],
			{ magic: 'J3D2bdl4' },
		);
		const model = parseJ3d(file)!;
		expect(model.kind).toBe('bdl');
		expect(model.inf1).not.toBeNull();
		expect(model.jnt1!.joints[0].name).toBe('root');
		expect(model.evp1!.envelopes).toHaveLength(1);
		expect(model.drw1!.entries).toHaveLength(1);
		expect(model.mat3!.materials[0].name).toBe('mat');
		expect(model.tex1!.textures[0].name).toBe('tex');
		// Material 0 samples TEX1 texture 0, so a viewer can bind it.
		expect(materialTextureIndex(model, 0)).toBe(0);
		expect(decodeJ3dTexture(model, file, 0)!.pixels.subarray(0, 4)).toEqual(
			new Uint8Array([0, 0, 255, 255]),
		);
	});

	it('keeps the rest of a model when one chunk is corrupt', () => {
		const goodJnt1 = buildJnt1([{ name: 'root' }]);
		const badMat3 = buildMat3([{ name: 'a', textureSlots: [0] }], [1]);
		// Truncate MAT3's payload to below its header size by lying about nothing
		// else: the container still walks, but MAT3 itself cannot be read.
		const brokenMat3 = badMat3.subarray(0, 0x20);
		const w = new Writer();
		w.bytes(brokenMat3);
		w.patchU32(4, 0x20);
		const file = buildContainer([goodJnt1, w.toUint8Array()]);
		const model = parseJ3d(file)!;
		expect(model.jnt1!.joints[0].name).toBe('root');
		expect(model.mat3).toBeNull();
	});
});
