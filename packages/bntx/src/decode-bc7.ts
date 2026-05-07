/**
 * BC7 (BPTC) decoder — high-quality 4×4-pixel block compression.
 *
 * BC7 is the modern replacement for BC1/BC3, used widely across
 * NintendoWare-based games for high-quality UI textures, character
 * art, and HDR maps. Unlike BC1/3 it gets near-lossless RGBA
 * quality in 1 byte/pixel — at the cost of a *very* complex decode.
 *
 * Each 16-byte block selects one of 8 modes (mode is encoded as the
 * position of the lowest set bit in the first byte). Each mode has
 * its own:
 *
 *   - subset count (1, 2, or 3 — colour-only modes can split the
 *     block into multiple "subsets" with separate endpoints, picked
 *     via a partition table)
 *   - endpoint precision (4..8 bits per channel + optional P-bit)
 *   - colour / alpha index precision (2..4 bits)
 *
 * This implementation closely follows the Microsoft DXTI/BPTC
 * spec (see `bc7-format-mode-reference` on Microsoft Learn) and the
 * AMD reference encoder (Compressonator). Partition / anchor tables
 * are bitwise-identical to the BC7 spec — these are fixed
 * constants, not creative expression.
 *
 * Output: row-major RGBA8 pixels.
 */

// ====================================================================
// Spec constants (partition tables, anchor indices, weight LUTs)
// ====================================================================
// All values below are direct transcriptions of the BC7 spec tables.

const COLOR_WEIGHTS_2 = [0, 21, 43, 64];
const COLOR_WEIGHTS_3 = [0, 9, 18, 27, 37, 46, 55, 64];
const COLOR_WEIGHTS_4 = [
	0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64,
];

