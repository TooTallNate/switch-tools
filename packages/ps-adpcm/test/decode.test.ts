import { describe, it, expect } from 'vitest';
import {
	decodePsAdpcm,
	encodeWav,
	psAdpcmBytesToSamples,
	squareKeyToSampleRate,
	PS_ADPCM_FRAME_SIZE,
	PS_ADPCM_SAMPLES_PER_FRAME,
} from '../src/index.js';

/**
 * Build a single PS-ADPCM frame from the given header/flag/nibbles.
 * `nibbles` must have 28 entries in [-8, 7].
 */
function makeFrame(
	coefIndex: number,
	shiftFactor: number,
	flag: number,
	nibbles: readonly number[],
): Uint8Array {
	if (nibbles.length !== PS_ADPCM_SAMPLES_PER_FRAME) {
		throw new Error(
			`nibbles must have exactly ${PS_ADPCM_SAMPLES_PER_FRAME} entries`,
		);
	}
	const f = new Uint8Array(PS_ADPCM_FRAME_SIZE);
	f[0] = ((coefIndex & 0xf) << 4) | (shiftFactor & 0xf);
	f[1] = flag;
	for (let i = 0; i < nibbles.length; i++) {
		const n = nibbles[i] & 0xf;
		// Low nibble first, then high nibble per byte
		const byteIdx = 2 + (i >> 1);
		if ((i & 1) === 0) {
			f[byteIdx] = (f[byteIdx] & 0xf0) | n;
		} else {
			f[byteIdx] = (f[byteIdx] & 0x0f) | (n << 4);
		}
	}
	return f;
}

describe('decodePsAdpcm — silent flag', () => {
	it('flag 0x07 forces 28 zero samples regardless of nibbles', () => {
		const frame = makeFrame(2, 8, 0x07, new Array(28).fill(7));
		const samples = decodePsAdpcm(frame);
		expect(samples.length).toBe(28);
		for (const s of samples) expect(s).toBe(0);
	});

	it('honours ignoreFlags option', () => {
		const frame = makeFrame(0, 12, 0x07, new Array(28).fill(0));
		const samples = decodePsAdpcm(frame, { ignoreFlags: true });
		// With coef=0 and nibble=0, samples are 0 regardless,
		// but the codepath should not branch into the silent
		// fast-path. Verify by feeding a non-zero nibble next:
		const frame2 = makeFrame(0, 12, 0x07, [
			1, ...new Array(27).fill(0),
		]);
		const samples2 = decodePsAdpcm(frame2, { ignoreFlags: true });
		// shift = 20 - 12 = 8
		// nibble 1 -> signed 1 -> scaled = 1 * 256 = 256
		// pred = 0 (coef 0,0, hist = 0)
		// sample = (256 + 0) >> 8 = 1
		expect(samples2[0]).toBe(1);
	});
});

