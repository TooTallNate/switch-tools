import { describe, it, expect } from 'vitest';
import {
	decodeFrames,
	decodeChannel,
	makeDspState,
	dspBytesForSamples,
	DSP_FRAME_SIZE,
	DSP_SAMPLES_PER_FRAME,
} from '../src/index.js';

/**
 * Hand-built reference frame the algorithm should decode the same
 * way vgmstream does.
 *
 * Single 8-byte DSP-ADPCM frame:
 *   header byte = 0x05  → predictor = 0, scale = 2^5 = 32
 *   bytes 1..7  = all 0x00 → 14 nibbles, all "0"
 *
 * With predictor 0 the (coef1, coef2) pair is (0, 0), so each
 * sample is `(0 * 32) << 11 + 1024 + 0 + 0 >> 11` = 0. The output
 * should be 14 zeros and the decoder state should remain (0, 0).
 */
const ZERO_FRAME = new Uint8Array(DSP_FRAME_SIZE);
ZERO_FRAME[0] = 0x05;

/**
 * A frame designed to exercise the predictor + history feedback
 * path without doing real DSP-ADPCM encoding here:
 *
 *   header = 0x00 → predictor=0 (coefs (0,0)), scale=2^0=1
 *   bytes 1..7 packed nibbles spelling out the sequence:
 *      +1, -1, +1, -1, +1, -1, +1, -1, +1, -1, +1, -1, +1, -1
 *
 * With (coef1, coef2) = (0, 0) the output is just `clamp16(((nibble*1)<<11 + 1024) >> 11)`,
 * which simplifies to `nibble` itself for nibbles in [-8, 7].
 */
function packAlternating(): Uint8Array {
	const f = new Uint8Array(DSP_FRAME_SIZE);
	f[0] = 0x00; // predictor 0, scale 2^0 = 1
	// 14 nibbles: +1, -1, +1, -1, ...
	// +1 → 0x1, -1 → 0xF (sign-extended back to -1 by the decoder)
	for (let i = 1; i <= 7; i++) f[i] = 0x1f; // hi=+1, lo=-1
	return f;
}

describe('decodeFrames — zero-frame sanity', () => {
	it('emits 14 zeros and leaves history at (0, 0)', () => {
		const state = makeDspState(new Uint8Array(32), { littleEndian: true });
		const out = new Int16Array(DSP_SAMPLES_PER_FRAME);
		decodeFrames(
			ZERO_FRAME,
			0,
			DSP_SAMPLES_PER_FRAME,
			state,
			out,
			0,
			1,
		);
		expect(Array.from(out)).toEqual(new Array(DSP_SAMPLES_PER_FRAME).fill(0));
		expect(state.hist1).toBe(0);
		expect(state.hist2).toBe(0);
	});
});

describe('decodeFrames — alternating ±1 frame', () => {
	it('decodes nibbles to ±1 with a zero predictor', () => {
		const state = makeDspState(new Uint8Array(32), { littleEndian: true });
		const out = new Int16Array(DSP_SAMPLES_PER_FRAME);
		decodeFrames(
			packAlternating(),
			0,
			DSP_SAMPLES_PER_FRAME,
			state,
			out,
			0,
			1,
		);
		// The decoder rounds via +1024 then >>11 so a raw nibble of N
		// passes through as N for any N in [-8, 7] (since the +1024
		// term is half a step and the multiplier is 2^11).
		const expected = [];
		for (let i = 0; i < DSP_SAMPLES_PER_FRAME; i++) {
			expected.push(i % 2 === 0 ? 1 : -1);
		}
		expect(Array.from(out)).toEqual(expected);
		// hist1 = last sample = -1, hist2 = second-to-last = +1
		expect(state.hist1).toBe(-1);
		expect(state.hist2).toBe(1);
	});

	it('honours stride for interleaved output', () => {
		const state = makeDspState(new Uint8Array(32), { littleEndian: true });
		const out = new Int16Array(DSP_SAMPLES_PER_FRAME * 2);
		// Stride 2 — write into every other slot, leaving the others zero.
		decodeFrames(
			packAlternating(),
			0,
			DSP_SAMPLES_PER_FRAME,
			state,
			out,
			1,
			2,
		);
		for (let i = 0; i < DSP_SAMPLES_PER_FRAME; i++) {
			expect(out[2 * i + 1]).toBe(i % 2 === 0 ? 1 : -1);
			expect(out[2 * i]).toBe(0);
		}
	});
});