// Each row = a partition pattern; values are the subset index for
// each of 16 pixels (row-major within a 4×4 block).
// fmt: off
// prettier-ignore
const PARTITION_TABLE_2: ReadonlyArray<ReadonlyArray<number>> = [
	[0,0,1,1, 0,0,1,1, 0,0,1,1, 0,0,1,1],[0,0,0,1, 0,0,0,1, 0,0,0,1, 0,0,0,1],
	[0,1,1,1, 0,1,1,1, 0,1,1,1, 0,1,1,1],[0,0,0,1, 0,0,1,1, 0,0,1,1, 0,1,1,1],
	[0,0,0,0, 0,0,0,1, 0,0,0,1, 0,0,1,1],[0,0,1,1, 0,1,1,1, 0,1,1,1, 1,1,1,1],
	[0,0,0,1, 0,0,1,1, 0,1,1,1, 1,1,1,1],[0,0,0,0, 0,0,0,1, 0,0,1,1, 0,1,1,1],
	[0,0,0,0, 0,0,0,0, 0,0,0,1, 0,0,1,1],[0,0,1,1, 0,1,1,1, 1,1,1,1, 1,1,1,1],
	[0,0,0,0, 0,0,0,1, 0,1,1,1, 1,1,1,1],[0,0,0,0, 0,0,0,0, 0,0,0,1, 0,1,1,1],
	[0,0,0,1, 0,1,1,1, 1,1,1,1, 1,1,1,1],[0,0,0,0, 0,0,0,0, 1,1,1,1, 1,1,1,1],
	[0,0,0,0, 1,1,1,1, 1,1,1,1, 1,1,1,1],[0,0,0,0, 0,0,0,0, 0,0,0,0, 1,1,1,1],
	[0,0,0,0, 1,0,0,0, 1,1,1,0, 1,1,1,1],[0,1,1,1, 0,0,0,1, 0,0,0,0, 0,0,0,0],
	[0,0,0,0, 0,0,0,0, 1,0,0,0, 1,1,1,0],[0,1,1,1, 0,0,1,1, 0,0,0,1, 0,0,0,0],
	[0,0,1,1, 0,0,0,1, 0,0,0,0, 0,0,0,0],[0,0,0,0, 1,0,0,0, 1,1,0,0, 1,1,1,0],
	[0,0,0,0, 0,0,0,0, 1,0,0,0, 1,1,0,0],[0,1,1,1, 0,0,1,1, 0,0,1,1, 0,0,0,1],
	[0,0,1,1, 0,0,0,1, 0,0,0,1, 0,0,0,0],[0,0,0,0, 1,0,0,0, 1,0,0,0, 1,1,0,0],
	[0,1,1,0, 0,1,1,0, 0,1,1,0, 0,1,1,0],[0,0,1,1, 0,1,1,0, 0,1,1,0, 1,1,0,0],
	[0,0,0,1, 0,1,1,1, 1,1,1,0, 1,0,0,0],[0,0,0,0, 1,1,1,1, 1,1,1,1, 0,0,0,0],
	[0,1,1,1, 0,0,0,1, 1,0,0,0, 1,1,1,0],[0,0,1,1, 1,0,0,1, 1,0,0,1, 1,1,0,0],
	[0,1,0,1, 0,1,0,1, 0,1,0,1, 0,1,0,1],[0,0,0,0, 1,1,1,1, 0,0,0,0, 1,1,1,1],
	[0,1,0,1, 1,0,1,0, 0,1,0,1, 1,0,1,0],[0,0,1,1, 0,0,1,1, 1,1,0,0, 1,1,0,0],
	[0,0,1,1, 1,1,0,0, 0,0,1,1, 1,1,0,0],[0,1,0,1, 0,1,0,1, 1,0,1,0, 1,0,1,0],
	[0,1,1,0, 1,0,0,1, 0,1,1,0, 1,0,0,1],[0,1,0,1, 1,0,1,0, 1,0,1,0, 0,1,0,1],
	[0,1,1,1, 0,0,1,1, 1,1,0,0, 1,1,1,0],[0,0,0,1, 0,0,1,1, 1,1,0,0, 1,0,0,0],
	[0,0,1,1, 0,0,1,0, 0,1,0,0, 1,1,0,0],[0,0,1,1, 1,0,1,1, 1,1,0,1, 1,1,0,0],
	[0,1,1,0, 1,0,0,1, 1,0,0,1, 0,1,1,0],[0,0,1,1, 1,1,0,0, 1,1,0,0, 0,0,1,1],
	[0,1,1,0, 0,1,1,0, 1,0,0,1, 1,0,0,1],[0,0,0,0, 0,1,1,0, 0,1,1,0, 0,0,0,0],
	[0,1,0,0, 1,1,1,0, 0,1,0,0, 0,0,0,0],[0,0,1,0, 0,1,1,1, 0,0,1,0, 0,0,0,0],
	[0,0,0,0, 0,0,1,0, 0,1,1,1, 0,0,1,0],[0,0,0,0, 0,1,0,0, 1,1,1,0, 0,1,0,0],
	[0,1,1,0, 1,1,0,0, 1,0,0,1, 0,0,1,1],[0,0,1,1, 0,1,1,0, 1,1,0,0, 1,0,0,1],
	[0,1,1,0, 0,0,1,1, 1,0,0,1, 1,1,0,0],[0,0,1,1, 1,0,0,1, 1,1,0,0, 0,1,1,0],
	[0,1,1,0, 1,1,0,0, 1,1,0,0, 1,0,0,1],[0,1,1,0, 0,0,1,1, 0,0,1,1, 1,0,0,1],
	[0,1,1,1, 1,1,1,0, 1,0,0,0, 0,0,0,1],[0,0,0,1, 1,0,0,0, 1,1,1,0, 0,1,1,1],
	[0,0,0,0, 1,1,1,1, 0,0,1,1, 0,0,1,1],[0,0,1,1, 0,0,1,1, 1,1,1,1, 0,0,0,0],
	[0,0,1,0, 0,0,1,0, 1,1,1,0, 1,1,1,0],[0,1,0,0, 0,1,0,0, 0,1,1,1, 0,1,1,1],
];
// prettier-ignore
const PARTITION_TABLE_3: ReadonlyArray<ReadonlyArray<number>> = [
	[0,0,1,1, 0,0,1,1, 0,2,2,1, 2,2,2,2],[0,0,0,1, 0,0,1,1, 2,2,1,1, 2,2,2,1],
	[0,0,0,0, 2,0,0,1, 2,2,1,1, 2,2,1,1],[0,2,2,2, 0,0,2,2, 0,0,1,1, 0,1,1,1],
	[0,0,0,0, 0,0,0,0, 1,1,2,2, 1,1,2,2],[0,0,1,1, 0,0,1,1, 0,0,2,2, 0,0,2,2],
	[0,0,2,2, 0,0,2,2, 1,1,1,1, 1,1,1,1],[0,0,1,1, 0,0,1,1, 2,2,1,1, 2,2,1,1],
	[0,0,0,0, 0,0,0,0, 1,1,1,1, 2,2,2,2],[0,0,0,0, 1,1,1,1, 1,1,1,1, 2,2,2,2],
	[0,0,0,0, 1,1,1,1, 2,2,2,2, 2,2,2,2],[0,0,1,2, 0,0,1,2, 0,0,1,2, 0,0,1,2],
	[0,1,1,2, 0,1,1,2, 0,1,1,2, 0,1,1,2],[0,1,2,2, 0,1,2,2, 0,1,2,2, 0,1,2,2],
	[0,0,1,1, 0,1,1,2, 1,1,2,2, 1,2,2,2],[0,0,1,1, 2,0,0,1, 2,2,0,0, 2,2,2,0],
	[0,0,0,1, 0,0,1,1, 0,1,1,2, 1,1,2,2],[0,1,1,1, 0,0,1,1, 2,0,0,1, 2,2,0,0],
	[0,0,0,0, 1,1,2,2, 1,1,2,2, 1,1,2,2],[0,0,2,2, 0,0,2,2, 0,0,2,2, 1,1,1,1],
	[0,1,1,1, 0,1,1,1, 0,2,2,2, 0,2,2,2],[0,0,0,1, 0,0,0,1, 2,2,2,1, 2,2,2,1],
	[0,0,0,0, 0,0,1,1, 0,1,2,2, 0,1,2,2],[0,0,0,0, 1,1,0,0, 2,2,1,0, 2,2,1,0],
	[0,1,2,2, 0,1,2,2, 0,0,1,1, 0,0,0,0],[0,0,1,2, 0,0,1,2, 1,1,2,2, 2,2,2,2],
	[0,1,1,0, 1,2,2,1, 1,2,2,1, 0,1,1,0],[0,0,0,0, 0,1,1,0, 1,2,2,1, 1,2,2,1],
	[0,0,2,2, 1,1,0,2, 1,1,0,2, 0,0,2,2],[0,1,1,0, 0,1,1,0, 2,0,0,2, 2,2,2,2],
	[0,0,1,1, 0,1,2,2, 0,1,2,2, 0,0,1,1],[0,0,0,0, 2,0,0,0, 2,2,1,1, 2,2,2,1],
	[0,0,0,0, 0,0,0,2, 1,1,2,2, 1,2,2,2],[0,2,2,2, 0,0,2,2, 0,0,1,2, 0,0,1,1],
	[0,0,1,1, 0,0,1,2, 0,0,2,2, 0,2,2,2],[0,1,2,0, 0,1,2,0, 0,1,2,0, 0,1,2,0],
	[0,0,0,0, 1,1,1,1, 2,2,2,2, 0,0,0,0],[0,1,2,0, 1,2,0,1, 2,0,1,2, 0,1,2,0],
	[0,1,2,0, 2,0,1,2, 1,2,0,1, 0,1,2,0],[0,0,1,1, 2,2,0,0, 1,1,2,2, 0,0,1,1],
	[0,0,1,1, 1,1,2,2, 2,2,0,0, 0,0,1,1],[0,1,0,1, 0,1,0,1, 2,2,2,2, 2,2,2,2],
	[0,0,0,0, 0,0,0,0, 2,1,2,1, 2,1,2,1],[0,0,2,2, 1,1,2,2, 0,0,2,2, 1,1,2,2],
	[0,0,2,2, 0,0,1,1, 0,0,2,2, 0,0,1,1],[0,2,2,0, 1,2,2,1, 0,2,2,0, 1,2,2,1],
	[0,1,0,1, 2,2,2,2, 2,2,2,2, 0,1,0,1],[0,0,0,0, 2,1,2,1, 2,1,2,1, 2,1,2,1],
	[0,1,0,1, 0,1,0,1, 0,1,0,1, 2,2,2,2],[0,2,2,2, 0,1,1,1, 0,2,2,2, 0,1,1,1],
	[0,0,0,2, 1,1,1,2, 0,0,0,2, 1,1,1,2],[0,0,0,0, 2,1,1,2, 2,1,1,2, 2,1,1,2],
	[0,2,2,2, 0,1,1,1, 0,1,1,1, 0,2,2,2],[0,0,0,2, 1,1,1,2, 1,1,1,2, 0,0,0,2],
	[0,1,1,0, 0,1,1,0, 0,1,1,0, 2,2,2,2],[0,0,0,0, 0,0,0,0, 2,1,1,2, 2,1,1,2],
	[0,1,1,0, 0,1,1,0, 2,2,2,2, 2,2,2,2],[0,0,2,2, 0,0,1,1, 0,0,1,1, 0,0,2,2],
	[0,0,2,2, 1,1,2,2, 1,1,2,2, 0,0,2,2],[0,0,0,0, 0,0,0,0, 0,0,0,0, 2,1,1,2],
	[0,0,0,2, 0,0,0,1, 0,0,0,2, 0,0,0,1],[0,2,2,2, 1,2,2,2, 0,2,2,2, 1,2,2,2],
	[0,1,0,1, 2,2,2,2, 2,2,2,2, 2,2,2,2],[0,1,1,1, 2,0,1,1, 2,2,0,1, 2,2,2,0],
];
// fmt: on

