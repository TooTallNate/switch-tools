/**
 * KotOR binary MDL / MDX models (xoreos `src/graphics/aurora/model_kotor.cpp`).
 *
 * The `.mdl` holds the node tree and the `.mdx` the interleaved vertex
 * data. MDL: u32 0 (binary), u32 model-data size, u32 raw-data size, then
 * the geometry header at 12; every offset below is relative to 12.
 *
 *   geometry header: name (32 @ +8), root node, node count, …,
 *   supermodel name (32 @ +136), name-table array (@ +184).
 *   node: u16 flags, u16 supernode, u16 node number (→ name), position,
 *   orientation (w, x, y, z), children / controller-key / controller-data
 *   arrays (offset, count, count), then sub-headers by flag: light 0x5C,
 *   emitter 216, reference 0x44, mesh (332 bytes, 340 in KotOR II),
 *   skin, …
 *   mesh: face array, bounds, diffuse / ambient, two texture names, the
 *   face-index pointer, MDX stride, normal / UV offsets, vertex count,
 *   texture count, render flags, MDX data offset.
 *
 * Node transforms chain from the root; position / orientation controllers
 * (types 8 and 20) override the header values with their first key.
 * KotOR is Z-up.
 */

export interface KotorMesh {
	node: string;
	texture: string;
	/** Second texture (lightmap on area models). */
	texture2: string;
	/** World-space (bind pose) positions / normals. */
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
	skinned: boolean;
}

export interface KotorModel {
	name: string;
	superModel: string;
	nodeCount: number;
	meshes: KotorMesh[];
	/** True when parsed with KotOR II's mesh header. */
	kotor2: boolean;
}

const dec = new TextDecoder('latin1');
const fixed = (b: Uint8Array, o: number, n: number) => {
	const s = b.subarray(o, o + n);
	const z = s.indexOf(0);
	return dec.decode(z >= 0 ? s.subarray(0, z) : s);
};

export function isKotorMdl(head: Uint8Array): boolean {
	return head.length >= 12 && head[0] === 0 && head[1] === 0 && head[2] === 0 && head[3] === 0 && (head[4]! | head[5]! | head[6]! | head[7]!) !== 0;
}

type Mat = number[];
function mul(a: Mat, b: Mat): Mat {
	const o = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!;
	return o;
}
function trs(p: number[], q: number[]): Mat {
	const [x, y, z, w] = q as [number, number, number, number];
	return [
		1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
		2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
		2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
		p[0]!, p[1]!, p[2]!, 1,
	];
}

export function parseKotorMdl(mdl: Uint8Array, mdx: Uint8Array): KotorModel {
	let first: unknown;
	for (const k2 of [false, true]) {
		try {
			return parse(mdl, mdx, k2);
		} catch (e) {
			first ??= e;
		}
	}
	throw first instanceof Error ? first : new Error(String(first));
}

