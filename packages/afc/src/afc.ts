/**
 * AFC block codec.
 *
 * AFC is Nintendo's ADPCM variant for the GameCube and Wii. It is the format
 * the DSP's sample accelerator reads directly out of ARAM, which is why every
 * design decision in it is about being cheap for a small fixed-function unit
 * rather than about compression ratio.
 *
 * A stream is a flat sequence of independent *blocks*, each of which always
 * decodes to exactly **16 samples**. There is no block index and no per-block
 * length field: the block size is implied by the variant, so the decoder can
 * seek to sample N by dividing. Two variants exist, and they are distinguished
 * only by that block size:
 *
 *   • 4-bit ("HQ"): 9 bytes per block — 1 header byte + 8 data bytes.
 *   • 2-bit ("LQ"): 5 bytes per block — 1 header byte + 4 data bytes.
 *
 * Those two numbers, 9 and 5, are how the hardware itself identifies the
 * variant: the DSP's voice descriptor stores the source type as the byte count,
 * so "type 9" *means* 4-bit AFC. We use the same convention for
 * {@link AfcVariant} so that a value read out of a game structure can be passed
 * straight through.
 *
 * ## Block layout
 *
 *   byte 0        header:  bits 7..4 = scale exponent, bits 3..0 = coefficient index
 *   bytes 1..n    packed sample values, most-significant first within each byte
 *
 * The header packs both halves of the ADPCM state into one byte. The high
 * nibble is an exponent, not a multiplier — the step size is `1 << exponent`,
 * which gives a range of 1..32768 out of four bits and is why AFC copes with
 * both quiet and loud passages without a per-block gain. The low nibble selects
 * one of sixteen fixed predictor coefficient pairs (see
 * {@link AFC_COEFFICIENTS}); unlike DSP-ADPCM, the coefficients are *not*
 * stored per stream, because the table lives in the DSP microcode.
 *
 * ## Reconstruction
 *
 * Each packed value is a two's-complement integer of the variant's width. It is
 * sign-extended and pre-scaled into the same fixed-point domain as the
 * predictor (11 fractional bits), then combined with the two previous output
 * samples:
 *
 *   sample = (step * value + yn1 * coefA + yn2 * coefB) >> 11
 *
 * clamped to signed 16 bits, after which `yn2 = yn1` and `yn1 = sample`.
 *
 * The single shift of the *whole* sum is deliberate and is the one place where
 * implementations in the wild disagree — some shift only the predictor term,
 * which is algebraically the same but rounds differently and drifts from the
 * hardware by an LSB. We follow the DSP: one shift, applied last.
 *
 * Because `yn1`/`yn2` carry across blocks, a stream can only be decoded from
 * the start (or from a point whose history you already know). That is what
 * {@link AfcState} is for.
 *
 * References (used to understand the format; implementation is original):
 *   - Dolphin, `Source/Core/Core/HW/DSPHLE/UCodes/Zelda.cpp` (the AFC path of
 *     the Zelda DSP microcode HLE).
 *   - XAYRGA's `jatafc` / `libJAudio`, which document the coefficient table.
 */

/**
 * AFC variant, identified by its block size in bytes — the same encoding the
 * DSP voice descriptor uses for its sample source type.
 */
export const AfcVariant = {
	/** 2-bit samples: 5 bytes per 16-sample block. */
	LQ_2BIT: 5,
	/** 4-bit samples: 9 bytes per 16-sample block. */
	HQ_4BIT: 9,
} as const;

export type AfcVariantValue = (typeof AfcVariant)[keyof typeof AfcVariant];

/** Every AFC block decodes to exactly this many samples. */
export const AFC_SAMPLES_PER_BLOCK = 16;

/** Number of fractional bits in the predictor's fixed-point coefficients. */
export const AFC_FRACTIONAL_BITS = 11;

/**
 * The sixteen predictor coefficient pairs, as `[a, b]` applied to the previous
 * and second-previous output sample respectively, in 1/2048 fixed point.
 *
 * These are a property of the format rather than of any one file — they live in
 * the DSP microcode, and the game uploads this exact table at init. Reading
 * them as ratios makes the design legible: index 1 is `[1.0, 0]` (repeat the
 * last sample), index 2 is `[0, 1.0]` (repeat the one before), index 3 is the
 * average of the two, index 10 is the most aggressive extrapolation
 * (`[2.5, -1.5]`), and index 0 is `[0, 0]` — no prediction at all, which is
 * what an encoder must select at a loop point so the block does not depend on
 * history the player will not have.
 */
export const AFC_COEFFICIENTS: readonly (readonly [number, number])[] = [
	[0, 0],
	[2048, 0],
	[0, 2048],
	[1024, 1024],
	[4096, -2048],
	[3584, -1536],
	[3072, -1024],
	[4608, -2560],
	[4200, -2248],
	[4800, -2300],
	[5120, -3072],
	[2048, -2048],
	[1024, -1024],
	[-1024, 1024],
	[-1024, 0],
	[-2048, 0],
];

/** Flattened `[a0, b0, a1, b1, ...]` form, to keep the inner loop off of tuples. */
const COEFFS_FLAT = new Int32Array(AFC_COEFFICIENTS.length * 2);
for (let i = 0; i < AFC_COEFFICIENTS.length; i++) {
	COEFFS_FLAT[i * 2] = AFC_COEFFICIENTS[i][0];
	COEFFS_FLAT[i * 2 + 1] = AFC_COEFFICIENTS[i][1];
}

/**
 * Rolling ADPCM history. AFC blocks are not independent, so decoding a stream
 * in pieces requires threading this through.
 */
export interface AfcState {
	/** Previous output sample. */
	yn1: number;
	/** Sample before that. */
	yn2: number;
}

