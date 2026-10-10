/** Shared mesh building and skeleton math for FF7 PSX models. */

export type Mat3 = Float64Array; // row-major 3×3

export const IDENTITY: Mat3 = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);

export function mul(a: Mat3, b: Mat3): Mat3 {
	const o = new Float64Array(9);
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
		}
	}
	return o;
}

export function apply(m: Mat3, x: number, y: number, z: number): [number, number, number] {
	return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

/** R = Ry · Rx · Rz (angles in radians): the per-bone rotation order of both field and battle models. */
export function rotationYXZ(rx: number, ry: number, rz: number): Mat3 {
	const [sx, cx, sy, cy, sz, cz] = [Math.sin(rx), Math.cos(rx), Math.sin(ry), Math.cos(ry), Math.sin(rz), Math.cos(rz)];
	const X = Float64Array.of(1, 0, 0, 0, cx, -sx, 0, sx, cx);
	const Y = Float64Array.of(cy, 0, sy, 0, 1, 0, -sy, 0, cy);
	const Z = Float64Array.of(cz, -sz, 0, sz, cz, 0, 0, 0, 1);
	return mul(mul(Y, X), Z);
}

export interface PsxTexture {
	width: number;
	height: number;
	/** RGBA8, top-down. */
	pixels: Uint8Array;
}

export interface PsxMeshGroup {
	/** Index into `PsxMesh.textures`, or -1 for untextured (vertex colour) polygons. */
	texture: number;
	firstIndex: number;
	indexCount: number;
}

export type Vec3 = [number, number, number];

/** World transforms of every bone (index meaning is format-specific). */
export interface Pose {
	R: Mat3[];
	T: Vec3[];
}

/** A posed, triangulated model in Y-up space. */
export interface PsxMesh {
	positions: Float32Array;
	/** RGB in 0..1 (white for textured polygons). */
	colors: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
	groups: PsxMeshGroup[];
	textures: PsxTexture[];
	bones: number;
	/**
	 * Rigid skinning: each vertex's transform index and its position in
	 * that bone's local (PSX) space, for re-posing with {@link applyPose}.
	 */
	skin: { bone: Uint16Array; local: Float32Array };
	/** Parent transform index of each transform (-1 for roots). */
	parents: Int16Array;
}

interface Corner {
	p: [number, number, number];
	c: [number, number, number];
	uv: [number, number];
	/** Transform index and bone-local position (for animation). */
	b?: number;
	l?: Vec3;
}

/** Accumulates triangles per material, then lays them out as contiguous groups. */
export class MeshBuilder {
	private tris = new Map<number, Corner[]>();
	textures: PsxTexture[] = [];

	/** Add a triangle; PSX space (Y down) is converted to Y-up by rotating 180° about X. */
	tri(texture: number, a: Corner, b: Corner, c: Corner): void {
		let list = this.tris.get(texture);
		if (!list) this.tris.set(texture, (list = []));
		list.push(a, b, c);
	}

	/** PSX quads are "Z" ordered: (v0, v1, v2) + (v1, v3, v2). */
	quad(texture: number, v0: Corner, v1: Corner, v2: Corner, v3: Corner): void {
		this.tri(texture, v0, v1, v2);
		this.tri(texture, v1, v3, v2);
	}

	build(bones: number, parents: ArrayLike<number> = []): PsxMesh {
		let count = 0;
		for (const list of this.tris.values()) count += list.length;
		const positions = new Float32Array(count * 3);
		const colors = new Float32Array(count * 3);
		const uvs = new Float32Array(count * 2);
		const indices = new Uint32Array(count);
		const bone = new Uint16Array(count);
		const local = new Float32Array(count * 3);
		const groups: PsxMeshGroup[] = [];
		let n = 0;
		const keys = [...this.tris.keys()].sort((a, b) => a - b);
		for (const key of keys) {
			const list = this.tris.get(key)!;
			groups.push({ texture: key, firstIndex: n, indexCount: list.length });
			for (const corner of list) {
				positions[n * 3] = corner.p[0];
				positions[n * 3 + 1] = -corner.p[1];
				positions[n * 3 + 2] = -corner.p[2];
				colors.set(corner.c, n * 3);
				uvs[n * 2] = corner.uv[0];
				uvs[n * 2 + 1] = corner.uv[1];
				indices[n] = n;
				bone[n] = corner.b ?? 0;
				if (corner.l) local.set(corner.l, n * 3);
				n++;
			}
		}
		return { positions, colors, uvs, indices, groups, textures: this.textures, bones, skin: { bone, local }, parents: Int16Array.from(parents) };
	}
}

export function rgb(bytes: Uint8Array, o: number): [number, number, number] {
	return [bytes[o] / 255, bytes[o + 1] / 255, bytes[o + 2] / 255];
}

export const WHITE: [number, number, number] = [1, 1, 1];

/** Write a pose into `out` (Y-up positions, same layout as `PsxMesh.positions`). */
export function applyPose(mesh: PsxMesh, pose: Pose, out: Float32Array = mesh.positions): Float32Array {
	const { bone, local } = mesh.skin;
	for (let i = 0; i < bone.length; i++) {
		const R = pose.R[bone[i]] ?? IDENTITY;
		const T = pose.T[bone[i]] ?? [0, 0, 0];
		const x = local[i * 3], y = local[i * 3 + 1], z = local[i * 3 + 2];
		out[i * 3] = R[0] * x + R[1] * y + R[2] * z + T[0];
		out[i * 3 + 1] = -(R[3] * x + R[4] * y + R[5] * z + T[1]);
		out[i * 3 + 2] = -(R[6] * x + R[7] * y + R[8] * z + T[2]);
	}
	return out;
}

/** An animation clip: frame count; the animator samples poses. */
export interface PsxClip {
	name: string;
	frames: number;
}

export interface PsxAnimator {
	clips: PsxClip[];
	/** World transforms for `clip` at `frame` (clamped). */
	pose(clip: number, frame: number): Pose;
}

/** Bone origin positions of a pose, Y-up like `PsxMesh.positions`. */
export function poseJoints(pose: Pose): Float32Array {
	const out = new Float32Array(pose.T.length * 3);
	pose.T.forEach((t, i) => {
		out[i * 3] = t[0];
		out[i * 3 + 1] = -t[1];
		out[i * 3 + 2] = -t[2];
	});
	return out;
}
