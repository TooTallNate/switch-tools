import { readReflexive, type HaloMap, type HaloTag } from './index.js';

/** One drawable part of a model: a triangle list with one shader. */
export interface HaloModelPart {
	geometry: number;
	part: number;
	/** Index into `HaloModel.shaders`. */
	shaderIndex: number;
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
}

export interface HaloModelShader {
	/** Shader tag, when it resolves. */
	shader?: HaloTag;
	/** Base map bitmap tag, when the shader has one. */
	baseMap?: HaloTag;
}

export interface HaloModel {
	parts: HaloModelPart[];
	shaders: HaloModelShader[];
	/** Geometry indices that were decoded (highest LOD of each region). */
	geometries: number[];
}

const PART_SIZE = 0x68;
const GEOMETRY_SIZE = 0x30;

function signExtend(v: number, bits: number): number {
	const shift = 32 - bits;
	return (v << shift) >> shift;
}

/** Decode a packed 11:11:10 signed normal. */
function unpackNormal(v: number, out: Float32Array, o: number): void {
	out[o] = signExtend(v & 0x7ff, 11) / 1023;
	out[o + 1] = signExtend((v >>> 11) & 0x7ff, 11) / 1023;
	out[o + 2] = signExtend((v >>> 22) & 0x3ff, 10) / 511;
}

/** Read a tag dependency (class, path, size, id) and resolve it. */
function dependency(map: HaloMap, offset: number): HaloTag | undefined {
	if (offset < 0 || offset + 16 > map.bytes.length) return undefined;
	const id = map.view.getUint32(offset + 0x0c, true);
	if (id === 0xffffffff) return undefined;
	return map.tagById(id);
}

const BITM = 0x6269746d; // 'bitm'

/** Find the first bitmap dependency in `[start, end)` (4-byte aligned). */
function scanForBitmap(map: HaloMap, start: number, end: number): HaloTag | undefined {
	for (let o = start; o + 16 <= end; o += 4) {
		if (map.view.getUint32(o, true) !== BITM) continue;
		const t = dependency(map, o);
		if (t?.tagClass === 'bitm') return t;
	}
	return undefined;
}

/** Base map of a shader tag (model, environment, transparent). */
export function shaderBaseMap(map: HaloMap, shader: HaloTag): HaloTag | undefined {
	const o = shader.dataOffset;
	if (o < 0) return undefined;
	const pick = (dep: number) => {
		const t = dependency(map, dep);
		return t?.tagClass === 'bitm' ? t : undefined;
	};
	let found: HaloTag | undefined;
	switch (shader.tagClass) {
		case 'soso':
			found = pick(o + 0xa4);
			if (!found) return scanForBitmap(map, o, o + 0x1b8);
			return found;
		case 'senv':
			found = pick(o + 0x88);
			if (!found) return scanForBitmap(map, o, o + 0x344);
			return found;
		case 'schi':
		case 'scex': {
			const maps = readReflexive(map, o + 0x54);
			if (maps.count) found = pick(maps.offset + 0x6c);
			return found ?? (maps.count ? scanForBitmap(map, maps.offset, maps.offset + 0xdc) : undefined);
		}
		case 'sotr': {
			const maps = readReflexive(map, o + 0x54);
			if (maps.count) found = pick(maps.offset + 0x1c);
			return found ?? (maps.count ? scanForBitmap(map, maps.offset, maps.offset + 0x64) : undefined);
		}
		default:
			return scanForBitmap(map, o, o + 0x200);
	}
}

/** Pick the highest-detail geometry of permutation 0 of every region. */
function selectGeometries(map: HaloMap, o: number, geometryCount: number): number[] {
	const regions = readReflexive(map, o + 0xc4);
	const picked = new Set<number>();
	for (let r = 0; r < regions.count; r++) {
		const perms = readReflexive(map, regions.offset + r * 76 + 0x40);
		if (!perms.count) continue;
		const po = perms.offset;
		// super high, high, medium, low, super low
		for (const lod of [0x48, 0x46, 0x44, 0x42, 0x40]) {
			const g = map.view.getUint16(po + lod, true);
			if (g < geometryCount) {
				picked.add(g);
				break;
			}
		}
	}
	if (!picked.size && geometryCount) picked.add(0);
	return [...picked].sort((a, b) => a - b);
}

/** Convert a triangle strip to a list, dropping degenerate triangles. */
function stripToList(strip: number[], vertexCount: number): number[] {
	const out: number[] = [];
	for (let i = 2; i < strip.length; i++) {
		const a = strip[i - 2];
		const b = strip[i - 1];
		const c = strip[i];
		if (a === b || b === c || a === c) continue;
		if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
		if (i % 2 === 0) out.push(a, b, c);
		else out.push(b, a, c);
	}
	return out;
}

