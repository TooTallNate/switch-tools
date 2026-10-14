/**
 * DOOM 3 BFG `.bmd5anim` (`idMD5Anim::LoadBinary`, `d3xp/anim/Anim.cpp`
 * in id's GPL DOOM-3-BFG release).
 *
 *   u32 'BMD' 101, i64 timestamp, then (all big-endian ints):
 *   numFrames, frameRate, animLength (ms), numJoints, numAnimatedComponents,
 *   bounds[n] (6 floats each),
 *   jointInfo[n]: name (string), parent, animBits, firstComponent,
 *   baseFrame[n]: quaternion x, y, z, w (big-endian) + translation (little-endian),
 *   componentFrames[n + 1] (little-endian floats; one padding float),
 *   totalDelta (vec3).
 *
 * A frame starts from the base frame; each joint with `animBits`
 * reads its animated components from `frame · numAnimatedComponents +
 * firstComponent`, in order tx, ty, tz, qx, qy, qz (bits 0–5), and
 * recomputes `w = √|1 − x² − y² − z²|`. Joints are parent-relative.
 */
import { Reader } from './reader.js';

export const BMD5ANIM_MAGIC = 0x424d4465; // 'B' 'M' 'D' 101

export interface IdAnimJoint {
	name: string;
	parent: number;
	animBits: number;
	firstComponent: number;
}

export interface IdMd5Anim {
	numFrames: number;
	frameRate: number;
	/** Milliseconds. */
	animLength: number;
	numAnimatedComponents: number;
	joints: IdAnimJoint[];
	baseFrame: { q: [number, number, number, number]; t: [number, number, number] }[];
	componentFrames: Float32Array;
	totalDelta: [number, number, number];
}

export function isBmd5anim(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x42 && head[1] === 0x4d && head[2] === 0x44 && head[3] === 0x65;
}

export function parseBmd5anim(bytes: Uint8Array): IdMd5Anim {
	const r = new Reader(bytes);
	if (r.u32be() !== BMD5ANIM_MAGIC) throw new Error('Not a BFG binary MD5 animation (missing "BMDe")');
	r.time64be();
	const numFrames = r.i32be();
	const frameRate = r.i32be();
	const animLength = r.i32be();
	r.i32be(); // numJoints
	const numAnimatedComponents = r.i32be();
	const nBounds = r.i32be();
	r.skip(nBounds * 24);
	const nJoints = r.i32be();
	if (nJoints < 0 || nJoints > 4096) throw new Error(`Bad joint count ${nJoints}`);
	const joints: IdAnimJoint[] = [];
	for (let i = 0; i < nJoints; i++) joints.push({ name: r.string(), parent: r.i32be(), animBits: r.i32be(), firstComponent: r.i32be() });
	const nBase = r.i32be();
	const baseFrame: IdMd5Anim['baseFrame'] = [];
	for (let i = 0; i < nBase; i++) {
		const q: [number, number, number, number] = [r.f32be(), r.f32be(), r.f32be(), r.f32be()];
		baseFrame.push({ q, t: r.vec3le() });
	}
	const nComp = r.i32be();
	if (nComp < 0 || nComp * 4 > r.remaining) throw new Error(`Bad component count ${nComp}`);
	const componentFrames = new Float32Array(nComp + 1);
	for (let i = 0; i < nComp && r.remaining >= 4; i++) componentFrames[i] = r.f32le();
	if (r.remaining >= 4) r.f32le(); // pad
	const totalDelta = r.remaining >= 12 ? r.vec3le() : ([0, 0, 0] as [number, number, number]);
	return { numFrames, frameRate, animLength, numAnimatedComponents, joints, baseFrame, componentFrames, totalDelta };
}

/** Parent-relative joint quaternions + translations at a frame (fractional frames blend). */
export function sampleBmd5anim(anim: IdMd5Anim, frame: number): IdMd5Anim['baseFrame'] {
	const n = Math.max(1, anim.numFrames);
	const f = Math.max(0, Math.min(n - 1, frame));
	const f0 = Math.floor(f);
	const f1 = Math.min(n - 1, f0 + 1);
	const t = f - f0;
	const a = decodeFrame(anim, f0);
	if (t === 0 || f1 === f0) return a;
	const b = decodeFrame(anim, f1);
	return a.map((ja, i) => {
		const jb = b[i]!;
		let [bx, by, bz, bw] = jb.q;
		// Shortest path.
		if (ja.q[0] * bx + ja.q[1] * by + ja.q[2] * bz + ja.q[3] * bw < 0) [bx, by, bz, bw] = [-bx, -by, -bz, -bw];
		const q: [number, number, number, number] = [
			ja.q[0] + (bx - ja.q[0]) * t,
			ja.q[1] + (by - ja.q[1]) * t,
			ja.q[2] + (bz - ja.q[2]) * t,
			ja.q[3] + (bw - ja.q[3]) * t,
		];
		const l = Math.hypot(...q) || 1;
		return {
			q: [q[0] / l, q[1] / l, q[2] / l, q[3] / l],
			t: [ja.t[0] + (jb.t[0] - ja.t[0]) * t, ja.t[1] + (jb.t[1] - ja.t[1]) * t, ja.t[2] + (jb.t[2] - ja.t[2]) * t],
		};
	});
}

function decodeFrame(anim: IdMd5Anim, frame: number): IdMd5Anim['baseFrame'] {
	const out = anim.baseFrame.map((j) => ({ q: [...j.q] as [number, number, number, number], t: [...j.t] as [number, number, number] }));
	if (anim.numAnimatedComponents === 0) return out;
	const base = frame * anim.numAnimatedComponents;
	anim.joints.forEach((info, i) => {
		const j = out[i];
		if (!j || !info.animBits) return;
		let c = base + info.firstComponent;
		const cf = anim.componentFrames;
		if (info.animBits & 1) j.t[0] = cf[c++]!;
		if (info.animBits & 2) j.t[1] = cf[c++]!;
		if (info.animBits & 4) j.t[2] = cf[c++]!;
		if (info.animBits & 0x38) {
			if (info.animBits & 8) j.q[0] = cf[c++]!;
			if (info.animBits & 16) j.q[1] = cf[c++]!;
			if (info.animBits & 32) j.q[2] = cf[c++]!;
			j.q[3] = Math.sqrt(Math.abs(1 - (j.q[0] * j.q[0] + j.q[1] * j.q[1] + j.q[2] * j.q[2])));
		}
	});
	return out;
}
