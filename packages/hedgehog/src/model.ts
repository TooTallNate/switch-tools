/**
 * Hedgehog Engine skeletal models (`.model`) and terrain models
 * (`.terrain-model`), after HedgeLib++ `hl_hh_model.h` / `.cpp`.
 *
 * Payload (big-endian; offsets per {@link readMirage}):
 *
 *   skeletal v2   mesh slot, 2 unknown arrays, nodeCount, nodes, matrices
 *   skeletal v4   mesh groups, 3 unknown arrays, nodeCount, nodes, matrices
 *   skeletal v5   mesh groups, 1 unknown array (morphs), nodeCount, nodes, matrices
 *   skeletal v6   v5 with 16-bit bone palettes (Frontiers terrain and up)
 *   terrain v5    mesh groups, name (and flags)
 *
 * A mesh group has three slots (opaque, transparent, punch-through), a
 * table of "special" slots (named, e.g. water) and its name inline.
 * A mesh: material name, u16 faces, vertex count / size / data, a
 * D3DVERTEXELEMENT9 list (stream, offset, Xbox 360 D3DDECLTYPE,
 * method, usage, usage index; stream 0xFF ends it), a bone palette and
 * texture units. Faces are a list or 0xFFFF-restarted strips (sample
 * chunk `Topology` node: 3 list, 4 strip; strips are the default).
 *
 * Nodes are (parent index, name); the matrices are each node's inverse
 * bind matrix, stored row-major for column vectors.
 */

import { findNode, readMirage, type MirageData } from './mirage.js';
import { primaryModelData } from './needle.js';

export type HhMeshSlot = 'opaque' | 'transparent' | 'punch' | string;

export interface HhMesh {
	group: string;
	slot: HhMeshSlot;
	material: string;
	vertexCount: number;
	positions: Float32Array;
	normals: Float32Array | null;
	/** UV sets (`texcoord` usage index 0, 1, …). */
	uvs: Float32Array[];
	colors: Float32Array | null;
	/** Up to 4 influences per vertex, as model node indices (-1 none). */
	joints: Int16Array | null;
	weights: Float32Array | null;
	indices: Uint32Array;
}

export interface HhNode {
	name: string;
	parent: number;
	/** Inverse bind matrix, column-major (three.js order). */
	inverseBind: Float32Array;
}

export interface HhModel {
	kind: 'skeletal' | 'terrain';
	version: number;
	name: string | null;
	meshes: HhMesh[];
	nodes: HhNode[];
}

const F = {
	float1: 0x2c83a4,
	float2: 0x2c23a5,
	float3: 0x2a23b9,
	float4: 0x1a23a6,
	int1: 0x2c83a1,
	int2: 0x2c23a2,
	int4: 0x1a23a3,
	uint1: 0x2c82a1,
	uint2: 0x2c22a2,
	uint4: 0x1a22a3,
	d3dColor: 0x182886,
	ubyte4: 0x1a2286,
	byte4: 0x1a2386,
	ubyte4Norm: 0x1a2086,
	byte4Norm: 0x1a2186,
	short2: 0x2c2359,
	short4: 0x1a235a,
	ushort2: 0x2c2259,
	ushort4: 0x1a225a,
	short2Norm: 0x2c2159,
	short4Norm: 0x1a215a,
	ushort2Norm: 0x2c2059,
	ushort4Norm: 0x1a205a,
	udec3: 0x2a2287,
	dec3: 0x2a2387,
	udec3Norm: 0x2a2087,
	dec3Norm: 0x2a2187,
	udec4Norm: 0x1a2087,
	dec4Norm: 0x1a2187,
	float16_2: 0x2c235f,
	float16_4: 0x1a2360,
} as const;

function half(h: number): number {
	const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}
const snorm = (v: number, bits: number) => {
	const max = (1 << (bits - 1)) - 1;
	const x = v & ((1 << bits) - 1);
	const signed = x & (1 << (bits - 1)) ? x - (1 << bits) : x;
	return Math.max(-1, signed / max);
};
const unorm = (v: number, bits: number) => (v & ((1 << bits) - 1)) / ((1 << bits) - 1);

