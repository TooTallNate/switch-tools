import { describe, expect, it } from 'vitest';

import {
	TrinityAttribute,
	TrinityFormat,
	bakeLayeredAlbedo,
	buildTrinityMesh,
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
