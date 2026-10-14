/**
 * Zelda 64 object files and their skeletal models.
 *
 * An object file (`object_link_boy`, `object_dodongo`, …) is loaded into
 * segment 6, so every pointer inside it is `0x06xxxxxx`. Characters are
 * skeletons (zeldaret oot/mm `z64animation.h`):
 *
 *   SkeletonHeader      u32 limbs (→ table of limb pointers), u8 limbCount
 *   FlexSkeletonHeader  SkeletonHeader, u8 dListCount
 *   StandardLimb        s16 jointPos[3], u8 child, u8 sibling, u32 dList   (12 bytes)
 *   LodLimb             s16 jointPos[3], u8 child, u8 sibling, u32 dLists[2] (16 bytes)
 *
 * Limb 0 is the root; `child` / `sibling` are limb indices (0xFF: none),
 * and each joint position is relative to its parent. The bind pose is
 * those translations alone (animation supplies rotations). Standard
 * skeletons draw each limb's display list under its own matrix; flex
 * skeletons (skinned) instead select matrices inside the lists with
 * `G_MTX` through segment 0x0D, one per limb that has a display list,
 * in draw order (`SkelAnime_DrawFlexLimbOpa`).
 *
 * The files carry no symbol table, so {@link findZ64Skeletons} finds
 * headers structurally: an in-file limb table whose limbs all have
 * valid indices and in-file display lists, forming a single tree.
 */

import { interpretDisplayList, type F3dexMesh, type SegmentResolver } from '@tootallnate/f3dex';
import { mergeF3dexMeshes } from './scene.js';

export interface Z64SkeletonRef {
	/** Offset of the skeleton header in the object file. */
	offset: number;
	limbCount: number;
	/** Display-list count for flex (skinned) skeletons, else null. */
	flexDListCount: number | null;
	/** 12 (standard) or 16 (LOD) bytes per limb. */
	limbSize: 12 | 16;
	/** Limb offsets in the object file. */
	limbs: number[];
}

