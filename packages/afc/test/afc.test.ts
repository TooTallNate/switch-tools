import { describe, expect, it } from 'vitest';

import {
	AFC_COEFFICIENTS,
	AFC_SAMPLES_PER_BLOCK,
	AFC_STREAM_HEADER_SIZE,
	AfcVariant,
	afcByteLength,
	afcSampleCount,
	decodeAfc,
	decodeAfcBlock,
	decodeAfcStream,
	isAfcStream,
	isAfcVariant,
	newAfcState,
	parseAfcStreamHeader,
} from '../src/index.js';

/**
 * Build a 4-bit AFC block: a header byte followed by 16 nibbles.
 *
 * `nibbles` are raw 0..15 values, packed high-nibble-first.
 */
function block4(shift: number, coefIndex: number, nibbles: number[]): Uint8Array {
	expect(nibbles).toHaveLength(16);
	const out = new Uint8Array(AfcVariant.HQ_4BIT);
	out[0] = ((shift & 0x0f) << 4) | (coefIndex & 0x0f);
	for (let i = 0; i < 16; i += 2) {
		out[1 + i / 2] = ((nibbles[i] & 0x0f) << 4) | (nibbles[i + 1] & 0x0f);
	}
	return out;
}

/** Build a 2-bit AFC block: header byte plus 16 two-bit values, MSB-first. */
function block2(shift: number, coefIndex: number, values: number[]): Uint8Array {
	expect(values).toHaveLength(16);
	const out = new Uint8Array(AfcVariant.LQ_2BIT);
	out[0] = ((shift & 0x0f) << 4) | (coefIndex & 0x0f);
	for (let i = 0; i < 16; i += 4) {
		out[1 + i / 4] =
			((values[i] & 3) << 6) |
			((values[i + 1] & 3) << 4) |
			((values[i + 2] & 3) << 2) |
			(values[i + 3] & 3);
	}
	return out;
}

function decodeOne(bytes: Uint8Array, variant: 5 | 9 = AfcVariant.HQ_4BIT): Int16Array {
	const dst = new Int16Array(AFC_SAMPLES_PER_BLOCK);
	const n = decodeAfcBlock(bytes, 0, variant, newAfcState(), dst, 0);
	expect(n).toBe(AFC_SAMPLES_PER_BLOCK);
	return dst;
}

/** All sixteen raw nibble values in order, i.e. signed 0..7 then -8..-1. */
const ALL_NIBBLES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const ALL_NIBBLES_SIGNED = [0, 1, 2, 3, 4, 5, 6, 7, -8, -7, -6, -5, -4, -3, -2, -1];

describe('AFC_COEFFICIENTS', () => {
	it('has sixteen pairs in 1/2048 fixed point', () => {
		expect(AFC_COEFFICIENTS).toHaveLength(16);
		for (const pair of AFC_COEFFICIENTS) expect(pair).toHaveLength(2);
	});

	it('encodes the predictors the format is documented around', () => {
		// Index 0 disables prediction entirely — an encoder must use it at a
		// loop point so the block doesn't depend on unavailable history.
		expect(AFC_COEFFICIENTS[0]).toEqual([0, 0]);
		// 2048 == 1.0, so index 1 repeats the previous sample and index 2 the
		// one before it; index 3 averages them.
		expect(AFC_COEFFICIENTS[1]).toEqual([2048, 0]);
		expect(AFC_COEFFICIENTS[2]).toEqual([0, 2048]);
		expect(AFC_COEFFICIENTS[3]).toEqual([1024, 1024]);
	});
});

