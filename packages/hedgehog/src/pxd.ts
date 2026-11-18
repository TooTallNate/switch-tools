/**
 * Sonic Frontiers skeletons (`.skl.pxd`) and animations (`.anm.pxd`),
 * after PXD Animation Tools (WistfulHopes/PXDAnimationTools, the
 * Blender add-on's `skeleton_import.py` and `anim_import.py`).
 *
 * Both are BINA 2.1 little-endian files; the payload starts at 0x40 and
 * offsets are relative to it.
 *
 * Skeleton, `KSXP` version 0x200:
 *
 *   0x08  parent indices      (u64 offset, u64 count, u64 capacity) of s16
 *   0x28  bone names          (u64 offset, …) of 16-byte entries (u64 name offset, u64)
 *   0x48  bind transforms     (u64 offset, …) of 0x30: position xyz _, rotation xyzw, scale xyz _
 *
 * Transforms are local to the parent bone.
 *
 * Animation, `NAXP` version 0x200: flags (0x08 additive, 0x09 = 8
 * compressed), duration (f32 @0x18), frame count (u32 @0x1C), track
 * count (u64 @0x20), main data (u64 @0x28) and root motion (u64 @0x30).
 * A compressed clip is an ACL 2.0 `compressed_tracks` blob, one track
 * per skeleton bone (see `@tootallnate/acl-wasm`). An uncompressed one
 * is a table of 0x48-byte tracks: (key count, frame offset, value
 * offset) for translation, rotation and scale, u16 frame numbers and
 * 16-byte values.
 */

export interface PxdBone {
	name: string;
	parent: number;
	translation: [number, number, number];
	/** Quaternion x, y, z, w. */
	rotation: [number, number, number, number];
	scale: [number, number, number];
}

export interface PxdSkeleton {
	bones: PxdBone[];
}

const BASE = 0x40;

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function view(bytes: Uint8Array) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u64 = (o: number) => Number(dv.getBigUint64(o, true));
	const off = (o: number) => {
		const v = u64(o);
		return v ? v + BASE : 0;
	};
	const f32 = (o: number) => dv.getFloat32(o, true);
	return { dv, u64, off, f32 };
}

export function isPxdSkeleton(bytes: Uint8Array): boolean {
	return bytes.length > 0x60 && ascii(bytes, 0, 4) === 'BINA' && ascii(bytes, 0x40, 4) === 'KSXP';
}

export function isPxdAnimation(bytes: Uint8Array): boolean {
	return bytes.length > 0x78 && ascii(bytes, 0, 4) === 'BINA' && ascii(bytes, 0x40, 4) === 'NAXP';
}

export function parsePxdSkeleton(bytes: Uint8Array): PxdSkeleton {
	if (!isPxdSkeleton(bytes)) throw new Error('Not a PXD skeleton');
	const { dv, u64, off, f32 } = view(bytes);
	const parents = off(0x48), count = u64(0x50), names = off(0x68), xforms = off(0x88);
	const bones: PxdBone[] = [];
	const td = new TextDecoder();
	for (let i = 0; i < count; i++) {
		const n = off(names + i * 16);
		let e = n;
		while (e < bytes.length && bytes[e] !== 0) e++;
		const t = xforms + i * 0x30;
		bones.push({
			name: td.decode(bytes.subarray(n, e)),
			parent: dv.getInt16(parents + i * 2, true),
			translation: [f32(t), f32(t + 4), f32(t + 8)],
			rotation: [f32(t + 16), f32(t + 20), f32(t + 24), f32(t + 28)],
			scale: [f32(t + 32), f32(t + 36), f32(t + 40)],
		});
	}
	return { bones };
}

export interface PxdAnimation {
	additive: boolean;
	compressed: boolean;
	duration: number;
	frameCount: number;
	trackCount: number;
	/** Frames per second (frame count − 1 over duration; 30 when static). */
	fps: number;
	/** ACL blob (compressed) or the start of the track table (uncompressed). */
	main: Uint8Array | null;
	/** Root motion: one more ACL track, when present. */
	root: Uint8Array | null;
}

