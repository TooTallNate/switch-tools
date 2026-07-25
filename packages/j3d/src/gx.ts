/**
 * The GX enumerations that J3D stores verbatim.
 *
 * J3D is not an abstract interchange format — it is a serialisation of the
 * GameCube's graphics hardware state. The numbers in `VTX1`'s format table and
 * `SHP1`'s display lists are the exact values the game passes to
 * `GXSetVtxAttrFmt` / `GXSetVtxDesc` and the exact opcodes the graphics
 * processor's command processor ("CP") decodes. So rather than invent our own
 * enums, we mirror GX's.
 *
 * ## Attributes
 *
 * GX describes a vertex as up to 26 independent *attributes*. The interesting
 * thing for a file-format reader is that attributes 0..8 are **matrix
 * indices**, not data: they select which of the 10 position matrices and 8
 * texture matrices currently loaded in the transform unit's small on-chip
 * memory (XF memory) should be applied to this vertex. That is how the
 * GameCube does skinning with no shaders — one bone index per vertex, poked
 * directly into the vertex stream.
 *
 * Because they are indices *into hardware state*, matrix-index attributes are
 * always `GX_DIRECT` in a display list: the byte in the vertex stream is the
 * value itself, and there is no array in the file for them to index. This is
 * exactly why `VTX1`'s array-offset table starts at `GX_VA_POS` (9) rather
 * than at attribute 0 — see the comment in `vtx1.ts`.
 *
 * ## Component types
 *
 * Positions, normals and texture coordinates share one set of numeric types
 * (`GxCompType`); colours have their own packing formats (`GxColorCompType`),
 * because the GP fetches colours through a different path in the vertex cache.
 *
 * ## Primitives
 *
 * A GX primitive opcode is `0x80 | (type << 3) | vat`, where `vat` is which of
 * the eight "vertex attribute tables" (format descriptors) the following
 * vertices use. J3D always writes VAT 0, but we mask the low three bits off
 * anyway so that a file using another VAT still parses — the VAT choice
 * affects nothing we do, since J3D stores the format in `VTX1` instead.
 *
 * References:
 *   - YAGCD, chapters on the CP and XF
 *   - Dolphin, Source/Core/VideoCommon/OpcodeDecoding.cpp
 *   - libogc's gx.h (the GX_* constants below match it exactly)
 */

/** GX vertex attributes (`GX_VA_*`). */
export const GxAttr = {
	/** Position/normal matrix index — always DIRECT; selects a bone. */
	PNMTXIDX: 0,
	TEX0MTXIDX: 1,
	TEX1MTXIDX: 2,
	TEX2MTXIDX: 3,
	TEX3MTXIDX: 4,
	TEX4MTXIDX: 5,
	TEX5MTXIDX: 6,
	TEX6MTXIDX: 7,
	TEX7MTXIDX: 8,
	POS: 9,
	NRM: 10,
	CLR0: 11,
	CLR1: 12,
	TEX0: 13,
	TEX1: 14,
	TEX2: 15,
	TEX3: 16,
	TEX4: 17,
	TEX5: 18,
	TEX6: 19,
	TEX7: 20,
	/** `GX_VA_POS_MTX_ARRAY`: the last slot in VTX1's offset table. Unused by J3D. */
	POS_MTX_ARRAY: 21,
	/** Terminator for both VTX1's format table and SHP1's attribute table. */
	NULL: 0xff,
} as const;

/** How a display list supplies an attribute (`GX_NONE`/`GX_DIRECT`/`GX_INDEX*`). */
export const GxAttrType = {
	/** Attribute absent; contributes nothing to the vertex stream. */
	NONE: 0,
	/** Value is inline in the vertex stream (1 byte for the matrix indices). */
	DIRECT: 1,
	INDEX8: 2,
	INDEX16: 3,
} as const;

/**
 * Bytes each attribute type occupies in a display-list vertex.
 *
 * `DIRECT` is one byte here because the only attributes J3D ever marks DIRECT
 * are the matrix indices, which are single bytes. (A truly direct *position*
 * would be however many bytes its format needs — GX allows it, J3D never does
 * it, and we'd be unable to index it into a vertex array anyway.)
 */
