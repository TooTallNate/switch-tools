import { describe, it, expect } from 'vitest';
import {
	VADPCM_FRAME_SIZE,
	VADPCM_SAMPLES_PER_FRAME,
	bookByteLength,
	decodeAifc,
	decodeVadpcm,
	isAifc,
	parseAifc,
	parseVadpcmBook,
	type VadpcmBook,
} from '../src/index.js';

/** Serialise a codebook in the in-RAM layout (s32 order/count). */
function encodeBook(book: VadpcmBook): Uint8Array {
	const out = new Uint8Array(bookByteLength(book.order, book.npredictors));
	const s32 = (o: number, v: number) => {
		out[o] = (v >>> 24) & 0xff;
		out[o + 1] = (v >>> 16) & 0xff;
		out[o + 2] = (v >>> 8) & 0xff;
		out[o + 3] = v & 0xff;
	};
	s32(0, book.order);
	s32(4, book.npredictors);
	for (let i = 0; i < book.vectors.length; i++) {
		const v = book.vectors[i] < 0 ? book.vectors[i] + 0x10000 : book.vectors[i];
		out[8 + i * 2] = (v >>> 8) & 0xff;
		out[8 + i * 2 + 1] = v & 0xff;
	}
	return out;
}

/**
 * A codebook whose coefficients are all zero: the prediction term
 * vanishes, so each output sample is exactly `residual << scale`.
 * That makes the residual path testable in isolation.
 */
function zeroBook(order = 2, npredictors = 1): VadpcmBook {
	return {
		order,
		npredictors,
		vectors: new Int16Array(order * npredictors * 8),
	};
}

/** Build one frame from a scale, predictor index, and 16 residuals. */
function frame(
	scale: number,
	predictor: number,
	residuals: number[],
): number[] {
	const out = [((scale & 0xf) << 4) | (predictor & 0xf)];
	for (let i = 0; i < 8; i++) {
		const hi = residuals[i * 2] & 0xf;
		const lo = residuals[i * 2 + 1] & 0xf;
		out.push((hi << 4) | lo);
	}
	return out;
}

const ZEROS16 = new Array<number>(16).fill(0);

describe('parseVadpcmBook', () => {
	it('round-trips a codebook', () => {
		const book = zeroBook(2, 3);
		for (let i = 0; i < book.vectors.length; i++) {
			book.vectors[i] = i * 7 - 100;
		}
		const parsed = parseVadpcmBook(encodeBook(book))!;
		expect(parsed.order).toBe(2);
		expect(parsed.npredictors).toBe(3);
		expect(Array.from(parsed.vectors)).toEqual(Array.from(book.vectors));
	});

	it('computes byte length', () => {
		// 8-byte header + order * npredictors * 8 coefficients * 2 B.
		expect(bookByteLength(2, 1)).toBe(8 + 32);
		expect(bookByteLength(2, 4)).toBe(8 + 128);
	});

	it('reads negative coefficients', () => {
		const book = zeroBook(2, 1);
		book.vectors[0] = -32768;
		book.vectors[1] = -1;
		const parsed = parseVadpcmBook(encodeBook(book))!;
		expect(parsed.vectors[0]).toBe(-32768);
		expect(parsed.vectors[1]).toBe(-1);
	});

	it('rejects implausible shapes in strict mode', () => {
		const bad = new Uint8Array(64);
		// order = 0
		expect(parseVadpcmBook(bad)).toBeNull();
		// order = 99
		bad[3] = 99;
		expect(parseVadpcmBook(bad)).toBeNull();
		// order 2, npredictors 0
		bad[3] = 2;
		expect(parseVadpcmBook(bad)).toBeNull();
		// order 2, npredictors 17 (index is a nibble, so max 16)
		bad[7] = 17;
		expect(parseVadpcmBook(bad)).toBeNull();
	});

	it('rejects a truncated coefficient array', () => {
		const full = encodeBook(zeroBook(2, 4));
		expect(parseVadpcmBook(full.subarray(0, full.length - 2))).toBeNull();
	});

	it('reads at a non-zero offset', () => {
		const book = zeroBook(2, 1);
		book.vectors[5] = 1234;
		const encoded = encodeBook(book);
		const buf = new Uint8Array(16 + encoded.length);
		buf.set(encoded, 16);
		expect(parseVadpcmBook(buf, 16)!.vectors[5]).toBe(1234);
	});
});