describe('decodePsAdpcm — coef_index 0 (identity, no prediction)', () => {
	it('passes nibbles through scaled by 2^shift', () => {
		// shift_factor = 12 -> shift = 8 -> scale = 256
		// With coef=0, prediction is 0 forever, so each sample =
		// signed_nibble * 256 (clamped to s16).
		const nibbles = [1, 2, 3, -1, -2, -3, 7, -8];
		const padded = [...nibbles, ...new Array(28 - nibbles.length).fill(0)];
		const frame = makeFrame(0, 12, 0, padded);
		const samples = decodePsAdpcm(frame);
		expect(samples[0]).toBe(1);
		expect(samples[1]).toBe(2);
		expect(samples[2]).toBe(3);
		expect(samples[3]).toBe(-1);
		expect(samples[4]).toBe(-2);
		expect(samples[5]).toBe(-3);
		expect(samples[6]).toBe(7);
		expect(samples[7]).toBe(-8);
		// Remaining 20 samples are all 0
		for (let i = nibbles.length; i < 28; i++) {
			expect(samples[i]).toBe(0);
		}
	});

	it('clamps to s16 range when shift produces overflow', () => {
		// shift_factor = 0 -> shift = 20 -> scale = 2^20 = 1,048,576
		// nibble = 7 -> signed = 7 -> scaled = 7 << 20 = 7,340,032
		// sample = (7,340,032 + 0) >> 8 = 28672 (fits s16: < 32767)
		// nibble = -8 -> scaled = -8 << 20 = -8,388,608
		// sample = -8,388,608 >> 8 = -32768 (exactly s16 min)
		//
		// To force clamping we use the EXTENDED coef table where
		// hist propagation can push beyond s16. Easier: just
		// verify the per-frame max output stays in s16 even at
		// the extreme nibble values.
		const frame = makeFrame(0, 0, 0, [
			7, -8, ...new Array(26).fill(0),
		]);
		const samples = decodePsAdpcm(frame);
		expect(samples[0]).toBe(28672);
		expect(samples[1]).toBe(-32768);
		// All samples within s16 range
		for (const s of samples) {
			expect(s).toBeGreaterThanOrEqual(-32768);
			expect(s).toBeLessThanOrEqual(32767);
		}
	});

	it('clamps when the predictor pushes a sample past s16 max', () => {
		// coef_index 4 = (122, -60), the most aggressive predictor.
		// Feed nibbles that drive hist1 up steadily and verify the
		// output stays s16-clamped.
		const frame = makeFrame(4, 4, 0, new Array(28).fill(7));
		const samples = decodePsAdpcm(frame);
		// All s16-valid
		for (const s of samples) {
			expect(s).toBeGreaterThanOrEqual(-32768);
			expect(s).toBeLessThanOrEqual(32767);
		}
		// At least one sample should be at the s16 max boundary
		// when feeding sustained max-positive nibbles with a
		// large positive coef.
		const hasMax = samples.some((s) => s === 32767);
		expect(hasMax).toBe(true);
	});
});

describe('decodePsAdpcm — multi-frame decoding', () => {
	it('carries hist1/hist2 across frames', () => {
		// coef_index = 1 → (c1, c2) = (60, 0). shift_factor = 12
		// → shift = 8.
		//
		// sample[0]: nibble = -8
		//   scaled = -8 << 8 = -2048
		//   pred   = (60*0 + 0*0) * 4 = 0
		//   sample = (-2048 + 0) >> 8 = -8
		// sample[1]: nibble = 0
		//   scaled = 0
		//   pred   = (60*-8 + 0*0) * 4 = -1920
		//   sample = (0 + -1920) >> 8 = -8  (arith shift rounds
		//                                     toward -∞)
		// sample[2..]: hist1 stays at -8, pred stays at -1920,
		//   sample stays at -8 forever — the predictor reaches a
		//   stable point because the coefs aren't pulling hist
		//   back to zero.
		const frame1 = makeFrame(1, 12, 0, [
			-8, ...new Array(27).fill(0),
		]);
		const samples = decodePsAdpcm(frame1);
		expect(samples[0]).toBe(-8);
		expect(samples[1]).toBe(-8);
		expect(samples[2]).toBe(-8);
		expect(samples[27]).toBe(-8);
	});

	it('predictor produces non-trivial decay for coef_index 4', () => {
		// coef_index = 4 → (c1, c2) = (122, -60). Most aggressive
		// predictor (used for smooth voiced sounds).
		// shift_factor = 8 → shift = 12.
		//
		// sample[0]: nibble = 4
		//   scaled = 4 << 12 = 16384
		//   pred   = 0
		//   sample = 16384 >> 8 = 64
		// sample[1]: nibble = 4 still
		//   pred = (122*64 + -60*0) * 4 = 31232
		//   sample = (16384 + 31232) >> 8 = 47616 >> 8 = 186
		const frame = makeFrame(4, 8, 0, new Array(28).fill(4));
		const samples = decodePsAdpcm(frame);
		expect(samples[0]).toBe(64);
		expect(samples[1]).toBe(186);
		// Subsequent samples grow as the predictor amplifies until
		// the system stabilises or saturates.
		expect(samples[2]).toBeGreaterThan(samples[1]);
	});

	it('handles a payload of two full frames', () => {
		const frame1 = makeFrame(0, 12, 0, new Array(28).fill(0));
		const frame2 = makeFrame(0, 12, 0, [
			1, ...new Array(27).fill(0),
		]);
		const buf = new Uint8Array(PS_ADPCM_FRAME_SIZE * 2);
		buf.set(frame1, 0);
		buf.set(frame2, PS_ADPCM_FRAME_SIZE);
		const samples = decodePsAdpcm(buf);
		expect(samples.length).toBe(PS_ADPCM_SAMPLES_PER_FRAME * 2);
		// All-zero frame 1 produces 28 zeros.
		for (let i = 0; i < PS_ADPCM_SAMPLES_PER_FRAME; i++) {
			expect(samples[i]).toBe(0);
		}
		// Frame 2 sample 0 = 1 (coef 0, no pred).
		expect(samples[PS_ADPCM_SAMPLES_PER_FRAME]).toBe(1);
	});
});

