/**
 * NUD models (`NDWD` little-endian, `NDP3` big-endian), from Bandai
 * Namco's NU3 engine (Pokkén Tournament, Smash 4).
 *
 * **Header.**
 *
 *     0x00  magic            0x04  file size
 *     0x08  version (u16 BE) 0x0A  mesh count (u16)
 *     0x0C  first / last bone index (s16 each)
 *     0x10  index-clump offset (+0x30) and size, vertex-clump size,
 *           vertex-add-clump size (the clumps, then the name table,
 *           are consecutive)
 *     0x20  bounding sphere (4 floats)
 *
 * **Meshes** follow at 0x30, 0x30 bytes each: bounding sphere (4
 * floats) + its centre again (3 floats), sort bias, name offset (into
 * the name table), u16 0, u16 bone flag, s16 single-bind bone, u16
 * polygon count, s32 polygon-header pointer. Polygon headers (0x30
 * bytes each) follow all the meshes, in mesh order:
 *
 *     +0x00  index offset (in the index clump)
 *     +0x04  vertex offset (vertex clump)
 *     +0x08  vertex-add offset (vertex-add clump)
 *     +0x0C  vertex count (u16)
 *     +0x0E  vertex type (u8: bone type << 4 | normal type)
 *     +0x0F  UV type (u8: UV count << 4 | colour type | UV format)
 *     +0x10  four material pointers (absolute; 0 = none)
 *     +0x20  index count (u16), +0x22 primitive (u16: high byte 0x40 =
 *            triangle list, 0 = triangle strips with 0xFFFF restarts)
 *
 * **Vertices.** For skinned polygons (bone type ≠ 0) the vertex clump
 * holds colour + UVs and the vertex-add clump holds position, normal
 * and bone data; otherwise one clump holds position/normal then
 * colour/UVs, interleaved per vertex. Positions are floats. Normal type
 * 0 = none (one pad float), 1 = float normal, 2 / 3 = float normal +
 * bitangent + tangent, 6 = half normal, 7 = half normal + bitangent +
 * tangent. Bone type 0x10 = 4 s32 ids + 4 float weights, 0x20 = u16 +
 * half, 0x40 = u8 + u8/255. Colour type 2 = 4 bytes (0..0x80 = 0..1),
 * 4 = 4 halves; UVs are halves (format 0) or floats (1).
 *
 * In the bind pose every vertex is in model space except meshes whose
 * name contains `_NSC`, which are bound rigidly to their single-bind
 * bone and need its transform.
 *
 * **Materials** (at each pointer): flags, 4 bytes, src factor, texture
 * count, dst factor, alpha func, ref alpha, cull mode (u16s), 4 bytes,
 * 2 × s32, then per texture 0x18 bytes (hash, 6 bytes, map mode u16,
 * wrap S / T, min / mag filter, mip detail, …), then attributes.
 *
 * Source: Smash Forge `Filetypes/Models/Nuds/NUD.cs` and `Polygon.cs`.
 */

export interface NudMaterial {
	flags: number;
	srcFactor: number;
	dstFactor: number;
	alphaFunc: number;
	refAlpha: number;
	cullMode: number;
	textures: { hash: number; wrapS: number; wrapT: number }[];
}

export interface NudPolygon {
	vertexCount: number;
	positions: Float32Array;
	normals: Float32Array | null;
	/** First UV set. */
	uvs: Float32Array | null;
	/** RGBA, normalised so 0x80 (the engine's 1.0) is 1. */
	colors: Float32Array | null;
	/** 4 bone ids and weights per vertex, when skinned. */
	boneIds: Uint16Array | null;
	boneWeights: Float32Array | null;
	/** Triangle list. */
	indices: Uint32Array;
	materials: NudMaterial[];
}

export interface NudMesh {
	name: string;
	boneFlag: number;
	/** Bone index for single-bound meshes, else -1. */
	singleBind: number;
	sortBias: number;
	polygons: NudPolygon[];
}

export interface NudModel {
	littleEndian: boolean;
	version: number;
	boundingSphere: [number, number, number, number];
	meshes: NudMesh[];
}

export function isNud(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 0x30) return false;
	const m = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
	return m === 'NDWD' || m === 'NDP3';
}

function half(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * f * 2 ** -24;
	if (e === 31) return f ? NaN : s * Infinity;
	return s * (1 + f / 1024) * 2 ** (e - 15);
}

function cstring(b: Uint8Array, o: number): string {
	let end = o;
	while (end < b.byteLength && b[end] !== 0) end++;
	return new TextDecoder('latin1').decode(b.subarray(o, end));
}