const u8 = (b: Uint8Array, o: number) => b[o] ?? 0;
const s16 = (b: Uint8Array, o: number) => (((u8(b, o) << 8) | u8(b, o + 1)) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;

/** Plausible first opcodes of an F3DEX2 display list. */
const DL_FIRST = new Set([0x01, 0x05, 0x06, 0xd7, 0xd9, 0xda, 0xde, 0xdf, 0xe1, 0xe2, 0xe3, 0xe7, 0xef, 0xf2, 0xf5, 0xfa, 0xfb, 0xfc, 0xfd, 0xd8]);

function segPtr(obj: Uint8Array, p: number, size = 4): number | null {
	if (p >>> 24 !== 0x06) return null;
	const o = p & 0xffffff;
	return o % 4 === 0 && o + size <= obj.length ? o : null;
}

function validDl(obj: Uint8Array, p: number): boolean {
	if (p === 0) return true;
	const o = segPtr(obj, p, 8);
	return o !== null && o % 8 === 0 && DL_FIRST.has(u8(obj, o));
}

/** Find skeleton headers in an object file. */
export function findZ64Skeletons(obj: Uint8Array): Z64SkeletonRef[] {
	const out: Z64SkeletonRef[] = [];
	const usedTables = new Set<number>();
	for (let o = 0; o + 12 <= obj.length; o += 4) {
		const table = segPtr(obj, u32(obj, o));
		if (table === null || usedTables.has(table)) continue;
		const count = u8(obj, o + 4);
		if (count < 2 || count > 120 || u8(obj, o + 5) || u8(obj, o + 6) || u8(obj, o + 7)) continue;
		if (table + count * 4 > obj.length) continue;
		const limbs: number[] = [];
		for (let i = 0; i < count; i++) {
			const l = segPtr(obj, u32(obj, table + i * 4), 12);
			if (l === null) break;
			limbs.push(l);
		}
		if (limbs.length !== count) continue;
		// Limb size: LOD limbs sit 16 bytes apart, standard ones 12.
		const deltas = limbs.slice(1).map((l, i) => l - limbs[i]!);
		const limbSize: 12 | 16 = deltas.filter((d) => d === 16).length > deltas.filter((d) => d === 12).length ? 16 : 12;
		let ok = true, dls = 0;
		for (const l of limbs) {
			const child = u8(obj, l + 6), sib = u8(obj, l + 7);
			if ((child !== 0xff && child >= count) || (sib !== 0xff && sib >= count)) ok = false;
			const dl = u32(obj, l + 8);
			if (!validDl(obj, dl) || (limbSize === 16 && !validDl(obj, u32(obj, l + 12)))) ok = false;
			if (dl) dls++;
			if (!ok) break;
		}
		if (!ok || dls === 0) continue;
		// Every limb must be reachable exactly once from the root.
		const seen = new Set<number>();
		const stack = [0];
		while (stack.length && ok) {
			const i = stack.pop()!;
			if (seen.has(i)) ok = false;
			seen.add(i);
			const l = limbs[i]!;
			const child = u8(obj, l + 6), sib = u8(obj, l + 7);
			if (child !== 0xff) stack.push(child);
			if (sib !== 0xff) stack.push(sib);
		}
		if (!ok || seen.size !== count) continue;
		const flex = u8(obj, o + 8);
		const isFlex = flex > 0 && flex <= count && !u8(obj, o + 9) && !u8(obj, o + 10) && !u8(obj, o + 11);
		usedTables.add(table);
		out.push({ offset: o, limbCount: count, flexDListCount: isFlex ? flex : null, limbSize, limbs });
	}
	return out;
}

/** Row-major, row-vector translation matrix (f3dex convention). */
function translation(x: number, y: number, z: number): Float32Array {
	const m = new Float32Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	m[12] = x;
	m[13] = y;
	m[14] = z;
	return m;
}

/**
 * An `AnimationHeader` (z64animation.h): `s16 frameCount, u16 pad,
 * u32 frameData (s16[]), u32 jointIndices (u16 x/y/z per joint),
 * u16 staticIndexMax`. Joint 0 is the root translation, joint i+1 limb
 * i's rotation (binary angles). An index below `staticIndexMax` reads
 * `frameData[index]` on every frame; others read `frameData[index + frame]`.
 */
export interface Z64AnimationRef {
	offset: number;
	frameCount: number;
	frameData: number;
	jointIndices: number;
	staticIndexMax: number;
}

/** Animation headers in an object file that fit a skeleton of `limbCount` limbs. */
export function findZ64Animations(obj: Uint8Array, limbCount: number): Z64AnimationRef[] {
	const out: Z64AnimationRef[] = [];
	const u16 = (o: number) => (u8(obj, o) << 8) | u8(obj, o + 1);
	for (let o = 0; o + 16 <= obj.length; o += 4) {
		const frameCount = s16(obj, o);
		if (frameCount < 1 || frameCount > 2000 || u16(o + 2) !== 0 || u16(o + 14) !== 0) continue;
		const frameData = segPtr(obj, u32(obj, o + 4), 2);
		const jointIndices = segPtr(obj, u32(obj, o + 8), (limbCount + 1) * 6);
		if (frameData === null || jointIndices === null) continue;
		const staticIndexMax = u16(o + 12);
		// A header follows its own joint table, which has exactly one
		// entry per limb plus the root, and the frame data precedes both.
		const tableEnd = jointIndices + (limbCount + 1) * 6;
		if (o < tableEnd || o - tableEnd >= 8 || frameData >= jointIndices) continue;
		const values = (jointIndices - frameData) >> 1;
		let ok = true;
		for (let k = 0; k < (limbCount + 1) * 3 && ok; k++) {
			const idx = u16(jointIndices + k * 2);
			const last = idx < staticIndexMax ? idx : idx + frameCount - 1;
			if (last >= values) ok = false;
		}
		if (ok) out.push({ offset: o, frameCount, frameData, jointIndices, staticIndexMax });
	}
	return out;
}

/** Joint values (root translation, then limb rotations) of `anim` at `frame`. */
export function z64AnimationFrame(obj: Uint8Array, anim: Z64AnimationRef, limbCount: number, frame = 0): Int16Array {
	const out = new Int16Array((limbCount + 1) * 3);
	const f = Math.min(Math.max(0, frame), anim.frameCount - 1);
	for (let k = 0; k < out.length; k++) {
		const idx = (u8(obj, anim.jointIndices + k * 2) << 8) | u8(obj, anim.jointIndices + k * 2 + 1);
		out[k] = s16(obj, anim.frameData + (idx < anim.staticIndexMax ? idx : idx + f) * 2);
	}
	return out;
}

/** Row-vector rotation about one axis by a binary angle. */
function rot(axis: 0 | 1 | 2, a: number): Float32Array {
	const r = (a / 32768) * Math.PI, c = Math.cos(r), s = Math.sin(r);
	const m = translation(0, 0, 0);
	// Row-vector form (transpose of the column-vector rotation).
	if (axis === 0) { m[5] = c; m[6] = s; m[9] = -s; m[10] = c; }
	else if (axis === 1) { m[0] = c; m[2] = -s; m[8] = s; m[10] = c; }
	else { m[0] = c; m[1] = s; m[4] = -s; m[5] = c; }
	return m;
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
	const o = new Float32Array(16);
	for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
		let v = 0;
		for (let k = 0; k < 4; k++) v += a[i * 4 + k]! * b[k * 4 + j]!;
		o[i * 4 + j] = v;
	}
	return o;
}