describe('variant helpers', () => {
	it('identifies the two block sizes and rejects anything else', () => {
		expect(isAfcVariant(5)).toBe(true);
		expect(isAfcVariant(9)).toBe(true);
		expect(isAfcVariant(0)).toBe(false);
		expect(isAfcVariant(8)).toBe(false);
		expect(isAfcVariant(18)).toBe(false);
	});

	it('rounds byte lengths up to a whole block', () => {
		// 16 samples is one block; 17 needs two.
		expect(afcByteLength(16, AfcVariant.HQ_4BIT)).toBe(9);
		expect(afcByteLength(17, AfcVariant.HQ_4BIT)).toBe(18);
		expect(afcByteLength(1, AfcVariant.HQ_4BIT)).toBe(9);
		expect(afcByteLength(16, AfcVariant.LQ_2BIT)).toBe(5);
		expect(afcByteLength(0, AfcVariant.HQ_4BIT)).toBe(0);
		expect(afcByteLength(16, 7)).toBe(0);
	});

	it('converts byte lengths back to samples, ignoring a partial block', () => {
		expect(afcSampleCount(9, AfcVariant.HQ_4BIT)).toBe(16);
		expect(afcSampleCount(17, AfcVariant.HQ_4BIT)).toBe(16);
		expect(afcSampleCount(18, AfcVariant.HQ_4BIT)).toBe(32);
		expect(afcSampleCount(5, AfcVariant.LQ_2BIT)).toBe(16);
	});
});

