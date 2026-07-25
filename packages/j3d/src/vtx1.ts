/**
 * `VTX1` — the vertex arrays.
 *
 * This chunk is a bag of per-attribute arrays: all positions in one array, all
 * normals in another, all texture coordinates in a third, and so on. The
 * display lists in `SHP1` then index each array *independently*, which is a
 * direct reflection of how the GameCube's graphics processor works: the CP
 * fetches each attribute of a vertex through its own indexed-array base
 * register, so sharing a position between two vertices that differ only in
 * their texture coordinate costs nothing. (Modern GPUs can't do this, which is
 * why `geometry.ts` has to de-duplicate index tuples.)
 *
 * Payload layout:
 *
 *   0x00 u32     attributeFormatOffset
 *   0x04 u32[13] dataOffsets           — 0 means "not present"
 *
 * ## The dataOffsets slot question
 *
 * Documentation for this table is genuinely contradictory. You will see it
 * described as "one entry per GX attribute starting at attribute 0", which
 * would make slot 0 `GX_VA_PNMTXIDX` and leave no room for texture
 * coordinates; and you will see it described as "13 entries starting at
 * `GX_VA_POS`".
 *
 * Neither reading is quite right. Attributes 0..8 are the position/normal and
 * texture *matrix indices*, which are always `GX_DIRECT` in a display list —
 * the byte in the vertex stream is itself the index into the transform unit's
 * matrix memory — so they have no array to point at and get no slot. But the
 * remaining slots are *not* a straight `attribute - 9` run, because the table
 * carries a dedicated NBT slot that has no GX attribute id of its own:
 *
 *   slot 0  = POS  (attr 9)       slot 5  = TEX0 (attr 13)
 *   slot 1  = NRM  (attr 10)      slot 6  = TEX1 (attr 14)
 *   slot 2  = NBT  (no attr id)   ...
 *   slot 3  = CLR0 (attr 11)      slot 12 = TEX7 (attr 20)
 *   slot 4  = CLR1 (attr 12)
 *
 * That is exactly 13 entries (1 + 1 + 1 + 2 + 8), which is the real reason the
 * table is 13 long — the `attribute - 9` reading also happens to produce 13 but
 * puts everything from CLR0 onwards one slot too early.
 *
 * This is confirmed against retail data rather than inferred: a Wind Waker
 * model whose format table declares exactly attributes 9 (POS), 10 (NRM) and
 * 13 (TEX0) has non-zero `dataOffsets` at indices 0, 1 and **5**. Under
 * `attribute - 9` TEX0 would resolve to slot 4, which holds 0, and every model
 * in the game would silently come out with no texture coordinates.
 *
 * So the mapping is `attribute - 9` for POS/NRM and `attribute - 8` from CLR0
 * on, which is what {@link vtx1SlotForAttribute} implements. We never index the
 * table by a hardcoded slot: we read the attribute-format table first, derive
 * each present attribute's slot from its own attribute id, and only touch
 * those entries.
 *
 * The NBT slot is parsed as `slot 2` but has no attribute id, so it is only
 * reachable via {@link Vtx1#nbt}. Normals are read from slot 1 even when the
 * NRM format entry declares NBT (`componentCount == 1`), which is what the
 * hardware does: NBT vertices still fetch their normal from the normal array.
 *
 * ## Attribute format entries
 *
 * The format table is a list of 16-byte entries terminated by an entry whose
 * attribute is 0xFF (`GX_VA_NULL`):
 *
 *   0x00 u32 attribute
 *   0x04 u32 componentCount
 *   0x08 u32 componentType
 *   0x0C u8  decimalPoint     — fixed-point fractional bits
 *   0x0D u8[3] padding
 *
 * (16 bytes, not 8: the three pad bytes after `decimalPoint` keep the struct
 * 4-byte aligned, which the Gekko requires for the `u32` loads that follow.)
 *
 * `componentCount` is interpreted per attribute:
 *
 *   POS: 0 = XY,  1 = XYZ
 *   NRM: 0 = XYZ, 1 = NBT (normal + binormal + tangent, 9 components)
 *   CLR: 0 = RGB, 1 = RGBA
 *   TEX: 0 = S,   1 = ST
 *
 * `componentType` is a `GxCompType` for POS/NRM/TEX and a `GxColorCompType`
 * for the colours.
 *
 * ## Fixed point
 *
 * Integer positions, normals and texture coordinates are **fixed point**: the
 * stored integer must be divided by `2 ** decimalPoint`. The GP does this in
 * hardware (the shift amount is part of the vertex attribute format register),
 * which is why the file stores raw integers. Forget the shift and your model
 * comes out 256x or 8192x too large — the single most common J3D bug.
 *
 * One hardware wrinkle worth knowing: `GXSetVtxAttrFmt` documents the shift as
 * *fixed* for normals (6 for S8, 14 for S16) and ignores whatever you pass.
 * Retail files store exactly those values anyway, so we honour the stored
 * `decimalPoint` uniformly rather than special-casing normals; if you ever meet
 * a file that disagrees with the hardware, the hardware wins and the normal
 * will be off by a power of two.
 *
 * ## Array lengths
 *
 * Nothing stores an element *count*. The engine doesn't need one — it hands
 * the array's base address to `GXSetArray` and lets the display list index
 * whatever it likes — so lengths have to be inferred from the gaps between
 * offsets: an array ends where the next present array begins, and the last one
 * ends at the end of the chunk. We gather every plausible offset in the table
 * (not just the ones we have formats for) to find those boundaries, so a file
 * that lists an array we don't understand still yields correct lengths for the
 * ones we do.
 */

