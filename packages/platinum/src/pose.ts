/**
 * Skeleton posing and CPU skinning for WMB3 models with MOT clips.
 *
 * A bone's local matrix is `T · Rz · Ry · Rx · S` (Euler XYZ, radians),
 * the convention of bayonetta_tools' `Linalg.get_transformation_matrix`.
 * World matrices chain parent-first; WMB vertices are stored in the bind
 * pose, so a vertex skins by `world(pose) · inverse(world(bind))`.
 */
import type { Mot } from './mot.js';
import type { Wmb } from './wmb.js';

/** Column-major 4×4. */
export type Mat4 = Float64Array;

export function trsMatrix(t: readonly number[], r: readonly number[], s: readonly number[]): Mat4 {
	const [cx, cy, cz] = [Math.cos(r[0]!), Math.cos(r[1]!), Math.cos(r[2]!)];
	const [sx, sy, sz] = [Math.sin(r[0]!), Math.sin(r[1]!), Math.sin(r[2]!)];
	// R = Rz · Ry · Rx
	const r00 = cz * cy;
	const r01 = cz * sy * sx - sz * cx;
	const r02 = cz * sy * cx + sz * sx;
	const r10 = sz * cy;
	const r11 = sz * sy * sx + cz * cx;
	const r12 = sz * sy * cx - cz * sx;
	const r20 = -sy;
	const r21 = cy * sx;
	const r22 = cy * cx;
	const m = new Float64Array(16);
	m[0] = r00 * s[0]!;
	m[1] = r10 * s[0]!;
	m[2] = r20 * s[0]!;
	m[4] = r01 * s[1]!;
	m[5] = r11 * s[1]!;
	m[6] = r21 * s[1]!;
	m[8] = r02 * s[2]!;
	m[9] = r12 * s[2]!;
	m[10] = r22 * s[2]!;
	m[12] = t[0]!;
	m[13] = t[1]!;
	m[14] = t[2]!;
	m[15] = 1;
	return m;
}

export function mul(a: Mat4, b: Mat4): Mat4 {
	const o = new Float64Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
		}
	}
	return o;
}

/** Inverse of an affine matrix. */
export function invert(m: Mat4): Mat4 {
	const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	const inv = det === 0 ? 0 : 1 / det;
	const o = new Float64Array(16);
	o[0] = A * inv;
	o[4] = -(b * i - c * h) * inv;
	o[8] = (b * f - c * e) * inv;
	o[1] = B * inv;
	o[5] = (a * i - c * g) * inv;
	o[9] = -(a * f - c * d) * inv;
	o[2] = C * inv;
	o[6] = -(a * h - b * g) * inv;
	o[10] = (a * e - b * d) * inv;
	const [tx, ty, tz] = [m[12]!, m[13]!, m[14]!];
	o[12] = -(o[0]! * tx + o[4]! * ty + o[8]! * tz);
	o[13] = -(o[1]! * tx + o[5]! * ty + o[9]! * tz);
	o[14] = -(o[2]! * tx + o[6]! * ty + o[10]! * tz);
	o[15] = 1;
	return o;
}

/** Bones ordered so every parent precedes its children. */
function topoOrder(wmb: Wmb): number[] {
	const order: number[] = [];
	const seen = new Uint8Array(wmb.bones.length);
	const visit = (i: number, depth: number) => {
		if (seen[i] || depth > 512) return;
		const p = wmb.bones[i]!.parent;
		if (p >= 0 && p < wmb.bones.length && p !== i) visit(p, depth + 1);
		if (!seen[i]) {
			seen[i] = 1;
			order.push(i);
		}
	};
	for (let i = 0; i < wmb.bones.length; i++) visit(i, 0);
	return order;
}

export class WmbPose {
	readonly wmb: Wmb;
	readonly bindWorld: Mat4[];
	readonly inverseBind: Mat4[];
	/** Current world matrices (bind pose until {@link setPose}). */
	world: Mat4[];
	/** Skinning matrices: world · inverseBind. */
	skinning: Mat4[];
	private order: number[];

	constructor(wmb: Wmb) {
		this.wmb = wmb;
		this.order = topoOrder(wmb);
		this.bindWorld = this.compose(() => null);
		this.inverseBind = this.bindWorld.map(invert);
		this.world = this.bindWorld;
		this.skinning = this.bindWorld.map(() => identity());
	}

