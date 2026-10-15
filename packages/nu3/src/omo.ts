/**
 * OMO skeletal animations (`"OMO "`, big-endian), from Bandai Namco's
 * NU3 engine (Pokkén Tournament, Smash 4).
 *
 *     0x00  "OMO "   0x04  version (2 × u16)   0x08  flags (u32)
 *     0x0C  u16 0    0x0E  bone count   0x10  frame count   0x12  frame size
 *     0x14  node offset   0x18  initial-values offset   0x1C  key offset
 *
 * Each node (0x10 bytes) is a flags byte (1 = translation, 2 = rotation,
 * 4 = scale), a translation / rotation / scale type byte each, the VBN
 * bone ID it drives, an offset to its initial values (relative to the
 * initial-values block) and an offset within each frame's key data.
 * Frames are `frame size` bytes each; a node's channels read in order:
 *
 * - **Translation**: type 0x08 interpolated (base and range vec3, three
 *   u16 fractions per frame), 0x20 constant (vec3), 0x04 keyframed (a
 *   float vec3 per frame).
 * - **Rotation** (high nibble): 0xA compressed (8 bytes per frame: three
 *   20-bit quaternion components plus the index of the dropped one),
 *   0x5 interpolated (vec3 base and range, w reconstructed), 0x6
 *   keyframed (vec3 plus a step: z += u16 × step), 0x7 constant.
 * - **Scale**: type 0x80 interpolated; a constant scale is flagged by the
 *   rotation byte's low nibble (2 or 3).
 *
 * Bones without a channel keep their VBN bind values. Clips play at 60
 * fps.
 *
 * Sources: Smash Forge `OMOOld.cs` via CrusherD2/pokken-blender
 * (`omo_parser.py`, MIT), which documents the Pokkén variants.
 */

export type Vec3 = [number, number, number];
/** Quaternion as (x, y, z, w). */
export type Quat = [number, number, number, number];

type Track = 'none' | 'interp' | 'const' | 'key' | 'compressed';

export interface OmoNode {
	/** VBN bone ID (`VbnBone.id`) this node drives. */
	boneId: number;
	keyOffset: number;
	t: Track;
	r: Track;
	s: Track;
	tBase: Vec3;
	tRange: Vec3;
	rBase: Vec3;
	rRange: Vec3;
	rStep: number;
	sBase: Vec3;
	sRange: Vec3;
}

export interface Omo {
	frameCount: number;
	frameSize: number;
	keyOffset: number;
	nodes: OmoNode[];
	/** The file, for sampling frames. */
	bytes: Uint8Array;
}

export interface OmoSample {
	t?: Vec3;
	r?: Quat;
	s?: Vec3;
}

export function isOmo(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 0x20 && bytes[0] === 0x4f && bytes[1] === 0x4d && bytes[2] === 0x4f && bytes[3] === 0x20;
}

export function parseOmo(bytes: Uint8Array): Omo {
	if (!isOmo(bytes)) throw new Error('Not an OMO animation');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let boneCount = dv.getUint16(0x0e, false);
	const frameCount = dv.getUint16(0x10, false);
	const frameSize = dv.getUint16(0x12, false);
	const nodeOffset = dv.getInt32(0x14, false);
	const interOffset = dv.getInt32(0x18, false);
	const keyOffset = dv.getInt32(0x1c, false);
	if (boneCount > interOffset / 0x10) boneCount = Math.floor(interOffset / 0x10);
	const f = (o: number) => dv.getFloat32(o, false);
	const vec = (o: number): Vec3 => [f(o), f(o + 4), f(o + 8)];
	const nodes: OmoNode[] = [];
	for (let i = 0; i < boneCount; i++) {
		const o = nodeOffset + i * 0x10;
		if (o + 0x10 > bytes.byteLength) break;
		const flags = bytes[o]!;
		const tf = bytes[o + 1]!;
		const rf = bytes[o + 2]!;
		const sf = bytes[o + 3]!;
		const n: OmoNode = {
			boneId: dv.getUint32(o + 4, false),
			keyOffset: dv.getInt32(o + 0x0c, false),
			t: 'none',
			r: 'none',
			s: 'none',
			tBase: [0, 0, 0],
			tRange: [0, 0, 0],
			rBase: [0, 0, 0],
			rRange: [0, 0, 0],
			rStep: 0,
			sBase: [1, 1, 1],
			sRange: [0, 0, 0],
		};
		let p = interOffset + dv.getInt32(o + 8, false);
		if (flags & 1) {
			if (tf === 0x08) {
				n.t = 'interp';
				n.tBase = vec(p);
				n.tRange = vec(p + 12);
				p += 24;
			} else if (tf === 0x20) {
				n.t = 'const';
				n.tBase = vec(p);
				p += 12;
			} else if (tf === 0x04) n.t = 'key';
		}
		if (flags & 2) {
			const hi = rf & 0xf0;
			if (hi === 0xa0) n.r = 'compressed';
			else if (hi === 0x50) {
				n.r = 'interp';
				n.rBase = vec(p);
				n.rRange = vec(p + 12);
				p += 24;
			} else if (hi === 0x60) {
				n.r = 'key';
				n.rBase = vec(p);
				n.rStep = f(p + 12) / 65535;
				p += 16;
			} else if (hi === 0x70) {
				n.r = 'const';
				n.rBase = vec(p);
				p += 12;
			}
		}
		if (flags & 4) {
			if ((sf & 0xf0) === 0x80) {
				n.s = 'interp';
				n.sBase = vec(p);
				n.sRange = vec(p + 12);
				p += 24;
			}
			if ((rf & 0x0f) === 2 || (rf & 0x0f) === 3) {
				n.s = 'const';
				n.sBase = vec(p);
				p += 12;
			}
		}
		nodes.push(n);
	}
	return { frameCount, frameSize, keyOffset, nodes, bytes };
}