import { chunkOffset, validateChunk, type J3dChunk } from './container.js';
import {
	GxAttr,
	GxColorCompType,
	GxCompType,
	gxAttrIsColor,
	gxColorSize,
	gxCompTypeSize,
} from './gx.js';
import { CHUNK_HEADER_SIZE } from './util.js';

/**
 * Number of entries in the `dataOffsets` table: POS, NRM, NBT, CLR0, CLR1 and
 * TEX0..TEX7.
 */
export const VTX1_SLOT_COUNT = 13;

/** The `dataOffsets` slot holding the NBT (normal/binormal/tangent) array. */
export const VTX1_NBT_SLOT = 2;

/**
 * Map a `GxAttr` to its index in the `dataOffsets` table, or -1 if the
 * attribute has no vertex array (the matrix-index attributes 0..8).
 *
 * The discontinuity at CLR0 is the NBT slot; see the file header for the retail
 * evidence that pins this down.
 */
export function vtx1SlotForAttribute(attribute: number): number {
	if (attribute === GxAttr.POS) return 0;
	if (attribute === GxAttr.NRM) return 1;
	// CLR0(11)..TEX7(20) sit at slots 3..12, one past the NBT slot.
	if (attribute >= GxAttr.CLR0 && attribute <= GxAttr.TEX7) return attribute - 8;
	return -1;
}

/** Size of one attribute-format entry. */
export const VTX1_FORMAT_ENTRY_SIZE = 0x10;

/** Runaway guard: the table can hold at most one entry per attribute. */
const MAX_FORMAT_ENTRIES = 64;

export interface Vtx1Array {
	/** `GxAttr` value this array holds. */
	attribute: number;
	/** Its index in the chunk's `dataOffsets` table; see {@link vtx1SlotForAttribute}. */
	slot: number;
	/** Raw `componentCount` field (interpretation depends on `attribute`). */
	componentCount: number;
	/** Raw `componentType` field: `GxCompType`, or `GxColorCompType` for colours. */
	componentType: number;
	/** Fixed-point fractional bits; 0 for floats and colours. */
	decimalPoint: number;
	/** Floats per element in {@link values}: 2/3/9 for geometry, always 4 for colours. */
	numComponents: number;
	/** Bytes each element occupies in the file. */
	elementSize: number;
	/** Number of elements, inferred from the gap to the next array. */
	count: number;
	/** Absolute offset of the raw array in the source buffer. */
	offset: number;
	/** Byte length of the raw array. */
	byteLength: number;
	/**
	 * Decoded values, `count * numComponents` long. Positions/normals/texcoords
	 * are already divided by `2 ** decimalPoint`; colours are normalised RGBA in
	 * 0..1 regardless of how they were packed.
	 */
	values: Float32Array;
}

export interface Vtx1 {
	/** Arrays in the order the format table listed them. */
	arrays: Vtx1Array[];
}

