/**
 * FF7 `.a` field-animation parser.
 *
 * Each `.a` file holds ONE animation (a stand pose, a walk
 * cycle, a death, etc.) intended for a specific skeleton.
 * Files with matching `bonesCount` are interchangeable across
 * different characters with the same rig topology.
 *
 * # File layout
 *
 *   header                36 bytes
 *     0x00  u32           version (always 1)
 *     0x04  u32           framesCount
 *     0x08  u32           bonesCount
 *     0x0C  u8[3]         rotation order (axis indices 0..2)
 *     0x0F  u8            unused
 *     0x10  u32 × 5       runtime data (ignored at parse time)
 *
 *   frames                framesCount × frameSize bytes
 *     where frameSize = 24 + bonesCount × 12
 *
 *   per frame:
 *     0x00  vec3 float32  root rotation (Euler degrees)
 *     0x0C  vec3 float32  root translation (model-space)
 *     0x18  vec3 × N      per-bone rotation (Euler degrees,
 *                          one record per bone)
 *
 * # Rotation order
 *
 * The three axis indices at offset 0x0C tell you the order
 * Euler rotations are composed:
 *
 *   0 → α (pitch / X axis)
 *   1 → β (yaw   / Y axis)
 *   2 → γ (roll  / Z axis)
 *
 * `[1, 0, 2]` (the most common pattern in the FF7 char corpus)
 * means "rotate around Y first, then X, then Z" — i.e. apply
 * the per-bone Euler `(α, β, γ)` triple as `Ry(β) * Rx(α) *
 * Rz(γ)` in matrix form, OR equivalently `Rz(γ) ∘ Rx(α) ∘
 * Ry(β)` when expressed as intrinsic rotations applied to a
 * local frame from outer to inner.
 *
 * Angles are stored in DEGREES; conversion to radians is the
 * caller's responsibility.
 *
 * All multi-byte integers and floats are little-endian.
 */

export interface ParsedAnim {
	version: number;
	framesCount: number;
	bonesCount: number;
	/** Axis indices for the Euler composition order, in application order. */
	rotationOrder: [number, number, number];
	frames: AnimFrame[];
}

export interface AnimFrame {
	/** Euler (α, β, γ) in DEGREES applied to the model root. */
	rootRotation: [number, number, number];
	/** Translation applied to the model root, model-space units. */
	rootTranslation: [number, number, number];
	/**
	 * One Euler (α, β, γ) per bone, in DEGREES. Index matches
	 * the bone's order in the corresponding HRC.
	 */
	boneRotations: Array<[number, number, number]>;
}

export class AnimParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AnimParseError';
	}
}

const HEADER_SIZE = 36;

/**
 * Sniff whether a buffer looks like an FF7 `.a` animation file.
 * The format has no proper magic — `version` is always 1 and
 * the file size must match the declared frame count + bone
 * count exactly — so we do a structural check.
 */
export function isAnim(bytes: Uint8Array): boolean {
	if (bytes.byteLength < HEADER_SIZE) return false;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint32(0, true) !== 1) return false;
	const frames = v.getUint32(4, true);
	const bones = v.getUint32(8, true);
	if (frames === 0 || frames > 5000) return false;
	if (bones === 0 || bones > 256) return false;
	const expected = HEADER_SIZE + frames * (24 + bones * 12);
	return bytes.byteLength === expected;
}

/**
 * Parse a `.a` animation file. Validates the header + computes
 * the expected file size; throws {@link AnimParseError} on
 * mismatch. Decoding is dense — every frame's bone rotations
 * are pulled out into one `boneRotations` array per frame.
 */
export function parseAnim(bytes: Uint8Array): ParsedAnim {
	if (bytes.byteLength < HEADER_SIZE) {
		throw new AnimParseError(
			`.a file too small (${bytes.byteLength} < ${HEADER_SIZE})`,
		);
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = v.getUint32(0, true);
	if (version !== 1) {
		throw new AnimParseError(`Unsupported animation version ${version}`);
	}
	const framesCount = v.getUint32(4, true);
	const bonesCount = v.getUint32(8, true);
	const rotationOrder: [number, number, number] = [
		bytes[12]!,
		bytes[13]!,
		bytes[14]!,
	];
	const frameSize = 24 + bonesCount * 12;
	const expected = HEADER_SIZE + framesCount * frameSize;
	if (bytes.byteLength !== expected) {
		throw new AnimParseError(
			`Size mismatch: declared ${framesCount} frames × ${bonesCount} bones = ${expected} bytes, actual ${bytes.byteLength}`,
		);
	}

	const frames: AnimFrame[] = new Array(framesCount);
	let cursor = HEADER_SIZE;
	for (let f = 0; f < framesCount; f++) {
		const rootRotation: [number, number, number] = [
			v.getFloat32(cursor + 0, true),
			v.getFloat32(cursor + 4, true),
			v.getFloat32(cursor + 8, true),
		];
		const rootTranslation: [number, number, number] = [
			v.getFloat32(cursor + 12, true),
			v.getFloat32(cursor + 16, true),
			v.getFloat32(cursor + 20, true),
		];
		const boneRotations: Array<[number, number, number]> = new Array(
			bonesCount,
		);
		const boneBase = cursor + 24;
		for (let b = 0; b < bonesCount; b++) {
			boneRotations[b] = [
				v.getFloat32(boneBase + b * 12 + 0, true),
				v.getFloat32(boneBase + b * 12 + 4, true),
				v.getFloat32(boneBase + b * 12 + 8, true),
			];
		}
		frames[f] = { rootRotation, rootTranslation, boneRotations };
		cursor += frameSize;
	}

	return {
		version,
		framesCount,
		bonesCount,
		rotationOrder,
		frames,
	};
}
