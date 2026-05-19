/**
 * FFVIII battle DAT — Section 1: Skeleton.
 *
 * Layout (section-relative), per OpenVIII's `Skeleton.cs`:
 *
 *   offset  type    field
 *     0x00  u16     cBones
 *     0x02  u16     scale            (raw u16; OpenVIII applies `/2048 * 12`)
 *     0x04  u16     unk2
 *     0x06  u16     unk3
 *     0x08  u16     unk4
 *     0x0A  u16     unk5
 *     0x0C  u16     unk6
 *     0x0E  u16     unk7
 *     0x10  Bone[cBones]              (48 bytes each)
 *
 * Bone record (48 bytes):
 *
 *   offset  type    field
 *     0x00  u16     parentId         (0xFFFF for root)
 *     0x02  i16     boneSize         (fixed-point; divide by 4096)
 *     0x04  i16     rotX             (fixed-point; raw/4096 * 360 = degrees)
 *     0x06  i16     rotY
 *     0x08  i16     rotZ
 *     0x0A  i16     unk4
 *     0x0C  i16     unk5
 *     0x0E  i16     unk6
 *     0x10  u8[32]  unknown          (per-bone padding/state)
 */

import { DatParseError } from './header.js';

export const SKELETON_HEADER_SIZE = 0x10 as const;
export const BONE_SIZE = 48 as const;

export interface DatBone {
	/** 0xFFFF for root. */
	parentId: number;
	/** Raw i16 bone length — divide by 4096 for the fixed-point fractional length. */
	boneSize: number;
	rotX: number; // degrees
	rotY: number;
	rotZ: number;
	/** Three more unknown i16 fields (named unk4, unk5, unk6 in the spec). */
	unk4: number;
	unk5: number;
	unk6: number;
}

export interface DatSkeleton {
	cBones: number;
	/**
	 * Raw u16 scale. OpenVIII applies `scale / 2048 * 12` to derive a per-axis
	 * scale factor — consumers can replicate that or use the raw value.
	 */
	scale: number;
	bones: DatBone[];
}

function rawRotToDegrees(raw: number): number {
	return (raw / 4096) * 360;
}

export function parseSkeleton(
	bytes: Uint8Array,
	sectionOffset: number,
): DatSkeleton {
	if (sectionOffset + SKELETON_HEADER_SIZE > bytes.length) {
		throw new DatParseError(
			`Skeleton section truncated at offset ${sectionOffset} (need ${SKELETON_HEADER_SIZE} header bytes)`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const cBones = view.getUint16(sectionOffset + 0x00, true);
	const scale = view.getUint16(sectionOffset + 0x02, true);
	const expectedEnd = sectionOffset + SKELETON_HEADER_SIZE + cBones * BONE_SIZE;
	if (expectedEnd > bytes.length) {
		throw new DatParseError(
			`Skeleton declares ${cBones} bones, needs ${expectedEnd - sectionOffset} bytes but only ${bytes.length - sectionOffset} available`,
		);
	}
	const bones: DatBone[] = [];
	for (let i = 0; i < cBones; i++) {
		const off = sectionOffset + SKELETON_HEADER_SIZE + i * BONE_SIZE;
		bones.push({
			parentId: view.getUint16(off + 0x00, true),
			boneSize: view.getInt16(off + 0x02, true),
			rotX: rawRotToDegrees(view.getInt16(off + 0x04, true)),
			rotY: rawRotToDegrees(view.getInt16(off + 0x06, true)),
			rotZ: rawRotToDegrees(view.getInt16(off + 0x08, true)),
			unk4: view.getInt16(off + 0x0a, true),
			unk5: view.getInt16(off + 0x0c, true),
			unk6: view.getInt16(off + 0x0e, true),
		});
	}
	return { cBones, scale, bones };
}