/**
 * World matrices (row-vector) per limb. With an animation frame, each
 * limb is `T(jointPos) · Rz · Ry · Rx` under its parent
 * (`Matrix_TranslateRotateZYX`) and the root takes the frame's root
 * translation; without one, translations only.
 */
export function z64LimbMatrices(obj: Uint8Array, ref: Z64SkeletonRef, frame: Int16Array | null): Float32Array[] {
	const out: Float32Array[] = new Array(ref.limbCount);
	const walk = (i: number, parent: Float32Array | null) => {
		for (let g = 0; i !== 0xff && g < 256; g++) {
			const l = ref.limbs[i]!;
			let x = s16(obj, l), y = s16(obj, l + 2), z = s16(obj, l + 4);
			if (i === 0 && frame) [x, y, z] = [frame[0]!, frame[1]!, frame[2]!];
			let local = translation(x, y, z);
			if (frame) {
				const rx = frame[(i + 1) * 3]!, ry = frame[(i + 1) * 3 + 1]!, rz = frame[(i + 1) * 3 + 2]!;
				// Column-vector T·Rz·Ry·Rx → row-vector Rx·Ry·Rz·T.
				local = mul(mul(mul(rot(0, rx), rot(1, ry)), rot(2, rz)), local);
			}
			const world = parent ? mul(local, parent) : local;
			out[i] = world;
			const child = u8(obj, l + 6);
			if (child !== 0xff) walk(child, world);
			i = u8(obj, l + 7);
		}
	};
	walk(0, null);
	return out;
}

export interface Z64BuildOptions {
	/** Pose: an animation frame from {@link z64AnimationFrame}; bind pose when absent. */
	frame?: Int16Array | null;
	/**
	 * Resolver for the combined buffer: segment 6 → the object, and
	 * optionally segment 4 → `gameplay_keep` appended after it.
	 */
	resolveSegment: SegmentResolver;
}

/** Joint origins (bind pose) per limb. */
export function z64JointPositions(obj: Uint8Array, ref: Z64SkeletonRef): Float32Array {
	const out = new Float32Array(ref.limbCount * 3);
	const walk = (i: number, px: number, py: number, pz: number) => {
		for (let g = 0; i !== 0xff && g < 256; g++) {
			const l = ref.limbs[i]!;
			const x = px + s16(obj, l), y = py + s16(obj, l + 2), z = pz + s16(obj, l + 4);
			out.set([x, y, z], i * 3);
			const child = u8(obj, l + 6);
			if (child !== 0xff) walk(child, x, y, z);
			i = u8(obj, l + 7);
		}
	};
	walk(0, 0, 0, 0);
	return out;
}

export interface Z64SkeletonMesh extends Pick<F3dexMesh, 'positions' | 'normals' | 'colors' | 'alphas' | 'uvs' | 'indices' | 'groups' | 'materials' | 'usesLighting'> {
	/** Per vertex: the limb it was drawn by (rigid limbs) or 0. */
	vertexLimb: Uint16Array;
	jointPositions: Float32Array;
	parents: Int16Array;
}

/**
 * Draw a skeleton's bind pose. `data` is the buffer `resolveSegment`
 * maps into (the object, optionally followed by `gameplay_keep`).
 */