export function parsePxdAnimation(bytes: Uint8Array): PxdAnimation {
	if (!isPxdAnimation(bytes)) throw new Error('Not a PXD animation');
	const { dv, u64, off, f32 } = view(bytes);
	const additive = bytes[0x48] === 1;
	const compressed = bytes[0x49] === 8;
	const duration = f32(0x58);
	const frameCount = dv.getUint32(0x5c, true);
	const trackCount = u64(0x60);
	const mainAt = off(0x68);
	let rootAt = off(0x70);
	const fileSize = dv.getUint32(8, true);
	if (rootAt > fileSize || rootAt >= bytes.length) rootAt = 0;
	const blob = (at: number) => {
		if (!at) return null;
		if (!compressed) return bytes.subarray(at);
		const n = dv.getUint32(at, true);
		return bytes.subarray(at, Math.min(bytes.length, at + n));
	};
	return {
		additive,
		compressed,
		duration,
		frameCount,
		trackCount,
		fps: duration > 0 && frameCount > 1 ? (frameCount - 1) / duration : 30,
		main: blob(mainAt),
		root: blob(rootAt),
	};
}

/**
 * Sample an uncompressed clip to `frameCount × trackCount` transforms
 * (12 floats each, the layout of `@tootallnate/acl-wasm`), holding each
 * channel at `rest` (the skeleton's bind pose) until its first key and
 * interpolating linearly between keys.
 */
export function sampleUncompressedPxd(bytes: Uint8Array, anim: PxdAnimation, rest?: PxdSkeleton): Float32Array {
	const { dv, u64, off, f32 } = view(bytes);
	const table = off(0x68);
	const out = new Float32Array(anim.frameCount * anim.trackCount * 12);
	for (let t = 0; t < anim.trackCount; t++) {
		const at = table + t * 0x48;
		const bone = rest?.bones[t];
		// (channel, components, destination float): translation, rotation, scale.
		const channels: [number, number, number][] = [
			[0, 3, 4],
			[1, 4, 0],
			[2, 3, 8],
		];
		for (const [c, width, dst] of channels) {
			const count = u64(at + c * 0x18), frames = off(at + c * 0x18 + 8), values = off(at + c * 0x18 + 16);
			const def = c === 0 ? (bone?.translation ?? [0, 0, 0]) : c === 1 ? (bone?.rotation ?? [0, 0, 0, 1]) : (bone?.scale ?? [1, 1, 1]);
			const keyFrame = (k: number) => dv.getUint16(frames + k * 2, true);
			const keyValue = (k: number, i: number) => f32(values + k * 16 + i * 4);
			let k = 0;
			for (let f = 0; f < anim.frameCount; f++) {
				const o = (f * anim.trackCount + t) * 12 + dst;
				if (!count || !values) {
					for (let i = 0; i < width; i++) out[o + i] = def[i]!;
					continue;
				}
				while (k + 1 < count && keyFrame(k + 1) <= f) k++;
				const f0 = keyFrame(k);
				if (f <= f0 || k + 1 >= count) {
					for (let i = 0; i < width; i++) out[o + i] = keyValue(k, i);
					continue;
				}
				const f1 = keyFrame(k + 1), a = (f - f0) / Math.max(1, f1 - f0);
				let dot = 0;
				for (let i = 0; i < width; i++) dot += keyValue(k, i) * keyValue(k + 1, i);
				const sign = c === 1 && dot < 0 ? -1 : 1;
				for (let i = 0; i < width; i++) out[o + i] = keyValue(k, i) * (1 - a) + sign * keyValue(k + 1, i) * a;
				if (c === 1) {
					const l = Math.hypot(out[o]!, out[o + 1]!, out[o + 2]!, out[o + 3]!) || 1;
					for (let i = 0; i < 4; i++) out[o + i]! /= l;
				}
			}
		}
	}
	return out;
}
