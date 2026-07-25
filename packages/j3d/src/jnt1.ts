/**
 * `JNT1` — joints (bones).
 *
 * A flat table of transforms plus names; the *shape* of the skeleton lives in
 * `INF1`'s hierarchy, not here. That split exists because the joint table is
 * also the model's bounding-volume hierarchy: each joint carries a bounding
 * sphere and box covering everything attached at or below it, and the engine
 * culls whole limbs with it before touching any geometry.
 *
 * Payload layout:
 *
 *   0x00 u16 jointCount
 *   0x02 u16 padding
 *   0x04 u32 jointEntryOffset
 *   0x08 u32 remapTableOffset
 *   0x0C u32 nameTableOffset
 *
 * Joint entry, 0x40 bytes:
 *
 *   0x00 u16    matrixType     — how the engine builds this joint's matrix
 *                                (0 basic, 1 billboard, 2 y-billboard)
 *   0x02 u8     inheritScale   — 0 = ignore the parent's scale (Nintendo's
 *                                "segment scale compensate"), 1 = inherit it.
 *                                Some references label this byte simply
 *                                "unknown" or "calcFlags"; retail files only
 *                                ever hold 0 or 1, and the scale-inheritance
 *                                reading is the one every viewer uses. Treat it
 *                                as a hint, not gospel.
 *   0x03 u8     padding
 *   0x04 f32[3] scale
 *   0x10 s16[3] rotation
 *   0x16 u16    padding
 *   0x18 f32[3] translation
 *   0x24 f32    boundingSphereRadius
 *   0x28 f32[3] bboxMin
 *   0x34 f32[3] bboxMax
 *
 * Rotations are 16-bit fixed-point *binary angles*: the full circle is 65536
 * units, so 32768 = 180°. Storing angles this way is not just about size — a
 * binary angle wraps for free on integer overflow, so interpolating or
 * accumulating rotations never needs a range reduction, which matters when
 * you're evaluating animation curves on a 486-class integer unit. We expose
 * both the raw s16 triple and the converted radians.
 */

import { chunkOffset, validateChunk, type J3dChunk } from './container.js';
import { CHUNK_HEADER_SIZE, readJ3dStringTable } from './util.js';

export const JNT1_ENTRY_SIZE = 0x40;

/** Radians per binary-angle unit: a half turn spans 32768 units. */
export const JNT1_ROTATION_SCALE = Math.PI / 32768;

export interface Jnt1Joint {
	index: number;
	name: string;
	/** 0 basic, 1 billboard, 2 y-billboard. */
	matrixType: number;
	/** False when the joint ignores its parent's scale. */
	inheritScale: boolean;
	scale: [number, number, number];
	/** Rotation in radians, converted from the stored binary angles. */
	rotation: [number, number, number];
	/** The raw s16 binary angles, in case you need to round-trip them. */
	rotationRaw: [number, number, number];
	translation: [number, number, number];
	boundingSphereRadius: number;
	bboxMin: [number, number, number];
	bboxMax: [number, number, number];
}

export interface Jnt1 {
	joints: Jnt1Joint[];
	/** `u16` per joint: joint index → joint entry index. */
	remapTable: number[];
}

/** Parse a `JNT1` chunk. Returns `null` if the header or entry table won't fit. */
export function parseJnt1(bytes: Uint8Array, chunk: J3dChunk): Jnt1 | null {
	if (!validateChunk(bytes, chunk)) return null;
	if (chunk.size < CHUNK_HEADER_SIZE + 0x10) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;
	const chunkEnd = chunk.offset + chunk.size;

	const jointCount = view.getUint16(payload + 0x00, false);
	const entryRel = view.getUint32(payload + 0x04, false);
	const remapRel = view.getUint32(payload + 0x08, false);
	const nameRel = view.getUint32(payload + 0x0c, false);

	if (jointCount === 0) return { joints: [], remapTable: [] };

	const entryOffset = chunkOffset(chunk, entryRel, jointCount * JNT1_ENTRY_SIZE);
	if (entryOffset < 0) return null;

	const remapOffset = chunkOffset(chunk, remapRel, jointCount * 2);
	const remapTable: number[] = [];
	if (remapOffset >= 0) {
		for (let i = 0; i < jointCount; i++) {
			remapTable.push(view.getUint16(remapOffset + i * 2, false));
		}
	}

	const nameOffset = chunkOffset(chunk, nameRel, 4);
	const names = nameOffset >= 0 ? readJ3dStringTable(bytes, nameOffset, chunkEnd) : null;

	const joints: Jnt1Joint[] = [];
	for (let i = 0; i < jointCount; i++) {
		const p = entryOffset + i * JNT1_ENTRY_SIZE;
		const rx = view.getInt16(p + 0x10, false);
		const ry = view.getInt16(p + 0x12, false);
		const rz = view.getInt16(p + 0x14, false);
		joints.push({
			index: i,
			name: names && i < names.length ? names[i] : '',
			matrixType: view.getUint16(p + 0x00, false),
			inheritScale: view.getUint8(p + 0x02) !== 0,
			scale: [
				view.getFloat32(p + 0x04, false),
				view.getFloat32(p + 0x08, false),
				view.getFloat32(p + 0x0c, false),
			],
			rotation: [
				rx * JNT1_ROTATION_SCALE,
				ry * JNT1_ROTATION_SCALE,
				rz * JNT1_ROTATION_SCALE,
			],
			rotationRaw: [rx, ry, rz],
			translation: [
				view.getFloat32(p + 0x18, false),
				view.getFloat32(p + 0x1c, false),
				view.getFloat32(p + 0x20, false),
			],
			boundingSphereRadius: view.getFloat32(p + 0x24, false),
			bboxMin: [
				view.getFloat32(p + 0x28, false),
				view.getFloat32(p + 0x2c, false),
				view.getFloat32(p + 0x30, false),
			],
			bboxMax: [
				view.getFloat32(p + 0x34, false),
				view.getFloat32(p + 0x38, false),
				view.getFloat32(p + 0x3c, false),
			],
		});
	}

	return { joints, remapTable };
}
