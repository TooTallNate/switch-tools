import { describe, expect, it } from 'vitest';

import {
	bakeTerrainColor,
	bakeTrinitySurface,
	uvScaleOffset,
	buildTerrainMesh,
	parseTrtrr,
	sampleTracmMaterials,
	TrinityAttribute,
	TrinityPose,
	TrinityFormat,
	bakeLayeredAlbedo,
	buildTrinityMesh,
	parseTracm,
	parseTrmbf,
	parseTrmdl,
	parseTrmmt,
	parseTrmsh,
	parseTrmtr,
	parseTrskl,
	sniffTrinity,
	trinityReferencedNames,
} from '../src/index.js';
import { F, buildFlatBuffer, type Field } from './fb-builder.js';

// Slots follow pkZukan/PokeDocs LA/Flatbuffers/Model/*.fbs.

const trmdl = () =>
	buildFlatBuffer([
		F.u32(0),
		F.tables([[F.str('mon.trmsh')], [F.str('mon_lod1.trmsh')]]),
		F.table([F.str('mon.trskl')]),
		F.strs(['mon.trmtr']),
	]);

const element = (sem: TrinityAttribute, fmt: TrinityFormat, offset: number): (Field | null)[] => [
	F.i32(0),
	F.u32(sem),
	F.u32(0),
	F.u32(fmt),
	F.u32(offset),
];

/** One shape: 4 vertices (pos f32x3, uv f32x2, joints u8x4, weights u16x4 unorm) = 32 B. */
const trmsh = () =>
	buildFlatBuffer([
		F.u32(0),
		F.tables([
			[
				F.str('mon_body_shape'),
				null,
				F.u32(1), // UINT16
				F.tables([
					[
						F.tables([
							element(TrinityAttribute.Position, TrinityFormat.Rgb32Float, 0),
							element(TrinityAttribute.Texcoord, TrinityFormat.Rg32Float, 12),
							element(TrinityAttribute.BlendIndices, TrinityFormat.Rgba8Uint, 20),
							element(TrinityAttribute.BlendWeights, TrinityFormat.Rgba16Unorm, 24),
						]),
						F.tables([[F.u32(32)]]),
					],
				]),
				F.tables([
					[F.u32(3), F.u32(0), F.u32(0), F.str('body')],
					[F.u32(3), F.u32(3), F.u32(0), F.str('eye')],
				]),
			],
		]),
		F.str('mon.trmbf'),
	]);

function vertexBytes(): Uint8Array {
	const b = new Uint8Array(4 * 32);
	const dv = new DataView(b.buffer);
	for (let v = 0; v < 4; v++) {
		const o = v * 32;
		[v, v * 2, 0].forEach((x, i) => dv.setFloat32(o + i * 4, x, true));
		dv.setFloat32(o + 12, v / 4, true);
		dv.setFloat32(o + 16, 1 - v / 4, true);
		b[o + 20] = v;
		dv.setUint16(o + 24, 65535, true);
	}
	return b;
}

const trmbf = () =>
	buildFlatBuffer([
		F.u32(0),
		F.tables([[F.tables([[F.bytes(new Uint8Array(new Uint16Array([0, 1, 2, 1, 3, 2]).buffer))]]), F.tables([[F.bytes(vertexBytes())]])]]),
	]);

const rgba = (c: number[]) => F.floats(c);
const trmtr = () =>
	buildFlatBuffer([
		F.u32(0),
		F.tables([
			[
				F.str('body'),
				F.tables([[F.str('Standard'), F.tables([[F.str('EnableBaseColorMap'), F.str('True')]])]]),
				F.tables([
					[F.str('BaseColorMap'), F.str('mon_body_alb.bntx'), F.u32(0)],
					[F.str('LayerMaskMap'), F.str('mon_body_lym.bntx'), F.u32(1)],
				]),
				F.tables([
					[null, null, null, null, null, null, null, null, null, F.u32(1), F.u32(6)],
					[],
				]),
				F.tables([[F.str('Roughness'), F.f32(0.5)]]),
				null,
				null,
				F.tables([
					[F.str('BaseColorLayer1'), rgba([0.5, 0.25, 0, 1])],
					[F.str('UVScaleOffset'), rgba([2, 1, 0, 0])],
				]),
			],
		]),
	]);