export function buildZ64SkeletonMesh(data: Uint8Array, obj: Uint8Array, ref: Z64SkeletonRef, options: Z64BuildOptions): Z64SkeletonMesh {
	const mats = z64LimbMatrices(obj, ref, options.frame ?? null);
	const joints = new Float32Array(ref.limbCount * 3);
	mats.forEach((m, i) => joints.set([m[12]!, m[13]!, m[14]!], i * 3));
	const parents = new Int16Array(ref.limbCount).fill(-1);
	// Draw order (depth-first, child before sibling) of limbs with display lists.
	const order: number[] = [];
	const visit = (i: number, parent: number) => {
		for (let g = 0; i !== 0xff && g < 256; g++) {
			const l = ref.limbs[i]!;
			parents[i] = parent;
			order.push(i);
			const child = u8(obj, l + 6);
			if (child !== 0xff) visit(child, i);
			i = u8(obj, l + 7);
		}
	};
	visit(0, -1);
	const limbMatrix = (i: number) => mats[i] ?? translation(0, 0, 0);
	const flexMatrices: Float32Array[] = [];
	for (const i of order) if (u32(obj, ref.limbs[i]! + 8)) flexMatrices.push(limbMatrix(i));

	// One synthetic list, `G_MTX limb; G_DL limb.dList` per limb, run in a
	// single pass: limbs share the RSP vertex cache (a limb's triangles can
	// use vertices the previous limb loaded), as in SkelAnime_Draw*.
	// It lives in segment 0x0F after `data`; 0x0F800000 + i·0x40 names
	// limb i's matrix.
	const drawn = order.filter((i) => u32(obj, ref.limbs[i]! + 8));
	const synth = new Uint8Array(drawn.length * 16 + 8);
	const sv = new DataView(synth.buffer);
	drawn.forEach((i, k) => {
		sv.setUint32(k * 16, 0xda380003); // gsSPMatrix(G_MTX_LOAD | G_MTX_NOPUSH | G_MTX_MODELVIEW)
		sv.setUint32(k * 16 + 4, 0x0f800000 + i * 0x40);
		sv.setUint32(k * 16 + 8, 0xde000000); // gsSPDisplayList
		sv.setUint32(k * 16 + 12, u32(obj, ref.limbs[i]! + 8));
	});
	sv.setUint32(drawn.length * 16, 0xdf000000);
	const buf = new Uint8Array(data.length + synth.length);
	buf.set(data);
	buf.set(synth, data.length);
	const resolveSegment: SegmentResolver = (addr) => {
		if (addr >>> 24 === 0x0f) {
			const o = addr & 0xffffff;
			return o < synth.length ? data.length + o : null;
		}
		return options.resolveSegment(addr);
	};
	const dbg = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.Z64DBG ?? '';
	const resolveMatrix = (addr: number) => {
		if (addr >>> 24 === 0x0d) return dbg === 'no0d' ? null : (flexMatrices[(addr & 0xffffff) >> 6] ?? null);
		if (addr >>> 20 === 0x0f8) return limbMatrix((addr & 0xfffff) >> 6);
		return null;
	};
	const mesh = interpretDisplayList(buf, data.length, {
		microcode: 'f3dex2',
		resolveSegment,
		trustSegments: true,
		resolveMatrix,
		maxCommands: 200000,
	});
	const parts = mesh.indices.length ? [{ mesh, limb: 0 }] : [];
	const merged = mergeF3dexMeshes(parts.map((p) => p.mesh));
	return { ...merged, vertexLimb: new Uint16Array(merged.positions.length / 3), jointPositions: joints, parents };
}

/**
 * `gObjectTable` in the `code` file: consecutive (vromStart, vromEnd)
 * pairs matching dmadata entries. Index = object ID; null for empty slots.
 */
export function findZ64ObjectTable(code: Uint8Array, files: readonly { vromStart: number; vromEnd: number }[]): ({ vromStart: number; vromEnd: number } | null)[] | null {
	const starts = new Map(files.map((f) => [f.vromStart, f.vromEnd]));
	for (let o = 0; o + 16 * 8 <= code.length; o += 4) {
		// Entry 0 is zero; entry 1 (gameplay_keep) is a real file.
		if (u32(code, o) !== 0 || u32(code, o + 4) !== 0) continue;
		let n = 1, hits = 0, misses = 0;
		while (o + n * 8 + 8 <= code.length) {
			const s = u32(code, o + n * 8), e = u32(code, o + n * 8 + 4);
			if (s === 0 && e === 0) {
				n++;
				continue;
			}
			if (starts.get(s) === e) {
				hits++;
				n++;
				continue;
			}
			if (e === s && s !== 0) {
				// Empty (zero-size) slot.
				n++;
				misses++;
				continue;
			}
			break;
		}
		if (hits >= 50 && misses < hits) {
			const out: ({ vromStart: number; vromEnd: number } | null)[] = [];
			for (let i = 0; i < n; i++) {
				const s = u32(code, o + i * 8), e = u32(code, o + i * 8 + 4);
				out.push(s && e > s ? { vromStart: s, vromEnd: e } : null);
			}
			return out;
		}
	}
	return null;
}
