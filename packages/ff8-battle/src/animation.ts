/**
 * FFVIII battle DAT — Section 3: Animation.
 *
 * Section layout (section-relative):
 *
 *   offset  type      field
 *     0x00  u32       cAnimations
 *     0x04  u32[cAnimations]   pAnimations (section-relative offsets)
 *     ...   Animation[cAnimations]
 *
 * Each animation:
 *   offset  type      field
 *     0x00  u8        cFrames
 *     0x01  ...       bit-packed frame stream (decoded with BitReader)
 *
 * Frame decoding (using BitReader):
 *   - Root translation: 3 × readPositionType().
 *       * Frame 0: values are absolute (× 0.01 for the final position).
 *       * Frame 1+: values are DELTAS, accumulated onto the running root pos
 *         from the previous frame.
 *   - `modeTest` flag: 1 bit. When set, every bone reads 3 additional
 *     readRotationType() tuples AFTER the main rotations and the results
 *     are DISCARDED. The bit cursor must stay in sync.
 *   - For each bone:
 *       3 × readRotationType() — XYZ rotation deltas (accumulated across frames).
 *       If `modeTest` is set, ALSO read 3 more readRotationType()s and discard.
 *   - All rotation accumulators are tracked in "raw" units (the readRotationType
 *     return value, which is already a signed delta on a /4096 scale). Final
 *     degrees = `accum / 4096 * 360`.
 *
 * BitReader (matches OpenVIII's `ExtapathyExtended.cs:BitReader`):
 *
 *   - `readBits(count)` reads `count` bits LSB-first from a rolling 3-byte
 *     window starting at the current byte cursor.
 *   - The result is sign-extended treating `count` as the bit width.
 *   - After read:
 *       newBitCursor = (bitCursor + count) % 8
 *       byteCursor  += (bitCursor + count) / 8 (integer division)
 *
 *   - `readPositionType()` reads 2 bits, selects a count from [3,6,9,16],
 *     then reads that many signed bits.
 *
 *   - `readRotationType()` reads 1 bit (presence flag). If 0, returns 0.
 *     If 1, reads 2 bits → count from [3,6,8,12], then reads that many signed bits.
 */

import { DatParseError } from './header.js';

// ----------------------------------------------------------------------------
// BitReader
// ----------------------------------------------------------------------------

const POSITION_TYPE_BITS = [3, 6, 9, 16] as const;
const ROTATION_TYPE_BITS = [3, 6, 8, 12] as const;

export class BitReader {
	private bytes: Uint8Array;
	private byteCursor: number;
	private bitCursor: number;

	constructor(bytes: Uint8Array, startOffset = 0) {
		this.bytes = bytes;
		this.byteCursor = startOffset;
		this.bitCursor = 0;
	}

	get position(): { byte: number; bit: number } {
		return { byte: this.byteCursor, bit: this.bitCursor };
	}

	/**
	 * Read `count` bits LSB-first from the rolling 3-byte window at the
	 * current byte cursor. The result is sign-extended treating `count`
	 * as the bit width.
	 */
	readBits(count: number): number {
		if (count <= 0 || count > 24) {
			throw new RangeError(`BitReader.readBits: count must be 1..24, got ${count}`);
		}
		// Compose a 24-bit window from the next 3 bytes (LE order).
		const b0 = this.byteCursor < this.bytes.length ? this.bytes[this.byteCursor]! : 0;
		const b1 = this.byteCursor + 1 < this.bytes.length ? this.bytes[this.byteCursor + 1]! : 0;
		const b2 = this.byteCursor + 2 < this.bytes.length ? this.bytes[this.byteCursor + 2]! : 0;
		const window = b0 | (b1 << 8) | (b2 << 16);
		const mask = (1 << count) - 1;
		const raw = (window >>> this.bitCursor) & mask;

		// Sign-extend treating `count` as the bit width.
		const signBit = 1 << (count - 1);
		const signed = raw & signBit ? raw - (1 << count) : raw;

		// Advance cursors.
		const total = this.bitCursor + count;
		this.byteCursor += Math.floor(total / 8);
		this.bitCursor = total % 8;

		return signed;
	}

	readPositionType(): number {
		const sel = this.readUnsignedBits(2);
		const count = POSITION_TYPE_BITS[sel]!;
		return this.readBits(count);
	}

	readRotationType(): number {
		const present = this.readUnsignedBits(1);
		if (present === 0) return 0;
		const sel = this.readUnsignedBits(2);
		const count = ROTATION_TYPE_BITS[sel]!;
		return this.readBits(count);
	}