/** Decode one vertex element to 4 numbers. Unknown formats give zeros. */
export function readVertexElement(dv: DataView, o: number, format: number): [number, number, number, number] {
	const f32 = (k: number) => dv.getFloat32(o + k * 4, false);
	const u8 = (k: number) => dv.getUint8(o + k);
	switch (format) {
		case F.float1:
			return [f32(0), 0, 0, 1];
		case F.float2:
			return [f32(0), f32(1), 0, 1];
		case F.float3:
			return [f32(0), f32(1), f32(2), 1];
		case F.float4:
			return [f32(0), f32(1), f32(2), f32(3)];
		case F.ubyte4:
			return [u8(0), u8(1), u8(2), u8(3)];
		case F.ubyte4Norm:
			return [u8(0) / 255, u8(1) / 255, u8(2) / 255, u8(3) / 255];
		case F.d3dColor:
			// ARGB in a big-endian u32.
			return [u8(1) / 255, u8(2) / 255, u8(3) / 255, u8(0) / 255];
		case F.byte4:
			return [dv.getInt8(o), dv.getInt8(o + 1), dv.getInt8(o + 2), dv.getInt8(o + 3)];
		case F.byte4Norm:
			return [0, 1, 2, 3].map((k) => Math.max(-1, dv.getInt8(o + k) / 127)) as [number, number, number, number];
		case F.short2:
			return [dv.getInt16(o, false), dv.getInt16(o + 2, false), 0, 1];
		case F.short4:
			return [0, 1, 2, 3].map((k) => dv.getInt16(o + k * 2, false)) as [number, number, number, number];
		case F.ushort2:
			return [dv.getUint16(o, false), dv.getUint16(o + 2, false), 0, 1];
		case F.ushort4:
			return [0, 1, 2, 3].map((k) => dv.getUint16(o + k * 2, false)) as [number, number, number, number];
		case F.short2Norm:
			return [Math.max(-1, dv.getInt16(o, false) / 32767), Math.max(-1, dv.getInt16(o + 2, false) / 32767), 0, 1];
		case F.short4Norm:
			return [0, 1, 2, 3].map((k) => Math.max(-1, dv.getInt16(o + k * 2, false) / 32767)) as [number, number, number, number];
		case F.ushort2Norm:
			return [dv.getUint16(o, false) / 65535, dv.getUint16(o + 2, false) / 65535, 0, 1];
		case F.ushort4Norm:
			return [0, 1, 2, 3].map((k) => dv.getUint16(o + k * 2, false) / 65535) as [number, number, number, number];
		case F.dec3Norm:
		case F.dec4Norm: {
			const v = dv.getUint32(o, false);
			return [snorm(v, 10), snorm(v >>> 10, 10), snorm(v >>> 20, 10), format === F.dec4Norm ? snorm(v >>> 30, 2) : 0];
		}
		case F.udec3Norm:
		case F.udec4Norm: {
			const v = dv.getUint32(o, false);
			return [unorm(v, 10), unorm(v >>> 10, 10), unorm(v >>> 20, 10), unorm(v >>> 30, 2)];
		}
		case F.float16_2:
			return [half(dv.getUint16(o, false)), half(dv.getUint16(o + 2, false)), 0, 1];
		case F.float16_4:
			return [0, 1, 2, 3].map((k) => half(dv.getUint16(o + k * 2, false))) as [number, number, number, number];
		case F.uint1:
		case F.int1:
			return [format === F.int1 ? dv.getInt32(o, false) : dv.getUint32(o, false), 0, 0, 1];
		default:
			return [0, 0, 0, 0];
	}
}

const USAGE = { position: 0, blendWeight: 1, blendIndices: 2, normal: 3, texcoord: 5, color: 10 } as const;

