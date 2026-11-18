/**
 * Hedgehog Engine 2 point clouds (`.pcmodel`, `.pccol`, …), BINA 2.1
 * little-endian, payload `CPIC` version 2 at 0x40 (offsets relative to
 * it). Sonic Frontiers places stage pieces with them: each instance
 * names a resource (a `.terrain-model` / `.model`, or a collision mesh
 * for `.pccol`) and gives its transform.
 *
 *   0x08  instances (u64 offset, u64 count)
 *   instance (0x40): u64 name, u64 resource name, position xyz,
 *     rotation xyz (Euler radians), u32 (1), scale xyz, padding
 *
 * Layout read from the files; the rotation order (X, then Y, then Z)
 * was checked against stage geometry lining up.
 */

export interface PointCloudInstance {
	name: string;
	resource: string;
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
}

const BASE = 0x40;

export function isPointCloud(bytes: Uint8Array): boolean {
	return bytes.length > 0x60 && String.fromCharCode(...bytes.subarray(0, 4)) === 'BINA' && String.fromCharCode(...bytes.subarray(0x40, 0x44)) === 'CPIC';
}

export function parsePointCloud(bytes: Uint8Array): PointCloudInstance[] {
	if (!isPointCloud(bytes)) throw new Error('Not a CPIC point cloud');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u64 = (o: number) => Number(dv.getBigUint64(o, true));
	const f = (o: number) => dv.getFloat32(o, true);
	const td = new TextDecoder();
	const str = (o: number) => {
		const at = u64(o) + BASE;
		let e = at;
		while (e < bytes.length && bytes[e] !== 0) e++;
		return td.decode(bytes.subarray(at, e));
	};
	const list = u64(0x48) + BASE, count = u64(0x50);
	const out: PointCloudInstance[] = [];
	for (let i = 0; i < count && list + i * 0x40 + 0x40 <= bytes.length; i++) {
		const o = list + i * 0x40;
		out.push({
			name: str(o),
			resource: str(o + 8),
			position: [f(o + 16), f(o + 20), f(o + 24)],
			rotation: [f(o + 28), f(o + 32), f(o + 36)],
			scale: [f(o + 44), f(o + 48), f(o + 52)],
		});
	}
	return out;
}

/** Column-major matrix for an instance: T · Rz · Ry · Rx · S. */
export function pointCloudMatrix(p: PointCloudInstance): Float32Array {
	const [rx, ry, rz] = p.rotation;
	const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
	// R = Rz · Ry · Rx
	const r = [
		cz * cy, sz * cy, -sy,
		cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx,
		cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx,
	];
	const [kx, ky, kz] = p.scale.map((s) => (s === 0 ? 1 : s)) as [number, number, number];
	const m = new Float32Array(16);
	m.set([r[0]! * kx, r[1]! * kx, r[2]! * kx, 0, r[3]! * ky, r[4]! * ky, r[5]! * ky, 0, r[6]! * kz, r[7]! * kz, r[8]! * kz, 0, p.position[0], p.position[1], p.position[2], 1]);
	return m;
}
