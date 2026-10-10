import { describe, expect, it } from 'vitest';
import {
	albedoTextureMap,
	applyUvTransform,
	buildGfbmdlMesh,
	colorUvTransform,
	GfbmdlPose,
	groupVisibility,
	layer1TextureMap,
	materialHints,
	materialValues,
	parseGfbanm,
	parseGfbanmcfg,
	parseGfbmdl,
	sampleVec3,
	sniffGflx,
	unpackQuaternion,
} from '../src/index.js';
import { buildFlatBuffer, F, f32Bytes, u16Bytes, type Field } from './fb-builder.js';

// ---- fixtures ----

function material(
	name: string,
	shader: string,
	textures: [sampler: string, index: number][],
	values: Record<string, number> = {},
	opts: { discard?: boolean; switches?: Record<string, boolean> } = {},
): (Field | null)[] {
	return [
		F.str(name),
		F.str(shader),
		F.i32(0),
		null,
		null,
		null,
		null,
		null,
		F.i32(0),
		null,
		null,
		F.tables(
			textures.map(([sampler, index]) => [
				F.str(sampler),
				F.i32(index),
				F.table([F.u32(0), F.u32(2), F.u32(1), F.u32(0), F.f32(0), F.f32(-2), F.f32(0), F.f32(0), F.f32(0)]),
			]),
		),
		F.tables(Object.entries(opts.switches ?? {}).map(([k, v]) => [F.str(k), F.bool(v)])),
		F.tables(Object.entries(values).map(([k, v]) => [F.str(k), F.f32(v)])),
		F.tables([[F.str('ConstantColor'), F.floats([0.5, 0.25, 1])]]),
		null,
		null,
		null,
		null,
		null,
		F.table([F.tables([[F.str('DiscardEnable'), F.bool(!!opts.discard)]]), F.tables([[F.str('CullMode'), F.i32(0)]]), null]),
	];
}

function bone(name: string, parent: number, t: number[], r = [0, 0, 0], s = [1, 1, 1]): (Field | null)[] {
	return [F.str(name), F.u32(1), F.i32(parent), F.u32(0), F.bool(true), F.floats(s), F.floats(r), F.floats(t)];
}

/** Two meshes: one rigid (on bone 1), one skinned 100% to bone 2. */
function buildModel(): Uint8Array {
	// Mesh 0: Position f32x3 + UV0 f32x2, one triangle.
	const rigid = new Float32Array([0, 1, 0, 0.25, 0.25, 1, 0, 0, 0.5, 0.5, 0, 0, 1, 0.75, 1]);
	// Mesh 1: Position f32x3 + BoneIndex u8x4 + BoneWeight unorm8x4.
	const skinned = new Uint8Array(3 * 20);
	const dv = new DataView(skinned.buffer);
	[
		[0, 0, 0],
		[1, 0, 0],
		[0, 0, 1],
	].forEach((p, i) => {
		p.forEach((c, k) => dv.setFloat32(i * 20 + k * 4, c, true));
		skinned.set([2, 0, 0, 0], i * 20 + 12);
		skinned.set([255, 0, 0, 0], i * 20 + 16);
	});
	return buildFlatBuffer([
		F.u32(0x18020511),
		F.floats([-1, 0, -1, 1, 11, 1]),
		F.strs(['body_col', 'dummy_col', 'iris_lyc', 'shadow_tbl']),
		F.strs(['Body', 'Eye', 'Shadow']),
		null,
		F.strs(['Body', 'Eye', 'Shadow']),
		F.tables([
			material('Body', 'PokeDefaultShader', [['Col0Tex', 0], ['EmissionMaskTex', 1]], {
				ColorUVScaleU: 2,
				ColorUVTranslateU: 1,
			}),
			material('Eye', 'CharaEyeShader', [['L0ColTex', 1], ['L1ColTex', 2]], { L1ScaleU: 2, L1ScaleV: 4 }, { discard: true }),
			material('Shadow', 'FieldShadowOnlyShader', [['ShadowToonTable', 3]]),
		]),
		F.tables([
			[F.u32(1), F.u32(0), F.floats([0, 0, 0, 1, 1, 1]), F.u32(0)],
			[F.u32(2), F.u32(1), F.floats([0, 0, 0, 1, 1, 1]), F.u32(0)],
		]),
		F.tables([
			[
				F.tables([[F.u32(0), F.u16s([0, 1, 2])], [F.u32(1), F.u16s([2, 1, 0])]]),
				F.tables([
					[F.u32(0), F.u32(0), F.u32(3)],
					[F.u32(3), F.u32(0), F.u32(2)],
				]),
				F.bytes(new Uint8Array(rigid.buffer)),
			],
			[
				F.tables([[F.u32(2), F.u16s([0, 1, 2])]]),
				F.tables([
					[F.u32(0), F.u32(0), F.u32(3)],
					[F.u32(11), F.u32(3), F.u32(4)],
					[F.u32(12), F.u32(8), F.u32(4)],
				]),
				F.bytes(skinned),
			],
		]),
		F.tables([
			bone('Root', -1, [0, 0, 0]),
			// Rotation (π/2, 0, π/2) distinguishes Z·Y·X from X·Y·Z order.
			bone('Rigid', 0, [0, 10, 0], [Math.PI / 2, 0, Math.PI / 2]),
			bone('Skin', 0, [5, 0, 0]),
		]),
	]);
}