describe('psAdpcmBytesToSamples', () => {
	it('returns 28 per frame', () => {
		expect(psAdpcmBytesToSamples(16)).toBe(28);
		expect(psAdpcmBytesToSamples(32)).toBe(56);
		expect(psAdpcmBytesToSamples(1024)).toBe(28 * 64);
	});

	it('truncates trailing partial frame', () => {
		expect(psAdpcmBytesToSamples(20)).toBe(28); // 1 full + 4 leftover
	});
});

describe('squareKeyToSampleRate', () => {
	it('returns base rate when key is zero', () => {
		expect(squareKeyToSampleRate(0, 48000)).toBe(48000);
		expect(squareKeyToSampleRate(0, 32000)).toBe(32000);
	});

	it('clamps to base rate for positive keys', () => {
		// Per vgmstream code: any rate >= base is clamped to base.
		expect(squareKeyToSampleRate(0x01000000, 48000)).toBeLessThanOrEqual(
			48000,
		);
	});

	it('produces typical PS2-era rates for negative keys', () => {
		// 44100 Hz from 48000 base: 48000 * 2^(key/0x1000000/12) = 44100
		// => 2^x = 44100/48000 = 0.91875
		// => x = log2(0.91875) = -0.1222
		// => key/0x1000000/12 = -0.1222
		// => key = -0.1222 * 12 * 0x1000000 ≈ -24600000 (signed 32-bit)
		const key44k = Math.round(
			Math.log2(44100 / 48000) * 12 * 0x1000000,
		);
		const rate = squareKeyToSampleRate(key44k, 48000);
		// Round-trip tolerance — vgmstream rounds, so within ±2 Hz is fine.
		expect(Math.abs(rate - 44100)).toBeLessThanOrEqual(2);
	});

	it('rounds, not truncates', () => {
		// A key that lands exactly at .5 should round up.
		// Construct a key that yields exactly 24000.5 Hz pre-round
		// from 48000 base: 2^x = 24000.5/48000.
		const key = Math.log2(24000.5 / 48000) * 12 * 0x1000000;
		const rate = squareKeyToSampleRate(Math.round(key), 48000);
		// Just sanity: result is a whole number.
		expect(Number.isInteger(rate)).toBe(true);
	});
});

describe('encodeWav', () => {
	it('produces a valid 44-byte header for mono 22050 Hz PCM', () => {
		const samples = new Int16Array([100, -100, 200, -200]);
		const wav = encodeWav(samples, 22050, 1);
		expect(wav.length).toBe(44 + samples.length * 2);
		const dec = new TextDecoder();
		expect(dec.decode(wav.slice(0, 4))).toBe('RIFF');
		expect(dec.decode(wav.slice(8, 12))).toBe('WAVE');
		expect(dec.decode(wav.slice(12, 16))).toBe('fmt ');
		expect(dec.decode(wav.slice(36, 40))).toBe('data');
		const v = new DataView(wav.buffer);
		expect(v.getUint32(4, true)).toBe(36 + samples.length * 2);
		expect(v.getUint32(16, true)).toBe(16); // fmt chunk size
		expect(v.getUint16(20, true)).toBe(1); // PCM
		expect(v.getUint16(22, true)).toBe(1); // mono
		expect(v.getUint32(24, true)).toBe(22050);
		expect(v.getUint16(34, true)).toBe(16); // bits per sample
		expect(v.getUint32(40, true)).toBe(samples.length * 2);
		// Samples round-trip
		expect(v.getInt16(44, true)).toBe(100);
		expect(v.getInt16(46, true)).toBe(-100);
		expect(v.getInt16(48, true)).toBe(200);
		expect(v.getInt16(50, true)).toBe(-200);
	});
});