// Anchor (high-bit-implicit) pixel indices for 2- and 3-subset
// partitions. Pixel index 0 is always an anchor (its high bit is
// implicit zero); the rest are looked up from these tables.
// prettier-ignore
const ANCHOR_TABLE_2_BIT2: ReadonlyArray<number> = [
	15,15,15,15, 15,15,15,15, 15,15,15,15, 15,15,15,15,
	15,2,8,2,    2,8,8,15,    2,8,2,2,    8,8,2,2,
	15,15,6,8,   2,8,15,15,   2,8,2,2,    2,15,15,6,
	6,2,6,8,     15,15,2,2,   15,15,15,15, 15,2,2,15,
];
// prettier-ignore
const ANCHOR_TABLE_3_BIT2: ReadonlyArray<number> = [
	3,3,15,15,   8,3,15,15,   8,8,6,6,    6,5,3,3,
	3,3,8,15,    3,3,6,10,    5,8,8,6,    8,5,15,15,
	8,15,3,5,    6,10,8,15,   15,3,15,5,  15,15,15,15,
	3,15,5,5,    5,8,5,10,    5,10,8,13,  15,12,3,3,
];
// prettier-ignore
const ANCHOR_TABLE_3_BIT3: ReadonlyArray<number> = [
	15,8,8,3,    15,15,3,8,   15,15,15,15, 15,15,15,8,
	15,8,15,3,   15,8,15,8,   3,15,6,10,   15,15,10,8,
	15,3,15,10,  10,8,9,10,   6,15,8,15,   3,6,6,8,
	15,3,15,15,  15,15,15,15, 15,15,15,15, 3,15,15,8,
];

