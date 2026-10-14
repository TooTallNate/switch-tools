/**
 * Posing and CPU skinning for BFG MD5 models.
 *
 * idTech's `idQuat::ToMat3` builds the transpose of the usual
 * (Hamilton, column-vector) rotation matrix, so we conjugate each joint
 * quaternion (negate w) and then use the standard formula; joints chain
 * as `world = parent · local`. Checked against the files' stored
 * `invertedDefaultPose`: `world(defaultPose) · inverted` is the identity
 * to within 1e-5 on real models.
 *
 * Matrices are 3×4 row-major, like `idJointMat`.
 */
import type { IdMd5Anim } from './anim.js';
import { sampleBmd5anim } from './anim.js';
import type { IdMd5Mesh, IdMd5Model } from './model.js';

export type JointMat = Float64Array;

export function jointMatrix(q: readonly number[], t: readonly number[]): JointMat {
	const [x, y, z] = [q[0]!, q[1]!, q[2]!];
	const w = -q[3]!;
	const m = new Float64Array(12);
	m[0] = 1 - 2 * (y * y + z * z);
	m[1] = 2 * (x * y - w * z);
	m[2] = 2 * (x * z + w * y);
	m[3] = t[0]!;
	m[4] = 2 * (x * y + w * z);
	m[5] = 1 - 2 * (x * x + z * z);
	m[6] = 2 * (y * z - w * x);
	m[7] = t[1]!;
	m[8] = 2 * (x * z - w * y);
	m[9] = 2 * (y * z + w * x);
	m[10] = 1 - 2 * (x * x + y * y);
	m[11] = t[2]!;
	return m;
}

export function mul34(a: ArrayLike<number>, b: ArrayLike<number>): JointMat {
	const o = new Float64Array(12);
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 4; c++) {
			let s = c === 3 ? a[r * 4 + 3]! : 0;
			for (let k = 0; k < 3; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
			o[r * 4 + c] = s;
		}
	}
	return o;
}

export class Md5Pose {
	readonly model: IdMd5Model;
	/** Skinning matrices (world · inverse bind) of the current pose. */
	skinning: JointMat[];
	/** World matrices of the current pose. */
	world: JointMat[];

	constructor(model: IdMd5Model) {
		this.model = model;
		this.world = this.compose(model.defaultPose);
		this.skinning = this.world.map((w, i) => mul34(w, model.invertedDefaultPose[i] ?? identity()));
	}

	private compose(locals: readonly { q: readonly number[]; t: readonly number[] }[]): JointMat[] {
		const out: JointMat[] = [];
		this.model.joints.forEach((j, i) => {
			const p = locals[i] ?? this.model.defaultPose[i]!;
			const L = jointMatrix(p.q, p.t);
			out[i] = j.parent >= 0 && j.parent < i && out[j.parent] ? mul34(out[j.parent]!, L) : L;
		});
		return out;
	}

	/**
	 * Pose from an animation at a (fractional) frame, or the default
	 * pose for `null`. Animation joints are matched to model joints by
	 * name; unmatched model joints keep their default pose.
	 */
	setPose(anim: IdMd5Anim | null, frame: number): void {
		if (!anim) {
			this.world = this.compose(this.model.defaultPose);
		} else {
			const sampled = sampleBmd5anim(anim, frame);
			const byName = new Map(anim.joints.map((j, i) => [j.name.toLowerCase(), i]));
			const locals = this.model.joints.map((j, i) => {
				const k = byName.get(j.name.toLowerCase());
				return k !== undefined && sampled[k] ? sampled[k]! : this.model.defaultPose[i]!;
			});
			this.world = this.compose(locals);
		}
		this.skinning = this.world.map((w, i) => mul34(w, this.model.invertedDefaultPose[i] ?? identity()));
	}

	/** Linear-blend skin a mesh's bind positions (and normals) into the outputs. */
	skin(mesh: IdMd5Mesh, outPos: Float32Array, outNrm: Float32Array | null, offset = 0): void {
		const n = mesh.positions.length / 3;
		const S = this.skinning;
		for (let v = 0; v < n; v++) {
			const x = mesh.positions[v * 3]!;
			const y = mesh.positions[v * 3 + 1]!;
			const z = mesh.positions[v * 3 + 2]!;
			const nx0 = mesh.normals[v * 3]!;
			const ny0 = mesh.normals[v * 3 + 1]!;
			const nz0 = mesh.normals[v * 3 + 2]!;
			let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, total = 0;
			for (let k = 0; k < 4; k++) {
				const w = mesh.weights[v * 4 + k]!;
				if (w <= 0) continue;
				const m = S[mesh.joints[v * 4 + k]!];
				if (!m) continue;
				total += w;
				px += w * (m[0]! * x + m[1]! * y + m[2]! * z + m[3]!);
				py += w * (m[4]! * x + m[5]! * y + m[6]! * z + m[7]!);
				pz += w * (m[8]! * x + m[9]! * y + m[10]! * z + m[11]!);
				nx += w * (m[0]! * nx0 + m[1]! * ny0 + m[2]! * nz0);
				ny += w * (m[4]! * nx0 + m[5]! * ny0 + m[6]! * nz0);
				nz += w * (m[8]! * nx0 + m[9]! * ny0 + m[10]! * nz0);
			}
			const o = (offset + v) * 3;
			if (total <= 0) {
				outPos[o] = x;
				outPos[o + 1] = y;
				outPos[o + 2] = z;
				if (outNrm) {
					outNrm[o] = nx0;
					outNrm[o + 1] = ny0;
					outNrm[o + 2] = nz0;
				}
				continue;
			}
			outPos[o] = px / total;
			outPos[o + 1] = py / total;
			outPos[o + 2] = pz / total;
			if (outNrm) {
				const l = Math.hypot(nx, ny, nz) || 1;
				outNrm[o] = nx / l;
				outNrm[o + 1] = ny / l;
				outNrm[o + 2] = nz / l;
			}
		}
	}
}

function identity(): Float32Array {
	return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
}