const trskl = () =>
	buildFlatBuffer([
		F.u32(0),
		F.tables([
			[F.str('root'), F.table([F.floats([1, 1, 1]), F.floats([0, 0, 0]), F.floats([0, 0, 0])]), null, null, F.i32(-1), F.i32(-1)],
			[F.str('waist'), F.table([F.floats([1, 1, 1]), F.floats([0, 0, 0]), F.floats([0, 1, 0])]), null, null, F.i32(0), F.i32(0)],
		]),
		F.tables([[F.u8(0)]]),
	]);

const trmmt = () => buildFlatBuffer([F.u32(0), F.u32(0), F.tables([[F.str('rare'), F.strs(['mon_rare.trmtr'])]])]);

describe('parsers', () => {
	it('reads a model', () => {
		const m = parseTrmdl(trmdl());
		expect(m.meshes).toEqual(['mon.trmsh', 'mon_lod1.trmsh']);
		expect(m.skeleton).toBe('mon.trskl');
		expect(m.materials).toEqual(['mon.trmtr']);
	});

	it('reads materials, samplers and parameters', () => {
		const [m] = parseTrmtr(trmtr()).materials;
		expect(m!.name).toBe('body');
		expect(m!.shader).toBe('Standard');
		expect(m!.shaderValues).toEqual({ EnableBaseColorMap: 'True' });
		expect(m!.textures.map((t) => t.binding)).toEqual(['BaseColorMap', 'LayerMaskMap']);
		expect(m!.samplers[0]).toEqual({ wrapU: 'clamp', wrapV: 'mirror' });
		expect(m!.floats.Roughness).toBe(0.5);
		expect(m!.float4s.UVScaleOffset).toEqual([2, 1, 0, 0]);
	});

	it('reads a skeleton', () => {
		const s = parseTrskl(trskl());
		expect(s.nodes.map((n) => [n.name, n.parent, n.rigIndex])).toEqual([
			['root', -1, -1],
			['waist', 0, 0],
		]);
		expect(s.nodes[1]!.translation).toEqual([0, 1, 0]);
		expect(s.boneCount).toBe(1);
	});

	it('reads a material table', () => {
		expect(parseTrmmt(trmmt()).tables).toEqual([{ name: 'rare', files: ['mon_rare.trmtr'] }]);
	});
});

describe('buildTrinityMesh', () => {
	it('decodes vertex streams, indices and sub-mesh sections', () => {
		const m = buildTrinityMesh(parseTrmsh(trmsh()), parseTrmbf(trmbf()));
		expect(m.numVertices).toBe(4);
		expect(Array.from(m.positions.subarray(3, 6))).toEqual([1, 2, 0]);
		expect(Array.from(m.uv0!.subarray(2, 4))).toEqual([0.25, 0.75]);
		expect(Array.from(m.joints!.subarray(12, 16))).toEqual([3, 0, 0, 0]);
		expect(m.weights![0]).toBe(1);
		expect(Array.from(m.indices)).toEqual([0, 1, 2, 1, 3, 2]);
		expect(m.sections).toEqual([
			{ material: 'body', shape: 'mon_body_shape', firstIndex: 0, indexCount: 3 },
			{ material: 'eye', shape: 'mon_body_shape', firstIndex: 3, indexCount: 3 },
		]);
	});
});

describe('sniffTrinity', () => {
	it('identifies each file kind', () => {
		expect(sniffTrinity(trmdl())).toBe('trmdl');
		expect(sniffTrinity(trmsh())).toBe('trmsh');
		expect(sniffTrinity(trmbf())).toBe('trmbf');
		expect(sniffTrinity(trmtr())).toBe('trmtr');
		expect(sniffTrinity(trskl())).toBe('trskl');
		expect(sniffTrinity(trmmt())).toBe('trmmt');
		expect(sniffTrinity(new Uint8Array(64))).toBeNull();
	});

	it("lists the files a model names (for archives that only store hashes)", () => {
		const names = trinityReferencedNames('trmdl', trmdl());
		for (const n of ['mon.trmsh', 'mon_lod1.trmsh', 'mon.trskl', 'mon.trmtr', 'mon_rare.trmtr', 'mon.trmbf', 'mon.trmdl']) {
			expect(names).toContain(n);
		}
		expect(trinityReferencedNames('trmsh', trmsh())).toEqual(['mon.trmbf']);
		expect(trinityReferencedNames('trmtr', trmtr())).toEqual(['mon_body_alb.bntx', 'mon_body_lym.bntx']);
	});
});