	private compose(override: (bone: number) => { t: number[]; r: number[]; s: number[] } | null): Mat4[] {
		const out: Mat4[] = new Array(this.wmb.bones.length);
		for (const i of this.order) {
			const b = this.wmb.bones[i]!;
			const o = override(i);
			const local = trsMatrix(o?.t ?? b.localPosition, o?.r ?? b.localRotation, o?.s ?? b.localScale);
			const p = b.parent;
			out[i] = p >= 0 && p < out.length && out[p] ? mul(out[p]!, local) : local;
		}
		return out;
	}

	/** Pose from a clip at a (fractional) frame; `null` restores the bind pose. */
	setPose(mot: Mot | null, frame: number): void {
		if (!mot) {
			this.world = this.bindWorld;
			this.skinning = this.bindWorld.map(() => identity());
			return;
		}
		const per = new Map<number, { t: number[]; r: number[]; s: number[] }>();
		for (const c of mot.curves) {
			if (c.boneId < 0) continue;
			const bi = this.wmb.boneIndexForId(c.boneId);
			if (bi < 0) continue;
			let e = per.get(bi);
			if (!e) {
				const b = this.wmb.bones[bi]!;
				e = { t: [...b.localPosition], r: [...b.localRotation], s: [...b.localScale] };
				per.set(bi, e);
			}
			const v = c.sample(frame);
			if (!Number.isFinite(v)) continue;
			if (c.channel <= 2) e.t[c.channel] = v;
			else if (c.channel <= 5) e.r[c.channel - 3] = v;
			else if (c.channel >= 7 && c.channel <= 9) e.s[c.channel - 7] = v;
		}
		this.world = this.compose((i) => per.get(i) ?? null);
		this.skinning = this.world.map((w, i) => mul(w, this.inverseBind[i]!));
	}

	/**
	 * Linear-blend skin bind-pose positions / normals into `outPos` /
	 * `outNrm`. Unweighted vertices are copied unchanged.
	 */
	skin(
		positions: Float32Array,
		normals: Float32Array | null,
		bones: Uint16Array,
		weights: Float32Array,
		outPos: Float32Array,
		outNrm: Float32Array | null,
	): void {
		const n = positions.length / 3;
		const S = this.skinning;
		for (let v = 0; v < n; v++) {
			const x = positions[v * 3]!;
			const y = positions[v * 3 + 1]!;
			const z = positions[v * 3 + 2]!;
			let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, total = 0;
			const hx = normals ? normals[v * 3]! : 0;
			const hy = normals ? normals[v * 3 + 1]! : 0;
			const hz = normals ? normals[v * 3 + 2]! : 0;
			for (let j = 0; j < 4; j++) {
				const w = weights[v * 4 + j]!;
				if (w <= 0) continue;
				const m = S[bones[v * 4 + j]!];
				if (!m) continue;
				total += w;
				px += w * (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!);
				py += w * (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!);
				pz += w * (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
				if (normals) {
					nx += w * (m[0]! * hx + m[4]! * hy + m[8]! * hz);
					ny += w * (m[1]! * hx + m[5]! * hy + m[9]! * hz);
					nz += w * (m[2]! * hx + m[6]! * hy + m[10]! * hz);
				}
			}
			if (total <= 0) {
				outPos[v * 3] = x;
				outPos[v * 3 + 1] = y;
				outPos[v * 3 + 2] = z;
				if (normals && outNrm) {
					outNrm[v * 3] = hx;
					outNrm[v * 3 + 1] = hy;
					outNrm[v * 3 + 2] = hz;
				}
				continue;
			}
			outPos[v * 3] = px;
			outPos[v * 3 + 1] = py;
			outPos[v * 3 + 2] = pz;
			if (normals && outNrm) {
				const l = Math.hypot(nx, ny, nz) || 1;
				outNrm[v * 3] = nx / l;
				outNrm[v * 3 + 1] = ny / l;
				outNrm[v * 3 + 2] = nz / l;
			}
		}
	}
}

function identity(): Mat4 {
	const m = new Float64Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}
