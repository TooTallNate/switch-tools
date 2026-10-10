/**
 * Skeletal posing and CPU linear-blend skinning for a flattened
 * {@link GfbmdlRenderMesh}.
 */

import {
	sampleFloat,
	sampleQuat,
	sampleStep,
	sampleVec3,
	type GfbanmAnimation,
	type GfbanmBoneTrack,
} from './animation.js';
import { composeQuat, eulerZYXToQuat, invert, multiply, type Mat4, type Quat, type Vec3 } from './math.js';
import type { GfbmdlRenderMesh } from './mesh.js';
import type { GfbmdlModel } from './model.js';

export class GfbmdlPose {
	readonly model: GfbmdlModel;
	readonly mesh: GfbmdlRenderMesh;
	private readonly invBind: Mat4[];
	private readonly bindRot: Quat[];
	private readonly order: number[];
	/** Current world matrix per bone. */
	readonly world: Mat4[];
	private readonly skinMats: Mat4[];

	constructor(model: GfbmdlModel, mesh: GfbmdlRenderMesh) {
		this.model = model;
		this.mesh = mesh;
		this.invBind = mesh.bindWorld.map((m) => invert(m));
		this.bindRot = model.bones.map((b) => eulerZYXToQuat(b.rotation));
		this.world = mesh.bindWorld.map((m) => Float64Array.from(m));
		this.skinMats = mesh.bindWorld.map(() => new Float64Array(16));
		// Topological order (parents first), robust to out-of-order lists.
		const n = model.bones.length;
		const visited = new Uint8Array(n);
		const order: number[] = [];
		const visit = (i: number, depth: number) => {
			if (visited[i] || depth > 512) return;
			const p = model.bones[i].parent;
			if (p >= 0 && p < n && p !== i) visit(p, depth + 1);
			if (!visited[i]) {
				visited[i] = 1;
				order.push(i);
			}
		};
		for (let i = 0; i < n; i++) visit(i, 0);
		this.order = order;
	}

	/** Evaluate `anim` at `frame` (or the bind pose when `anim` is null). */
	setPose(anim: GfbanmAnimation | null, frame: number): void {
		const tracks = new Map<string, GfbanmBoneTrack>();
		if (anim) for (const b of anim.bones) tracks.set(b.name, b);
		const local = new Float64Array(16);
		for (const i of this.order) {
			const b = this.model.bones[i];
			const tr = tracks.get(b.name);
			const t: Vec3 = tr?.translation ? sampleVec3(tr.translation, frame) : b.translation;
			const q: Quat = tr?.rotation ? sampleQuat(tr.rotation, frame) : this.bindRot[i];
			const s: Vec3 = tr?.scale ? sampleVec3(tr.scale, frame) : b.scale;
			composeQuat(t, q, s, local);
			const p = b.parent;
			if (p >= 0 && p < this.model.bones.length && p !== i) multiply(this.world[p], local, this.world[i]);
			else this.world[i].set(local);
		}
	}

	/**
	 * Skin the bind-pose mesh into `positions` / `normals` (same layout
	 * as the render mesh) using the current pose. `hidden[groupIndex]`
	 * collapses a group's vertices so its triangles become degenerate.
	 */
	skin(positions: Float32Array, normals: Float32Array | null, hidden?: Uint8Array): void {
		const { mesh } = this;
		for (let b = 0; b < this.skinMats.length; b++) multiply(this.world[b], this.invBind[b], this.skinMats[b]);
		const P = mesh.positions;
		const N = mesh.normals;
		const bi = mesh.boneIndices;
		const bw = mesh.boneWeights;
		for (const sec of mesh.sections) {
			const end = sec.firstVertex + sec.numVertices;
			if (hidden && hidden[sec.groupIndex]) {
				for (let v = sec.firstVertex; v < end; v++) {
					positions[v * 3] = positions[v * 3 + 1] = positions[v * 3 + 2] = 0;
				}
				continue;
			}
			for (let v = sec.firstVertex; v < end; v++) {
				const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
				let ox = 0, oy = 0, oz = 0, nx = 0, ny = 0, nz = 0;
				const hasN = N && normals;
				const ix = hasN ? N![v * 3] : 0, iy = hasN ? N![v * 3 + 1] : 0, iz = hasN ? N![v * 3 + 2] : 0;
				for (let k = 0; k < 4; k++) {
					const w = bw[v * 4 + k];
					if (w === 0) continue;
					const m = this.skinMats[bi[v * 4 + k]];
					if (!m) continue;
					ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
					oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
					oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
					if (hasN) {
						nx += w * (m[0] * ix + m[4] * iy + m[8] * iz);
						ny += w * (m[1] * ix + m[5] * iy + m[9] * iz);
						nz += w * (m[2] * ix + m[6] * iy + m[10] * iz);
					}
				}
				positions[v * 3] = ox;
				positions[v * 3 + 1] = oy;
				positions[v * 3 + 2] = oz;
				if (hasN) {
					const len = Math.hypot(nx, ny, nz) || 1;
					normals![v * 3] = nx / len;
					normals![v * 3 + 1] = ny / len;
					normals![v * 3 + 2] = nz / len;
				}
			}
		}
	}
}

/**
 * Per-group hidden flags for `anim` at `frame`, from its visibility
 * tracks (keyed by the group's bone name). `null` when the animation
 * has no visibility tracks.
 */
export function groupVisibility(model: GfbmdlModel, anim: GfbanmAnimation | null, frame: number): Uint8Array | null {
	if (!anim || anim.visibility.length === 0) return null;
	const byName = new Map(anim.visibility.map((v) => [v.name, v.track]));
	const hidden = new Uint8Array(model.groups.length);
	model.groups.forEach((g, i) => {
		const tr = byName.get(model.bones[g.boneIndex]?.name ?? '');
		if (tr && sampleStep(tr, frame) === 0) hidden[i] = 1;
	});
	return hidden;
}

/**
 * Animated material float values (e.g. `ColorUVTranslateU`) for
 * `anim` at `frame`, keyed by material name then value name.
 */
export function materialValues(anim: GfbanmAnimation | null, frame: number): Map<string, Record<string, number>> {
	const out = new Map<string, Record<string, number>>();
	if (!anim) return out;
	for (const m of anim.materials) {
		if (!m.values.length) continue;
		const rec: Record<string, number> = {};
		for (const v of m.values) rec[v.name] = sampleFloat(v.track, frame);
		out.set(m.name, rec);
	}
	return out;
}
