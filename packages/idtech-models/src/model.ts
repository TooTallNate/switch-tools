/**
 * DOOM 3 BFG Edition compiled models, as shipped in `.resources`:
 *
 * - `BRMl` static models (`.blwo`, `.base`, `.bma`, `.bflt`, … — the
 *   original source extension is kept, prefixed with `b`):
 *   `idRenderModelStatic::LoadBinaryModel` in `renderer/Model.cpp`.
 * - `.bmd5mesh` skinned models: the same static block (usually with no
 *   geometry), then an `MD5` block with joints, the default pose and
 *   per-mesh deform info: `idRenderModelMD5::LoadBinaryModel` in
 *   `renderer/Model_md5.cpp`.
 *
 * Both from id Software's GPL DOOM-3-BFG source release.
 *
 * Vertices are `idDrawVert` (32 bytes): position, half-float UV,
 * normal / tangent / colour / colour2 bytes. Static models read the
 * position little-endian (`ReadVec3`); MD5 deform verts are read with
 * `ReadBigArray`, which byte-swaps each field from big-endian. For MD5
 * meshes `color` holds four joint indices and `color2` their weights.
 * Normals and tangents are bytes mapped as `b / 255 · 2 − 1`.
 *
 * Index (`triIndex_t`) width isn't recorded; BFG uses 16 bits, and we
 * fall back to 32 if the file doesn't parse to its end with 16.
 *
 * Coordinates are idTech's: Z-up, in game units (about an inch).
 */
import { halfToFloat, Reader } from './reader.js';

export const BRM_MAGIC = 0x42524d6c; // 'B' 'R' 'M' 108
/** `MD5B_MAGIC`: '5' 'D' 'M' then the version byte (106). */
export const MD5B_MAGIC_PREFIX = 0x35444d00;

export interface IdSurface {
	id: number;
	material: string;
	positions: Float32Array;
	uvs: Float32Array;
	normals: Float32Array;
	/** RGBA 0..1. */
	colors: Float32Array;
	indices: Uint32Array;
}

export interface IdStaticModel {
	timeStamp: number;
	name: string;
	surfaces: IdSurface[];
	bounds: [[number, number, number], [number, number, number]];
}

export interface IdJoint {
	name: string;
	parent: number;
}

export interface IdMd5Mesh extends IdSurface {
	/** Four joint indices and 0..1 weights per vertex. */
	joints: Uint8Array;
	weights: Float32Array;
	surfaceNum: number;
}

export interface IdMd5Model {
	static: IdStaticModel;
	joints: IdJoint[];
	/** Parent-relative default pose: quaternion (x, y, z, w) and translation. */
	defaultPose: { q: [number, number, number, number]; t: [number, number, number] }[];
	/** Inverse of each joint's world bind matrix, 3×4 row-major. */
	invertedDefaultPose: Float32Array[];
	meshes: IdMd5Mesh[];
}

export function isBrm(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x42 && head[1] === 0x52 && head[2] === 0x4d && head[3] === 0x6c;
}

interface Vert {
	positions: Float32Array;
	uvs: Float32Array;
	normals: Float32Array;
	colors: Float32Array;
	color: Uint8Array;
	color2: Uint8Array;
}

function readVerts(r: Reader, n: number, bigXyz: boolean): Vert {
	const v: Vert = {
		positions: new Float32Array(n * 3),
		uvs: new Float32Array(n * 2),
		normals: new Float32Array(n * 3),
		colors: new Float32Array(n * 4),
		color: new Uint8Array(n * 4),
		color2: new Uint8Array(n * 4),
	};
	for (let i = 0; i < n; i++) {
		const p = bigXyz ? r.vec3be() : r.vec3le();
		v.positions.set(p, i * 3);
		v.uvs[i * 2] = halfToFloat(r.u16be());
		v.uvs[i * 2 + 1] = halfToFloat(r.u16be());
		for (let k = 0; k < 4; k++) {
			const b = r.u8();
			if (k < 3) v.normals[i * 3 + k] = (b / 255) * 2 - 1;
		}
		r.skip(4); // tangent
		for (let k = 0; k < 4; k++) {
			const b = r.u8();
			v.color[i * 4 + k] = b;
			v.colors[i * 4 + k] = b / 255;
		}
		for (let k = 0; k < 4; k++) v.color2[i * 4 + k] = r.u8();
	}
	return v;
}

function readIndices(r: Reader, n: number, wide: boolean): Uint32Array {
	const out = new Uint32Array(n);
	for (let i = 0; i < n; i++) out[i] = wide ? r.u32be() : r.u16be();
	return out;
}