function readMesh(m: MirageData, at: number, wideBones: boolean, strips: boolean, group: string, slot: string): HhMesh {
	const { dv, u32, off, str } = m;
	const material = str(off(at));
	const faceCount = u32(at + 4), faceAt = off(at + 8);
	const vertexCount = u32(at + 12), vertexSize = u32(at + 16), vtx = off(at + 20), elAt = off(at + 24);
	const boneCount = u32(at + 28), boneAt = off(at + 32);
	const palette: number[] = [];
	for (let i = 0; i < boneCount; i++) palette.push(wideBones ? dv.getUint16(boneAt + i * 2, false) : dv.getUint8(boneAt + i));

	const elements: { offset: number; format: number; usage: number; index: number }[] = [];
	for (let e = elAt; e + 12 <= m.bytes.length; e += 12) {
		const stream = dv.getUint16(e, false), format = dv.getUint32(e + 4, false);
		if (stream === 0xff || format === 0xffffffff) break;
		elements.push({ offset: dv.getUint16(e + 2, false), format, usage: dv.getUint8(e + 9), index: dv.getUint8(e + 10) });
		if (elements.length > 32) break;
	}
	const has = (usage: number, index = 0) => elements.find((e) => e.usage === usage && e.index === index);

	const positions = new Float32Array(vertexCount * 3);
	const nEl = has(USAGE.normal), cEl = has(USAGE.color), jEl = has(USAGE.blendIndices), wEl = has(USAGE.blendWeight);
	const uvEls = elements.filter((e) => e.usage === USAGE.texcoord).sort((a, b) => a.index - b.index);
	const normals = nEl ? new Float32Array(vertexCount * 3) : null;
	const colors = cEl ? new Float32Array(vertexCount * 4) : null;
	const uvs = uvEls.map(() => new Float32Array(vertexCount * 2));
	const joints = jEl && palette.length ? new Int16Array(vertexCount * 4).fill(-1) : null;
	const weights = joints ? new Float32Array(vertexCount * 4) : null;
	const pEl = has(USAGE.position);
	for (let v = 0; v < vertexCount; v++) {
		const base = vtx + v * vertexSize;
		if (pEl) {
			const p = readVertexElement(dv, base + pEl.offset, pEl.format);
			positions.set([p[0], p[1], p[2]], v * 3);
		}
		if (nEl && normals) {
			const n = readVertexElement(dv, base + nEl.offset, nEl.format);
			normals.set([n[0], n[1], n[2]], v * 3);
		}
		if (cEl && colors) colors.set(readVertexElement(dv, base + cEl.offset, cEl.format), v * 4);
		uvEls.forEach((e, k) => {
			const t = readVertexElement(dv, base + e.offset, e.format);
			uvs[k]![v * 2] = t[0];
			uvs[k]![v * 2 + 1] = t[1];
		});
		if (jEl && joints && weights) {
			const j = readVertexElement(dv, base + jEl.offset, jEl.format);
			const w = wEl ? readVertexElement(dv, base + wEl.offset, wEl.format) : [1, 0, 0, 0];
			// D3D convention: weights may leave the last one implicit.
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += w[k]!;
			for (let k = 0; k < 4; k++) {
				const wt = sum > 0 ? w[k]! / sum : k === 0 ? 1 : 0;
				const idx = j[k]!;
				if (wt <= 0 || idx >= palette.length) continue;
				joints[v * 4 + k] = palette[idx]!;
				weights[v * 4 + k] = wt;
			}
		}
	}

	const faces: number[] = [];
	for (let i = 0; i < faceCount; i++) faces.push(dv.getUint16(faceAt + i * 2, false));
	let indices: number[];
	if (strips) {
		indices = [];
		let flip = false;
		for (let i = 2; i < faces.length; i++) {
			const a = faces[i - 2]!, b = faces[i - 1]!, c = faces[i]!;
			if (a === 0xffff || b === 0xffff || c === 0xffff) {
				flip = false;
				if (c === 0xffff) i += 2;
				continue;
			}
			if (a !== b && b !== c && a !== c) indices.push(...(flip ? [a, c, b] : [a, b, c]));
			flip = !flip;
		}
	} else {
		indices = faces.slice(0, faces.length - (faces.length % 3));
	}
	return {
		group,
		slot,
		material,
		vertexCount,
		positions,
		normals,
		uvs,
		colors,
		joints,
		weights,
		indices: Uint32Array.from(indices.filter((x) => x < vertexCount).length === indices.length ? indices : indices.map((x) => Math.min(x, vertexCount - 1))),
	};
}