/** Pack a quaternion the way GFBANM stores it (reference BigInt layout). */
function packQuat(x: number, y: number, z: number, extra: number): [number, number, number] {
	const cq = ((((BigInt(x) << 30n) | (BigInt(y) << 15n) | BigInt(z)) << 3n) | BigInt(extra)) & 0xffffffffffffn;
	return [Number(cq & 0xffffn), Number((cq >> 16n) & 0xffffn), Number((cq >> 32n) & 0xffffn)];
}

function buildAnim(): Uint8Array {
	// Identity rotation: extra=3 puts the reconstructed component in W;
	// 0x4000 is the S15 encoding of zero.
	const q = u16Bytes(packQuat(0x4000, 0x4000, 0x4000, 3));
	return buildFlatBuffer([
		F.table([F.u32(0), F.u32(11), F.u32(30)]),
		F.table([
			F.tables([
				[
					F.str('Skin'),
					null,
					null,
					F.u8(1),
					F.table([F.struct(q)]),
					F.u8(3),
					F.table([F.u16s([0, 10]), F.structs(f32Bytes([5, 0, 0, 5, 10, 0]), 2)]),
				],
			]),
		]),
		F.table([
			F.tables([
				[F.str('Body'), null, F.tables([[F.str('ColorUVTranslateU'), F.u8(2), F.table([F.f32v([0, 0.5, 0.5])])]]), null],
			]),
		]),
		F.table([F.tables([[F.str('Rigid'), F.u8(1), F.table([F.u8(0)])]])]),
	]);
}

function buildConfig(): Uint8Array {
	return buildFlatBuffer([
		null,
		null,
		F.i32(0),
		F.i32(0),
		null,
		null,
		F.table([F.tables([[F.str('fi01_wait01'), F.str('pm0000_00_fi01_wait01.gfbanm')]])]),
	]);
}

// ---- tests ----

describe('parseGfbmdl', () => {
	const model = parseGfbmdl(buildModel());

	it('reads names, materials and texture bindings', () => {
		expect(model.version).toBe(0x18020511);
		expect(model.materialNames).toEqual(['Body', 'Eye', 'Shadow']);
		const body = model.materials[0];
		expect(body.shader).toBe('PokeDefaultShader');
		expect(body.textures[0]).toMatchObject({ sampler: 'Col0Tex', texture: 'body_col', wrapS: 'mirror', wrapT: 'clamp' });
		expect(body.values.ColorUVScaleU).toBe(2);
		expect(body.colors.ConstantColor).toEqual([0.5, 0.25, 1]);
		expect(model.materials[1].common.switches.DiscardEnable).toBe(true);
	});

	it('decodes the vertex layout and bones', () => {
		expect(model.meshes[0].stride).toBe(20);
		expect(model.meshes[0].vertexCount).toBe(3);
		expect(model.meshes[1].attributes.map((a) => a.type)).toEqual([0, 11, 12]);
		expect(model.bones[1]).toMatchObject({ name: 'Rigid', parent: 0, translation: [0, 10, 0] });
	});

	it('rejects garbage', () => {
		expect(() => parseGfbmdl(new Uint8Array(8))).toThrow();
	});
});

describe('buildGfbmdlMesh', () => {
	const model = parseGfbmdl(buildModel());
	const mesh = buildGfbmdlMesh(model);

	it('gives each polygon its own vertices', () => {
		expect(mesh.sections.map((s) => [s.materialIndex, s.numVertices])).toEqual([
			[0, 3],
			[1, 3],
			[2, 3],
		]);
		expect(mesh.numVertices).toBe(9);
		for (const i of mesh.indices) expect(i).toBeLessThan(mesh.numVertices);
	});

	it('places rigid meshes with the group bone (Euler Z·Y·X)', () => {
		// (0,1,0) → Rx(π/2) → (0,0,1) → Rz(π/2) → (0,0,1), + (0,10,0).
		const p = Array.from(mesh.positions.subarray(0, 3)).map((x) => Math.round(x * 1e4) / 1e4);
		expect(p).toEqual([0, 10, 1]);
		// Rigid vertices are weighted 100% to the group bone.
		expect(Array.from(mesh.boneIndices.subarray(0, 4))).toEqual([1, 1, 1, 1]);
		expect(mesh.boneWeights[0]).toBe(1);
	});

	it('keeps skinned weights and absolute bone indices', () => {
		const v = mesh.sections[2].firstVertex;
		expect(mesh.boneIndices[v * 4]).toBe(2);
		expect(mesh.boneWeights[v * 4]).toBeCloseTo(1);
	});

	it('reproduces the bind pose when skinned at rest', () => {
		const pose = new GfbmdlPose(model, mesh);
		pose.setPose(null, 0);
		const out = new Float32Array(mesh.positions.length);
		pose.skin(out, null);
		for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(mesh.positions[i], 4);
	});
});

