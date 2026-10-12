/**
 * Game Freak "Trinity" model files (namespace `Hayabusa.Model`), as
 * shipped by Pokémon Legends: Arceus. A model is several magic-less
 * FlatBuffers that name each other:
 *
 *   .trmdl  model: mesh files (one per LOD), skeleton, material files
 *   .trmsh  mesh shapes: vertex layouts, sub-meshes (index range +
 *           material name), buffer file name
 *   .trmbf  the shapes' index + vertex buffers, in shape order
 *   .trmtr  materials: per pass, texture bindings, samplers, params
 *   .trskl  skeleton: transform nodes (local TRS, parent, rig index)
 *   .trmmt  material table (e.g. the shiny `rare` material set)
 *
 * Field slots follow the schemas in pkZukan/PokeDocs
 * (`LA/Flatbuffers/Model/*.fbs`); vertex decoding and the rig-index
 * convention match freedom12/PokemonModelViewer and ChicoEevee's
 * Pokémon Switch Blender importer. Scarlet / Violet use the same
 * files with extra trailing fields, which this reader ignores.
 */

import { FlatBuffer, type Table } from '@tootallnate/gfbmdl';

export type Vec3 = [number, number, number];

export interface TrmdlModel {
	/** Mesh file per LOD (`pm0025_00_00.trmsh`, `…_lod1.trmsh`, …). */
	meshes: string[];
	skeleton: string | null;
	/** Material files (`pm0025_00_00.trmtr`). */
	materials: string[];
	bounds: { min: Vec3; max: Vec3 } | null;
}

/** Vertex attribute semantics (`Attribute` enum). */
export enum TrinityAttribute {
	None = 0,
	Position = 1,
	Normal = 2,
	Tangent = 3,
	Binormal = 4,
	Color = 5,
	Texcoord = 6,
	BlendIndices = 7,
	BlendWeights = 8,
}

/** Vertex element formats (`InputLayoutFormat` enum). */
export enum TrinityFormat {
	None = 0,
	Rgba8Unorm = 20,
	Rgba8Uint = 22,
	R32Uint = 36,
	R32Int = 37,
	Rgba16Unorm = 39,
	Rgba16Float = 43,
	Rg32Float = 48,
	Rgb32Float = 51,
	Rgba32Float = 54,
}

export interface TrinityVertexElement {
	semantic: TrinityAttribute;
	/** e.g. 0 / 1 for TEXCOORD0 / TEXCOORD1. */
	semanticIndex: number;
	format: TrinityFormat;
	/** Byte offset within one vertex of its stream. */
	offset: number;
}

export interface TrinityVertexStream {
	elements: TrinityVertexElement[];
	/** Bytes per vertex. */
	stride: number;
}

export interface TrinitySubMesh {
	indexCount: number;
	indexOffset: number;
	material: string;
}

export interface TrinityShape {
	name: string;
	/** Index element size code: 0 u8, 1 u16, 2 u32, 3 u64. */
	indexFormat: number;
	/** One per vertex buffer of the shape. */
	streams: TrinityVertexStream[];
	subMeshes: TrinitySubMesh[];
	meshName: string;
}

export interface TrmshMesh {
	shapes: TrinityShape[];
	/** The `.trmbf` holding this mesh's buffers. */
	bufferFile: string;
}

export interface TrinityShapeBuffers {
	indices: Uint8Array[];
	vertices: Uint8Array[];
}

export interface TrmbfBuffers {
	/** Per shape, in {@link TrmshMesh.shapes} order. */
	buffers: TrinityShapeBuffers[];
}

export type TrinityWrap = 'repeat' | 'clamp' | 'mirror' | 'mirror-once';

export interface TrinityTexture {
	/** Shader binding, e.g. `BaseColorMap`, `NormalMap`, `LayerMaskMap`. */
	binding: string;
	/** Texture file, e.g. `pm0025_00_00_body_a_alb.bntx`. */
	file: string;
	/** Index into {@link TrinityMaterial.samplers}. */
	slot: number;
}

export interface TrinityMaterial {
	name: string;
	shader: string | null;
	/** Shader switches (`EnableBaseColorMap` → `True`, …). */
	shaderValues: Record<string, string>;
	textures: TrinityTexture[];
	samplers: { wrapU: TrinityWrap; wrapV: TrinityWrap }[];
	floats: Record<string, number>;
	/** Float4 parameters (`BaseColor`, `UVScaleOffset`, …) as RGBA. */
	float4s: Record<string, [number, number, number, number]>;
	ints: Record<string, number>;
	alphaType: string | null;
}

export interface TrmtrMaterials {
	materials: TrinityMaterial[];
}

export enum TrinityNodeType {
	Transform = 0,
	Joint = 1,
	Locator = 2,
}

export interface TrinityNode {
	name: string;
	scale: Vec3;
	/** Euler angles in radians, applied X then Y then Z (`R = Rz·Ry·Rx`). */
	rotation: Vec3;
	translation: Vec3;
	/** Parent node index, or -1. */
	parent: number;
	/** Skinning rig index (what blend indices refer to), or -1. */
	rigIndex: number;
	type: TrinityNodeType;
}