function readGroup(m: MirageData, at: number, wideBones: boolean, strips: boolean, out: HhMesh[], named = true): void {
	const { u32, off, str } = m;
	const name = named ? str(at + 0x28) : '';
	const slots = ['opaque', 'transparent', 'punch'];
	for (let s = 0; s < (named ? 3 : 1); s++) {
		const n = u32(at + s * 8), list = off(at + s * 8 + 4);
		for (let i = 0; i < n; i++) out.push(readMesh(m, off(list + i * 4), wideBones, strips, name, slots[s]!));
	}
	if (!named) return;
	const sc = u32(at + 0x18), types = off(at + 0x1c), counts = off(at + 0x20), meshes = off(at + 0x24);
	for (let i = 0; i < sc; i++) {
		const type = str(off(types + i * 4));
		const n = u32(off(counts + i * 4));
		const list = off(meshes + i * 4);
		for (let k = 0; k < n; k++) out.push(readMesh(m, off(list + k * 4), wideBones, strips, name, type));
	}
}

function readGroups(m: MirageData, at: number, wideBones: boolean, strips: boolean, out: HhMesh[]): void {
	const n = m.u32(at), list = m.off(at + 4);
	for (let i = 0; i < n; i++) readGroup(m, m.off(list + i * 4), wideBones, strips, out);
}

function readNodes(m: MirageData, count: number, nodesAt: number, matsAt: number): HhNode[] {
	const nodes: HhNode[] = [];
	for (let i = 0; i < count; i++) {
		const n = m.off(nodesAt + i * 4);
		const inv = new Float32Array(16);
		for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) inv[c * 4 + r] = m.dv.getFloat32(matsAt + i * 64 + (r * 4 + c) * 4, false);
		nodes.push({ name: m.str(m.off(n + 4)), parent: m.dv.getInt32(n, false), inverseBind: inv });
	}
	return nodes;
}

/** Parse a `.model` (skeletal) or `.terrain-model`, unwrapping Needle archives. */
export function parseHhModel(bytes: Uint8Array, kind: 'skeletal' | 'terrain' = 'skeletal', lod: 'highest' | 'lowest' = 'highest'): HhModel {
	const m = readMirage(primaryModelData(bytes, lod));
	const topology = findNode(m.nodes, 'Topology');
	const strips = topology ? topology.value !== 3 : true;
	const meshes: HhMesh[] = [];
	const d = m.data, v = m.version;
	if (kind === 'terrain') {
		readGroups(m, d, false, strips, meshes);
		const nameAt = m.off(d + 8);
		return { kind, version: v, name: nameAt ? m.str(nameAt) : null, meshes, nodes: [] };
	}
	let nodes: HhNode[] = [];
	switch (v) {
		case 2: {
			const n = m.u32(d), list = m.off(d + 4);
			for (let i = 0; i < n; i++) meshes.push(readMesh(m, m.off(list + i * 4), false, strips, '', 'opaque'));
			nodes = readNodes(m, m.u32(d + 0x18), m.off(d + 0x1c), m.off(d + 0x20));
			break;
		}
		case 4:
			readGroups(m, d, false, strips, meshes);
			nodes = readNodes(m, m.u32(d + 0x20), m.off(d + 0x24), m.off(d + 0x28));
			break;
		case 5:
		case 6:
			readGroups(m, d, v === 6, strips, meshes);
			nodes = readNodes(m, m.u32(d + 0x10), m.off(d + 0x14), m.off(d + 0x18));
			break;
		default:
			throw new Error(`Hedgehog Engine model version ${v} is not supported`);
	}
	return { kind, version: v, name: null, meshes, nodes };
}
