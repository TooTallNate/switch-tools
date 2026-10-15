/**
 * VBN skeletons (`"VBN "` big-endian, `" NBV"` little-endian), from
 * Bandai Namco's NU3 engine.
 *
 *     0x00  magic   0x04  2 × s16 (version)
 *     0x08  bone count   0x0C  4 × per-type bone counts (bones start at 0x1C)
 *
 * Then per bone: a 64-byte name, type, parent index (0x0FFFFFFF or
 * negative = root) and bone ID (u32s). After all of those, per bone,
 * nine floats: position, Euler rotation (radians) and scale.
 *
 * The local transform is `T · R · S` with `R = Rz · Ry · Rx` (Smash
 * Forge builds the quaternion `z * y * x` and composes `S * R * T` in
 * OpenTK's row-vector convention), and a bone's world transform is
 * its parent's world times its local.
 *
 * Source: Smash Forge `Filetypes/Models/VBN.cs` (`Read`, `update`,
 * `FromEulerAngles`). Pokkén DX bind poses are big-endian.
 */

export interface VbnBone {
	name: string;
	type: number;
	/** Parent bone index, or -1 for a root. */
	parent: number;
	id: number;
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
}

export function isVbn(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 0x18) return false;
	const m = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
	return m === 'VBN ' || m === ' NBV';
}

export function parseVbn(bytes: Uint8Array): VbnBone[] {
	if (!isVbn(bytes)) throw new Error('Not a VBN skeleton');
	const le = bytes[0] === 0x20;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = dv.getUint32(0x08, le);
	if (0x1c + count * (0x4c + 36) > bytes.byteLength) throw new Error('VBN: bone table is out of bounds');
	const bones: VbnBone[] = [];
	let o = 0x1c;
	for (let i = 0; i < count; i++, o += 0x4c) {
		let end = o;
		while (end < o + 64 && bytes[end] !== 0) end++;
		const parent = dv.getInt32(o + 0x44, le);
		bones.push({
			name: new TextDecoder('latin1').decode(bytes.subarray(o, end)),
			type: dv.getUint32(o + 0x40, le),
			parent: parent < 0 || parent === 0x0fffffff || parent >= count ? -1 : parent,
			id: dv.getUint32(o + 0x48, le),
			position: [0, 0, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
		});
	}
	for (const b of bones) {
		const f = (k: number) => dv.getFloat32(o + k * 4, le);
		b.position = [f(0), f(1), f(2)];
		b.rotation = [f(3), f(4), f(5)];
		b.scale = [f(6), f(7), f(8)];
		o += 36;
	}
	return bones;
}

/** Column-major 4×4 matrix. */
export type Mat4 = Float32Array;

function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Float32Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
			out[c * 4 + r] = s;
		}
	}
	return out;
}

/** Local `T · Rz · Ry · Rx · S` for one bone. */
export function vbnLocalMatrix(b: VbnBone): Mat4 {
	const [x, y, z] = b.rotation;
	const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
	// R = Rz * Ry * Rx (column vectors).
	const r00 = cz * cy, r01 = cz * sy * sx - sz * cx, r02 = cz * sy * cx + sz * sx;
	const r10 = sz * cy, r11 = sz * sy * sx + cz * cx, r12 = sz * sy * cx - cz * sx;
	const r20 = -sy, r21 = cy * sx, r22 = cy * cx;
	const [kx, ky, kz] = b.scale;
	const [tx, ty, tz] = b.position;
	return new Float32Array([
		r00 * kx, r10 * kx, r20 * kx, 0,
		r01 * ky, r11 * ky, r21 * ky, 0,
		r02 * kz, r12 * kz, r22 * kz, 0,
		tx, ty, tz, 1,
	]);
}

