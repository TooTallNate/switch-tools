/**
 * `EVP1` and `DRW1` — skinning.
 *
 * These two chunks together answer the question "which matrix does a vertex's
 * `PNMTXIDX` actually select?", and the two-level design falls straight out of
 * the hardware. GX's transform unit can hold ten position matrices at once and
 * applies exactly one of them per vertex. There is no hardware blending. So
 * *rigid* skinning is free — point `PNMTXIDX` at a bone — while *smooth*
 * skinning has to be done on the CPU, by computing a blended matrix and
 * uploading it into one of the ten slots before drawing the packet that needs
 * it.
 *
 * `DRW1` is therefore the indirection that hides which of the two you're
 * getting:
 *
 *   0x00 u16 count
 *   0x02 u16 padding
 *   0x04 u32 isWeightedOffset   — u8 per entry: 0 = rigid, 1 = weighted
 *   0x08 u32 indexOffset        — u16 per entry: a `JNT1` joint index when
 *                                 rigid, an `EVP1` envelope index when weighted
 *
 * A shape's matrix table (in `SHP1`) holds `DRW1` indices, so the game walks
 * `DRW1` for each one and either grabs the joint's matrix directly or asks
 * `EVP1` for a blend.
 *
 * `EVP1` holds the blends ("envelopes"):
 *
 *   0x00 u16 count
 *   0x02 u16 padding
 *   0x04 u32 weightedIndexCountOffset — u8 per envelope: how many joints
 *   0x08 u32 weightedIndexOffset      — u16 joint indices, all envelopes
 *                                       concatenated
 *   0x0C u32 weightOffset             — f32 weights, same concatenation
 *   0x10 u32 inverseBindMatrixOffset  — f32[12] per *joint* (3x4, row-major)
 *
 * The three parallel arrays are concatenated rather than indexed, so an
 * envelope's slice starts at the sum of all preceding counts — a prefix sum,
 * which is cheap to compute once and avoids storing a per-envelope offset.
 *
 * The inverse bind matrices are 3x4 rather than 4x4 because that's the shape GX
 * matrix memory takes: the bottom row of an affine transform is always
 * (0,0,0,1), so the hardware simply doesn't store it.
 *
 * We parse the tables and stop there. Actually deforming vertices is a
 * renderer's job, and a viewer that only wants the bind pose (which is what
 * `VTX1` already contains) doesn't need any of it.
 */

import { chunkOffset, validateChunk, type J3dChunk } from './container.js';
import { CHUNK_HEADER_SIZE } from './util.js';

/** A weighted matrix: joints plus the weights to blend them with. */
export interface Evp1Envelope {
	index: number;
	/** `JNT1` joint indices. */
	jointIndices: number[];
	/** Blend weights, parallel to `jointIndices`. Should sum to 1. */
	weights: number[];
}

export interface Evp1 {
	envelopes: Evp1Envelope[];
	/**
	 * Inverse bind matrices, 12 floats each (3x4, row-major), one per joint
	 * referenced by any envelope. Empty when the table couldn't be located.
	 */
	inverseBindMatrices: Float32Array;
}

export interface Drw1Entry {
	index: number;
	/** True when `value` is an `EVP1` envelope index rather than a joint index. */
	isWeighted: boolean;
	/** `JNT1` joint index, or `EVP1` envelope index when `isWeighted`. */
	value: number;
}

export interface Drw1 {
	entries: Drw1Entry[];
}

/**
 * Parse an `EVP1` chunk. Returns `null` when the header or one of the parallel
 * arrays is out of range.
 */
export function parseEvp1(bytes: Uint8Array, chunk: J3dChunk): Evp1 | null {
	if (!validateChunk(bytes, chunk)) return null;
	if (chunk.size < CHUNK_HEADER_SIZE + 0x14) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;

	const count = view.getUint16(payload + 0x00, false);
	const countRel = view.getUint32(payload + 0x04, false);
	const indexRel = view.getUint32(payload + 0x08, false);
	const weightRel = view.getUint32(payload + 0x0c, false);
	const matrixRel = view.getUint32(payload + 0x10, false);

	if (count === 0) {
		return { envelopes: [], inverseBindMatrices: new Float32Array(0) };
	}

	const countOffset = chunkOffset(chunk, countRel, count);
	if (countOffset < 0) return null;

	// Total joint references across all envelopes — the length of the index and
	// weight arrays, which are otherwise unbounded.
	let total = 0;
	const counts: number[] = [];
	for (let i = 0; i < count; i++) {
		const n = view.getUint8(countOffset + i);
		counts.push(n);
		total += n;
	}

	const indexOffset = chunkOffset(chunk, indexRel, total * 2);
	const weightOffset = chunkOffset(chunk, weightRel, total * 4);
	if (indexOffset < 0 || weightOffset < 0) return null;

	const envelopes: Evp1Envelope[] = [];
	let cursor = 0;
	for (let i = 0; i < count; i++) {
		const n = counts[i];
		const jointIndices: number[] = [];
		const weights: number[] = [];
		for (let j = 0; j < n; j++) {
			jointIndices.push(view.getUint16(indexOffset + (cursor + j) * 2, false));
			weights.push(view.getFloat32(weightOffset + (cursor + j) * 4, false));
		}
		cursor += n;
		envelopes.push({ index: i, jointIndices, weights });
	}

	// The matrix table has one entry per joint, and nothing tells us how many
	// joints there are — so we take everything from the table's start to the end
	// of the chunk, rounded down to whole matrices.
	let inverseBindMatrices = new Float32Array(0);
	const matrixOffset = chunkOffset(chunk, matrixRel, 48);
	if (matrixOffset >= 0) {
		const available = chunk.offset + chunk.size - matrixOffset;
		const matrices = Math.floor(available / 48);
		inverseBindMatrices = new Float32Array(matrices * 12);
		for (let i = 0; i < matrices * 12; i++) {
			inverseBindMatrices[i] = view.getFloat32(matrixOffset + i * 4, false);
		}
	}

	return { envelopes, inverseBindMatrices };
}

/** Parse a `DRW1` chunk. Returns `null` when either array is out of range. */
export function parseDrw1(bytes: Uint8Array, chunk: J3dChunk): Drw1 | null {
	if (!validateChunk(bytes, chunk)) return null;
	if (chunk.size < CHUNK_HEADER_SIZE + 0x0c) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;

	const count = view.getUint16(payload + 0x00, false);
	const flagRel = view.getUint32(payload + 0x04, false);
	const indexRel = view.getUint32(payload + 0x08, false);

	if (count === 0) return { entries: [] };

	const flagOffset = chunkOffset(chunk, flagRel, count);
	const indexOffset = chunkOffset(chunk, indexRel, count * 2);
	if (flagOffset < 0 || indexOffset < 0) return null;

	const entries: Drw1Entry[] = [];
	for (let i = 0; i < count; i++) {
		entries.push({
			index: i,
			isWeighted: view.getUint8(flagOffset + i) !== 0,
			value: view.getUint16(indexOffset + i * 2, false),
		});
	}
	return { entries };
}