export function gxAttrTypeSize(attrType: number): number {
	switch (attrType) {
		case GxAttrType.NONE:
			return 0;
		case GxAttrType.DIRECT:
			return 1;
		case GxAttrType.INDEX8:
			return 1;
		case GxAttrType.INDEX16:
			return 2;
		default:
			return -1;
	}
}

/** Numeric types for position/normal/texcoord components (`GX_U8`..`GX_F32`). */
export const GxCompType = {
	U8: 0,
	S8: 1,
	U16: 2,
	S16: 3,
	F32: 4,
} as const;

/** Packing formats for colour components (`GX_RGB565`..`GX_RGBA8`). */
export const GxColorCompType = {
	RGB565: 0,
	RGB8: 1,
	RGBX8: 2,
	RGBA4: 3,
	RGBA6: 4,
	RGBA8: 5,
} as const;

/** Size in bytes of one `GxCompType` component. -1 if unknown. */
export function gxCompTypeSize(compType: number): number {
	switch (compType) {
		case GxCompType.U8:
		case GxCompType.S8:
			return 1;
		case GxCompType.U16:
		case GxCompType.S16:
			return 2;
		case GxCompType.F32:
			return 4;
		default:
			return -1;
	}
}

/** Size in bytes of one packed colour. -1 if unknown. */
export function gxColorSize(compType: number): number {
	switch (compType) {
		case GxColorCompType.RGB565:
		case GxColorCompType.RGBA4:
			return 2;
		case GxColorCompType.RGB8:
		case GxColorCompType.RGBA6:
			return 3;
		case GxColorCompType.RGBX8:
		case GxColorCompType.RGBA8:
			return 4;
		default:
			return -1;
	}
}

/** True for the attributes whose data lives in a `VTX1` array. */
export function gxAttrHasArray(attribute: number): boolean {
	return attribute >= GxAttr.POS && attribute <= GxAttr.TEX7;
}

/** True for CLR0/CLR1, which use `GxColorCompType` instead of `GxCompType`. */
export function gxAttrIsColor(attribute: number): boolean {
	return attribute === GxAttr.CLR0 || attribute === GxAttr.CLR1;
}

/**
 * GX primitive opcodes, with the VAT bits already zeroed.
 *
 * `QUADS2` (0x88) is the second quad opcode; the hardware treats it exactly
 * like `QUADS`, and it exists only because early GX revisions had a separate
 * path for it.
 */
export const GxPrimitive = {
	QUADS: 0x80,
	QUADS2: 0x88,
	TRIANGLES: 0x90,
	TRIANGLESTRIP: 0x98,
	TRIANGLEFAN: 0xa0,
	LINES: 0xa8,
	LINESTRIP: 0xb0,
	POINTS: 0xb8,
} as const;

/** Human-readable name for a masked primitive opcode. */
export function gxPrimitiveName(type: number): string {
	switch (type) {
		case GxPrimitive.QUADS:
			return 'QUADS';
		case GxPrimitive.QUADS2:
			return 'QUADS2';
		case GxPrimitive.TRIANGLES:
			return 'TRIANGLES';
		case GxPrimitive.TRIANGLESTRIP:
			return 'TRIANGLESTRIP';
		case GxPrimitive.TRIANGLEFAN:
			return 'TRIANGLEFAN';
		case GxPrimitive.LINES:
			return 'LINES';
		case GxPrimitive.LINESTRIP:
			return 'LINESTRIP';
		case GxPrimitive.POINTS:
			return 'POINTS';
		default:
			return `UNKNOWN_0x${type.toString(16)}`;
	}
}

/** True when `type` (VAT bits masked off) is a primitive we know how to walk. */
export function gxPrimitiveIsKnown(type: number): boolean {
	switch (type) {
		case GxPrimitive.QUADS:
		case GxPrimitive.QUADS2:
		case GxPrimitive.TRIANGLES:
		case GxPrimitive.TRIANGLESTRIP:
		case GxPrimitive.TRIANGLEFAN:
		case GxPrimitive.LINES:
		case GxPrimitive.LINESTRIP:
		case GxPrimitive.POINTS:
			return true;
		default:
			return false;
	}
}
