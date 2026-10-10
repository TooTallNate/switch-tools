/**
 * GFBMDL model parser (GFLX schema, model version 0x18020511 as shipped
 * in Pokémon: Let's Go, Pikachu! / Eevee!).
 *
 * Field slots follow Switch-Toolbox's `gfbmdl.fbs` and were verified
 * against every model in the game. Notable corrections to that schema:
 * vertex type 2 is the tangent (the `.fbs` calls it "Binormal"), and
 * the bone `RigidCheck` struct is never present in Let's Go files, so
 * vertex bone indices address the bone array directly.
 */

import { FlatBuffer, type Table } from './flatbuffers.js';

export enum GfbmdlVertexType {
	Position = 0,
	Normal = 1,
	Tangent = 2,
	UV0 = 3,
	UV1 = 4,
	UV2 = 5,
	UV3 = 6,
	Color0 = 7,
	Color1 = 8,
	Color2 = 9,
	Color3 = 10,
	BoneIndex = 11,
	BoneWeight = 12,
	Bitangent = 13,
}

export enum GfbmdlBufferFormat {
	Float = 0,
	HalfFloat = 1,
	Byte = 3,
	Short = 5,
	BytesAsFloat = 8,
}

/** Byte size of one component per buffer format. */
export const BUFFER_FORMAT_SIZE: Record<number, number> = {
	[GfbmdlBufferFormat.Float]: 4,
	[GfbmdlBufferFormat.HalfFloat]: 2,
	[GfbmdlBufferFormat.Byte]: 1,
	[GfbmdlBufferFormat.Short]: 2,
	[GfbmdlBufferFormat.BytesAsFloat]: 1,
};

/** Texture wrap modes as stored in `TextureMapping`. */
export type GfbmdlWrap = 'repeat' | 'clamp' | 'mirror';

export interface GfbmdlBoundingBox {
	min: [number, number, number];
	max: [number, number, number];
}

export interface GfbmdlTextureMap {
	/** Shader sampler name, e.g. `Col0Tex`, `L0ColTex`, `Texture01`. */
	sampler: string;
	/** Index into {@link GfbmdlModel.textureNames}. */
	index: number;
	/** Resolved texture name (the BNTX's embedded name), or `''`. */
	texture: string;
	wrapS: GfbmdlWrap;
	wrapT: GfbmdlWrap;
	lodBias: number;
}

export interface GfbmdlMaterial {
	name: string;
	/** Shader group, e.g. `PokeDefaultShader`, `CharaDefaultShader`. */
	shader: string;
	renderLayer: number;
	shaderIndex: number;
	textures: GfbmdlTextureMap[];
	switches: Record<string, boolean>;
	values: Record<string, number>;
	colors: Record<string, [number, number, number]>;
	/** `MaterialCommon` block (CullMode, BlendMode, ColorMapUvIndex…). */
	common: {
		switches: Record<string, boolean>;
		values: Record<string, number>;
		colors: Record<string, [number, number, number]>;
	};
}

export interface GfbmdlGroup {
	/** Bone the mesh is attached to (its vertices are local to it). */
	boneIndex: number;
	meshIndex: number;
	bbox: GfbmdlBoundingBox | null;
	layer: number;
}

export interface GfbmdlVertexAttribute {
	type: GfbmdlVertexType;
	format: GfbmdlBufferFormat;
	/** Component count (1..4). */
	count: number;
	/** Byte offset within one vertex. */
	offset: number;
	/** Byte size within one vertex. */
	size: number;
}

export interface GfbmdlPolygon {
	materialIndex: number;
	/** u16 triangle list. */
	indices: Uint16Array;
}

export interface GfbmdlMesh {
	polygons: GfbmdlPolygon[];
	attributes: GfbmdlVertexAttribute[];
	stride: number;
	vertexCount: number;
	/** Interleaved vertex data (a view into the source buffer). */
	data: Uint8Array;
}

export interface GfbmdlBone {
	name: string;
	/** 1 = used for skinning, 0 = locator / helper. */
	type: number;
	/** Parent index, or -1 for a root. */
	parent: number;
	/** Local scale. */
	scale: [number, number, number];
	/** Local rotation, Euler radians, applied in Z·Y·X matrix order. */
	rotation: [number, number, number];
	/** Local translation. */
	translation: [number, number, number];
	/** Raw slot-4 flag (`SegmentScale` / `Visible` in Switch-Toolbox). */
	flag: boolean;
}

