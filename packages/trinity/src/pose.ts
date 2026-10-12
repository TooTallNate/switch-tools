/**
 * Skeletal posing and CPU linear-blend skinning for Trinity models.
 *
 * Legends: Arceus animations are GFBANM clips (the same format as
 * Let's Go, see `@tootallnate/gfbmdl`) whose bone tracks are keyed by
 * {@link TrinityNode} name. Nodes compose `T · R · S` with
 * `R = Rz·Ry·Rx`; a vertex's blend indices are rig indices, mapped to
 * the node with that `rig_idx` (+ `rig_offset`). Vertices are stored in
 * bind-pose model space, so each skinning matrix is
 * `world(node) · world_bind(node)⁻¹`.
 */

import {
	composeQuat,
	eulerZYXToQuat,
	invert,
	multiply,
	sampleQuat,
	sampleVec3,
	type GfbanmAnimation,
	type GfbanmBoneTrack,
	type Mat4,
	type Quat,
	type Vec3,
} from '@tootallnate/gfbmdl';

import type { TrsklSkeleton } from './model.js';

export class TrinityPose {
	readonly skeleton: TrsklSkeleton;
	/** Current world matrix per node (column-major). */
	readonly world: Mat4[];
	private readonly bindRot: Quat[];
	private readonly invBind: Mat4[];
	private readonly order: number[];
	/** Rig index → node index. */
	private readonly rigNode: Int32Array;
	private readonly skinMats: Mat4[];

	constructor(skeleton: TrsklSkeleton) {
		this.skeleton = skeleton;
		const n = skeleton.nodes.length;
		this.bindRot = skeleton.nodes.map((b) => eulerZYXToQuat(b.rotation));
		this.world = skeleton.nodes.map(() => new Float64Array(16));
		// Parents first, robust to out-of-order lists and bad parents.
		const visited = new Uint8Array(n);
		const order: number[] = [];
		const visit = (i: number, depth: number) => {
			if (visited[i] || depth > 512) return;
			const p = skeleton.nodes[i]!.parent;
			if (p >= 0 && p < n && p !== i) visit(p, depth + 1);
			if (!visited[i]) {
				visited[i] = 1;
				order.push(i);
			}
		};
		for (let i = 0; i < n; i++) visit(i, 0);
		this.order = order;
		this.setPose(null, 0);
		this.invBind = this.world.map((m) => invert(m));
		let maxRig = -1;
		for (const node of skeleton.nodes) if (node.rigIndex >= 0) maxRig = Math.max(maxRig, node.rigIndex + skeleton.rigOffset);
		this.rigNode = new Int32Array(Math.max(maxRig + 1, skeleton.boneCount)).fill(-1);
		skeleton.nodes.forEach((node, i) => {
			if (node.rigIndex >= 0) this.rigNode[node.rigIndex + skeleton.rigOffset] = i;
		});
		this.skinMats = Array.from(this.rigNode, () => new Float64Array(16));
	}

	/** Evaluate `anim` at `frame`, or the bind pose when `anim` is null. */
	setPose(anim: GfbanmAnimation | null, frame: number): void {
		const tracks = new Map<string, GfbanmBoneTrack>();
		if (anim) for (const b of anim.bones) tracks.set(b.name, b);
		const local = new Float64Array(16);
		const nodes = this.skeleton.nodes;
		for (const i of this.order) {
			const node = nodes[i]!;
			const tr = tracks.get(node.name);
			const t: Vec3 = tr?.translation ? sampleVec3(tr.translation, frame) : node.translation;
			const q: Quat = tr?.rotation ? sampleQuat(tr.rotation, frame) : this.bindRot[i]!;
			const s: Vec3 = tr?.scale ? sampleVec3(tr.scale, frame) : node.scale;
			composeQuat(t, q, s, local);
			const p = node.parent;
			if (p >= 0 && p < nodes.length && p !== i) multiply(this.world[p]!, local, this.world[i]!);
			else this.world[i]!.set(local);
		}
	}

	/** World position of every node in the current pose (3 floats each). */
	jointPositions(out = new Float32Array(this.world.length * 3)): Float32Array {
		this.world.forEach((m, i) => out.set([m[12]!, m[13]!, m[14]!], i * 3));
		return out;
	}

	/**
	 * Skin bind-pose `positions` / `normals` (with per-vertex rig
	 * `joints` + `weights`, four each) into `outPositions` / `outNormals`.
	 * Vertices with no weights keep their bind position.
	 */
	skin(
		positions: Float32Array,
		normals: Float32Array | null,
		joints: ArrayLike<number>,
		weights: ArrayLike<number>,
		outPositions: Float32Array,
		outNormals: Float32Array | null,
	): void {
		for (let r = 0; r < this.rigNode.length; r++) {
			const node = this.rigNode[r]!;
			if (node >= 0) multiply(this.world[node]!, this.invBind[node]!, this.skinMats[r]!);
		}
		const n = positions.length / 3;
		const hasN = !!(normals && outNormals);
		for (let v = 0; v < n; v++) {
			const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
			const ix = hasN ? normals![v * 3]! : 0, iy = hasN ? normals![v * 3 + 1]! : 0, iz = hasN ? normals![v * 3 + 2]! : 0;
			let ox = 0, oy = 0, oz = 0, nx = 0, ny = 0, nz = 0, total = 0;
			for (let k = 0; k < 4; k++) {
				const w = weights[v * 4 + k]!;
				if (!(w > 0)) continue;
				const r = joints[v * 4 + k]!;
				if (r >= this.rigNode.length || this.rigNode[r]! < 0) continue;
				const m = this.skinMats[r]!;
				total += w;
				ox += w * (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!);
				oy += w * (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!);
				oz += w * (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
				if (hasN) {
					nx += w * (m[0]! * ix + m[4]! * iy + m[8]! * iz);
					ny += w * (m[1]! * ix + m[5]! * iy + m[9]! * iz);
					nz += w * (m[2]! * ix + m[6]! * iy + m[10]! * iz);
				}
			}
			if (total <= 0) {
				outPositions[v * 3] = x;
				outPositions[v * 3 + 1] = y;
				outPositions[v * 3 + 2] = z;
				if (hasN) {
					outNormals![v * 3] = ix;
					outNormals![v * 3 + 1] = iy;
					outNormals![v * 3 + 2] = iz;
				}
				continue;
			}
			outPositions[v * 3] = ox / total;
			outPositions[v * 3 + 1] = oy / total;
			outPositions[v * 3 + 2] = oz / total;
			if (hasN) {
				const len = Math.hypot(nx, ny, nz) || 1;
				outNormals![v * 3] = nx / len;
				outNormals![v * 3 + 1] = ny / len;
				outNormals![v * 3 + 2] = nz / len;
			}
		}
	}
}