/** World (bind-pose) matrices for every bone. */
export function vbnWorldMatrices(bones: VbnBone[]): Mat4[] {
	const out: (Mat4 | undefined)[] = new Array(bones.length);
	const visit = (i: number, depth: number): Mat4 => {
		const cached = out[i];
		if (cached) return cached;
		const local = vbnLocalMatrix(bones[i]!);
		const p = bones[i]!.parent;
		const world = p >= 0 && depth < 512 ? multiply(visit(p, depth + 1), local) : local;
		out[i] = world;
		return world;
	};
	return bones.map((_, i) => visit(i, 0));
}

/** Per-bone channel overrides, keyed by `VbnBone.id` (e.g. an OMO sample). */
export interface BonePose {
	t?: [number, number, number];
	/** Quaternion (x, y, z, w). */
	r?: [number, number, number, number];
	s?: [number, number, number];
}

/** `T · R(q) · S` as a column-major matrix. */
function composeQuat(t: readonly number[], q: readonly number[], s: readonly number[]): Mat4 {
	const [x, y, z, w] = q as [number, number, number, number];
	const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
	const [kx, ky, kz] = s as [number, number, number];
	return new Float32Array([
		(1 - 2 * (yy + zz)) * kx, 2 * (xy + wz) * kx, 2 * (xz - wy) * kx, 0,
		2 * (xy - wz) * ky, (1 - 2 * (xx + zz)) * ky, 2 * (yz + wx) * ky, 0,
		2 * (xz + wy) * kz, 2 * (yz - wx) * kz, (1 - 2 * (xx + yy)) * kz, 0,
		t[0]!, t[1]!, t[2]!, 1,
	]);
}

/** The bind rotation as a quaternion (Rz · Ry · Rx). */
function eulerQuat(r: readonly number[]): [number, number, number, number] {
	const [x, y, z] = r as [number, number, number];
	const cx = Math.cos(x / 2), sx = Math.sin(x / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2), cz = Math.cos(z / 2), sz = Math.sin(z / 2);
	return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

/**
 * World matrices for a pose: each bone's local transform takes the
 * override's channels where present and the bind values otherwise.
 */
export function vbnPoseMatrices(bones: VbnBone[], pose: Map<number, BonePose> | null): Mat4[] {
	const out: (Mat4 | undefined)[] = new Array(bones.length);
	const visit = (i: number, depth: number): Mat4 => {
		const cached = out[i];
		if (cached) return cached;
		const b = bones[i]!;
		const p = pose?.get(b.id);
		const local = p ? composeQuat(p.t ?? b.position, p.r ?? eulerQuat(b.rotation), p.s ?? b.scale) : vbnLocalMatrix(b);
		const world = b.parent >= 0 && depth < 512 ? multiply(visit(b.parent, depth + 1), local) : local;
		out[i] = world;
		return world;
	};
	return bones.map((_, i) => visit(i, 0));
}

/** Inverse of an affine column-major matrix. */
export function invertAffine(m: Mat4): Mat4 {
	const [a, b, c, , d, e, f, , g, h, i] = m as unknown as number[];
	const det = a! * (e! * i! - f! * h!) - d! * (b! * i! - c! * h!) + g! * (b! * f! - c! * e!);
	const inv = det === 0 ? 0 : 1 / det;
	const r = new Float32Array(16);
	r[0] = (e! * i! - f! * h!) * inv;
	r[1] = (c! * h! - b! * i!) * inv;
	r[2] = (b! * f! - c! * e!) * inv;
	r[4] = (f! * g! - d! * i!) * inv;
	r[5] = (a! * i! - c! * g!) * inv;
	r[6] = (c! * d! - a! * f!) * inv;
	r[8] = (d! * h! - e! * g!) * inv;
	r[9] = (b! * g! - a! * h!) * inv;
	r[10] = (a! * e! - b! * d!) * inv;
	const tx = m[12]!, ty = m[13]!, tz = m[14]!;
	r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz);
	r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz);
	r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
	r[15] = 1;
	return r;
}

/** Skinning matrices `pose · bind⁻¹` (identity in the bind pose). */
export function skinMatrices(bindWorld: Mat4[], poseWorld: Mat4[]): Mat4[] {
	return poseWorld.map((p, i) => multiply(p, invertAffine(bindWorld[i]!)));
}