export interface GfbmdlModel {
	version: number;
	bbox: GfbmdlBoundingBox | null;
	textureNames: string[];
	shaderNames: string[];
	materialNames: string[];
	materials: GfbmdlMaterial[];
	groups: GfbmdlGroup[];
	meshes: GfbmdlMesh[];
	bones: GfbmdlBone[];
}

const WRAP: GfbmdlWrap[] = ['repeat', 'clamp', 'mirror'];

function bbox(a: number[] | null): GfbmdlBoundingBox | null {
	return a ? { min: [a[0], a[1], a[2]], max: [a[3], a[4], a[5]] } : null;
}

function vec3(t: Table, slot: number, def: [number, number, number]): [number, number, number] {
	const f = t.floats(slot, 3);
	return f ? [f[0], f[1], f[2]] : def;
}

function namedBools(list: Table[]): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const s of list) out[s.str(0) ?? ''] = s.bool(1);
	return out;
}

function namedColors(list: Table[]): Record<string, [number, number, number]> {
	const out: Record<string, [number, number, number]> = {};
	for (const s of list) out[s.str(0) ?? ''] = vec3(s, 1, [0, 0, 0]);
	return out;
}

/** Parse a `.gfbmdl` buffer. Vertex data is decoded lazily (see `decodeAttribute`). */
export function parseGfbmdl(bytes: Uint8Array): GfbmdlModel {
	if (bytes.length < 16) throw new Error('Buffer too small to be a GFBMDL');
	const fb = new FlatBuffer(bytes);
	const m = fb.root();
	if (!m.isSane()) throw new Error('Not a GFBMDL (invalid FlatBuffers root table)');

	const textureNames = m.strings(2);
	const shaderNames = m.strings(3);
	const materialNames = m.strings(5);

	const materials: GfbmdlMaterial[] = m.tables(6).map((t) => {
		const values: Record<string, number> = {};
		for (const s of t.tables(13)) values[s.str(0) ?? ''] = s.f32(1);
		const common = t.table(20);
		const commonValues: Record<string, number> = {};
		for (const s of common?.tables(1) ?? []) commonValues[s.str(0) ?? ''] = s.i32(1);
		return {
			name: t.str(0) ?? '',
			shader: t.str(1) ?? '',
			renderLayer: t.i32(2),
			shaderIndex: t.i32(8),
			textures: t.tables(11).map((tm): GfbmdlTextureMap => {
				const index = tm.i32(1);
				const p = tm.table(2);
				return {
					sampler: tm.str(0) ?? '',
					index,
					texture: textureNames[index] ?? '',
					wrapS: WRAP[p?.u32(1) ?? 0] ?? 'repeat',
					wrapT: WRAP[p?.u32(2) ?? 0] ?? 'repeat',
					lodBias: p?.f32(8) ?? 0,
				};
			}),
			switches: namedBools(t.tables(12)),
			values,
			colors: namedColors(t.tables(14)),
			common: {
				switches: namedBools(common?.tables(0) ?? []),
				values: commonValues,
				colors: namedColors(common?.tables(2) ?? []),
			},
		};
	});

	const groups: GfbmdlGroup[] = m.tables(7).map((t) => ({
		boneIndex: t.u32(0),
		meshIndex: t.u32(1),
		bbox: bbox(t.floats(2, 6)),
		layer: t.u32(3),
	}));

	const meshes: GfbmdlMesh[] = m.tables(8).map((t, mi) => {
		let offset = 0;
		const attributes: GfbmdlVertexAttribute[] = t.tables(1).map((a) => {
			const type = a.u32(0) as GfbmdlVertexType;
			const format = a.u32(1) as GfbmdlBufferFormat;
			const count = a.u32(2);
			const compSize = BUFFER_FORMAT_SIZE[format];
			if (compSize === undefined) {
				throw new Error(`Mesh ${mi}: unknown vertex buffer format ${format}`);
			}
			if (count < 1 || count > 4) {
				throw new Error(`Mesh ${mi}: invalid vertex attribute component count ${count}`);
			}
			const attr = { type, format, count, offset, size: compSize * count };
			offset += attr.size;
			return attr;
		});
		const stride = offset;
		const data = t.bytes(2) ?? new Uint8Array(0);
		if (stride === 0 || data.length % stride !== 0) {
			throw new Error(`Mesh ${mi}: vertex data (${data.length} bytes) is not a multiple of the stride (${stride})`);
		}
		const vertexCount = data.length / stride;
		const polygons = t.tables(0).map((p) => ({
			materialIndex: p.u32(0),
			indices: p.u16s(1) ?? new Uint16Array(0),
		}));
		return { polygons, attributes, stride, vertexCount, data };
	});

	const bones: GfbmdlBone[] = m.tables(9).map((t) => ({
		name: t.str(0) ?? '',
		type: t.u32(1),
		parent: t.i32(2),
		flag: t.bool(4),
		scale: vec3(t, 5, [1, 1, 1]),
		rotation: vec3(t, 6, [0, 0, 0]),
		translation: vec3(t, 7, [0, 0, 0]),
	}));

	return {
		version: m.u32(0),
		bbox: bbox(m.floats(1, 6)),
		textureNames,
		shaderNames,
		materialNames,
		materials,
		groups,
		meshes,
		bones,
	};
}