describe('bakeLayeredAlbedo', () => {
	it('tints the albedo by each layer where its mask is set', () => {
		const [mat] = parseTrmtr(trmtr()).materials;
		// 2×1: left texel masked (R = 255), right not.
		const albedo = { width: 2, height: 1, pixels: new Uint8Array([255, 255, 255, 255, 255, 0, 0, 255]) };
		const mask = { width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 0, 0, 0, 0, 0]) };
		const out = bakeLayeredAlbedo(mat!, albedo, mask)!;
		// White × layer 1 (linear 0.5, 0.25, 0) → sRGB.
		expect(Array.from(out.pixels.subarray(0, 4))).toEqual([188, 137, 0, 255]);
		// Unmasked: albedo unchanged.
		expect(Array.from(out.pixels.subarray(4, 8))).toEqual([255, 0, 0, 255]);
	});
});

describe('parseTracm', () => {
	it('reads per-shape visibility', () => {
		const flag = (v: boolean) => F.table([null, null, F.table([F.u8(1), F.table([F.bool(v)])])]);
		const bytes = buildFlatBuffer([
			F.table([F.u32(0), F.u32(120), F.u32(60)]),
			F.tables([
				[F.str('mon_body_shape'), null, null, null, null, flag(true)],
				[F.str('mon_longtongue_shape'), null, null, null, null, flag(false)],
				[F.str('mon_eye_shape')],
			]),
		]);
		const c = parseTracm(bytes);
		expect([c.frameCount, c.fps]).toEqual([120, 60]);
		expect([...c.visibility]).toEqual([
			['mon_body_shape', true],
			['mon_longtongue_shape', false],
		]);
	});
});

describe('TrinityPose', () => {
	const skl = parseTrskl(trskl()); // root → waist (rig 0) at (0, 1, 0)
	const positions = new Float32Array([0, 1, 0, 1, 1, 0]);
	const joints = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]);
	const weights = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);

	it('skins the bind pose to the input', () => {
		const pose = new TrinityPose(skl);
		const out = new Float32Array(6);
		pose.skin(positions, null, joints, weights, out, null);
		expect(Array.from(out)).toEqual([0, 1, 0, 1, 1, 0]);
	});

	it('moves weighted vertices with an animated bone; unweighted ones stay', () => {
		const pose = new TrinityPose(skl);
		const anim = {
			frameCount: 1,
			fps: 60,
			bones: [{ name: 'waist', scale: null, translation: { kind: 'fixed' as const, frames: null, values: [[0, 3, 0] as [number, number, number]] }, rotation: null }],
			materials: [],
			visibility: [],
			triggers: [],
		};
		pose.setPose(anim, 0);
		const out = new Float32Array(6);
		pose.skin(positions, null, joints, weights, out, null);
		expect(Array.from(out)).toEqual([0, 3, 0, 1, 1, 0]);
		expect(Array.from(pose.jointPositions().subarray(3, 6))).toEqual([0, 3, 0]);
	});
});

describe('tracm material curves', () => {
	it('samples float4 curves per material, interpolating keys', () => {
		const keys = (pairs: [number, number][]) => F.table([F.tables(pairs.map(([t, v]) => [F.f32(t), F.f32(v)]))]);
		const bytes = buildFlatBuffer([
			F.table([F.u32(0), F.u32(10), F.u32(60)]),
			F.tables([
				[
					F.str('mon_eye_shape'),
					null,
					null,
					null,
					F.table([
						null,
						null,
						F.tables([[F.str('eye'), null, F.tables([[F.str('UVScaleOffset'), F.table([keys([[0, 1]]), keys([[0, 1]]), keys([[0, 0]]), keys([[0, 0], [10, -0.5]])])]])]]),
					]),
				],
			]),
		]);
		const clip = parseTracm(bytes);
		expect(sampleTracmMaterials(clip, 5).get('eye')?.UVScaleOffset).toEqual([1, 1, 0, -0.25]);
	});
});

