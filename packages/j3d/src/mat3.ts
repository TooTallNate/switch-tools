/**
 * `MAT3` — materials.
 *
 * `MAT3` is by far the most convoluted chunk in the format, and understanding
 * *why* makes it much less mysterious: it is a de-duplicating store for GX
 * register state. The GameCube has no shaders. A "material" is a couple of
 * hundred bytes of hardware register values — cull mode, up to 16 TEV stages,
 * blend mode, Z mode, fog, texture-matrix setups — and across a whole model
 * (or a whole *level*) an enormous amount of that state repeats. So instead of
 * storing the state inline per material, `MAT3` stores one flat table per
 * *field*, and each material entry holds an array of `u16` **indices into those
 * tables**. Two materials differing only in texture end up sharing every table
 * entry except one.
 *
 * Which means reading a texture assignment out of `MAT3` is a triple
 * indirection:
 *
 *   material index (what `INF1` names)
 *     → remap table          → material *entry* index
 *       → entry's texture slot (u16) → index into MAT3's texture-index table
 *         → u16 in that table   → index into `TEX1`
 *
 * Payload layout — a run of chunk-relative `u32` offsets after the count:
 *
 *   0x00 u16 materialCount
 *   0x02 u16 padding
 *   0x04 u32 materialEntryOffset      0x28 u32 lightOffset
 *   0x08 u32 remapTableOffset         0x2C u32 texGenCountOffset
 *   0x0C u32 nameTableOffset          0x30 u32 texGenOffset
 *   0x10 u32 indirectOffset           0x34 u32 postTexGenOffset
 *   0x14 u32 cullModeOffset           0x38 u32 texMatrixOffset
 *   0x18 u32 materialColorOffset      0x3C u32 postTexMatrixOffset
 *   0x1C u32 colorChanCountOffset     0x40 u32 textureIndexOffset  ← we want this
 *   0x20 u32 colorChanOffset          0x44 u32 tevOrderOffset
 *   0x24 u32 ambientColorOffset
 *   ... and on through TEV colours, stages, swap tables, fog, alpha compare,
 *       blend mode, Z mode, Z-compare location, dither and NBT scale.
 *
 * Note the two *count* tables (`colorChanCount` at 0x1C, `texGenCount` at 0x2C):
 * it's easy to leave them out when transcribing this header from documentation
 * that lists only the "interesting" tables, and doing so shifts every later
 * offset by one slot. Verified against retail data: `0x3C` (postTexMatrix) is
 * zero in all 1000 Wind Waker models sampled, while `0x40` yields a table of
 * valid `TEX1` indices — so reading `0x3C` here silently disables texturing for
 * the entire game rather than failing loudly.
 *
 * Material entry, 0x14C bytes — confirmed empirically rather than by summing
 * the field list below (which is incomplete and totals only 0x134): across 1200
 * retail models, bounding the entry table by the next table offset and dividing
 * by the entry count gives exactly 0x14C every time. We only need one field out
 * of it, at 0x84:
 *
 *   0x00 u8      flag ("materialMode")
 *   0x01 u8      cullModeIndex
 *   0x02 u8      colorChanCountIndex
 *   0x03 u8      texGenCountIndex
 *   0x04 u8      tevStageCountIndex
 *   0x05 u8      zCompLocIndex
 *   0x06 u8      zModeIndex
 *   0x07 u8      ditherIndex
 *   0x08 u16[2]  materialColorIndex
 *   0x0C u16[4]  colorChanIndex
 *   0x14 u16[2]  ambientColorIndex
 *   0x18 u16[8]  lightIndex
 *   0x28 u16[8]  texGenIndex
 *   0x38 u16[8]  postTexGenIndex
 *   0x48 u16[10] texMatrixIndex
 *   0x5C u16[20] postTexMatrixIndex
 *   0x84 u16[8]  textureIndex        ← indices into the texture-index table
 *   ... TEV konstant colours/selects, TEV order, TEV stages, swap tables,
 *       fog, alpha compare, blend mode, NBT scale.
 *
 * **This is a deliberately partial parser.** Full GX material emulation is a
 * project of its own (TEV is a 16-stage programmable combiner), and this
 * package exists to get geometry and textures into a viewer. So we extract the
 * material count, the names, and the texture assignment — and nothing else. In
 * exchange, we are careful: any indirection that doesn't validate yields
 * `textureIndex: -1` rather than a confident wrong number, and a `MAT3` we
 * can't make sense of at all still lets the rest of the model parse, because
 * {@link parseMat3} returning `null` is not fatal to {@link parseJ3d}.
 *
 * Note that the *entry* count is not `materialCount`: entries are shared, so
 * there are only as many as `max(remapTable) + 1`. This is the same
 * de-duplication idea one level up.
 */

import { chunkOffset, validateChunk, type J3dChunk } from './container.js';
import { CHUNK_HEADER_SIZE, readJ3dStringTable } from './util.js';

/** Size of one material entry. */
export const MAT3_ENTRY_SIZE = 0x14c;

/** Offset of the `u16[8]` texture-index-table indices within an entry. */
export const MAT3_ENTRY_TEXTURE_INDEX_OFFSET = 0x84;

/**
 * Payload-relative offset of the `textureIndexOffset` field in the `MAT3`
 * header — i.e. where the entry→`TEX1` indirection table lives.
 *
 * Confirmed against retail data; see the file header for why `0x3C` is the
 * tempting-but-wrong answer.
 */
export const MAT3_TEXTURE_INDEX_TABLE_OFFSET = 0x40;

/** GX supports 8 simultaneous textures, so a material has 8 slots. */
export const MAT3_TEXTURE_SLOTS = 8;