/** Find the array for a `GxAttr`, or `null`. */
export function vtx1Array(vtx1: Vtx1 | null, attribute: number): Vtx1Array | null {
	if (!vtx1) return null;
	for (const a of vtx1.arrays) if (a.attribute === attribute) return a;
	return null;
}

/**
 * Floats per element for a non-colour attribute, from its `componentCount`.
 * Returns -1 for a combination we don't recognise.
 */
function geometryComponents(attribute: number, componentCount: number): number {
	if (attribute === GxAttr.POS) {
		if (componentCount === 0) return 2; // XY
		if (componentCount === 1) return 3; // XYZ
		return -1;
	}
	if (attribute === GxAttr.NRM) {
		if (componentCount === 0) return 3; // XYZ
		// NBT: normal, binormal and tangent packed together. Used by the
		// bump-mapped materials in a few Wind Waker models. We decode all nine
		// floats and let consumers take the first three.
		if (componentCount === 1) return 9;
		return -1;
	}
	if (attribute >= GxAttr.TEX0 && attribute <= GxAttr.TEX7) {
		if (componentCount === 0) return 1; // S
		if (componentCount === 1) return 2; // ST
		return -1;
	}
	return -1;
}

/** Expand an n-bit channel to 8 bits by replicating its high bits. */
function expand4(v: number): number {
	return v * 0x11;
}
function expand5(v: number): number {
	return (v << 3) | (v >> 2);
}
function expand6(v: number): number {
	return (v << 2) | (v >> 4);
}

/**
 * Decode `count` packed colours starting at `offset` into RGBA floats.
 *
 * We always emit four components: a format without alpha yields 1.0, so
 * consumers never have to branch on the packing.
 */
function decodeColors(
	view: DataView,
	offset: number,
	count: number,
	compType: number,
): Float32Array {
	const out = new Float32Array(count * 4);
	const size = gxColorSize(compType);
	for (let i = 0; i < count; i++) {
		const p = offset + i * size;
		let r = 0;
		let g = 0;
		let b = 0;
		let a = 255;
		switch (compType) {
			case GxColorCompType.RGB565: {
				const v = view.getUint16(p, false);
				r = expand5((v >> 11) & 0x1f);
				g = expand6((v >> 5) & 0x3f);
				b = expand5(v & 0x1f);
				break;
			}
			case GxColorCompType.RGB8:
				r = view.getUint8(p);
				g = view.getUint8(p + 1);
				b = view.getUint8(p + 2);
				break;
			case GxColorCompType.RGBX8:
				// The fourth byte exists for alignment; alpha is *not* stored.
				r = view.getUint8(p);
				g = view.getUint8(p + 1);
				b = view.getUint8(p + 2);
				break;
			case GxColorCompType.RGBA4: {
				const v = view.getUint16(p, false);
				r = expand4((v >> 12) & 0xf);
				g = expand4((v >> 8) & 0xf);
				b = expand4((v >> 4) & 0xf);
				a = expand4(v & 0xf);
				break;
			}
			case GxColorCompType.RGBA6: {
				// 24 bits, big-endian, six per channel.
				const v =
					(view.getUint8(p) << 16) |
					(view.getUint8(p + 1) << 8) |
					view.getUint8(p + 2);
				r = expand6((v >> 18) & 0x3f);
				g = expand6((v >> 12) & 0x3f);
				b = expand6((v >> 6) & 0x3f);
				a = expand6(v & 0x3f);
				break;
			}
			case GxColorCompType.RGBA8:
				r = view.getUint8(p);
				g = view.getUint8(p + 1);
				b = view.getUint8(p + 2);
				a = view.getUint8(p + 3);
				break;
		}
		out[i * 4 + 0] = r / 255;
		out[i * 4 + 1] = g / 255;
		out[i * 4 + 2] = b / 255;
		out[i * 4 + 3] = a / 255;
	}
	return out;
}