// Per-mode constants. Values are zero where N/A.
//
// type → [colorBits, alphaBits, partitionBits, rotationBits,
//         numSubsets, hasPBit, hasIndexSelector, colorIdxBits, alphaIdxBits]
const MODE_INFO = [
	{ colorBits: 4, alphaBits: 0, partitionBits: 4, rotationBits: 0, numSubsets: 3, hasPBit: true, sharedPBit: false, hasIndexSelector: false, colorIdxBits: 3, alphaIdxBits: 0 },
	{ colorBits: 6, alphaBits: 0, partitionBits: 6, rotationBits: 0, numSubsets: 2, hasPBit: true, sharedPBit: true, hasIndexSelector: false, colorIdxBits: 3, alphaIdxBits: 0 },
	{ colorBits: 5, alphaBits: 0, partitionBits: 6, rotationBits: 0, numSubsets: 3, hasPBit: false, sharedPBit: false, hasIndexSelector: false, colorIdxBits: 2, alphaIdxBits: 0 },
	{ colorBits: 7, alphaBits: 0, partitionBits: 6, rotationBits: 0, numSubsets: 2, hasPBit: true, sharedPBit: false, hasIndexSelector: false, colorIdxBits: 2, alphaIdxBits: 0 },
	{ colorBits: 5, alphaBits: 6, partitionBits: 0, rotationBits: 2, numSubsets: 1, hasPBit: false, sharedPBit: false, hasIndexSelector: true, colorIdxBits: 2, alphaIdxBits: 3 },
	{ colorBits: 7, alphaBits: 8, partitionBits: 0, rotationBits: 2, numSubsets: 1, hasPBit: false, sharedPBit: false, hasIndexSelector: false, colorIdxBits: 2, alphaIdxBits: 2 },
	{ colorBits: 7, alphaBits: 7, partitionBits: 0, rotationBits: 0, numSubsets: 1, hasPBit: true, sharedPBit: false, hasIndexSelector: false, colorIdxBits: 4, alphaIdxBits: 0 },
	{ colorBits: 5, alphaBits: 5, partitionBits: 6, rotationBits: 0, numSubsets: 2, hasPBit: true, sharedPBit: false, hasIndexSelector: false, colorIdxBits: 2, alphaIdxBits: 0 },
] as const;