describe('decodeAfcBlock — 4-bit', () => {
	it('with prediction disabled, reproduces the sign-extended values exactly', () => {
		// Coefficient index 0 zeroes the predictor and shift 0 makes the step 1,
		// so the output *is* the signed nibble. This pins the sign extension and
		// the fixed-point scaling simultaneously: the pre-scale by 2048 and the
		// final >> 11 must cancel exactly, or these numbers move.
		const out = decodeOne(block4(0, 0, ALL_NIBBLES));
		expect([...out]).toEqual(ALL_NIBBLES_SIGNED);
	});

	it('treats the header high nibble as an exponent, not a multiplier', () => {
		// shift 3 => step 8, so every sample scales by 8 rather than by 3.
		const out = decodeOne(block4(3, 0, ALL_NIBBLES));
		expect([...out]).toEqual(ALL_NIBBLES_SIGNED.map((v) => v * 8));
	});

	it('accumulates when the predictor repeats the previous sample', () => {
		// Coefficient 1 is [1.0, 0], so with a constant value of +1 the block
		// integrates: 1, 2, 3, ... 16.
		const out = decodeOne(block4(0, 1, new Array(16).fill(1)));
		expect([...out]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
	});

	it('reaches two samples back for coefficient 2', () => {
		// [0, 1.0] predicts from yn2. Starting history is 0,0 so with a constant
		// +1 the output alternates between two interleaved ramps.
		const out = decodeOne(block4(0, 2, new Array(16).fill(1)));
		expect([...out]).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
	});

	it('clamps to signed 16-bit range', () => {
		// step 32768 against +7 overflows immediately and must saturate rather
		// than wrap to a negative sample.
		const hi = decodeOne(block4(15, 0, new Array(16).fill(7)));
		expect([...hi]).toEqual(new Array(16).fill(32767));
		// -8 at the same step saturates the other way.
		const lo = decodeOne(block4(15, 0, new Array(16).fill(8)));
		expect([...lo]).toEqual(new Array(16).fill(-32768));
	});

	it('reads values most-significant-nibble first within each byte', () => {
		const out = decodeOne(block4(0, 0, [1, 2, ...new Array(14).fill(0)]));
		expect(out[0]).toBe(1);
		expect(out[1]).toBe(2);
	});

	it('threads history across blocks', () => {
		// Two integrating blocks in a row must continue from 16, not restart.
		const one = block4(0, 1, new Array(16).fill(1));
		const src = new Uint8Array([...one, ...one]);
		const dst = new Int16Array(32);
		const state = newAfcState();
		decodeAfcBlock(src, 0, AfcVariant.HQ_4BIT, state, dst, 0);
		decodeAfcBlock(src, 9, AfcVariant.HQ_4BIT, state, dst, 16);
		expect(dst[15]).toBe(16);
		expect(dst[16]).toBe(17);
		expect(dst[31]).toBe(32);
	});

	it('returns 0 rather than reading past the end of a truncated block', () => {
		const short = block4(0, 0, ALL_NIBBLES).subarray(0, 8);
		const dst = new Int16Array(16);
		expect(decodeAfcBlock(short, 0, AfcVariant.HQ_4BIT, newAfcState(), dst, 0)).toBe(0);
		// Untouched output.
		expect([...dst]).toEqual(new Array(16).fill(0));
	});

	it('returns 0 for a negative offset or an undersized destination', () => {
		const b = block4(0, 0, ALL_NIBBLES);
		expect(decodeAfcBlock(b, -1, AfcVariant.HQ_4BIT, newAfcState(), new Int16Array(16), 0)).toBe(0);
		expect(decodeAfcBlock(b, 0, AfcVariant.HQ_4BIT, newAfcState(), new Int16Array(8), 0)).toBe(0);
	});
});

describe('decodeAfcBlock — 2-bit', () => {
	it('scales four times coarser than the 4-bit variant for the same exponent', () => {
		// The 2-bit pre-scale is 8192 against the 4-bit's 2048, and 8192 >> 11
		// is 4 — which is precisely why this variant is the "low quality" one.
		const out = decodeOne(block2(0, 0, [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]), AfcVariant.LQ_2BIT);
		// Raw 0,1,2,3 sign-extend to 0,1,-2,-1 and then scale by 4.
		expect([...out]).toEqual([0, 4, -8, -4, 0, 4, -8, -4, 0, 4, -8, -4, 0, 4, -8, -4]);
	});

	it('packs four values per byte, most significant first', () => {
		const out = decodeOne(block2(0, 0, [1, 0, 0, 0, ...new Array(12).fill(0)]), AfcVariant.LQ_2BIT);
		expect(out[0]).toBe(4);
		expect(out[1]).toBe(0);
	});

	it('consumes only five bytes per block', () => {
		const b = block2(0, 0, new Array(16).fill(0));
		expect(b).toHaveLength(5);
	});
});

describe('decodeAfc', () => {
	it('decodes a run of blocks', () => {
		const one = block4(0, 0, ALL_NIBBLES);
		const src = new Uint8Array([...one, ...one, ...one]);
		const out = decodeAfc(src, 0, src.length, AfcVariant.HQ_4BIT);
		expect(out).toHaveLength(48);
		expect([...out.subarray(32, 48)]).toEqual(ALL_NIBBLES_SIGNED);
	});

	it('trims the padding samples of the final block to the declared length', () => {
		// A stream of 20 samples occupies two blocks but must not emit 32.
		const one = block4(0, 0, ALL_NIBBLES);
		const src = new Uint8Array([...one, ...one]);
		expect(decodeAfc(src, 0, src.length, AfcVariant.HQ_4BIT, 20)).toHaveLength(20);
		expect(decodeAfc(src, 0, src.length, AfcVariant.HQ_4BIT, 999)).toHaveLength(32);
		expect(decodeAfc(src, 0, src.length, AfcVariant.HQ_4BIT, 0)).toHaveLength(0);
	});

	it('ignores a trailing partial block', () => {
		const one = block4(0, 0, ALL_NIBBLES);
		const src = new Uint8Array([...one, 0x00, 0x11]);
		expect(decodeAfc(src, 0, src.length, AfcVariant.HQ_4BIT)).toHaveLength(16);
	});

	it('clamps byteLength to what the buffer actually holds', () => {
		const one = block4(0, 0, ALL_NIBBLES);
		expect(decodeAfc(one, 0, 9999, AfcVariant.HQ_4BIT)).toHaveLength(16);
	});
});

// ---------------------------------------------------------------------------
// Stream container
// ---------------------------------------------------------------------------

interface StreamOpts {
	sampleCount: number;
	channels: number;
	sampleRate?: number;
	bitsPerSample?: number;
	samplesPerBlock?: number;
	variant?: 5 | 9;
	/** Override the payload size written into the header. */
	dataSize?: number;
	/** Truncate the emitted payload to this many bytes. */
	truncateTo?: number;
	/** Per-channel block factory, so channels can be made distinguishable. */
	makeBlock?: (channel: number, blockIndex: number) => Uint8Array;
}

function buildStream(o: StreamOpts): Uint8Array {
	const variant = o.variant ?? AfcVariant.HQ_4BIT;
	const blocks = Math.ceil(o.sampleCount / AFC_SAMPLES_PER_BLOCK);
	const payloadLen = blocks * variant * o.channels;
	const declared = o.dataSize ?? payloadLen;

	const payload = new Uint8Array(payloadLen);
	for (let b = 0; b < blocks; b++) {
		for (let c = 0; c < o.channels; c++) {
			const blk = o.makeBlock
				? o.makeBlock(c, b)
				: block4(0, 0, ALL_NIBBLES).subarray(0, variant);
			payload.set(blk.subarray(0, variant), (b * o.channels + c) * variant);
		}
	}

	const emitted = o.truncateTo === undefined ? payloadLen : Math.min(payloadLen, o.truncateTo);
	const out = new Uint8Array(AFC_STREAM_HEADER_SIZE + emitted);
	const view = new DataView(out.buffer);
	view.setUint32(0x00, declared, false);
	view.setUint32(0x04, o.sampleCount, false);
	view.setUint16(0x08, o.sampleRate ?? 32000, false);
	view.setUint16(0x0a, o.bitsPerSample ?? 4, false);
	view.setUint16(0x0c, o.samplesPerBlock ?? AFC_SAMPLES_PER_BLOCK, false);
	view.setUint16(0x0e, 30, false);
	out.set(payload.subarray(0, emitted), AFC_STREAM_HEADER_SIZE);
	return out;
}

describe('parseAfcStreamHeader', () => {
	it('derives a stereo layout from the payload size', () => {
		const h = parseAfcStreamHeader(buildStream({ sampleCount: 320, channels: 2 }))!;
		expect(h).not.toBeNull();
		expect(h.channelCount).toBe(2);
		expect(h.variant).toBe(AfcVariant.HQ_4BIT);
		expect(h.sampleCount).toBe(320);
		expect(h.sampleRate).toBe(32000);
		expect(h.dataOffset).toBe(AFC_STREAM_HEADER_SIZE);
		expect(h.durationSeconds).toBeCloseTo(0.01, 5);
	});

	it('derives mono and four-channel layouts too', () => {
		expect(parseAfcStreamHeader(buildStream({ sampleCount: 160, channels: 1 }))?.channelCount).toBe(1);
		expect(parseAfcStreamHeader(buildStream({ sampleCount: 160, channels: 4 }))?.channelCount).toBe(4);
	});

	it('derives the 2-bit variant from its block size', () => {
		const h = parseAfcStreamHeader(
			buildStream({ sampleCount: 160, channels: 2, variant: AfcVariant.LQ_2BIT, bitsPerSample: 2 }),
		)!;
		expect(h.variant).toBe(AfcVariant.LQ_2BIT);
		expect(h.channelCount).toBe(2);
	});

	it('rejects a samplesPerBlock that is not 16', () => {
		// AFC is defined in terms of 16-sample blocks; anything else isn't AFC,
		// and this field is one of the few real integrity checks available.
		expect(parseAfcStreamHeader(buildStream({ sampleCount: 160, channels: 2, samplesPerBlock: 14 }))).toBeNull();
	});

	it('rejects an implausible sample rate', () => {
		expect(parseAfcStreamHeader(buildStream({ sampleCount: 160, channels: 2, sampleRate: 10 }))).toBeNull();
		expect(parseAfcStreamHeader(buildStream({ sampleCount: 160, channels: 2, sampleRate: 0 }))).toBeNull();
	});

	it('rejects a payload size that no channel count can explain', () => {
		// One byte more than any whole number of interleaved blocks.
		const bytes = buildStream({ sampleCount: 160, channels: 2 });
		new DataView(bytes.buffer).setUint32(0x00, 91, false);
		expect(parseAfcStreamHeader(bytes)).toBeNull();
	});

	it('rejects a channel count beyond anything plausible', () => {
		const bytes = buildStream({ sampleCount: 16, channels: 1 });
		// 9 * 64 implies 64 channels.
		new DataView(bytes.buffer).setUint32(0x00, 9 * 64, false);
		expect(parseAfcStreamHeader(bytes)).toBeNull();
	});

	it('rejects zero-length and short buffers', () => {
		expect(parseAfcStreamHeader(new Uint8Array(0))).toBeNull();
		expect(parseAfcStreamHeader(new Uint8Array(AFC_STREAM_HEADER_SIZE - 1))).toBeNull();
		expect(parseAfcStreamHeader(new Uint8Array(64))).toBeNull(); // all zeroes
		expect(parseAfcStreamHeader(buildStream({ sampleCount: 160, channels: 2 }), -1)).toBeNull();
	});

	it('accepts a truncated payload, since a short read still identifies the file', () => {
		const h = parseAfcStreamHeader(buildStream({ sampleCount: 320, channels: 2, truncateTo: 20 }));
		expect(h).not.toBeNull();
		expect(h!.channelCount).toBe(2);
	});

	it('parses at a non-zero offset', () => {
		const inner = buildStream({ sampleCount: 160, channels: 2 });
		const wrapped = new Uint8Array(100 + inner.length);
		wrapped.set(inner, 100);
		expect(parseAfcStreamHeader(wrapped, 100)?.channelCount).toBe(2);
	});
});

describe('isAfcStream', () => {
	it('accepts a well-formed stream and rejects other data', () => {
		expect(isAfcStream(buildStream({ sampleCount: 160, channels: 2 }))).toBe(true);
		const rarc = new Uint8Array(64);
		rarc.set([0x52, 0x41, 0x52, 0x43], 0);
		expect(isAfcStream(rarc)).toBe(false);
		expect(isAfcStream(new Uint8Array(64).fill(0xff))).toBe(false);
	});
});

describe('decodeAfcStream', () => {
	it('interleaves channels rather than concatenating them', () => {
		// Left integrates by +1 per sample; right is a flat zero. If the
		// de-interleave were wrong, the left ramp would land in the right
		// channel or the two would appear as consecutive halves.
		const bytes = buildStream({
			sampleCount: 16,
			channels: 2,
			makeBlock: (c) =>
				c === 0 ? block4(0, 1, new Array(16).fill(1)) : block4(0, 0, new Array(16).fill(0)),
		});
		const d = decodeAfcStream(bytes)!;
		expect(d.channelCount).toBe(2);
		expect(d.sampleCount).toBe(16);
		expect(d.samples).toHaveLength(32);
		const left: number[] = [];
		const right: number[] = [];
		for (let i = 0; i < d.sampleCount; i++) {
			left.push(d.samples[i * 2]);
			right.push(d.samples[i * 2 + 1]);
		}
		expect(left).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
		expect(right).toEqual(new Array(16).fill(0));
	});

	it('keeps an independent predictor history per channel', () => {
		// Both channels integrate. Across two blocks each must reach 32; a
		// shared history would make the second channel continue from the first.
		const bytes = buildStream({
			sampleCount: 32,
			channels: 2,
			makeBlock: () => block4(0, 1, new Array(16).fill(1)),
		});
		const d = decodeAfcStream(bytes)!;
		expect(d.sampleCount).toBe(32);
		expect(d.samples[31 * 2]).toBe(32);
		expect(d.samples[31 * 2 + 1]).toBe(32);
	});

	it('honours the declared sample count over the block padding', () => {
		const d = decodeAfcStream(buildStream({ sampleCount: 20, channels: 2 }))!;
		expect(d.sampleCount).toBe(20);
		expect(d.samples).toHaveLength(40);
	});

	it('returns what it can from a truncated payload', () => {
		// Enough bytes for the first interleaved group only.
		const d = decodeAfcStream(buildStream({ sampleCount: 320, channels: 2, truncateTo: 18 }))!;
		expect(d.sampleCount).toBe(16);
		expect(d.samples).toHaveLength(32);
	});

	it('returns an empty result when not even one group is present', () => {
		const d = decodeAfcStream(buildStream({ sampleCount: 320, channels: 2, truncateTo: 4 }))!;
		expect(d.sampleCount).toBe(0);
		expect(d.samples).toHaveLength(0);
	});

	it('returns null for data that is not a stream', () => {
		expect(decodeAfcStream(new Uint8Array(64))).toBeNull();
	});

	it('produces a sample count that divides evenly by the channel count', () => {
		// This is the invariant `encodeWav` enforces, so breaking it would make
		// every decoded stream unplayable.
		const d = decodeAfcStream(buildStream({ sampleCount: 100, channels: 2 }))!;
		expect(d.samples.length % d.channelCount).toBe(0);
	});
});