export interface Mat3Material {
	/** Material index, as referenced by `INF1`. */
	index: number;
	name: string;
	/** Which shared material entry this material uses (via the remap table). */
	entryIndex: number;
	/**
	 * `TEX1` texture index for each of the 8 GX texture slots, -1 when the slot
	 * is unused or the indirection failed to validate.
	 */
	textureIndices: number[];
	/** The first assigned texture — what a simple viewer should bind. -1 if none. */
	textureIndex: number;
}

export interface Mat3 {
	materials: Mat3Material[];
	/** `u16` per material: material index → material entry index. */
	remapTable: number[];
	/** `MAT3`'s own texture-index table: entry slot value → `TEX1` index. */
	textureIndexTable: number[];
	/**
	 * True when the material-entry table validated and texture assignments were
	 * read for real. When false, every `textureIndex` is -1 and callers should
	 * fall back to something else (or to no texture).
	 */
	texturesResolved: boolean;
}

/**
 * Length of the table starting at chunk-relative `rel`, inferred from the next
 * larger offset in the header.
 *
 * `MAT3`'s tables are laid out in the order of the header's offset fields, so
 * the gap to the next offset bounds the table — the same trick `VTX1` forces on
 * us, for the same reason (no counts are stored).
 */
function tableLength(
	rel: number,
	allOffsets: readonly number[],
	chunkSize: number,
): number {
	let end = chunkSize;
	for (const other of allOffsets) {
		if (other > rel && other <= chunkSize && other < end) end = other;
	}
	return end - rel;
}

/**
 * Parse the parts of `MAT3` we care about. Returns `null` only when the header
 * itself is unusable.
 */
export function parseMat3(bytes: Uint8Array, chunk: J3dChunk): Mat3 | null {
	if (!validateChunk(bytes, chunk)) return null;
	if (chunk.size < CHUNK_HEADER_SIZE + MAT3_TEXTURE_INDEX_TABLE_OFFSET + 4) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;
	const chunkEnd = chunk.offset + chunk.size;

	const materialCount = view.getUint16(payload + 0x00, false);
	const entryRel = view.getUint32(payload + 0x04, false);
	const remapRel = view.getUint32(payload + 0x08, false);
	const nameRel = view.getUint32(payload + 0x0c, false);
	const textureIndexRel = view.getUint32(payload + MAT3_TEXTURE_INDEX_TABLE_OFFSET, false);

	// Every offset in the header, for the table-length inference above. The
	// header is 0x04 + 30 * 4 bytes; we read as many as the chunk actually has.
	const allOffsets: number[] = [];
	for (let i = 0; i < 30; i++) {
		const at = payload + 0x04 + i * 4;
		if (at + 4 > chunkEnd) break;
		allOffsets.push(view.getUint32(at, false));
	}

	const remapOffset = chunkOffset(chunk, remapRel, materialCount * 2);
	const remapTable: number[] = [];
	if (remapOffset >= 0) {
		for (let i = 0; i < materialCount; i++) {
			remapTable.push(view.getUint16(remapOffset + i * 2, false));
		}
	} else {
		// No remap table: assume the identity mapping. Some exporters omit it.
		for (let i = 0; i < materialCount; i++) remapTable.push(i);
	}

	const nameOffset = chunkOffset(chunk, nameRel, 4);
	const names = nameOffset >= 0 ? readJ3dStringTable(bytes, nameOffset, chunkEnd) : null;

	const textureIndexOffset = chunkOffset(chunk, textureIndexRel, 2);
	const textureIndexTable: number[] = [];
	if (textureIndexOffset >= 0) {
		const len = tableLength(textureIndexRel, allOffsets, chunk.size);
		const count = Math.max(0, Math.floor(len / 2));
		for (let i = 0; i < count; i++) {
			textureIndexTable.push(view.getUint16(textureIndexOffset + i * 2, false));
		}
	}

	// The entry table has one entry per *distinct* material state.
	let entryCount = 0;
	for (const r of remapTable) entryCount = Math.max(entryCount, r + 1);
	const entryOffset = chunkOffset(chunk, entryRel, entryCount * MAT3_ENTRY_SIZE);
	const texturesResolved =
		entryOffset >= 0 && textureIndexTable.length > 0 && entryCount > 0;

	const materials: Mat3Material[] = [];
	for (let i = 0; i < materialCount; i++) {
		const entryIndex = remapTable[i] ?? i;
		const textureIndices: number[] = [];
		for (let s = 0; s < MAT3_TEXTURE_SLOTS; s++) textureIndices.push(-1);

		if (texturesResolved) {
			const base =
				entryOffset +
				entryIndex * MAT3_ENTRY_SIZE +
				MAT3_ENTRY_TEXTURE_INDEX_OFFSET;
			for (let s = 0; s < MAT3_TEXTURE_SLOTS; s++) {
				const at = base + s * 2;
				if (at + 2 > chunkEnd) break;
				const slot = view.getUint16(at, false);
				// 0xFFFF is the format's universal "unset" for these u16 indices.
				if (slot === 0xffff) continue;
				if (slot >= textureIndexTable.length) continue;
				textureIndices[s] = textureIndexTable[slot];
			}
		}

		let textureIndex = -1;
		for (const t of textureIndices) {
			if (t >= 0) {
				textureIndex = t;
				break;
			}
		}

		materials.push({
			index: i,
			name: names && i < names.length ? names[i] : '',
			entryIndex,
			textureIndices,
			textureIndex,
		});
	}

	return { materials, remapTable, textureIndexTable, texturesResolved };
}