describe('decodeVadpcm', () => {
	it('produces 16 samples per 9-byte frame', () => {
		const data = Uint8Array.from(frame(0, 0, ZEROS16));
		expect(data.length).toBe(VADPCM_FRAME_SIZE);
		const r = decodeVadpcm(data, zeroBook());
		expect(r.frames).toBe(1);
		expect(r.samples.length).toBe(VADPCM_SAMPLES_PER_FRAME);
	});

	it('with a zero codebook, output is residual << scale', () => {
		const residuals = [1, 2, 3, -1, -2, 7, -8, 0, 1, 1, 1, 1, 1, 1, 1, 1];
		const r = decodeVadpcm(
			Uint8Array.from(frame(3, 0, residuals)),
			zeroBook(),
		);
		expect(Array.from(r.samples.subarray(0, 8))).toEqual(
			residuals.slice(0, 8).map((v) => v << 3),
		);
	});

	it('sign-extends 4-bit residuals', () => {
		// Nibble 0x8 is -8, 0xF is -1.
		const r = decodeVadpcm(
			Uint8Array.from(frame(0, 0, [8, 15, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
			zeroBook(),
		);
		expect(r.samples[0]).toBe(-8);
		expect(r.samples[1]).toBe(-1);
		expect(r.samples[2]).toBe(7);
	});

	it('applies the prediction term from previous output', () => {
		// order 1 so exactly one history sample contributes. Set the
		// single coefficient to 2048 (= 1.0 in Q11), so each sample
		// becomes previousSample + residual.
		const book: VadpcmBook = {
			order: 1,
			npredictors: 1,
			vectors: new Int16Array(8).fill(2048),
		};
		// First frame establishes a value; second sees it as history.
		const data = Uint8Array.from([
			...frame(0, 0, [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
			...frame(0, 0, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		]);
		const r = decodeVadpcm(data, book);
		// Vector 1: residual 5 then zeros; with coefficient 1.0 the
		// zeros inherit... the accumulator, so all 8 samples are 5.
		expect(r.samples[0]).toBe(5);
		// Second frame's first vector starts from state = 5.
		expect(r.samples[16]).toBeGreaterThan(0);
	});

	it('carries decoder state across frames', () => {
		const book: VadpcmBook = {
			order: 1,
			npredictors: 1,
			vectors: new Int16Array(8).fill(2048),
		};
		const one = Uint8Array.from(
			frame(0, 0, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		);
		const fresh = decodeVadpcm(one, book);
		const resumed = decodeVadpcm(one, book, {
			state: Int16Array.from([0, 0, 0, 0, 0, 0, 0, 100]),
		});
		// Same bits, different starting state → different output.
		expect(resumed.samples[0]).not.toBe(fresh.samples[0]);
		expect(fresh.state.length).toBe(8);
	});

	it('selects predictors by the header nibble', () => {
		// Two predictors: index 0 is silent, index 1 doubles history.
		const book: VadpcmBook = {
			order: 1,
			npredictors: 2,
			vectors: new Int16Array(16),
		};
		book.vectors.fill(0, 0, 8); // predictor 0
		book.vectors.fill(2048, 8, 16); // predictor 1
		// The history sample the predictor multiplies is state[7] —
		// the LAST sample of the previous vector — so the priming
		// frame has to end non-zero.
		const priming = frame(0, 0, new Array(16).fill(4));
		const withP0 = decodeVadpcm(
			Uint8Array.from([...priming, ...frame(0, 0, ZEROS16)]),
			book,
		);
		const withP1 = decodeVadpcm(
			Uint8Array.from([...priming, ...frame(0, 1, ZEROS16)]),
			book,
		);
		// Predictor 0 predicts nothing, so the tail decays to zero;
		// predictor 1 sustains the previous sample.
		expect(withP0.samples[16]).toBe(0);
		expect(withP1.samples[16]).not.toBe(0);
	});

	it('clamps to 16 bits and reports the count', () => {
		// A zero codebook tops out at 7 << 12 = 28672, inside int16.
		// Sustaining the previous sample (coefficient 1.0 in Q11) and
		// adding a big residual each step runs it past the ceiling.
		const book: VadpcmBook = {
			order: 1,
			npredictors: 1,
			vectors: new Int16Array(8).fill(2048),
		};
		const r = decodeVadpcm(
			Uint8Array.from(frame(12, 0, new Array(16).fill(7))),
			book,
		);
		expect(r.clamped).toBeGreaterThan(0);
		expect(r.samples[r.samples.length - 1]).toBe(32767);
	});

	it('ignores a trailing partial frame', () => {
		const data = Uint8Array.from([...frame(0, 0, ZEROS16), 0x11, 0x22]);
		const r = decodeVadpcm(data, zeroBook());
		expect(r.frames).toBe(1);
		expect(r.samples.length).toBe(16);
	});

	it('honours the frames option', () => {
		const data = Uint8Array.from([
			...frame(0, 0, ZEROS16),
			...frame(0, 0, ZEROS16),
			...frame(0, 0, ZEROS16),
		]);
		expect(decodeVadpcm(data, zeroBook(), { frames: 2 }).frames).toBe(2);
		// Asking for more than exist is capped, not an error.
		expect(decodeVadpcm(data, zeroBook(), { frames: 99 }).frames).toBe(3);
	});

	it('does not read outside the codebook for an out-of-range predictor', () => {
		// Header claims predictor 15 but the book has only 1.
		const r = decodeVadpcm(
			Uint8Array.from(frame(0, 15, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
			zeroBook(2, 1),
		);
		expect(Number.isFinite(r.samples[0])).toBe(true);
		expect(r.samples[0]).toBe(2);
	});

	it('handles an empty input', () => {
		const r = decodeVadpcm(new Uint8Array(0), zeroBook());
		expect(r.frames).toBe(0);
		expect(r.samples.length).toBe(0);
	});

	it('does not overflow int32 when accumulating', () => {
		// Extreme coefficients against extreme history: eight
		// products of ~2^30 would wrap if the accumulator were
		// coerced to int32.
		const book: VadpcmBook = {
			order: 2,
			npredictors: 1,
			vectors: new Int16Array(16).fill(-32768),
		};
		const r = decodeVadpcm(
			Uint8Array.from([
				...frame(12, 0, new Array(16).fill(7)),
				...frame(12, 0, new Array(16).fill(7)),
			]),
			book,
		);
		// Every sample must remain a valid int16.
		for (const s of r.samples) {
			expect(s).toBeGreaterThanOrEqual(-32768);
			expect(s).toBeLessThanOrEqual(32767);
		}
	});
});

describe('AIFC container', () => {
	/** Build a minimal AIFC with COMM, VADPCMCODES and SSND. */
	function makeAifc(book: VadpcmBook, audio: Uint8Array): Uint8Array {
		const parts: number[] = [];
		const push32 = (v: number) =>
			parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
		const push16 = (v: number) => parts.push((v >>> 8) & 0xff, v & 0xff);
		const pushTag = (s: string) => {
			for (const ch of s) parts.push(ch.charCodeAt(0));
		};

		// COMM: channels, frames, bits, 80-bit rate, compression.
		pushTag('COMM');
		push32(22 + 2);
		push16(1);
		push32((audio.length / VADPCM_FRAME_SIZE) * VADPCM_SAMPLES_PER_FRAME);
		push16(16);
		// 32000 Hz as an 80-bit extended float. The mantissa carries
		// an explicit integer bit, so value = mantissa * 2^(exp-16383-63).
		// 0xFA00_0000_0000_0000 = 250 * 2^56, and
		// 250 * 2^56 * 2^(16397-16446) = 32000.
		push16(16397);
		parts.push(0xfa, 0x00, 0, 0, 0, 0, 0, 0);
		pushTag('VAPC');
		push16(0); // pad to even

		// APPL/stoc/VADPCMCODES
		const name = 'VADPCMCODES';
		const bookBytes = book.vectors.length * 2;
		pushTag('APPL');
		push32(4 + 1 + name.length + 6 + bookBytes);
		pushTag('stoc');
		parts.push(name.length);
		pushTag(name);
		push16(1); // version
		push16(book.order);
		push16(book.npredictors);
		for (let i = 0; i < book.vectors.length; i++) {
			const v =
				book.vectors[i] < 0 ? book.vectors[i] + 0x10000 : book.vectors[i];
			push16(v);
		}

		// SSND
		pushTag('SSND');
		push32(8 + audio.length);
		push32(0);
		push32(0);
		for (const b of audio) parts.push(b);

		const body = Uint8Array.from(parts);
		const out = new Uint8Array(12 + body.length);
		out.set([0x46, 0x4f, 0x52, 0x4d], 0); // FORM
		const size = 4 + body.length;
		out[4] = (size >>> 24) & 0xff;
		out[5] = (size >>> 16) & 0xff;
		out[6] = (size >>> 8) & 0xff;
		out[7] = size & 0xff;
		out.set([0x41, 0x49, 0x46, 0x43], 8); // AIFC
		out.set(body, 12);
		return out;
	}

	it('detects the signature', () => {
		expect(isAifc(makeAifc(zeroBook(), new Uint8Array(9)))).toBe(true);
		expect(isAifc(Uint8Array.from([1, 2, 3, 4]))).toBe(false);
		expect(isAifc(new Uint8Array(32))).toBe(false);
	});

	it('parses COMM, the codebook and the audio payload', () => {
		const book = zeroBook(2, 2);
		book.vectors[0] = 1000;
		book.vectors[31] = -1000;
		const audio = Uint8Array.from([
			...frame(2, 0, [1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		]);
		const file = parseAifc(makeAifc(book, audio));
		expect(file.channels).toBe(1);
		expect(file.sampleRate).toBe(32000);
		expect(file.compressionType).toBe('VAPC');
		expect(file.book).not.toBeNull();
		expect(file.book!.order).toBe(2);
		expect(file.book!.npredictors).toBe(2);
		expect(file.book!.vectors[0]).toBe(1000);
		expect(file.book!.vectors[31]).toBe(-1000);
		expect(file.audioData.length).toBe(audio.length);
	});

	it('decodes end to end', () => {
		const audio = Uint8Array.from(
			frame(1, 0, [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]),
		);
		const result = decodeAifc(parseAifc(makeAifc(zeroBook(), audio)));
		expect(result.samples.length).toBe(16);
		expect(result.samples[0]).toBe(4); // 2 << 1
	});

	it('throws when the codebook chunk is missing', () => {
		const withBook = makeAifc(zeroBook(), new Uint8Array(9));
		// Corrupt the APPL chunk's name so it is skipped as unknown.
		// Search for the full string: a bare 0x56 scan would hit the
		// COMM chunk's 'VAPC' compression tag first.
		const needle = 'VADPCMCODES';
		let idx = -1;
		for (let i = 0; i + needle.length <= withBook.length; i++) {
			let match = true;
			for (let j = 0; j < needle.length; j++) {
				if (withBook[i + j] !== needle.charCodeAt(j)) {
					match = false;
					break;
				}
			}
			if (match) {
				idx = i;
				break;
			}
		}
		expect(idx).toBeGreaterThan(0);
		withBook[idx] = 0x58; // 'X'
		const file = parseAifc(withBook);
		expect(file.book).toBeNull();
		expect(() => decodeAifc(file)).toThrow(/codebook/i);
	});

	it('rejects a non-AIFC buffer', () => {
		expect(() => parseAifc(new Uint8Array(32))).toThrow(/signature/i);
	});
});