/** Decode `count * numComponents` fixed-point or float components. */
function decodeGeometry(
	view: DataView,
	offset: number,
	total: number,
	compType: number,
	decimalPoint: number,
): Float32Array {
	const out = new Float32Array(total);
	// 2 ** -decimalPoint. Exact in binary floating point, so this is a
	// lossless rescale rather than an approximation.
	const scale = compType === GxCompType.F32 ? 1 : 1 / Math.pow(2, decimalPoint);
	const size = gxCompTypeSize(compType);
	for (let i = 0; i < total; i++) {
		const p = offset + i * size;
		let v = 0;
		switch (compType) {
			case GxCompType.U8:
				v = view.getUint8(p);
				break;
			case GxCompType.S8:
				v = view.getInt8(p);
				break;
			case GxCompType.U16:
				v = view.getUint16(p, false);
				break;
			case GxCompType.S16:
				v = view.getInt16(p, false);
				break;
			case GxCompType.F32:
				v = view.getFloat32(p, false);
				break;
		}
		out[i] = v * scale;
	}
	return out;
}

/**
 * Parse a `VTX1` chunk.
 *
 * Returns `null` when the chunk is too small, the format table is unreadable,
 * or the table never terminates. A *single* malformed attribute entry (unknown
 * component type, offset out of range) is skipped instead: models with an
 * exotic extra array should still hand you their positions.
 */
export function parseVtx1(bytes: Uint8Array, chunk: J3dChunk): Vtx1 | null {
	if (!validateChunk(bytes, chunk)) return null;
	const headerEnd = CHUNK_HEADER_SIZE + 4 + VTX1_SLOT_COUNT * 4;
	if (chunk.size < headerEnd) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;

	const formatRel = view.getUint32(payload + 0x00, false);
	const formatOffset = chunkOffset(chunk, formatRel, VTX1_FORMAT_ENTRY_SIZE);
	if (formatOffset < 0) return null;

	// Read every slot, whether or not we end up using it. The values that are
	// in range serve as the boundary set for length inference below; the rest
	// (0 for "absent", garbage in a corrupt file) are filtered out.
	const slotRel: number[] = [];
	for (let i = 0; i < VTX1_SLOT_COUNT; i++) {
		slotRel.push(view.getUint32(payload + 0x04 + i * 4, false));
	}
	const boundaries: number[] = [chunk.size];
	for (const rel of slotRel) {
		if (rel >= headerEnd && rel <= chunk.size && !boundaries.includes(rel)) {
			boundaries.push(rel);
		}
	}
	boundaries.sort((a, b) => a - b);

	/** End (chunk-relative) of the array starting at `rel`. */
	const arrayEnd = (rel: number): number => {
		for (const b of boundaries) if (b > rel) return b;
		return chunk.size;
	};

	const arrays: Vtx1Array[] = [];
	let p = formatOffset;
	let terminated = false;
	for (let i = 0; i < MAX_FORMAT_ENTRIES; i++) {
		if (p + VTX1_FORMAT_ENTRY_SIZE > chunk.offset + chunk.size) break;
		const attribute = view.getUint32(p + 0x00, false);
		if (attribute === GxAttr.NULL) {
			terminated = true;
			break;
		}
		const componentCount = view.getUint32(p + 0x04, false);
		const componentType = view.getUint32(p + 0x08, false);
		const decimalPoint = view.getUint8(p + 0x0c);
		p += VTX1_FORMAT_ENTRY_SIZE;

		const slot = vtx1SlotForAttribute(attribute);
		if (slot < 0 || slot >= VTX1_SLOT_COUNT) continue;
		const rel = slotRel[slot];
		if (rel === 0) continue;

		const isColor = gxAttrIsColor(attribute);
		const elementSize = isColor
			? gxColorSize(componentType)
			: gxCompTypeSize(componentType) *
				Math.max(0, geometryComponents(attribute, componentCount));
		const numComponents = isColor
			? 4
			: geometryComponents(attribute, componentCount);
		if (elementSize <= 0 || numComponents <= 0) continue;

		const start = chunkOffset(chunk, rel, elementSize);
		if (start < 0) continue;
		const byteLength = arrayEnd(rel) - rel;
		if (byteLength < elementSize) continue;
		const count = Math.floor(byteLength / elementSize);

		const values = isColor
			? decodeColors(view, start, count, componentType)
			: decodeGeometry(
					view,
					start,
					count * numComponents,
					componentType,
					decimalPoint,
				);

		arrays.push({
			attribute,
			slot,
			componentCount,
			componentType,
			decimalPoint,
			numComponents,
			elementSize,
			count,
			offset: start,
			byteLength,
			values,
		});
	}
	if (!terminated) return null;

	return { arrays };
}