export interface TrsklSkeleton {
	nodes: TrinityNode[];
	/** Number of skinning bones (rig indices 0 … n-1). */
	boneCount: number;
	/** Added to rig indices when merging onto a base skeleton (NPCs). */
	rigOffset: number;
}

export interface TrmmtTable {
	tables: { name: string; files: string[] }[];
}

function root(bytes: Uint8Array): Table {
	const t = new FlatBuffer(bytes).root();
	if (!t.isSane()) throw new Error('Not a FlatBuffer');
	return t;
}

const vec3 = (t: Table | null, slot: number, def: Vec3): Vec3 => (t?.floats(slot, 3) as Vec3 | null) ?? def;

export function parseTrmdl(bytes: Uint8Array): TrmdlModel {
	const t = root(bytes);
	const box = t.table(5);
	return {
		meshes: t.tables(1).map((r) => r.str(0) ?? '').filter(Boolean),
		skeleton: t.table(2)?.str(0) || null,
		materials: t.strings(3),
		bounds: box ? { min: vec3(box, 0, [0, 0, 0]), max: vec3(box, 1, [0, 0, 0]) } : null,
	};
}

export function parseTrmsh(bytes: Uint8Array): TrmshMesh {
	const t = root(bytes);
	return {
		bufferFile: t.str(2) ?? '',
		shapes: t.tables(1).map((s) => ({
			name: s.str(0) ?? '',
			indexFormat: s.u32(2, 0),
			streams: s.tables(3).map((layout) => ({
				elements: layout.tables(0).map((e) => ({
					semantic: e.u32(1) as TrinityAttribute,
					semanticIndex: e.u32(2),
					format: e.u32(3) as TrinityFormat,
					offset: e.u32(4),
				})),
				stride: layout.tables(1)[0]?.u32(0) ?? 0,
			})),
			subMeshes: s.tables(4).map((m) => ({
				indexCount: m.u32(0),
				indexOffset: m.u32(1),
				material: m.str(3) ?? '',
			})),
			meshName: s.str(12) ?? '',
		})),
	};
}

export function parseTrmbf(bytes: Uint8Array): TrmbfBuffers {
	const t = root(bytes);
	const data = (list: Table[]) => list.map((b) => b.bytes(0) ?? new Uint8Array(0));
	return {
		buffers: t.tables(1).map((b) => ({ indices: data(b.tables(0)), vertices: data(b.tables(1)) })),
	};
}

const WRAP: Record<number, TrinityWrap> = { 0: 'repeat', 1: 'clamp', 6: 'mirror', 7: 'mirror-once' };

export function parseTrmtr(bytes: Uint8Array): TrmtrMaterials {
	const t = root(bytes);
	const named = <T>(list: Table[], read: (p: Table) => T): Record<string, T> => {
		const out: Record<string, T> = {};
		for (const p of list) {
			const k = p.str(0);
			if (k) out[k] = read(p);
		}
		return out;
	};
	const rgba = (p: Table) => (p.floats(1, 4) ?? [0, 0, 0, 0]) as [number, number, number, number];
	return {
		materials: t.tables(1).map((m) => {
			const shader = m.tables(1)[0] ?? null;
			return {
				name: m.str(0) ?? '',
				shader: shader?.str(0) ?? null,
				shaderValues: shader ? named(shader.tables(1), (p) => p.str(1) ?? '') : {},
				textures: m.tables(2).map((p) => ({ binding: p.str(0) ?? '', file: p.str(1) ?? '', slot: p.u32(2) })),
				samplers: m.tables(3).map((s) => ({ wrapU: WRAP[s.u32(9)] ?? 'repeat', wrapV: WRAP[s.u32(10)] ?? 'repeat' })),
				floats: named(m.tables(4), (p) => p.f32(1)),
				float4s: { ...named(m.tables(6), rgba), ...named(m.tables(7), rgba) },
				ints: named(m.tables(9), (p) => p.i32(1)),
				alphaType: m.str(15),
			};
		}),
	};
}

export function parseTrskl(bytes: Uint8Array): TrsklSkeleton {
	const t = root(bytes);
	return {
		nodes: t.tables(1).map((n) => {
			const tr = n.table(1);
			return {
				name: n.str(0) ?? '',
				scale: vec3(tr, 0, [1, 1, 1]),
				rotation: vec3(tr, 1, [0, 0, 0]),
				translation: vec3(tr, 2, [0, 0, 0]),
				parent: n.i32(4, -1),
				rigIndex: n.i32(5, -1),
				type: n.u32(7) as TrinityNodeType,
			};
		}),
		boneCount: t.vectorLength(2),
		rigOffset: t.u32(4),
	};
}

export function parseTrmmt(bytes: Uint8Array): TrmmtTable {
	const t = root(bytes);
	return { tables: t.tables(2).map((m) => ({ name: m.str(0) ?? '', files: m.strings(1) })) };
}