const SCALE1 = 1 / Math.SQRT2;
const SCALE2 = (SCALE1 * 2) / 1048575;

function normalize(q: Quat): Quat {
	const l = Math.hypot(q[0], q[1], q[2], q[3]);
	return l < 1e-8 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** w from x, y, z (the engine's Newton-refined inverse square root). */
function rot6W(x: number, y: number, z: number): number {
	const c = 1 - (x * x + y * y + z * z);
	let r = c - 1e-12 < 0 ? 0 : c > 0 ? 1 / Math.sqrt(Math.abs(c)) : 0;
	for (let i = 0; i < 3; i++) r = r * (1.5 - 0.5 * c * r * r);
	return c * r;
}

/** Sample every node at `frame` (clamped). */
export function sampleOmo(omo: Omo, frame: number): Map<number, OmoSample> {
	const { bytes } = omo;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const fi = Math.max(0, Math.min(omo.frameCount - 1, Math.floor(frame)));
	const out = new Map<number, OmoSample>();
	for (const n of omo.nodes) {
		let p = omo.keyOffset + omo.frameSize * fi + n.keyOffset;
		const u16 = () => {
			const v = p + 2 <= bytes.byteLength ? dv.getUint16(p, false) : 0;
			p += 2;
			return v;
		};
		const f32 = () => {
			const v = p + 4 <= bytes.byteLength ? dv.getFloat32(p, false) : 0;
			p += 4;
			return v;
		};
		const s: OmoSample = {};
		if (n.t === 'interp') {
			const a = u16() / 0xffff, b = u16() / 0xffff, c = u16() / 0xffff;
			s.t = [n.tBase[0] + n.tRange[0] * a, n.tBase[1] + n.tRange[1] * b, n.tBase[2] + n.tRange[2] * c];
		} else if (n.t === 'const') s.t = n.tBase;
		else if (n.t === 'key') s.t = [f32(), f32(), f32()];

		if (n.r === 'compressed') {
			const b = bytes.subarray(p, p + 8);
			p += 8;
			if (b.byteLength === 8) {
				const f1 = (b[0]! << 12) | (b[1]! << 4) | ((b[2]! & 0xf0) >> 4);
				const f2 = ((b[2]! & 0x0f) << 16) | (b[3]! << 8) | b[4]!;
				const f3 = (b[5]! << 12) | (b[6]! << 4) | ((b[7]! & 0xf0) >> 4);
				const c1 = f1 * SCALE2 - SCALE1, c2 = f2 * SCALE2 - SCALE1, c3 = f3 * SCALE2 - SCALE1;
				const rest = Math.sqrt(Math.abs(1 - (c1 * c1 + c2 * c2 + c3 * c3)));
				const which = b[7]! & 0x0f;
				s.r =
					which === 0 ? [rest, c1, c2, c3] : which === 1 ? [c1, rest, c2, c3] : which === 2 ? [c1, c2, rest, c3] : [c1, c2, c3, rest];
			}
		} else if (n.r === 'interp') {
			const a = u16() / 0xffff, b = u16() / 0xffff, c = u16() / 0xffff;
			const x = n.rBase[0] + n.rRange[0] * a, y = n.rBase[1] + n.rRange[1] * b, z = n.rBase[2] + n.rRange[2] * c;
			s.r = normalize([x, y, z, Math.sqrt(Math.abs(1 - (x * x + y * y + z * z)))]);
		} else if (n.r === 'key') {
			const [x, y, z0] = n.rBase;
			const z = z0 + u16() * n.rStep;
			s.r = [x, y, z, rot6W(x, y, z)];
		} else if (n.r === 'const') {
			const [x, y, z] = n.rBase;
			s.r = normalize([x, y, z, Math.sqrt(Math.abs(1 - (x * x + y * y + z * z)))]);
		}

		if (n.s === 'interp') {
			const a = u16() / 0xffff, b = u16() / 0xffff, c = u16() / 0xffff;
			s.s = [n.sBase[0] + n.sRange[0] * a, n.sBase[1] + n.sRange[1] * b, n.sBase[2] + n.sRange[2] * c];
		} else if (n.s === 'const') s.s = n.sBase;
		out.set(n.boneId, s);
	}
	return out;
}
