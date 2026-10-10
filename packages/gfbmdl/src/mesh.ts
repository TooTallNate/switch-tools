/**
 * Flatten a parsed GFBMDL into one renderer-friendly indexed mesh.
 *
 * - Every group's vertices are transformed by its group bone's bind
 *   world matrix. For Pokémon / trainers that bone is identity (the
 *   vertices are already model-space bind pose); for field, demo and
 *   effect models the meshes are rigidly attached to a bone and stored
 *   in that bone's local space.
 * - Each polygon (material-bounded index list) gets its *own* copy of
 *   the vertices it references, so per-material UV transforms and
 *   per-group visibility can be applied per vertex without seams
 *   bleeding between materials.
 * - Skin data is resolved to absolute bone indices. Rigid meshes (no
 *   BoneWeight stream) are weighted 100% to the group bone, so a
 *   single skinning path animates both.
 */

import { composeEuler, identity, multiply, type Mat4 } from './math.js';
import {
	decodeAttribute,
	findAttribute,
	GfbmdlVertexType,
	type GfbmdlModel,
} from './model.js';

export interface GfbmdlRenderSection {
	materialIndex: number;
	groupIndex: number;
	/** Offset into {@link GfbmdlRenderMesh.indices}. */
	firstIndex: number;
	numTriangles: number;
	/** First vertex owned by this section. */
	firstVertex: number;
	numVertices: number;
}

export interface GfbmdlRenderMesh {
	numVertices: number;
	/** Model-space bind-pose positions (xyz). */
	positions: Float32Array;
	/** Model-space bind-pose unit normals (xyz), when present. */
	normals?: Float32Array;
	/** Raw UV0 (uv), untransformed. */
	uv0?: Float32Array;
	/** Raw UV1 (uv), when present. */
	uv1?: Float32Array;
	/** Color0 as RGBA 0..1, when present. */
	colors?: Float32Array;
	/** 4 absolute bone indices per vertex. */
	boneIndices: Uint16Array;
	/** 4 weights per vertex (sum to 1). */
	boneWeights: Float32Array;
	indices: Uint32Array;
	sections: GfbmdlRenderSection[];
	/** Bind-pose world matrix per bone. */
	bindWorld: Mat4[];
}

/** Bind-pose world matrix of every bone (parents before children). */
export function bindWorldMatrices(model: GfbmdlModel): Mat4[] {
	const out: Mat4[] = new Array(model.bones.length);
	const resolve = (i: number, depth: number): Mat4 => {
		if (out[i]) return out[i];
		const b = model.bones[i];
		const local = composeEuler(b.translation, b.rotation, b.scale);
		const p = b.parent;
		out[i] =
			p >= 0 && p < model.bones.length && p !== i && depth < 512
				? multiply(resolve(p, depth + 1), local)
				: local;
		return out[i];
	};
	for (let i = 0; i < model.bones.length; i++) resolve(i, 0);
	return out;
}