/** Read `bitCount` bits from a 128-bit value, starting at `pos`. */
function readBits(lo: bigint, hi: bigint, pos: number, bitCount: number): number {
	if (bitCount === 0) return 0;
	if (pos + bitCount <= 64) {
		return Number((lo >> BigInt(pos)) & ((1n << BigInt(bitCount)) - 1n));
	}
	if (pos >= 64) {
		return Number((hi >> BigInt(pos - 64)) & ((1n << BigInt(bitCount)) - 1n));
	}
	const lowCount = 64 - pos;
	const highCount = bitCount - lowCount;
	const lowVal = Number((lo >> BigInt(pos)) & ((1n << BigInt(lowCount)) - 1n));
	const highVal = Number(hi & ((1n << BigInt(highCount)) - 1n));
	return lowVal | (highVal << lowCount);
}

/** Look up the interpolation weight for an index given the bit count. */
function weight(idx: number, bitCount: number): number {
	if (bitCount === 2) return COLOR_WEIGHTS_2[idx];
	if (bitCount === 3) return COLOR_WEIGHTS_3[idx];
	if (bitCount === 4) return COLOR_WEIGHTS_4[idx];
	return 0;
}

/** Linear interpolation between two endpoints with BC7's weight LUT. */
function interp(e0: number, e1: number, idx: number, bitCount: number): number {
	if (bitCount === 0) return e0;
	const w = weight(idx, bitCount);
	return ((64 - w) * e0 + w * e1 + 32) >> 6;
}

/** Get the partition (subset) index for a given pixel. */
function getSubset(numSubsets: number, partition: number, pixelIndex: number): number {
	if (numSubsets === 1) return 0;
	if (numSubsets === 2) return PARTITION_TABLE_2[partition][pixelIndex];
	return PARTITION_TABLE_3[partition][pixelIndex];
}