function halfToFloat(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * Decode one vertex attribute into a tightly-packed `Float32Array`
 * of `vertexCount × attr.count` components. `BytesAsFloat` (unorm8)
 * is normalised to 0..1; `Byte` / `Short` are returned as integers.
 */
export function decodeAttribute(mesh: GfbmdlMesh, attr: GfbmdlVertexAttribute): Float32Array {
	const { data, stride, vertexCount } = mesh;
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const n = attr.count;
	const out = new Float32Array(vertexCount * n);
	for (let v = 0; v < vertexCount; v++) {
		let p = v * stride + attr.offset;
		for (let c = 0; c < n; c++) {
			let x: number;
			switch (attr.format) {
				case GfbmdlBufferFormat.Float:
					x = dv.getFloat32(p, true);
					p += 4;
					break;
				case GfbmdlBufferFormat.HalfFloat:
					x = halfToFloat(dv.getUint16(p, true));
					p += 2;
					break;
				case GfbmdlBufferFormat.Byte:
					x = dv.getUint8(p);
					p += 1;
					break;
				case GfbmdlBufferFormat.Short:
					x = dv.getUint16(p, true);
					p += 2;
					break;
				case GfbmdlBufferFormat.BytesAsFloat:
					x = dv.getUint8(p) / 255;
					p += 1;
					break;
				default:
					throw new Error(`Unknown buffer format ${attr.format}`);
			}
			out[v * n + c] = x;
		}
	}
	return out;
}

/** Find the first attribute of `type` in a mesh. */
export function findAttribute(mesh: GfbmdlMesh, type: GfbmdlVertexType): GfbmdlVertexAttribute | undefined {
	return mesh.attributes.find((a) => a.type === type);
}

/**
 * Sampler names that carry the base colour, in priority order. Covers
 * every shader family in Let's Go: Pokémon (`Col0Tex`), trainers
 * (`L0ColTex`), field (`Texture01`, `TextureMap01`, `CliffTex01`, …)
 * and effects (`Tex01WRAP` …).
 */
export const ALBEDO_SAMPLERS = [
	'Col0Tex',
	'L0ColTex',
	'Texture01',
	'TextureMap01',
	'CliffTex01',
	'Rock_tex',
	'GroundTex01',
	'Ground00Tex01',
	'GrassTex01',
	'WaterNetTex01',
	'green_hikari',
	'Tex01WRAP',
	'Tex01CLAMP',
	'Tex01MIRROR',
	'ColorTexWRAP',
	'ColorMap',
	'TextureMap02',
	'Texture02',
	'GroundTex02',
	'WaterNetTex02',
	'Tex02WRAP',
];

/** Samplers that never hold a base colour (ramps, masks, depth, normals…). */
const NON_ALBEDO_SAMPLER =
	/toontable|lighttbl|lighttable|highlighttable|depthbuffer|lightproj|normal|parallax|highl?ight|mask|emission|ambient|specular|sphere|effect|blend|border|reflection|sky_tex|fur|alpha01|light_line|lerp/i;

/** The material's albedo texture map, or `null` when it has none. */
export function albedoTextureMap(mat: GfbmdlMaterial): GfbmdlTextureMap | null {
	const usable = (t: GfbmdlTextureMap) => t.texture !== '';
	for (const s of ALBEDO_SAMPLERS) {
		const t = mat.textures.find((x) => x.sampler === s && usable(x));
		if (t) return t;
	}
	return (
		mat.textures.find((x) => usable(x) && !NON_ALBEDO_SAMPLER.test(x.sampler) && !/^dummy/i.test(x.texture)) ??
		null
	);
}

/**
 * The second colour layer, shown where the albedo's alpha is cut out —
 * e.g. the iris under an eye white. Trainers bind it as `L1ColTex`;
 * Pokémon as `LyCol0Tex`, gated by the `Layer1Enable` switch.
 */
export function layer1TextureMap(mat: GfbmdlMaterial): GfbmdlTextureMap | null {
	const t = mat.textures.find(
		(x) => x.sampler === 'L1ColTex' || (x.sampler === 'LyCol0Tex' && mat.switches.Layer1Enable),
	);
	if (!t || !t.texture || /^(dummy|chara_d_)/i.test(t.texture)) return null;
	return t;
}

/**
 * Colour-map UV transform. The game samples at
 * `base + scale · (uv + translate)` in a V-flipped UV space
 * (`v' = 1 − v`) — Pokémon bodies use this with a mirrored wrap to
 * paint both halves from a half-width texture, and eye / mouth
 * expressions are selected by animating the translation.
 */
export interface GfbmdlUvTransform {
	scaleU: number;
	scaleV: number;
	translateU: number;
	translateV: number;
	baseU: number;
	baseV: number;
}

const pick = (v: Record<string, number>, keys: string[], def: number): number => {
	for (const k of keys) if (v[k] !== undefined) return v[k];
	return def;
};

/** UV transform for the material's albedo (layer 0). */
export function colorUvTransform(mat: GfbmdlMaterial): GfbmdlUvTransform {
	const v = mat.values;
	const sampler = albedoTextureMap(mat)?.sampler ?? '';
	// Field / effect shaders only carry a per-texture scale.
	const fieldScale = /^(Texture01|TextureMap01|CliffTex01|Rock_tex)$/.test(sampler)
		? ['Tex01_Scale_U', 'Tex01_Scale_V']
		: /^Tex01/.test(sampler)
			? ['Tex01ScaleU', 'Tex01ScaleV']
			: sampler === 'ColorMap'
				? ['ColorMapScaleU', 'ColorMapScaleV']
				: null;
	return {
		scaleU: pick(v, ['ColorUVScaleU', 'L0ScaleU', ...(fieldScale ? [fieldScale[0]] : [])], 1),
		scaleV: pick(v, ['ColorUVScaleV', 'L0ScaleV', ...(fieldScale ? [fieldScale[1]] : [])], 1),
		translateU: pick(v, ['ColorUVTranslateU', 'L0UVTranslateU'], 0),
		translateV: pick(v, ['ColorUVTranslateV', 'L0UVTranslateV'], 0),
		baseU: pick(v, ['ColorBaseU', 'L0UVBaseU'], 0),
		baseV: pick(v, ['ColorBaseV', 'L0UVBaseV'], 0),
	};
}

/** UV transform for the trainer second colour layer (`L1ColTex`). */
export function layer1UvTransform(mat: GfbmdlMaterial): GfbmdlUvTransform {
	const v = mat.values;
	return {
		scaleU: pick(v, ['L1ScaleU', 'Layer1UVScaleU'], 1),
		scaleV: pick(v, ['L1ScaleV', 'Layer1UVScaleV'], 1),
		translateU: pick(v, ['L1UVTranslateU', 'Layer1UVTranslateU'], 0),
		translateV: pick(v, ['L1UVTranslateV', 'Layer1UVTranslateV'], 0),
		baseU: pick(v, ['L1UVBaseU', 'Layer1BaseU'], 0),
		baseV: pick(v, ['L1UVBaseV', 'Layer1BaseV'], 0),
	};
}

/** Apply a UV transform to a raw stored UV, returning the sample coordinate. */
export function applyUvTransform(t: GfbmdlUvTransform, u: number, v: number): [number, number] {
	return [t.baseU + t.scaleU * (u + t.translateU), t.baseV + t.scaleV * (1 - v + t.translateV)];
}

/** Shader groups that only draw effects / shadows / collision, never a visible surface. */
const HIDDEN_SHADERS = /ShadowOnly|Collision|FireCore|FireMask|SmokeMask/i;

export interface GfbmdlMaterialHints {
	/** Not drawn in a plain preview (shadow casters, collision, fire masks). */
	hidden: boolean;
	/** Texture alpha is a cutout mask (`DiscardEnable` / alpha test). */
	alphaTest: boolean;
}

export function materialHints(mat: GfbmdlMaterial): GfbmdlMaterialHints {
	return {
		hidden: Boolean(mat.switches.SkipMainRendering) || HIDDEN_SHADERS.test(mat.shader),
		alphaTest: Boolean(mat.common.switches.DiscardEnable || mat.common.switches.TextureAlphaTestEnable),
	};
}