describe('decodeFrames — predictor + history feedback', () => {
	it('uses the chosen coef pair from the channel table', () => {
		// coef pair 1 = (coef1=2048, coef2=0) → output = (nibble*scale<<11 + 1024 + 2048*hist1) >> 11
		// = nibble * scale + (1024 + 2048*hist1) >> 11
		// = nibble*scale + hist1   (when hist1 fits and scale=1)
		// So feeding frame `(predictor=1, scale=1)` with all-zero
		// nibbles should produce a constant geometric series — except
		// hist1 starts at 0, so output stays 0.
		// Better test: start with hist1 = 100, scale = 1, nibbles = 0.
		// First sample: (0 * 1) << 11 + 1024 + 2048*100 = 0+1024+204800 = 205824. >>11 = 100.
		// So output[0] = 100, hist1 = 100 (unchanged), hist2 = old_hist1 = 100.
		const coefBytes = new Uint8Array(32);
		const dv = new DataView(coefBytes.buffer);
		// Pair 0 → (0, 0). Pair 1 → (2048, 0).
		dv.setInt16(4, 2048, true); // coefs[2] = coef1 of pair 1
		dv.setInt16(6, 0, true);    // coefs[3] = coef2 of pair 1

		const state = makeDspState(coefBytes, {
			littleEndian: true,
			hist1: 100,
			hist2: 0,
		});
		const frame = new Uint8Array(DSP_FRAME_SIZE);
		frame[0] = 0x10; // predictor=1, scale=1
		const out = new Int16Array(DSP_SAMPLES_PER_FRAME);
		decodeFrames(frame, 0, DSP_SAMPLES_PER_FRAME, state, out, 0, 1);
		// All 14 samples should be 100.
		for (let i = 0; i < DSP_SAMPLES_PER_FRAME; i++) {
			expect(out[i]).toBe(100);
		}
		expect(state.hist1).toBe(100);
		expect(state.hist2).toBe(100);
	});
});

describe('decodeFrames — clamping', () => {
	it('clamps over/underflow to the s16 range', () => {
		// Force overflow: predictor pair (32767, 0) with hist1 = 32767.
		// 32767 * 32767 = ~1.07e9 — a 32-bit int, plenty of headroom in
		// JS number → the >>11 yields ~525,253 → must clamp to 32767.
		const coefBytes = new Uint8Array(32);
		const dv = new DataView(coefBytes.buffer);
		dv.setInt16(0, 32767, true); // pair 0 coef1
		dv.setInt16(2, 0, true);     // pair 0 coef2

		const state = makeDspState(coefBytes, {
			littleEndian: true,
			hist1: 32767,
			hist2: 0,
		});
		const frame = new Uint8Array(DSP_FRAME_SIZE);
		frame[0] = 0x00; // predictor 0, scale 1
		const out = new Int16Array(1);
		decodeFrames(frame, 0, 1, state, out, 0, 1);
		expect(out[0]).toBe(32767);
	});
});

describe('decodeChannel + dspBytesForSamples', () => {
	it('decodes a multi-frame stream with continuous history', () => {
		// Five copies of the alternating frame back-to-back. The
		// predictor (and hist) is reset by the per-frame header byte
		// only insofar as the chosen pair applies — the hist values
		// themselves persist. Since pair 0 = (0,0), hist contributes
		// nothing; output is just the nibble stream.
		const f = packAlternating();
		const stream = new Uint8Array(f.length * 5);
		for (let i = 0; i < 5; i++) stream.set(f, i * f.length);

		const state = makeDspState(new Uint8Array(32), { littleEndian: true });
		const samples = decodeChannel(stream, DSP_SAMPLES_PER_FRAME * 5, state);
		expect(samples.length).toBe(DSP_SAMPLES_PER_FRAME * 5);
		for (let i = 0; i < samples.length; i++) {
			expect(samples[i]).toBe(i % 2 === 0 ? 1 : -1);
		}
	});

	it('rounds dspBytesForSamples up to whole frames', () => {
		expect(dspBytesForSamples(0)).toBe(0);
		expect(dspBytesForSamples(1)).toBe(8);
		expect(dspBytesForSamples(14)).toBe(8);
		expect(dspBytesForSamples(15)).toBe(16);
		expect(dspBytesForSamples(28)).toBe(16);
		expect(dspBytesForSamples(29)).toBe(24);
	});
});

describe('decodeFrames — block-interleave continuity (BFSTM-style)', () => {
	it('carries hist across separate slice calls (simulates block-interleaved BFSTM)', () => {
		// Build a 5-frame stream with predictor 1 / coef (2048,0) and
		// non-zero nibbles so we can prove hist propagates.
		const coefBytes = new Uint8Array(32);
		const dv = new DataView(coefBytes.buffer);
		dv.setInt16(4, 2048, true); // pair 1 coef1
		dv.setInt16(6, 0, true);
		const frame = new Uint8Array(DSP_FRAME_SIZE);
		frame[0] = 0x10; // predictor=1, scale=1
		// Single nibble of +1 first sample, rest zeros.
		frame[1] = 0x10; // hi=1 (sample 0 = +1), lo=0
		const stream5 = new Uint8Array(frame.length * 5);
		for (let i = 0; i < 5; i++) stream5.set(frame, i * frame.length);

		const oneShot = makeDspState(coefBytes, { littleEndian: true });
		const oneShotOut = decodeChannel(
			stream5,
			DSP_SAMPLES_PER_FRAME * 5,
			oneShot,
		);

		const split = makeDspState(coefBytes, { littleEndian: true });
		const splitOut = new Int16Array(DSP_SAMPLES_PER_FRAME * 5);
		// Decode frames 0..1 from one buffer, then 2..4 from another.
		const part1 = stream5.subarray(0, DSP_FRAME_SIZE * 2);
		const part2 = stream5.subarray(DSP_FRAME_SIZE * 2);
		decodeFrames(
			part1,
			0,
			DSP_SAMPLES_PER_FRAME * 2,
			split,
			splitOut,
			0,
			1,
		);
		decodeFrames(
			part2,
			0,
			DSP_SAMPLES_PER_FRAME * 3,
			split,
			splitOut,
			DSP_SAMPLES_PER_FRAME * 2,
			1,
		);
		expect(Array.from(splitOut)).toEqual(Array.from(oneShotOut));
	});
});