/** Read one `BRMl` static model at the reader's position. */
export function readStatic(r: Reader, wide: boolean): IdStaticModel {
	if (r.u32be() !== BRM_MAGIC) throw new Error('Not a BFG binary model (missing "BRMl")');
	const timeStamp = r.time64be();
	const numSurfaces = r.i32be();
	if (numSurfaces < 0 || numSurfaces > 100_000) throw new Error(`Bad surface count ${numSurfaces}`);
	const surfaces: IdSurface[] = [];
	const idx = wide ? 4 : 2;
	for (let s = 0; s < numSurfaces; s++) {
		const id = r.i32be();
		const material = r.string();
		if (!r.bool()) {
			surfaces.push({ id, material, positions: new Float32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0) });
			continue;
		}
		r.vec3le();
		r.vec3le(); // bounds
		r.i32be(); // ambientViewCount
		r.bool(); // generateNormals
		r.bool(); // tangentsCalculated
		r.bool(); // perfectHull
		r.bool(); // referencedIndexes
		const numVerts = r.i32be();
		const vertsInFile = r.i32be();
		const v = vertsInFile > 0 ? readVerts(r, numVerts, false) : readVerts(r, 0, false);
		const shadowVerts = r.i32be();
		r.skip(shadowVerts * 16);
		const numIndexes = r.i32be();
		const indices = numIndexes > 0 ? readIndices(r, numIndexes, wide) : new Uint32Array(0);
		if (r.i32be() > 0) r.skip(numIndexes * idx); // silIndexes
		const mirrored = r.i32be();
		r.skip(mirrored * 4);
		const dup = r.i32be();
		r.skip(dup * 8);
		const silEdges = r.i32be();
		r.skip(silEdges * 4 * idx);
		if (r.bool()) r.skip(numVerts * (2 * idx + 12)); // dominantTris
		r.i32be();
		r.i32be();
		r.i32be(); // shadow index counts, cap plane bits
		surfaces.push({ id, material, positions: v.positions, uvs: v.uvs, normals: v.normals, colors: v.colors, indices });
	}
	const bounds: IdStaticModel['bounds'] = [r.vec3le(), r.vec3le()];
	r.i32be(); // overlaysAdded
	r.i32be(); // lastModifiedFrame
	r.i32be(); // lastArchivedFrame
	const name = r.string();
	r.skip(9); // isStaticWorldModel … hasShadowCastingSurfaces
	return { timeStamp, name, surfaces, bounds };
}

function withIndexWidth<T>(bytes: Uint8Array, parse: (wide: boolean) => T, complete: (r: T) => boolean): T {
	let first: unknown;
	for (const wide of [false, true]) {
		try {
			const out = parse(wide);
			if (complete(out)) return out;
			first ??= new Error('Model did not parse to its end');
		} catch (e) {
			first ??= e;
		}
	}
	throw first instanceof Error ? first : new Error(String(first));
}

/** Parse a `BRMl` static model. */
export function parseBrm(bytes: Uint8Array): IdStaticModel {
	let end = 0;
	return withIndexWidth(
		bytes,
		(wide) => {
			const r = new Reader(bytes);
			const m = readStatic(r, wide);
			end = r.pos;
			return m;
		},
		() => end === bytes.length,
	);
}

/** Parse a `.bmd5mesh` skinned model. */
export function parseBmd5mesh(bytes: Uint8Array): IdMd5Model {
	let end = 0;
	return withIndexWidth(
		bytes,
		(wide) => {
			const r = new Reader(bytes);
			const stat = readStatic(r, wide);
			const magic = r.u32be();
			if ((magic & 0xffffff00) >>> 0 !== MD5B_MAGIC_PREFIX) {
				throw new Error('Missing MD5 block');
			}
			const nJoints = r.i32be();
			if (nJoints < 0 || nJoints > 4096) throw new Error(`Bad joint count ${nJoints}`);
			const joints: IdJoint[] = [];
			for (let i = 0; i < nJoints; i++) joints.push({ name: r.string(), parent: r.i32be() });
			const nPose = r.i32be();
			const defaultPose: IdMd5Model['defaultPose'] = [];
			for (let i = 0; i < nPose; i++) {
				const q: [number, number, number, number] = [r.f32be(), r.f32be(), r.f32be(), r.f32be()];
				defaultPose.push({ q, t: r.vec3le() });
			}
			const nInv = r.i32be();
			const invertedDefaultPose: Float32Array[] = [];
			for (let i = 0; i < nInv; i++) {
				const m = new Float32Array(12);
				for (let k = 0; k < 12; k++) m[k] = r.f32be();
				invertedDefaultPose.push(m);
			}
			const nMeshes = r.i32be();
			const idx = wide ? 4 : 2;
			const meshes: IdMd5Mesh[] = [];
			for (let i = 0; i < nMeshes; i++) {
				const material = r.string();
				r.i32be(); // numVerts
				r.i32be(); // numTris
				const nMeshJoints = r.i32be();
				r.skip(nMeshJoints);
				r.f32be(); // maxJointVertDist
				r.i32be(); // numSourceVerts
				const numOutputVerts = r.i32be();
				const numIndexes = r.i32be();
				const numMirrored = r.i32be();
				const numDup = r.i32be();
				const numSilEdges = r.i32be();
				const v = readVerts(r, Math.max(0, numOutputVerts), true);
				const indices = numIndexes > 0 ? readIndices(r, numIndexes, wide) : new Uint32Array(0);
				if (numIndexes > 0) r.skip(numIndexes * idx); // silIndexes
				r.skip(Math.max(0, numMirrored) * 4);
				r.skip(Math.max(0, numDup) * 8);
				r.skip(Math.max(0, numSilEdges) * 4 * idx);
				const surfaceNum = r.i32be();
				const weights = new Float32Array(v.color2.length);
				for (let k = 0; k < weights.length; k++) weights[k] = v.color2[k]! / 255;
				meshes.push({
					id: i,
					material,
					positions: v.positions,
					uvs: v.uvs,
					normals: v.normals,
					colors: v.colors,
					indices,
					joints: v.color,
					weights,
					surfaceNum,
				});
			}
			end = r.pos;
			return { static: stat, joints, defaultPose, invertedDefaultPose, meshes };
		},
		() => end === bytes.length,
	);
}
