/**
 * FF7 PC battle animation-pack parser.
 *
 * Each battle character / enemy's `<base>da` file is an
 * animation pack: a 4-byte header followed by all body
 * animations and weapon animations back-to-back. Counts come
 * from the master file's `numBodyAnimations` /
 * `numWeaponAnimations` fields, not from anything inside the
 * pack itself.
 *
 * Each animation is a 12-byte sub-header + a bit-packed delta-
 * compressed stream of frames:
 *
 *   offset  type    field
 *     0x00  u32     numBonesModel    (informational; "numBones + 1")
 *     0x04  u32     numFrames1       (unreliable)
 *     0x08  u32     blockLength      (total bytes after this 12-byte header)
 *     0x0C  u16     numFrames2       (unreliable)
 *     0x0E  u16     animationLength  (length of bit stream in bytes)
 *     0x10  u8      key              (quantization key; 0, 2, or 4)
 *     0x11  …       animationStream  (bit-packed, `animationLength` bytes)
 *     …             trailing data    (unparsed; `blockLength - animationLength` bytes)
 *
 * The bit stream encodes:
 *   - Frame 0 in full: rootTranslation (3 × 16 bits signed) + per-bone
 *     rotations (3 × (12-key) bits signed per axis, shifted up by `key`
 *     to recover 12-bit precision).
 *   - Frame 1..N in deltas: rootTranslation deltas (1 control bit per axis
 *     selects 7- or 16-bit signed length) + per-bone rotation deltas
 *     (1 has-delta bit per axis; if set, 3-bit length selects 1..6 bits
 *     or full (12-key) bits of signed delta).
 *
 * Each per-axis 12-bit accumulator wraps modulo 4096 each frame.
 * Final angle in degrees = `(accum < 0 ? accum + 4096 : accum) * 360 / 4096`.
 *
 * Body animations have `bonesVectorLength = numBones + 1` (where slot 0
 * is the ROOT rotation, separated out post-hoc). Weapon animations
 * have `bonesVectorLength = 1` (only the weapon-bone rotation, no
 * separate root).
 *
 * Rotation order is intrinsic YXZ (same as field models). Frame rate
 * is 15 fps.
 *
 * Reference: Kimera's `DAAnimationsPack*` modules + kujata's
 * `battle-animation-loader.js`.
 */

import type { BattleSkeletonHeader } from './skeleton.js';

export class BattleAnimationParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BattleAnimationParseError';
	}
}

export interface BattleAnimationFrame {
	rootTranslation: [number, number, number];
	/**
	 * For body animations: index 0 is the root rotation, indices 1..N
	 * are per-bone rotations. For weapon animations: only one entry
	 * (the weapon bone).
	 *
	 * All angles are in DEGREES, matching the field-anim convention.
	 */
	boneRotations: [number, number, number][];
}

export interface BattleAnimation {
	/** True when this slot was empty (skip in playback). */
	empty: boolean;
	/** Quantization key (0, 2, or 4); informational. */
	key: number;
	/**
	 * True when the malformed-header workaround fired (rare; mostly
	 * Frog/`rsaa`). Exposed for diagnostic UIs.
	 */
	missingNumFrames2: boolean;
	/** Decoded frames. Length may be < numFrames2 if the stream truncates. */
	frames: BattleAnimationFrame[];
}

export interface ParsedAnimationPack {
	/** Sentinel from the first 4 bytes; not reliable. */
	sentinelCount: number;
	bodyAnimations: BattleAnimation[];
	weaponAnimations: BattleAnimation[];
}

interface BitReader {
	bytes: Uint8Array;
	end: number; // first byte past the stream end
	bit: number; // global bit offset from `bytes[0]` bit 7
	exhausted: boolean;
}

function makeBitReader(bytes: Uint8Array, start: number, length: number): BitReader {
	return {
		bytes,
		end: start + length,
		bit: start * 8,
		exhausted: false,
	};
}

function readBitsUnsigned(r: BitReader, n: number): number {
	let value = 0;
	for (let i = 0; i < n; i++) {
		const byteIdx = r.bit >>> 3;
		const bitIdx = 7 - (r.bit & 7);
		if (byteIdx >= r.end) {
			r.exhausted = true;
			return value;
		}
		const bit = (r.bytes[byteIdx]! >> bitIdx) & 1;
		value = (value << 1) | bit;
		r.bit++;
	}
	return value;
}

function readBitsSigned(r: BitReader, n: number): number {
	if (n === 0) return 0;
	const u = readBitsUnsigned(r, n);
	const signBit = 1 << (n - 1);
	if (u & signBit) {
		// Sign-extend.
		return u - (1 << n);
	}
	return u;
}