function parse(mdl: Uint8Array, mdx: Uint8Array, kotor2: boolean): KotorModel {
	if (!isKotorMdl(mdl)) throw new Error('Not a binary KotOR MDL');
	const dv = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
	const xv = new DataView(mdx.buffer, mdx.byteOffset, mdx.byteLength);
	const B = 12;
	const u32 = (o: number) => dv.getUint32(B + o, true);
	const f32 = (o: number) => dv.getFloat32(B + o, true);
	const name = fixed(mdl, B + 8, 32);
	const rootNode = u32(40);
	const nodeCount = u32(44);
	const superModel = fixed(mdl, B + 136, 32);
	const nameOff = u32(184);
	const nameCount = u32(188);
	const names: string[] = [];
	for (let i = 0; i < nameCount && i < 65536; i++) names.push(fixed(mdl, B + u32(nameOff + i * 4), 64));
	const meshes: KotorMesh[] = [];
	const seen = new Set<number>();

	const visit = (off: number, parent: Mat, depth: number) => {
		if (depth > 128 || seen.has(off) || B + off + 80 > mdl.length) return;
		seen.add(off);
		const flags = dv.getUint16(B + off, true);
		const number = dv.getUint16(B + off + 4, true);
		let pos = [f32(off + 16), f32(off + 20), f32(off + 24)];
		let rot = [f32(off + 32), f32(off + 36), f32(off + 40), f32(off + 28)]; // x, y, z, w
		// Controllers: first key of position (8) / orientation (20).
		const keyOff = u32(off + 56);
		const keyN = u32(off + 60);
		const dataOff = u32(off + 68);
		for (let k = 0; k < keyN && k < 256; k++) {
			const c = keyOff + k * 16;
			const type = u32(c);
			const rows = dv.getUint16(B + c + 6, true);
			const dataIndex = dv.getUint16(B + c + 10, true);
			const cols = mdl[B + c + 12]!;
			if (rows < 1) continue;
			const d = (i: number) => f32(dataOff + (dataIndex + i) * 4);
			if (type === 8 && (cols === 3 || cols === 19)) pos = [d(0), d(1), d(2)];
			else if (type === 20 && cols === 4) rot = [d(0), d(1), d(2), d(3)];
			else if (type === 20 && cols === 2) {
				const t = dv.getUint32(B + dataOff + dataIndex * 4, true);
				const x = 1 - (t & 0x7ff) / 1023;
				const y = 1 - ((t >>> 11) & 0x7ff) / 1023;
				const z = 1 - (t >>> 22) / 511;
				const s = x * x + y * y + z * z;
				rot = s < 1 ? [x, y, z, -Math.sqrt(1 - s)] : [x / Math.sqrt(s), y / Math.sqrt(s), z / Math.sqrt(s), 0];
			}
		}
		const ql = Math.hypot(rot[0]!, rot[1]!, rot[2]!, rot[3]!) || 1;
		const world = mul(parent, trs(pos, rot.map((v) => v / ql)));

		let h = off + 80;
		if (flags & 0x0002) h += 0x5c;
		if (flags & 0x0004) h += 216;
		if (flags & 0x0010) h += 0x44;
		if (flags & 0x0020) {
			const facesCount = u32(h + 12);
			const tex0 = fixed(mdl, B + h + 88, 32);
			const tex1 = fixed(mdl, B + h + 120, 32);
			const offOffVerts = u32(h + 188);
			const offOffVertsCount = u32(h + 192);
			const stride = u32(h + 252);
			const offNormals = u32(h + 264);
			const offUV = u32(h + 272);
			const vertexCount = dv.getUint16(B + h + 304, true);
			const render = mdl[B + h + 313]!;
			const tail = kotor2 ? 8 : 0;
			const offNodeData = u32(h + 324 + tail);
			if (offOffVertsCount > 1) throw new Error(`Face offsets count ${offOffVertsCount}`);
			if (vertexCount > 0 && facesCount > 0 && offOffVertsCount === 1) {
				if (stride < 12 || stride > 512 || offNodeData + vertexCount * stride > mdx.length) throw new Error('Mesh vertex data out of the MDX');
				const offVerts = u32(offOffVerts);
				const indices = new Uint32Array(facesCount * 3);
				for (let i = 0; i < facesCount * 3; i++) {
					const v = dv.getUint16(B + offVerts + i * 2, true);
					if (v >= vertexCount) throw new Error('Face index out of range');
					indices[i] = v;
				}
				const positions = new Float32Array(vertexCount * 3);
				const normals = new Float32Array(vertexCount * 3);
				const uvs = new Float32Array(vertexCount * 2);
				const m = world;
				for (let v = 0; v < vertexCount; v++) {
					const o = offNodeData + v * stride;
					const x = xv.getFloat32(o, true);
					const y = xv.getFloat32(o + 4, true);
					const z = xv.getFloat32(o + 8, true);
					positions[v * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
					positions[v * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
					positions[v * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
					const no = offNormals !== 0xffffffff && offNormals < stride ? o + offNormals : o + 12;
					const nx = xv.getFloat32(no, true);
					const ny = xv.getFloat32(no + 4, true);
					const nz = xv.getFloat32(no + 8, true);
					normals[v * 3] = m[0]! * nx + m[4]! * ny + m[8]! * nz;
					normals[v * 3 + 1] = m[1]! * nx + m[5]! * ny + m[9]! * nz;
					normals[v * 3 + 2] = m[2]! * nx + m[6]! * ny + m[10]! * nz;
					if (offUV !== 0xffffffff && offUV + 8 <= stride) {
						uvs[v * 2] = xv.getFloat32(o + offUV, true);
						uvs[v * 2 + 1] = xv.getFloat32(o + offUV + 4, true);
					}
				}
				if (render !== 0) {
					meshes.push({ node: names[number] ?? `node_${number}`, texture: tex0.toLowerCase(), texture2: tex1.toLowerCase(), positions, normals, uvs, indices, skinned: (flags & 0x0040) !== 0 });
				}
			}
		}
		const childOff = u32(off + 44);
		const childN = u32(off + 48);
		for (let c = 0; c < childN && c < 4096; c++) visit(u32(childOff + c * 4), world, depth + 1);
	};
	visit(rootNode, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
	return { name, superModel, nodeCount, meshes, kotor2 };
}
