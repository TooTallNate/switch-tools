/**
 * Posing Hedgehog Engine models with a PXD skeleton and clip.
 *
 * A clip's track `i` drives skeleton bone `i` with a local transform
 * (translation, rotation, scale). Scale is "aligned", as in the PXD
 * Animation Tools' Blender import: it scales a bone and its children's
 * geometry but not its children's positions. Model nodes are matched to
 * skeleton bones by name; nodes the skeleton doesn't have (helpers,
 * physics bones) keep their bind offset from their parent.
 *
 * Matrices are column-major (three.js order), column vectors.
 */

import type { HhNode } from './model.js';
import type { PxdSkeleton } from './pxd.js';

export type Mat4 = Float32Array;

export function mat4Multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4 = new Float32Array(16)): Mat4 {
	const r = new Float32Array(16);
	for (let c = 0; c < 4; c++)
		for (let i = 0; i < 4; i++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + i]! * b[c * 4 + k]!;
			r[c * 4 + i] = s;
		}
	out.set(r);
	return out;
}

/** Inverse of an affine matrix (rotation · scale + translation). */
export function mat4InvertAffine(m: ArrayLike<number>): Mat4 {
	const a = m[0]!, b = m[1]!, c = m[2]!, d = m[4]!, e = m[5]!, f = m[6]!, g = m[8]!, h = m[9]!, i = m[10]!;
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
	const det = a * A + b * B + c * C || 1;
	const o = new Float32Array(16);
	o[0] = A / det;
	o[1] = -(b * i - c * h) / det;
	o[2] = (b * f - c * e) / det;
	o[4] = B / det;
	o[5] = (a * i - c * g) / det;
	o[6] = -(a * f - c * d) / det;
	o[8] = C / det;
	o[9] = -(a * h - b * g) / det;
	o[10] = (a * e - b * d) / det;
	const tx = m[12]!, ty = m[13]!, tz = m[14]!;
	o[12] = -(o[0]! * tx + o[4]! * ty + o[8]! * tz);
	o[13] = -(o[1]! * tx + o[5]! * ty + o[9]! * tz);
	o[14] = -(o[2]! * tx + o[6]! * ty + o[10]! * tz);
	o[15] = 1;
	return o;
}

/** T · R (no scale) from a translation and an x, y, z, w quaternion. */
function trMatrix(t: ArrayLike<number>, q: ArrayLike<number>, at = 0, qAt = 0): Mat4 {
	let x = q[qAt]!, y = q[qAt + 1]!, z = q[qAt + 2]!, w = q[qAt + 3]!;
	const l = Math.hypot(x, y, z, w) || 1;
	x /= l;
	y /= l;
	z /= l;
	w /= l;
	const m = new Float32Array(16);
	m[0] = 1 - 2 * (y * y + z * z);
	m[1] = 2 * (x * y + z * w);
	m[2] = 2 * (x * z - y * w);
	m[4] = 2 * (x * y - z * w);
	m[5] = 1 - 2 * (x * x + z * z);
	m[6] = 2 * (y * z + x * w);
	m[8] = 2 * (x * z + y * w);
	m[9] = 2 * (y * z - x * w);
	m[10] = 1 - 2 * (x * x + y * y);
	m[12] = t[at]!;
	m[13] = t[at + 1]!;
	m[14] = t[at + 2]!;
	m[15] = 1;
	return m;
}

/**
 * Each skeleton bone's world matrix for one frame of `transforms`
 * (12 floats per track, `@tootallnate/acl-wasm` layout), or for the
 * skeleton's bind pose when `transforms` is null. Tracks past the
 * clip's track count keep the bind pose.
 */
export function pxdWorldMatrices(skeleton: PxdSkeleton, transforms: Float32Array | null, frame = 0, tracks = 0): Mat4[] {
	const n = skeleton.bones.length;
	const tr: Mat4[] = new Array(n);
	const scale: [number, number, number][] = new Array(n);
	const out: Mat4[] = new Array(n);
	for (let i = 0; i < n; i++) {
		const b = skeleton.bones[i]!;
		let local: Mat4, s: [number, number, number];
		if (transforms && i < tracks) {
			const o = (frame * tracks + i) * 12;
			local = trMatrix(transforms, transforms, o + 4, o);
			const sx = transforms[o + 8]!, sy = transforms[o + 9]!, sz = transforms[o + 10]!;
			s = sx === 0 && sy === 0 && sz === 0 ? [1, 1, 1] : [sx, sy, sz];
		} else {
			local = trMatrix(b.translation, b.rotation);
			s = [...b.scale];
		}
		const p = b.parent >= 0 && b.parent < i ? b.parent : -1;
		tr[i] = p >= 0 ? mat4Multiply(tr[p]!, local) : local;
		scale[i] = p >= 0 ? [scale[p]![0] * s[0], scale[p]![1] * s[1], scale[p]![2] * s[2]] : s;
		const m = tr[i]!.slice();
		for (let r = 0; r < 3; r++) {
			m[r] = m[r]! * scale[i]![0];
			m[4 + r] = m[4 + r]! * scale[i]![1];
			m[8 + r] = m[8 + r]! * scale[i]![2];
		}
		out[i] = m;
	}
	return out;
}

/**
 * Skinning matrices (world · inverse bind) for every model node, given
 * the skeleton's bone world matrices from {@link pxdWorldMatrices}.
 */
export function hhSkinMatrices(nodes: HhNode[], skeleton: PxdSkeleton, boneWorlds: Mat4[]): Mat4[] {
	const byName = new Map(skeleton.bones.map((b, i) => [b.name, i]));
	const bindWorld = nodes.map((n) => mat4InvertAffine(n.inverseBind));
	const world: Mat4[] = new Array(nodes.length);
	const resolve = (i: number, depth = 0): Mat4 => {
		if (world[i]) return world[i]!;
		const bone = byName.get(nodes[i]!.name);
		let w: Mat4;
		if (bone !== undefined) w = boneWorlds[bone]!;
		else {
			const p = nodes[i]!.parent;
			if (p >= 0 && p < nodes.length && p !== i && depth < 256) {
				// Keep the bind offset from the (posed) parent.
				const offset = mat4Multiply(nodes[p]!.inverseBind, bindWorld[i]!);
				w = mat4Multiply(resolve(p, depth + 1), offset);
			} else w = bindWorld[i]!;
		}
		world[i] = w;
		return w;
	};
	return nodes.map((n, i) => mat4Multiply(resolve(i), n.inverseBind));
}