describe('bakeTrinitySurface', () => {
	const material = (extra: Partial<ReturnType<typeof parseTrmtr>['materials'][number]> = {}) => ({
		...parseTrmtr(trmtr()).materials[0]!,
		...extra,
	});
	const solid = (w: number, h: number, rgba: number[]) => ({ width: w, height: h, pixels: Uint8Array.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]!) });

	it('draws the eye highlight through its own UV transform', () => {
		const mat = material({
			shaderValues: { EnableHighlight: 'True' },
			textures: [
				{ binding: 'BaseColorMap', file: 'a', slot: 0 },
				{ binding: 'HighlightMaskMap', file: 'h', slot: 0 },
			],
			samplers: [{ wrapU: 'clamp', wrapV: 'clamp' }],
			float4s: { UVScaleOffset: [1, 1, 0, 0], UVScaleOffset1: [1, 1, 0.5, 0] },
		});
		// Highlight mask: left half white, right half black (clamped).
		const mask = { width: 2, height: 1, pixels: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]) };
		// UVScaleOffset1 shifts the mask +0.5 in U: raw u = 0.125 samples
		// mask u = 0.625, the black half.
		const out = bakeTrinitySurface(mat, { BaseColorMap: solid(1, 1, [0, 0, 0, 255]), HighlightMaskMap: mask }, { u0: 0, v0: 0, u1: 1, v1: 1, width: 4, height: 1 });
		expect(out.pixels[0]).toBe(0);
		// Animated back to no offset, the left half lights up.
		const out2 = bakeTrinitySurface(mat, { BaseColorMap: solid(1, 1, [0, 0, 0, 255]), HighlightMaskMap: mask }, { u0: 0, v0: 0, u1: 1, v1: 1, width: 4, height: 1 }, { UVScaleOffset1: [1, 1, 0, 0] });
		expect(out2.pixels[0]).toBe(255);
		expect(out2.pixels[3 * 4]).toBe(0);
	});

	it('ignores the UV scale in translate-only (UVTransformMode T) eyes', () => {
		const shaderValues = { UVTransformMode: 'T' };
		const mat = material({
			shaderValues,
			textures: [{ binding: 'BaseColorMap', file: 'a', slot: 0 }],
			samplers: [{ wrapU: 'clamp', wrapV: 'clamp' }],
			// Magnemite's eye: taken literally, (2, 4) clamps to the edge.
			float4s: { UVScaleOffset: [2, 4, 0, 0] },
		});
		expect(uvScaleOffset(mat)).toEqual([1, 1, 0, 0]);
		expect(uvScaleOffset(mat, [2, 4, 0.5, 0])).toEqual([1, 1, 0.5, 0]);
		expect(uvScaleOffset(material({ shaderValues: {}, float4s: { UVScaleOffset: [2, 4, 0, 0] } }))).toEqual([2, 4, 0, 0]);
		// 2×1 albedo: black left, white right. Scaled by 2, raw u = 0.375
		// would sample the white half; unscaled it stays black.
		const albedo = { width: 2, height: 1, pixels: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) };
		const out = bakeTrinitySurface(mat, { BaseColorMap: albedo }, { u0: 0, v0: 0, u1: 1, v1: 1, width: 4, height: 1 });
		expect([0, 1, 2, 3].map((x) => out.pixels[x * 4])).toEqual([0, 0, 255, 255]);
	});
});

describe('terrain', () => {
	it('reads tile bounds as width, height, depth (stored Z-up)', () => {
		const bytes = buildFlatBuffer([
			null,
			F.table([F.f32(1025), F.f32(1025), F.f32(121.5), F.u32(8), F.u32(2048)]),
			F.table([F.u32(1024), F.u32(1024)]),
			F.u32(1),
			F.tables([[F.str('tree.trmdl'), F.strs(['tile_tree_X0Z0_d0.trins'])]]),
			null,
			null,
			F.table([F.str('tile.trmtr')]),
			F.strs(['tile_detailmap_0.trtbf']),
		]);
		const t = parseTrtrr(bytes);
		expect(t.size).toEqual({ x: 1025, y: 121.5, z: 1025 });
		expect(t.material).toBe('tile.trmtr');
		expect(sniffTrinity(bytes)).toBe('trtrr');
		expect(trinityReferencedNames('trtrr', bytes)).toEqual(expect.arrayContaining(['tile.trtrr', 'tile_tree_X0Z0_d0.trins', 'tile_detailmap_0.trtbf']));
	});

	it('displaces a grid by the heightmap', () => {
		const m = buildTerrainMesh(new Float32Array([0, 0, 0, 1]), 2, 2, { x: 10, y: 4, z: 20 });
		expect(m.numVertices).toBe(4);
		expect(Array.from(m.positions.subarray(9, 12))).toEqual([10, 4, 20]);
		expect(m.indices.length).toBe(6);
	});

	it('blends layer colours by splat weight', () => {
		const control = [{ width: 1, height: 1, pixels: new Uint8Array([255, 255, 0, 0]) }];
		const img = bakeTerrainColor(control, [[1, 0, 0], [0, 0, 1], null, null]);
		// Equal red / blue in linear space → sRGB 188 each.
		expect(Array.from(img.pixels)).toEqual([188, 0, 188, 255]);
	});
});