	/** Read `count` bits and return as an UNSIGNED integer (no sign extension). */
	readUnsignedBits(count: number): number {
		// Same logic as readBits but without sign extension.
		const b0 = this.byteCursor < this.bytes.length ? this.bytes[this.byteCursor]! : 0;
		const b1 = this.byteCursor + 1 < this.bytes.length ? this.bytes[this.byteCursor + 1]! : 0;
		const b2 = this.byteCursor + 2 < this.bytes.length ? this.bytes[this.byteCursor + 2]! : 0;
		const window = b0 | (b1 << 8) | (b2 << 16);
		const mask = (1 << count) - 1;
		const raw = (window >>> this.bitCursor) & mask;
		const total = this.bitCursor + count;
		this.byteCursor += Math.floor(total / 8);
		this.bitCursor = total % 8;
		return raw;
	}
}

// ----------------------------------------------------------------------------
// Animation decoder
// ----------------------------------------------------------------------------

export interface DatAnimationFrame {
	/** Root translation in "world units" (raw delta × 0.01, accumulated). */
	rootTranslation: [number, number, number];
	/** Per-bone (rotX, rotY, rotZ) in degrees. */
	boneRotations: [number, number, number][];
}

export interface DatAnimation {
	frames: DatAnimationFrame[];
}

function rawRotToDegrees(raw: number): number {
	return (raw / 4096) * 360;
}

function decodeOneAnimation(
	bytes: Uint8Array,
	startOffset: number,
	boneCount: number,
): DatAnimation {
	if (startOffset >= bytes.length) {
		throw new DatParseError(
			`Animation start offset ${startOffset} past EOF (${bytes.length})`,
		);
	}
	const cFrames = bytes[startOffset]!;
	const br = new BitReader(bytes, startOffset + 1);

	const frames: DatAnimationFrame[] = [];

	// Running accumulators.
	const rootAccum: [number, number, number] = [0, 0, 0];
	const boneAccum: [number, number, number][] = Array.from(
		{ length: boneCount },
		() => [0, 0, 0],
	);

	for (let f = 0; f < cFrames; f++) {
		// Root translation: 3 × readPositionType.
		const rx = br.readPositionType();
		const ry = br.readPositionType();
		const rz = br.readPositionType();
		if (f === 0) {
			rootAccum[0] = rx;
			rootAccum[1] = ry;
			rootAccum[2] = rz;
		} else {
			rootAccum[0] += rx;
			rootAccum[1] += ry;
			rootAccum[2] += rz;
		}

		// modeTest flag — single bit, unsigned.
		const modeTest = br.readUnsignedBits(1) !== 0;

		const boneRotations: [number, number, number][] = [];
		for (let b = 0; b < boneCount; b++) {
			const dx = br.readRotationType();
			const dy = br.readRotationType();
			const dz = br.readRotationType();
			boneAccum[b]![0] += dx;
			boneAccum[b]![1] += dy;
			boneAccum[b]![2] += dz;

			if (modeTest) {
				// Discard 3 more rotation reads to keep the bit cursor in sync.
				br.readRotationType();
				br.readRotationType();
				br.readRotationType();
			}

			boneRotations.push([
				rawRotToDegrees(boneAccum[b]![0]!),
				rawRotToDegrees(boneAccum[b]![1]!),
				rawRotToDegrees(boneAccum[b]![2]!),
			]);
		}

		frames.push({
			rootTranslation: [
				rootAccum[0] * 0.01,
				rootAccum[1] * 0.01,
				rootAccum[2] * 0.01,
			],
			boneRotations,
		});
	}

	return { frames };
}

export function parseAnimations(
	bytes: Uint8Array,
	sectionOffset: number,
	boneCount: number,
): DatAnimation[] {
	if (sectionOffset + 4 > bytes.length) {
		throw new DatParseError(
			`Animation section truncated at offset ${sectionOffset}`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const cAnimations = view.getUint32(sectionOffset + 0, true);
	if (cAnimations > 4096) {
		throw new DatParseError(
			`Animation cAnimations=${cAnimations} implausibly large`,
		);
	}
	const ptrTableEnd = sectionOffset + 4 + cAnimations * 4;
	if (ptrTableEnd > bytes.length) {
		throw new DatParseError(
			`Animation pointer table out of bounds (needs ${cAnimations * 4} bytes)`,
		);
	}
	const animOffsets: number[] = [];
	for (let i = 0; i < cAnimations; i++) {
		animOffsets.push(view.getUint32(sectionOffset + 4 + i * 4, true));
	}

	const animations: DatAnimation[] = [];
	for (const rel of animOffsets) {
		const animStart = sectionOffset + rel;
		try {
			animations.push(decodeOneAnimation(bytes, animStart, boneCount));
		} catch (e) {
			// Skip / record an empty animation on decode failure so the
			// section index alignment isn't lost.
			animations.push({ frames: [] });
			void e;
		}
	}
	return animations;
}