describe('materials', () => {
	const model = parseGfbmdl(buildModel());

	it('picks albedo and layer-1 maps', () => {
		expect(albedoTextureMap(model.materials[0])?.texture).toBe('body_col');
		expect(albedoTextureMap(model.materials[2])).toBeNull();
		expect(layer1TextureMap(model.materials[1])?.texture).toBe('iris_lyc');
	});

	it('applies the colour UV transform in V-flipped space', () => {
		const t = colorUvTransform(model.materials[0]);
		expect(t).toMatchObject({ scaleU: 2, translateU: 1, scaleV: 1 });
		expect(applyUvTransform(t, 0.25, 0.25)).toEqual([2.5, 0.75]);
	});

	it('flags hidden and alpha-tested materials', () => {
		expect(materialHints(model.materials[0])).toEqual({ hidden: false, alphaTest: false });
		expect(materialHints(model.materials[1]).alphaTest).toBe(true);
		expect(materialHints(model.materials[2]).hidden).toBe(true);
	});
});

describe('animation', () => {
	const model = parseGfbmdl(buildModel());
	const mesh = buildGfbmdlMesh(model);
	const anim = parseGfbanm(buildAnim());

	it('parses tracks', () => {
		expect(anim.frameCount).toBe(11);
		expect(anim.fps).toBe(30);
		expect(anim.bones[0].name).toBe('Skin');
		expect(anim.bones[0].rotation?.values[0].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 0, 0, 1]);
		expect(anim.bones[0].translation?.kind).toBe('framed');
	});

	it('interpolates framed tracks', () => {
		expect(sampleVec3(anim.bones[0].translation!, 5)).toEqual([5, 5, 0]);
	});

	it('skins a posed vertex', () => {
		const pose = new GfbmdlPose(model, mesh);
		pose.setPose(anim, 10);
		const out = new Float32Array(mesh.positions.length);
		pose.skin(out, null);
		const v = mesh.sections[2].firstVertex;
		// Skin bone moved from (5,0,0) to (5,10,0).
		expect(out[v * 3 + 1] - mesh.positions[v * 3 + 1]).toBeCloseTo(10);
	});

	it('samples material values and visibility', () => {
		expect(materialValues(anim, 1).get('Body')?.ColorUVTranslateU).toBeCloseTo(0.5);
		expect(Array.from(groupVisibility(model, anim, 0)!)).toEqual([1, 0]);
	});

	it('unpacks quaternions like the 48-bit reference', () => {
		const ref = (a: number, b: number, c: number) => {
			const cq = (BigInt(c) << 32n) | (BigInt(b) << 16n) | BigInt(a);
			const extra = Number(cq & 7n);
			const num = cq >> 3n;
			const s15 = (u: number) => {
				const sign = (u >> 14) & 1;
				u &= 0x3fff;
				return sign === 0 ? u - 0x4000 : u;
			};
			const k = 1 / (0x399e * Math.SQRT2);
			const x = s15(Number((num >> 30n) & 0x7fffn)) * k;
			const y = s15(Number((num >> 15n) & 0x7fffn)) * k;
			const z = s15(Number(num & 0x7fffn)) * k;
			const q = [Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)), x, y, z];
			const sw = [[0, 3, 2, 1], [3, 0, 2, 1], [3, 2, 0, 1], [3, 2, 1, 0]][extra & 3];
			const r = sw.map((i) => q[i]);
			return extra >> 2 ? r.map((v) => -v) : r;
		};
		let seed = 12345;
		const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xffff;
		for (let i = 0; i < 2000; i++) {
			const a = rnd(), b = rnd(), c = rnd();
			const got = unpackQuaternion(a, b, c);
			ref(a, b, c).forEach((v, k) => expect(got[k]).toBeCloseTo(v, 12));
		}
	});
});

describe('parseGfbanmcfg', () => {
	it('lists state → file', () => {
		expect(parseGfbanmcfg(buildConfig()).animations).toEqual([
			{ name: 'fi01_wait01', file: 'pm0000_00_fi01_wait01.gfbanm' },
		]);
	});
});

describe('sniffGflx', () => {
	it('tells the three formats apart', () => {
		expect(sniffGflx(buildModel())).toBe('gfbmdl');
		expect(sniffGflx(buildAnim())).toBe('gfbanm');
		expect(sniffGflx(buildConfig())).toBe('gfbanmcfg');
	});

	it('rejects non-FlatBuffers', () => {
		expect(sniffGflx(new Uint8Array(64).fill(0xab))).toBeNull();
		expect(sniffGflx(new TextEncoder().encode('BNTX\0\0\0\0 not a flatbuffer at all'))).toBeNull();
	});
});