/** Strips (0xFFFF restarts) to a triangle list, as Smash Forge does. */
function stripToTriangles(strip: number[]): number[] {
	const out: number[] = [];
	if (strip.length < 3) return out;
	let p = 0;
	let f1 = strip[p++]!;
	let f2 = strip[p++]!;
	let dir = 1;
	while (p < strip.length) {
		const f3 = strip[p++]!;
		if (f3 === 0xffff) {
			if (p + 1 >= strip.length) break;
			f1 = strip[p++]!;
			f2 = strip[p++]!;
			dir = 1;
			continue;
		}
		dir = -dir;
		if (f1 !== f2 && f2 !== f3 && f3 !== f1) {
			if (dir > 0) out.push(f3, f2, f1);
			else out.push(f2, f3, f1);
		}
		f1 = f2;
		f2 = f3;
	}
	return out;
}

export function parseNud(bytes: Uint8Array): NudModel {
	if (!isNud(bytes)) throw new Error('Not an NDWD / NDP3 NUD');
	const le = bytes[3] === 0x44; // 'D'
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint16(8, false);
	const meshCount = dv.getUint16(0x0a, le);
	const indexStart = dv.getInt32(0x10, le) + 0x30;
	const indexSize = dv.getInt32(0x14, le);
	const vertStart = indexStart + indexSize;
	const vertSize = dv.getInt32(0x18, le);
	const vertAddStart = vertStart + vertSize;
	const vertAddSize = dv.getInt32(0x1c, le);
	const nameStart = vertAddStart + vertAddSize;
	const f32 = (o: number) => dv.getFloat32(o, le);
	const boundingSphere: NudModel['boundingSphere'] = [f32(0x20), f32(0x24), f32(0x28), f32(0x2c)];

	const heads: { name: string; boneFlag: number; singleBind: number; sortBias: number; polyCount: number }[] = [];
	let o = 0x30;
	for (let i = 0; i < meshCount; i++) {
		const sortBias = f32(o + 0x1c);
		const name = cstring(bytes, nameStart + dv.getInt32(o + 0x20, le));
		const boneFlag = dv.getUint16(o + 0x26, le);
		const singleBind = dv.getInt16(o + 0x28, le);
		const polyCount = dv.getUint16(o + 0x2a, le);
		heads.push({ name, boneFlag, singleBind, sortBias, polyCount });
		o += 0x30;
	}

	const meshes: NudMesh[] = [];
	for (const h of heads) {
		const polygons: NudPolygon[] = [];
		for (let i = 0; i < h.polyCount; i++, o += 0x30) {
			const idxOff = dv.getInt32(o, le) + indexStart;
			const vtxOff = dv.getInt32(o + 4, le) + vertStart;
			const addOff = dv.getInt32(o + 8, le) + vertAddStart;
			const count = dv.getUint16(o + 0x0c, le);
			const vertexType = bytes[o + 0x0e]!;
			const uvType = bytes[o + 0x0f]!;
			const matPtrs = [0, 1, 2, 3].map((k) => dv.getInt32(o + 0x10 + k * 4, le));
			const indexCount = dv.getUint16(o + 0x20, le);
			const primitive = dv.getUint16(o + 0x22, le);
			polygons.push(
				readPolygon(dv, le, {
					idxOff,
					vtxOff,
					addOff,
					count,
					vertexType,
					uvType,
					indexCount,
					// High byte: 0x40 = triangle list, 0 = strips (low byte: polygon flag).
					triangles: primitive >> 8 === 0x40,
					singleBind: h.singleBind,
				}),
			);
			polygons[polygons.length - 1]!.materials = readMaterials(dv, le, matPtrs);
		}
		meshes.push({ name: h.name, boneFlag: h.boneFlag, singleBind: h.singleBind, sortBias: h.sortBias, polygons });
	}
	return { littleEndian: le, version, boundingSphere, meshes };
}