function xformPoint(m: Mat4, x: number, y: number, z: number, out: Float32Array, o: number): void {
	out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
	out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
	out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

function xformDir(m: Mat4, x: number, y: number, z: number, out: Float32Array, o: number): void {
	const nx = m[0] * x + m[4] * y + m[8] * z;
	const ny = m[1] * x + m[5] * y + m[9] * z;
	const nz = m[2] * x + m[6] * y + m[10] * z;
	const len = Math.hypot(nx, ny, nz) || 1;
	out[o] = nx / len;
	out[o + 1] = ny / len;
	out[o + 2] = nz / len;
}

export function buildGfbmdlMesh(model: GfbmdlModel): GfbmdlRenderMesh {
	const bindWorld = bindWorldMatrices(model);
	const boneCount = model.bones.length;

	// Pass 1: count output vertices / indices so we allocate once.
	let totalVerts = 0;
	let totalIdx = 0;
	let anyNormals = false, anyUv0 = false, anyUv1 = false, anyColors = false;
	for (const g of model.groups) {
		const mesh = model.meshes[g.meshIndex];
		if (!mesh) continue;
		if (findAttribute(mesh, GfbmdlVertexType.Normal)) anyNormals = true;
		if (findAttribute(mesh, GfbmdlVertexType.UV0)) anyUv0 = true;
		if (findAttribute(mesh, GfbmdlVertexType.UV1)) anyUv1 = true;
		if (findAttribute(mesh, GfbmdlVertexType.Color0)) anyColors = true;
		for (const p of mesh.polygons) {
			const seen = new Uint8Array(mesh.vertexCount);
			let n = 0;
			for (const i of p.indices) {
				if (i < mesh.vertexCount && !seen[i]) {
					seen[i] = 1;
					n++;
				}
			}
			totalVerts += n;
			totalIdx += p.indices.length - (p.indices.length % 3);
		}
	}

	const positions = new Float32Array(totalVerts * 3);
	const normals = anyNormals ? new Float32Array(totalVerts * 3) : undefined;
	const uv0 = anyUv0 ? new Float32Array(totalVerts * 2) : undefined;
	const uv1 = anyUv1 ? new Float32Array(totalVerts * 2) : undefined;
	const colors = anyColors ? new Float32Array(totalVerts * 4).fill(1) : undefined;
	const boneIndices = new Uint16Array(totalVerts * 4);
	const boneWeights = new Float32Array(totalVerts * 4);
	const indices = new Uint32Array(totalIdx);
	const sections: GfbmdlRenderSection[] = [];

	let vOut = 0;
	let iOut = 0;
	model.groups.forEach((g, gi) => {
		const mesh = model.meshes[g.meshIndex];
		if (!mesh) return;
		const M = bindWorld[g.boneIndex] ?? identity();
		const groupBone = g.boneIndex < boneCount ? g.boneIndex : 0;
		const get = (t: GfbmdlVertexType) => {
			const a = findAttribute(mesh, t);
			return a ? { data: decodeAttribute(mesh, a), n: a.count } : null;
		};
		const pos = get(GfbmdlVertexType.Position);
		if (!pos || pos.n < 3) return;
		const nrm = get(GfbmdlVertexType.Normal);
		const t0 = get(GfbmdlVertexType.UV0);
		const t1 = get(GfbmdlVertexType.UV1);
		const col = get(GfbmdlVertexType.Color0);
		const colAttr = findAttribute(mesh, GfbmdlVertexType.Color0);
		const colScale = colAttr && colAttr.format === 3 /* Byte */ ? 1 / 255 : 1;
		const bi = get(GfbmdlVertexType.BoneIndex);
		const bw = get(GfbmdlVertexType.BoneWeight);

		for (const p of mesh.polygons) {
			const remap = new Int32Array(mesh.vertexCount).fill(-1);
			const firstVertex = vOut;
			const firstIndex = iOut;
			const triIdx = p.indices.length - (p.indices.length % 3);
			for (let k = 0; k < triIdx; k++) {
				const src = p.indices[k];
				if (src >= mesh.vertexCount) {
					indices[iOut++] = firstVertex; // degenerate, never out of range
					continue;
				}
				let dst = remap[src];
				if (dst < 0) {
					dst = remap[src] = vOut++;
					const pp = src * pos.n;
					xformPoint(M, pos.data[pp], pos.data[pp + 1], pos.data[pp + 2], positions, dst * 3);
					if (normals && nrm) {
						const q = src * nrm.n;
						xformDir(M, nrm.data[q], nrm.data[q + 1], nrm.data[q + 2], normals, dst * 3);
					}
					if (uv0 && t0) {
						uv0[dst * 2] = t0.data[src * t0.n];
						uv0[dst * 2 + 1] = t0.data[src * t0.n + 1];
					}
					if (uv1 && t1) {
						uv1[dst * 2] = t1.data[src * t1.n];
						uv1[dst * 2 + 1] = t1.data[src * t1.n + 1];
					}
					if (colors && col) {
						for (let c = 0; c < Math.min(4, col.n); c++) colors[dst * 4 + c] = col.data[src * col.n + c] * colScale;
					}
					// Skin: absolute bone indices; rigid → group bone.
					let wsum = 0;
					if (bi && bw) {
						for (let c = 0; c < 4; c++) {
							const w = c < bw.n ? bw.data[src * bw.n + c] : 0;
							const b = c < bi.n ? bi.data[src * bi.n + c] : 0;
							const valid = w > 0 && b < boneCount;
							boneIndices[dst * 4 + c] = valid ? b : groupBone;
							boneWeights[dst * 4 + c] = valid ? w : 0;
							if (valid) wsum += w;
						}
					}
					if (wsum > 0) {
						for (let c = 0; c < 4; c++) boneWeights[dst * 4 + c] /= wsum;
					} else {
						boneIndices[dst * 4] = groupBone;
						boneWeights[dst * 4] = 1;
						for (let c = 1; c < 4; c++) {
							boneIndices[dst * 4 + c] = groupBone;
							boneWeights[dst * 4 + c] = 0;
						}
					}
				}
				indices[iOut++] = dst;
			}
			sections.push({
				materialIndex: p.materialIndex,
				groupIndex: gi,
				firstIndex,
				numTriangles: (iOut - firstIndex) / 3,
				firstVertex,
				numVertices: vOut - firstVertex,
			});
		}
	});

	return {
		numVertices: vOut,
		positions,
		normals,
		uv0,
		uv1,
		colors,
		boneIndices,
		boneWeights,
		indices,
		sections,
		bindWorld,
	};
}