/**
 * Decode a `mode` (Xbox) model tag. Vertex and index buffers are
 * referenced by address from each part: `triangle offset` points to
 * u16 strip indices and `vertex offset` points to a 12-byte buffer
 * descriptor whose second word is the vertex data address.
 * Positions are returned in Halo world units (1 unit = 10 ft), Z up.
 */
export function parseModelTag(map: HaloMap, tag: HaloTag): HaloModel | null {
	if ((tag.tagClass !== 'mode' && tag.tagClass !== 'mod2') || tag.dataOffset < 0) {
		return null;
	}
	const v = map.view;
	const o = tag.dataOffset;
	const uScale = v.getFloat32(o + 0x30, true) || 1;
	const vScale = v.getFloat32(o + 0x34, true) || 1;

	const shadersRef = readReflexive(map, o + 0xdc);
	const shaders: HaloModelShader[] = [];
	for (let i = 0; i < shadersRef.count; i++) {
		const shader = dependency(map, shadersRef.offset + i * 32);
		shaders.push({ shader, baseMap: shader ? shaderBaseMap(map, shader) : undefined });
	}

	const geometriesRef = readReflexive(map, o + 0xd0);
	const geometries = selectGeometries(map, o, geometriesRef.count);
	const parts: HaloModelPart[] = [];
	for (const gi of geometries) {
		const partsRef = readReflexive(map, geometriesRef.offset + gi * GEOMETRY_SIZE + 0x24);
		for (let pi = 0; pi < partsRef.count; pi++) {
			const po = partsRef.offset + pi * PART_SIZE;
			const part = decodePart(map, po, uScale, vScale);
			if (part) parts.push({ ...part, geometry: gi, part: pi });
		}
	}
	return { parts, shaders, geometries };
}

function decodePart(
	map: HaloMap,
	po: number,
	uScale: number,
	vScale: number,
): Omit<HaloModelPart, 'geometry' | 'part'> | null {
	const v = map.view;
	const shaderIndex = v.getUint16(po + 0x04, true);
	const stripType = v.getUint16(po + 0x44, true);
	const triangleCount = v.getUint32(po + 0x48, true);
	const indexOffset = map.offsetOf(v.getUint32(po + 0x4c, true));
	const vertexType = v.getUint16(po + 0x54, true);
	const vertexCount = v.getUint32(po + 0x58, true);
	const descriptor = map.offsetOf(v.getUint32(po + 0x64, true));
	if (indexOffset < 0 || descriptor < 0 || !vertexCount) return null;
	const vertexOffset = map.offsetOf(v.getUint32(descriptor + 4, true));
	if (vertexOffset < 0) return null;
	const compressed = vertexType !== 4;
	const stride = compressed ? 32 : 68;
	if (vertexOffset + vertexCount * stride > map.bytes.length) return null;

	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);
	const uvs = new Float32Array(vertexCount * 2);
	for (let i = 0; i < vertexCount; i++) {
		const vo = vertexOffset + i * stride;
		positions[i * 3] = v.getFloat32(vo, true);
		positions[i * 3 + 1] = v.getFloat32(vo + 4, true);
		positions[i * 3 + 2] = v.getFloat32(vo + 8, true);
		if (compressed) {
			unpackNormal(v.getUint32(vo + 0x0c, true), normals, i * 3);
			uvs[i * 2] = (v.getInt16(vo + 0x18, true) / 32767) * uScale;
			uvs[i * 2 + 1] = (v.getInt16(vo + 0x1a, true) / 32767) * vScale;
		} else {
			normals[i * 3] = v.getFloat32(vo + 0x0c, true);
			normals[i * 3 + 1] = v.getFloat32(vo + 0x10, true);
			normals[i * 3 + 2] = v.getFloat32(vo + 0x14, true);
			uvs[i * 2] = v.getFloat32(vo + 0x30, true) * uScale;
			uvs[i * 2 + 1] = v.getFloat32(vo + 0x34, true) * vScale;
		}
	}

	// Strips store (index count - 2) as the triangle count.
	const indexCount = stripType === 1 ? triangleCount + 2 : triangleCount * 3;
	if (indexOffset + indexCount * 2 > map.bytes.length) return null;
	const raw: number[] = new Array(indexCount);
	for (let i = 0; i < indexCount; i++) raw[i] = v.getUint16(indexOffset + i * 2, true);
	let list: number[];
	if (stripType === 1) {
		list = stripToList(raw, vertexCount);
	} else {
		list = raw.filter((_, i) => i < Math.floor(raw.length / 3) * 3);
		if (list.some((x) => x >= vertexCount)) return null;
	}
	return {
		shaderIndex,
		positions,
		normals,
		uvs,
		indices: Uint32Array.from(list),
	};
}