function readPolygon(
	dv: DataView,
	le: boolean,
	p: {
		idxOff: number;
		vtxOff: number;
		addOff: number;
		count: number;
		vertexType: number;
		uvType: number;
		indexCount: number;
		triangles: boolean;
		singleBind: number;
	},
): NudPolygon {
	const n = p.count;
	const boneType = p.vertexType & 0xf0;
	const normalType = p.vertexType & 0x0f;
	const uvCount = p.uvType >> 4;
	const colorType = p.uvType & 0x0e;
	const uvFloat = (p.uvType & 1) === 1;
	const positions = new Float32Array(n * 3);
	const normals = normalType === 0 ? null : new Float32Array(n * 3);
	const uvs = uvCount > 0 ? new Float32Array(n * 2) : null;
	const colors = colorType === 2 || colorType === 4 ? new Float32Array(n * 4) : null;
	const boneIds = boneType ? new Uint16Array(n * 4) : null;
	const boneWeights = boneType ? new Float32Array(n * 4) : null;
	const f32 = (o: number) => dv.getFloat32(o, le);
	const h16 = (o: number) => half(dv.getUint16(o, le));

	const readUv = (o: number, v: number): number => {
		if (colorType === 2) {
			for (let k = 0; k < 4; k++) colors![v * 4 + k] = dv.getUint8(o + k) / 0x80;
			o += 4;
		} else if (colorType === 4) {
			for (let k = 0; k < 4; k++) colors![v * 4 + k] = h16(o + k * 2);
			o += 8;
		}
		for (let u = 0; u < uvCount; u++) {
			const a = uvFloat ? f32(o) : h16(o);
			const b = uvFloat ? f32(o + 4) : h16(o + 2);
			if (u === 0) {
				uvs![v * 2] = a;
				uvs![v * 2 + 1] = b;
			}
			o += uvFloat ? 8 : 4;
		}
		return o;
	};
	const readVertex = (o: number, v: number): number => {
		positions[v * 3] = f32(o);
		positions[v * 3 + 1] = f32(o + 4);
		positions[v * 3 + 2] = f32(o + 8);
		o += 12;
		switch (normalType) {
			case 0:
				o += 4;
				break;
			case 1:
				normals!.set([f32(o + 4), f32(o + 8), f32(o + 12)], v * 3);
				o += 20;
				break;
			case 2:
			case 3:
				normals!.set([f32(o + 4), f32(o + 8), f32(o + 12)], v * 3);
				o += 20 + 32;
				break;
			case 6:
				normals!.set([h16(o), h16(o + 2), h16(o + 4)], v * 3);
				o += 8;
				break;
			case 7:
				normals!.set([h16(o), h16(o + 2), h16(o + 4)], v * 3);
				o += 8 + 16;
				break;
			default:
				throw new Error(`NUD: unsupported normal type ${normalType}`);
		}
		if (boneType === 0x10) {
			for (let k = 0; k < 4; k++) {
				boneIds![v * 4 + k] = dv.getInt32(o + k * 4, le);
				boneWeights![v * 4 + k] = f32(o + 16 + k * 4);
			}
			o += 32;
		} else if (boneType === 0x20) {
			for (let k = 0; k < 4; k++) {
				boneIds![v * 4 + k] = dv.getUint16(o + k * 2, le);
				boneWeights![v * 4 + k] = h16(o + 8 + k * 2);
			}
			o += 16;
		} else if (boneType === 0x40) {
			for (let k = 0; k < 4; k++) {
				boneIds![v * 4 + k] = dv.getUint8(o + k);
				boneWeights![v * 4 + k] = dv.getUint8(o + 4 + k) / 255;
			}
			o += 8;
		} else if (boneType !== 0) {
			throw new Error(`NUD: unsupported bone type 0x${boneType.toString(16)}`);
		}
		return o;
	};

	if (boneType) {
		let o = p.vtxOff;
		for (let v = 0; v < n; v++) o = readUv(o, v);
		o = p.addOff;
		for (let v = 0; v < n; v++) o = readVertex(o, v);
	} else {
		let o = p.vtxOff;
		for (let v = 0; v < n; v++) {
			o = readVertex(o, v);
			o = readUv(o, v);
		}
	}

	const raw: number[] = [];
	for (let i = 0; i < p.indexCount; i++) raw.push(dv.getUint16(p.idxOff + i * 2, le));
	const list = p.triangles ? raw.slice(0, raw.length - (raw.length % 3)) : stripToTriangles(raw);
	const indices = new Uint32Array(list.length);
	let w = 0;
	for (let i = 0; i + 2 < list.length; i += 3) {
		if (list[i]! < n && list[i + 1]! < n && list[i + 2]! < n) {
			indices[w++] = list[i]!;
			indices[w++] = list[i + 1]!;
			indices[w++] = list[i + 2]!;
		}
	}
	return {
		vertexCount: n,
		positions,
		normals,
		uvs,
		colors,
		boneIds,
		boneWeights,
		indices: indices.subarray(0, w),
		materials: [],
	};
}

function readMaterials(dv: DataView, le: boolean, ptrs: number[]): NudMaterial[] {
	const out: NudMaterial[] = [];
	for (const ptr of ptrs) {
		if (!ptr || ptr + 0x20 > dv.byteLength) break;
		const texCount = dv.getUint16(ptr + 0x0a, le);
		const textures: NudMaterial['textures'] = [];
		for (let i = 0; i < texCount && ptr + 0x20 + (i + 1) * 0x18 <= dv.byteLength; i++) {
			const t = ptr + 0x20 + i * 0x18;
			textures.push({ hash: dv.getUint32(t, le), wrapS: dv.getUint8(t + 0x0c), wrapT: dv.getUint8(t + 0x0d) });
		}
		out.push({
			flags: dv.getUint32(ptr, le),
			srcFactor: dv.getUint16(ptr + 0x08, le),
			dstFactor: dv.getUint16(ptr + 0x0c, le),
			alphaFunc: dv.getUint16(ptr + 0x0e, le),
			refAlpha: dv.getUint16(ptr + 0x10, le),
			cullMode: dv.getUint16(ptr + 0x12, le),
			textures,
		});
	}
	return out;
}