/** Decode a single 16-byte BC7 block into 64 RGBA bytes (16 pixels × 4). */
function decodeBlock(src: Uint8Array, off: number, out: Uint8Array, outOff: number): void {
	// Read block as two 64-bit LE words.
	const dv = new DataView(src.buffer, src.byteOffset + off, 16);
	const lo = dv.getBigUint64(0, true);
	const hi = dv.getBigUint64(8, true);
	// Mode = position of lowest set bit in byte 0 (0..7). If none,
	// the block is reserved and renders as transparent black.
	let mode = -1;
	for (let i = 0; i < 8; i++) {
		if ((Number(lo) >> i) & 1) {
			mode = i;
			break;
		}
	}
	if (mode < 0) {
		for (let i = 0; i < 16; i++) {
			out[outOff + i * 4 + 0] = 0;
			out[outOff + i * 4 + 1] = 0;
			out[outOff + i * 4 + 2] = 0;
			out[outOff + i * 4 + 3] = 0;
		}
		return;
	}

	const info = MODE_INFO[mode];
	const numSubsets = info.numSubsets;

	// --- Bit-stream cursor through the block. The BC7 spec lays
	// fields out in a tight sequence; we just walk them in order. ---
	let pos = mode + 1; // mode marker bits

	const partition =
		info.partitionBits > 0 ? readBits(lo, hi, pos, info.partitionBits) : 0;
	pos += info.partitionBits;

	const rotation = info.rotationBits > 0 ? readBits(lo, hi, pos, info.rotationBits) : 0;
	pos += info.rotationBits;

	const indexSelector = info.hasIndexSelector ? readBits(lo, hi, pos, 1) : 0;
	pos += info.hasIndexSelector ? 1 : 0;

	// Endpoints: (numSubsets * 2) RGB triplets, then optionally
	// the same number of alpha values for modes with explicit alpha.
	const totalEndpoints = numSubsets * 2;
	const ep = new Int32Array(totalEndpoints * 4); // [r,g,b,a, r,g,b,a, ...]

	// Read all reds, then greens, then blues (in that order — that's
	// how the spec packs the endpoints).
	for (let i = 0; i < totalEndpoints; i++) {
		ep[i * 4 + 0] = readBits(lo, hi, pos, info.colorBits);
		pos += info.colorBits;
	}
	for (let i = 0; i < totalEndpoints; i++) {
		ep[i * 4 + 1] = readBits(lo, hi, pos, info.colorBits);
		pos += info.colorBits;
	}
	for (let i = 0; i < totalEndpoints; i++) {
		ep[i * 4 + 2] = readBits(lo, hi, pos, info.colorBits);
		pos += info.colorBits;
	}
	if (info.alphaBits > 0) {
		for (let i = 0; i < totalEndpoints; i++) {
			ep[i * 4 + 3] = readBits(lo, hi, pos, info.alphaBits);
			pos += info.alphaBits;
		}
	}

	// P-bits: one per endpoint (0/3/6 mode), one per pair (1 mode), or none.
	if (info.hasPBit) {
		if (info.sharedPBit) {
			// Mode 1: 2 P-bits, one per subset, applied to both endpoints
			// of that subset.
			const p0 = readBits(lo, hi, pos, 1);
			pos += 1;
			const p1 = readBits(lo, hi, pos, 1);
			pos += 1;
			ep[0 * 4 + 0] = (ep[0 * 4 + 0] << 1) | p0;
			ep[0 * 4 + 1] = (ep[0 * 4 + 1] << 1) | p0;
			ep[0 * 4 + 2] = (ep[0 * 4 + 2] << 1) | p0;
			ep[1 * 4 + 0] = (ep[1 * 4 + 0] << 1) | p0;
			ep[1 * 4 + 1] = (ep[1 * 4 + 1] << 1) | p0;
			ep[1 * 4 + 2] = (ep[1 * 4 + 2] << 1) | p0;
			ep[2 * 4 + 0] = (ep[2 * 4 + 0] << 1) | p1;
			ep[2 * 4 + 1] = (ep[2 * 4 + 1] << 1) | p1;
			ep[2 * 4 + 2] = (ep[2 * 4 + 2] << 1) | p1;
			ep[3 * 4 + 0] = (ep[3 * 4 + 0] << 1) | p1;
			ep[3 * 4 + 1] = (ep[3 * 4 + 1] << 1) | p1;
			ep[3 * 4 + 2] = (ep[3 * 4 + 2] << 1) | p1;
		} else {
			// One P-bit per endpoint, applied to all of R/G/B (and A if
			// the mode encodes alpha as combined with colour).
			for (let i = 0; i < totalEndpoints; i++) {
				const p = readBits(lo, hi, pos, 1);
				pos += 1;
				ep[i * 4 + 0] = (ep[i * 4 + 0] << 1) | p;
				ep[i * 4 + 1] = (ep[i * 4 + 1] << 1) | p;
				ep[i * 4 + 2] = (ep[i * 4 + 2] << 1) | p;
				if (info.alphaBits > 0 && (mode === 6 || mode === 7)) {
					ep[i * 4 + 3] = (ep[i * 4 + 3] << 1) | p;
				}
			}
		}
	}

	// Replicate the high bits to the low bits (so e.g. 5-bit value
	// 0b11111 becomes 0xFF, not 0xF8).
	const colorPrec = info.colorBits + (info.hasPBit ? 1 : 0);
	const alphaPrec = info.alphaBits + (info.hasPBit && (mode === 6 || mode === 7) ? 1 : 0);
	for (let i = 0; i < totalEndpoints; i++) {
		ep[i * 4 + 0] = ((ep[i * 4 + 0] << (8 - colorPrec)) | (ep[i * 4 + 0] >> (2 * colorPrec - 8))) & 0xff;
		ep[i * 4 + 1] = ((ep[i * 4 + 1] << (8 - colorPrec)) | (ep[i * 4 + 1] >> (2 * colorPrec - 8))) & 0xff;
		ep[i * 4 + 2] = ((ep[i * 4 + 2] << (8 - colorPrec)) | (ep[i * 4 + 2] >> (2 * colorPrec - 8))) & 0xff;
		if (info.alphaBits > 0) {
			ep[i * 4 + 3] = ((ep[i * 4 + 3] << (8 - alphaPrec)) | (ep[i * 4 + 3] >> (2 * alphaPrec - 8))) & 0xff;
		} else {
			ep[i * 4 + 3] = 0xff;
		}
	}

	// --- Indices ---
	// Anchor pixels (where the high bit is dropped) are pixel 0 plus
	// (for 2/3-subset modes) entries in the anchor tables.
	const colorAnchorBits = info.colorIdxBits;
	const alphaAnchorBits = info.alphaIdxBits || info.colorIdxBits;
	const colorIndexBegin = pos;
	// Calculate total bits used by the colour index table.
	let colorIndexBits = 0;
	for (let i = 0; i < 16; i++) {
		colorIndexBits += isAnchor(numSubsets, partition, i) ? colorAnchorBits - 1 : colorAnchorBits;
	}
	pos += colorIndexBits;
	let alphaIndexBegin = -1;
	if (info.alphaIdxBits > 0) {
		alphaIndexBegin = pos;
		// alpha anchors only for pixel 0 (subset count is always 1
		// for modes 4/5 which are the only ones with separate alpha
		// indices).
		// total alpha bits = (16 - 1) * alphaBits + (alphaBits - 1)
		const alphaBits = info.alphaIdxBits;
		pos += 15 * alphaBits + (alphaBits - 1);
	}

	const colorIndices = new Uint8Array(16);
	{
		let cur = colorIndexBegin;
		for (let i = 0; i < 16; i++) {
			const bits = isAnchor(numSubsets, partition, i) ? colorAnchorBits - 1 : colorAnchorBits;
			colorIndices[i] = readBits(lo, hi, cur, bits);
			cur += bits;
		}
	}
	const alphaIndices = new Uint8Array(16);
	if (alphaIndexBegin >= 0) {
		let cur = alphaIndexBegin;
		for (let i = 0; i < 16; i++) {
			const bits = i === 0 ? info.alphaIdxBits - 1 : info.alphaIdxBits;
			alphaIndices[i] = readBits(lo, hi, cur, bits);
			cur += bits;
		}
	}

	// --- Render each pixel ---
	for (let i = 0; i < 16; i++) {
		const subset = getSubset(numSubsets, partition, i);
		const e0r = ep[(subset * 2 + 0) * 4 + 0];
		const e0g = ep[(subset * 2 + 0) * 4 + 1];
		const e0b = ep[(subset * 2 + 0) * 4 + 2];
		const e0a = ep[(subset * 2 + 0) * 4 + 3];
		const e1r = ep[(subset * 2 + 1) * 4 + 0];
		const e1g = ep[(subset * 2 + 1) * 4 + 1];
		const e1b = ep[(subset * 2 + 1) * 4 + 2];
		const e1a = ep[(subset * 2 + 1) * 4 + 3];

		// Mode 4's index-selector bit picks which set is for colour
		// and which is for alpha.
		let cIdx: number;
		let aIdx: number;
		let cBits: number;
		let aBits: number;
		if (mode === 4 && indexSelector === 1) {
			cIdx = alphaIndices[i];
			aIdx = colorIndices[i];
			cBits = info.alphaIdxBits;
			aBits = info.colorIdxBits;
		} else if (info.alphaIdxBits > 0) {
			cIdx = colorIndices[i];
			aIdx = alphaIndices[i];
			cBits = info.colorIdxBits;
			aBits = info.alphaIdxBits;
		} else {
			cIdx = colorIndices[i];
			aIdx = colorIndices[i];
			cBits = info.colorIdxBits;
			aBits = info.colorIdxBits;
		}

		let r = interp(e0r, e1r, cIdx, cBits);
		let g = interp(e0g, e1g, cIdx, cBits);
		let b = interp(e0b, e1b, cIdx, cBits);
		let a = info.alphaBits > 0 ? interp(e0a, e1a, aIdx, aBits) : 0xff;

		// Component rotation (modes 4/5): swap one colour channel
		// with alpha.
		if (rotation === 1) {
			const t = r;
			r = a;
			a = t;
		} else if (rotation === 2) {
			const t = g;
			g = a;
			a = t;
		} else if (rotation === 3) {
			const t = b;
			b = a;
			a = t;
		}

		out[outOff + i * 4 + 0] = r;
		out[outOff + i * 4 + 1] = g;
		out[outOff + i * 4 + 2] = b;
		out[outOff + i * 4 + 3] = a;
	}
}