/**
 * Convert a 12-bit signed accumulator (range [-2048, 2047]) to
 * a degree value in [0, 360). FF7 stores 12-bit fractions of a
 * full turn; negative values wrap by adding 4096 (= 1 turn).
 */
function accumToDegrees(accumSigned: number): number {
	const wrapped = accumSigned < 0 ? accumSigned + 0x1000 : accumSigned;
	return (wrapped / 4096) * 360;
}

function decodeAnimation(
	allBytes: Uint8Array,
	cursor: { offset: number },
	bonesVectorLength: number,
): BattleAnimation {
	const view = new DataView(
		allBytes.buffer,
		allBytes.byteOffset,
		allBytes.byteLength,
	);
	const start = cursor.offset;
	const numBonesModel = view.getUint32(start + 0, true); // unused
	void numBonesModel;
	const numFrames1 = view.getUint32(start + 4, true);
	void numFrames1;
	const blockLength = view.getUint32(start + 8, true);

	// Empty slot sentinel.
	if (blockLength < 11) {
		cursor.offset = start + 12 + blockLength;
		return {
			empty: true,
			key: 0,
			missingNumFrames2: false,
			frames: [],
		};
	}

	let numFrames2 = view.getUint16(start + 12, true);
	let animationLength = view.getUint16(start + 14, true);
	let key = view.getUint8(start + 16);
	let missingNumFrames2 = false;

	// Malformed-header workaround: when numFrames2 equals
	// `blockLength - 5`, the header is actually 10 bytes (no
	// numFrames2 field); shift the read by -2 bytes.
	if (numFrames2 === blockLength - 5) {
		numFrames2 = 0xffff; // unknown
		animationLength = view.getUint16(start + 12, true);
		key = view.getUint8(start + 14);
		missingNumFrames2 = true;
	}

	if (key !== 0 && key !== 2 && key !== 4) {
		// Invalid key — skip the whole slot.
		cursor.offset = start + 12 + blockLength;
		return {
			empty: true,
			key,
			missingNumFrames2,
			frames: [],
		};
	}

	const streamOffset = missingNumFrames2 ? start + 15 : start + 17;
	const br = makeBitReader(allBytes, streamOffset, animationLength);

	const fullBits = 12 - key;
	const frames: BattleAnimationFrame[] = [];
	// Per-bone running accumulators (one signed 12-bit value per axis).
	const accum: number[][] = Array.from({ length: bonesVectorLength }, () => [
		0,
		0,
		0,
	]);
	let rootT: [number, number, number] = [0, 0, 0];

	// -------- Frame 0 (uncompressed) --------
	{
		const tx = readBitsSigned(br, 16);
		const ty = readBitsSigned(br, 16);
		const tz = readBitsSigned(br, 16);
		if (br.exhausted) {
			cursor.offset = start + 12 + blockLength;
			return { empty: false, key, missingNumFrames2, frames };
		}
		rootT = [tx, ty, tz];
		const rotations: [number, number, number][] = [];
		for (let bi = 0; bi < bonesVectorLength; bi++) {
			const aRaw = readBitsSigned(br, fullBits);
			const bRaw = readBitsSigned(br, fullBits);
			const cRaw = readBitsSigned(br, fullBits);
			const a = aRaw << key;
			const b = bRaw << key;
			const c = cRaw << key;
			accum[bi] = [a, b, c];
			rotations.push([accumToDegrees(a), accumToDegrees(b), accumToDegrees(c)]);
			if (br.exhausted) break;
		}
		frames.push({ rootTranslation: rootT, boneRotations: rotations });
		if (br.exhausted) {
			cursor.offset = start + 12 + blockLength;
			return { empty: false, key, missingNumFrames2, frames };
		}
	}

	// -------- Frames 1..N (deltas) --------
	while (true) {
		const startBitOffset = br.bit;
		// Root-translation deltas.
		let truncated = false;
		const newRootT: [number, number, number] = [rootT[0], rootT[1], rootT[2]];
		for (let i = 0; i < 3; i++) {
			const flag = readBitsUnsigned(br, 1);
			if (br.exhausted) {
				truncated = true;
				break;
			}
			const offLen = flag === 0 ? 7 : 16;
			const delta = readBitsSigned(br, offLen);
			if (br.exhausted) {
				truncated = true;
				break;
			}
			newRootT[i] = newRootT[i]! + delta;
		}
		if (truncated) {
			br.bit = startBitOffset;
			break;
		}

		const rotations: [number, number, number][] = [];
		for (let bi = 0; bi < bonesVectorLength; bi++) {
			const newAxes: number[] = [accum[bi]![0]!, accum[bi]![1]!, accum[bi]![2]!];
			for (let axis = 0; axis < 3; axis++) {
				const hasDelta = readBitsUnsigned(br, 1);
				if (br.exhausted) {
					truncated = true;
					break;
				}
				let deltaRaw = 0;
				if (hasDelta === 1) {
					const dLen = readBitsUnsigned(br, 3);
					if (br.exhausted) {
						truncated = true;
						break;
					}
					if (dLen === 0) {
						deltaRaw = -1;
					} else if (dLen === 7) {
						deltaRaw = readBitsSigned(br, fullBits);
						if (br.exhausted) {
							truncated = true;
							break;
						}
					} else {
						const v = readBitsSigned(br, dLen);
						if (br.exhausted) {
							truncated = true;
							break;
						}
						// Sign-flip-shift: high bit of `v` indicates which
						// of two near-equal-magnitude deltas to pick.
						if (v < 0) {
							deltaRaw = v - (1 << (dLen - 1));
						} else {
							deltaRaw = v + (1 << (dLen - 1));
						}
					}
				}
				const delta = deltaRaw << key;
				// 12-bit wraparound (sign-extend to keep accumulator in
				// [-2048, 2047]).
				let next = (newAxes[axis]! + delta) & 0xfff;
				if (next & 0x800) next -= 0x1000;
				newAxes[axis] = next;
			}
			if (truncated) break;
			accum[bi] = [newAxes[0]!, newAxes[1]!, newAxes[2]!];
			rotations.push([
				accumToDegrees(newAxes[0]!),
				accumToDegrees(newAxes[1]!),
				accumToDegrees(newAxes[2]!),
			]);
		}

		if (truncated) {
			br.bit = startBitOffset;
			break;
		}

		rootT = newRootT;
		frames.push({ rootTranslation: rootT.slice() as [number, number, number], boneRotations: rotations });
	}

	cursor.offset = start + 12 + blockLength;
	return { empty: false, key, missingNumFrames2, frames };
}