/** A fresh state, as used at the start of a stream (and at a loop point). */
export function newAfcState(): AfcState {
	return { yn1: 0, yn2: 0 };
}

/** True for a block size we know how to decode. */
export function isAfcVariant(blockSize: number): blockSize is AfcVariantValue {
	return blockSize === AfcVariant.LQ_2BIT || blockSize === AfcVariant.HQ_4BIT;
}

/** Bytes occupied by `sampleCount` samples of one channel, rounded up to a block. */
export function afcByteLength(sampleCount: number, variant: number): number {
	if (!isAfcVariant(variant) || sampleCount <= 0) return 0;
	return Math.ceil(sampleCount / AFC_SAMPLES_PER_BLOCK) * variant;
}

/** Samples represented by `byteLength` bytes of one channel. */
export function afcSampleCount(byteLength: number, variant: number): number {
	if (!isAfcVariant(variant) || byteLength <= 0) return 0;
	return Math.floor(byteLength / variant) * AFC_SAMPLES_PER_BLOCK;
}

/**
 * Decode one block: 16 samples from `src[offset ...]`.
 *
 * `state` is read and updated in place. Returns the number of samples written
 * (always {@link AFC_SAMPLES_PER_BLOCK}), or 0 if the block would run past the
 * end of `src` — a truncated stream stops cleanly rather than reading garbage.
 *
 * The intermediate sum stays inside a signed 32-bit integer for every legal
 * input — the worst case is a maximum step of 32768 against a maximum
 * pre-scaled value of 16384, plus two predictor terms, which is about 8.7e8 and
 * so comfortably under 2^31. That is what lets us use `>>` (arithmetic, and
 * floor-rounding for negatives, matching the hardware) instead of a divide.
 */
export function decodeAfcBlock(
	src: Uint8Array,
	offset: number,
	variant: AfcVariantValue,
	state: AfcState,
	dst: Int16Array,
	dstOffset: number,
): number {
	if (offset < 0 || offset + variant > src.length) return 0;
	if (dstOffset < 0 || dstOffset + AFC_SAMPLES_PER_BLOCK > dst.length) return 0;

	const header = src[offset];
	// High nibble is an exponent: the quantisation step is a power of two.
	const step = 1 << (header >> 4);
	const coefBase = (header & 0x0f) * 2;
	const coefA = COEFFS_FLAT[coefBase];
	const coefB = COEFFS_FLAT[coefBase + 1];

	let yn1 = state.yn1;
	let yn2 = state.yn2;

	// Both variants pre-scale their packed value so that it lands in the
	// predictor's 11-fractional-bit domain. Sign extension is done by shifting
	// the value up to the top of a 16-bit field and back down arithmetically,
	// which is exactly what the DSP does and avoids a branch on the sign bit.
	//
	//   4-bit: (v << 12) sign-extended, then >> 1  ->  signed(v) * 2048
	//   2-bit: (v << 14) sign-extended, then >> 1  ->  signed(v) * 8192
	//
	// The 2-bit variant therefore has a step four times coarser for the same
	// exponent, which is the whole reason it is called "low quality".
	const shiftUp = variant === AfcVariant.HQ_4BIT ? 12 : 14;
	const valuesPerByte = variant === AfcVariant.HQ_4BIT ? 2 : 4;
	const bitsPerValue = variant === AfcVariant.HQ_4BIT ? 4 : 2;
	const mask = variant === AfcVariant.HQ_4BIT ? 0x0f : 0x03;

	let p = offset + 1;
	let out = dstOffset;
	for (let i = 0; i < AFC_SAMPLES_PER_BLOCK; i += valuesPerByte) {
		const packed = src[p++];
		for (let k = 0; k < valuesPerByte; k++) {
			// Most-significant value first within the byte.
			const raw = (packed >> (8 - bitsPerValue * (k + 1))) & mask;
			const value = (((raw << shiftUp) << 16) >> 16) >> 1;
			let sample = (step * value + yn1 * coefA + yn2 * coefB) >> AFC_FRACTIONAL_BITS;
			if (sample > 32767) sample = 32767;
			else if (sample < -32768) sample = -32768;
			dst[out++] = sample;
			yn2 = yn1;
			yn1 = sample;
		}
	}

	state.yn1 = yn1;
	state.yn2 = yn2;
	return AFC_SAMPLES_PER_BLOCK;
}

/**
 * Decode a contiguous run of single-channel AFC blocks.
 *
 * `sampleLimit` trims the tail: the last block always produces 16 samples even
 * when the stream's declared length ends part-way through it, and emitting
 * those extra samples would append a fraction of a millisecond of noise to
 * every file.
 */
export function decodeAfc(
	src: Uint8Array,
	offset: number,
	byteLength: number,
	variant: AfcVariantValue,
	sampleLimit?: number,
	state: AfcState = newAfcState(),
): Int16Array {
	const usableBytes = Math.max(
		0,
		Math.min(byteLength, src.length - Math.max(0, offset)),
	);
	const blocks = Math.floor(usableBytes / variant);
	const produced = blocks * AFC_SAMPLES_PER_BLOCK;
	const total =
		sampleLimit === undefined ? produced : Math.min(produced, Math.max(0, sampleLimit));

	// Decode into a full-block buffer, then hand back a view of the wanted
	// prefix so callers never see the padding samples.
	const scratch = new Int16Array(produced);
	let out = 0;
	for (let b = 0; b < blocks; b++) {
		if (decodeAfcBlock(src, offset + b * variant, variant, state, scratch, out) === 0) {
			break;
		}
		out += AFC_SAMPLES_PER_BLOCK;
	}
	return total === produced ? scratch : scratch.subarray(0, total);
}