/** True if pixel `i` is an "anchor" (its high index bit is implicit zero). */
function isAnchor(numSubsets: number, partition: number, i: number): boolean {
	if (i === 0) return true;
	if (numSubsets === 2) return ANCHOR_TABLE_2_BIT2[partition] === i;
	if (numSubsets === 3) {
		return (
			ANCHOR_TABLE_3_BIT2[partition] === i ||
			ANCHOR_TABLE_3_BIT3[partition] === i
		);
	}
	return false;
}

/**
 * Decode a BC7-compressed texture (block-grid input) to RGBA8.
 * `src` should be `ceil(w/4) * ceil(h/4) * 16` bytes; output is
 * `w * h * 4` bytes in row-major order.
 */
export function decodeBC7(src: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	const blocksWide = Math.ceil(w / 4);
	const blocksTall = Math.ceil(h / 4);
	const tmp = new Uint8Array(64);
	for (let by = 0; by < blocksTall; by++) {
		for (let bx = 0; bx < blocksWide; bx++) {
			const off = (by * blocksWide + bx) * 16;
			if (off + 16 > src.length) continue;
			decodeBlock(src, off, tmp, 0);
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px;
					const y = by * 4 + py;
					if (x >= w || y >= h) continue;
					const sIdx = (py * 4 + px) * 4;
					const dIdx = (y * w + x) * 4;
					out[dIdx + 0] = tmp[sIdx + 0];
					out[dIdx + 1] = tmp[sIdx + 1];
					out[dIdx + 2] = tmp[sIdx + 2];
					out[dIdx + 3] = tmp[sIdx + 3];
				}
			}
		}
	}
	return out;
}