/**
 * For body animations, the first per-frame rotation slot is
 * actually the ROOT rotation (not bone 0). Split it out post-
 * hoc so callers don't have to special-case slot 0.
 *
 * After splitting:
 *   - `frame.rootRotation` = the original `boneRotations[0]`
 *   - `frame.boneRotations` = the original `boneRotations.slice(1)`
 */
export interface SplitBattleAnimationFrame {
	rootTranslation: [number, number, number];
	rootRotation: [number, number, number];
	boneRotations: [number, number, number][];
}

export interface SplitBattleAnimation {
	empty: boolean;
	key: number;
	missingNumFrames2: boolean;
	frames: SplitBattleAnimationFrame[];
}

export function splitRootFromFrames(
	anim: BattleAnimation,
): SplitBattleAnimation {
	const frames: SplitBattleAnimationFrame[] = [];
	for (const f of anim.frames) {
		const root: [number, number, number] = f.boneRotations[0] ?? [0, 0, 0];
		frames.push({
			rootTranslation: f.rootTranslation,
			rootRotation: root,
			boneRotations: f.boneRotations.slice(1),
		});
	}
	return {
		empty: anim.empty,
		key: anim.key,
		missingNumFrames2: anim.missingNumFrames2,
		frames,
	};
}

/**
 * Parse a full animation pack (`<base>da` file).
 *
 * @param bytes The pack bytes.
 * @param header The master file's header (provides counts).
 */
export function parseAnimationPack(
	bytes: Uint8Array,
	header: Pick<
		BattleSkeletonHeader,
		'numBones' | 'numBodyAnimations' | 'numWeaponAnimations'
	>,
): ParsedAnimationPack {
	if (bytes.length < 4) {
		throw new BattleAnimationParseError(
			`Animation pack too short (${bytes.length} bytes)`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const sentinelCount = view.getUint32(0, true);
	const bodyBonesVectorLength = header.numBones > 1 ? header.numBones + 1 : 1;

	const cursor = { offset: 4 };
	const bodyAnimations: BattleAnimation[] = [];
	for (let i = 0; i < header.numBodyAnimations; i++) {
		if (cursor.offset + 12 > bytes.length) break;
		bodyAnimations.push(decodeAnimation(bytes, cursor, bodyBonesVectorLength));
	}

	const weaponAnimations: BattleAnimation[] = [];
	for (let i = 0; i < header.numWeaponAnimations; i++) {
		if (cursor.offset + 12 > bytes.length) break;
		weaponAnimations.push(decodeAnimation(bytes, cursor, 1));
	}

	return { sentinelCount, bodyAnimations, weaponAnimations };
}
