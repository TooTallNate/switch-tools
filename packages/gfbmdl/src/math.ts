/**
 * Small column-major 4×4 matrix / quaternion helpers (Three.js layout:
 * element `[c * 4 + r]`), so results can be fed to `Matrix4.fromArray`.
 */

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];
/** Quaternion as `[x, y, z, w]`. */
export type Quat = [number, number, number, number];

export function identity(): Mat4 {
	const m = new Float64Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}

/** `out = a · b` (`out` may alias neither input). */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float64Array(16)): Mat4 {
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			out[c * 4 + r] =
				a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
		}
	}
	return out;
}

/** Compose translation · rotation(quaternion) · scale. */
export function composeQuat(t: Vec3, q: Quat, s: Vec3, out: Mat4 = new Float64Array(16)): Mat4 {
	const [x, y, z, w] = q;
	const x2 = x + x, y2 = y + y, z2 = z + z;
	const xx = x * x2, xy = x * y2, xz = x * z2;
	const yy = y * y2, yz = y * z2, zz = z * z2;
	const wx = w * x2, wy = w * y2, wz = w * z2;
	out[0] = (1 - (yy + zz)) * s[0];
	out[1] = (xy + wz) * s[0];
	out[2] = (xz - wy) * s[0];
	out[3] = 0;
	out[4] = (xy - wz) * s[1];
	out[5] = (1 - (xx + zz)) * s[1];
	out[6] = (yz + wx) * s[1];
	out[7] = 0;
	out[8] = (xz + wy) * s[2];
	out[9] = (yz - wx) * s[2];
	out[10] = (1 - (xx + yy)) * s[2];
	out[11] = 0;
	out[12] = t[0];
	out[13] = t[1];
	out[14] = t[2];
	out[15] = 1;
	return out;
}

/**
 * Euler (radians) → quaternion for the GFLX bone convention: the
 * rotation matrix is `Rz · Ry · Rx` (Three.js Euler order `'ZYX'`).
 */
export function eulerZYXToQuat(e: Vec3): Quat {
	const cx = Math.cos(e[0] / 2), sx = Math.sin(e[0] / 2);
	const cy = Math.cos(e[1] / 2), sy = Math.sin(e[1] / 2);
	const cz = Math.cos(e[2] / 2), sz = Math.sin(e[2] / 2);
	return [
		sx * cy * cz - cx * sy * sz,
		cx * sy * cz + sx * cy * sz,
		cx * cy * sz - sx * sy * cz,
		cx * cy * cz + sx * sy * sz,
	];
}

export function composeEuler(t: Vec3, e: Vec3, s: Vec3, out?: Mat4): Mat4 {
	return composeQuat(t, eulerZYXToQuat(e), s, out);
}

/** General 4×4 inverse. Returns identity for singular input. */
export function invert(m: Mat4, out: Mat4 = new Float64Array(16)): Mat4 {
	const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
	const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
	const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
	const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
	const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
	const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
	const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
	const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
	const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) {
		out.set(identity());
		return out;
	}
	const d = 1 / det;
	out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
	out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
	out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
	out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
	out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
	out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
	out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
	out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
	out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
	out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
	out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
	out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
	out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
	out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
	out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
	out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
	return out;
}

/** Normalised spherical interpolation. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
	let [bx, by, bz, bw] = b;
	let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
	if (cos < 0) {
		cos = -cos;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}
	let k0: number, k1: number;
	if (cos > 0.9995) {
		k0 = 1 - t;
		k1 = t;
	} else {
		const theta = Math.acos(cos);
		const sin = Math.sin(theta);
		k0 = Math.sin((1 - t) * theta) / sin;
		k1 = Math.sin(t * theta) / sin;
	}
	const q: Quat = [a[0] * k0 + bx * k1, a[1] * k0 + by * k1, a[2] * k0 + bz * k1, a[3] * k0 + bw * k1];
	const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
	return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}
