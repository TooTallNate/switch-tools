import { describe, it, expect } from 'vitest';
import { decodeBrr } from '../src/index.js';

const END = 0x01;
const LOOP = 0x02;

/** Build a BRR block header byte. */
function header(shift: number, filter: number, flags = 0): number {
	return ((shift & 0x0f) << 4) | ((filter & 3) << 2) | (flags & 3);
}

/** Pack 16 signed nibbles (-8..7) into 8 data bytes, high nibble first. */
function packNibbles(nibbles: number[]): number[] {
	if (nibbles.length !== 16) throw new Error('need exactly 16 nibbles');
	const out: number[] = [];
	for (let i = 0; i < 16; i += 2) {
		const hi = nibbles[i] & 0x0f;
		const lo = nibbles[i + 1] & 0x0f;
		out.push((hi << 4) | lo);
	}
	return out;
}

function block(
	shift: number,
	filter: number,
	nibbles: number[],
	flags = 0,
): number[] {
	return [header(shift, filter, flags), ...packNibbles(nibbles)];
}

describe('decodeBrr', () => {
	it('decodes a filter-0 block (shift 1 is identity)', () => {
		// With shift 1, s = (n << 1) >> 1 = n exactly.
		const nibbles = [0, 1, 2, 3, 4, 5, 6, 7, -8, -7, -6, -5, -4, -3, -2, -1];
		const bytes = new Uint8Array(block(1, 0, nibbles, END));
		const result = decodeBrr(bytes);
		expect(result.blocks).toBe(1);
		expect(result.ended).toBe(true);
		expect(result.loop).toBe(false);
		expect(Array.from(result.samples)).toEqual(nibbles);
	});

	it('decodes filter-0 with shift 0 (nibble >> 1)', () => {
		const nibbles = [0, 1, 2, 3, 4, 5, 6, 7, -8, -7, -6, -5, -4, -3, -2, -1];
		const bytes = new Uint8Array(block(0, 0, nibbles, END));
		const result = decodeBrr(bytes);
		// s = (n << 0) >> 1, arithmetic shift → floor(n / 2).
		expect(Array.from(result.samples)).toEqual(
			nibbles.map((n) => n >> 1),
		);
	});

	it('accumulates filter 1 as s += (p1 * 15) >> 4', () => {
		// All nibbles = 1, shift 8 → base contribution (1 << 8) >> 1 = 128.
		const nibbles = new Array<number>(16).fill(1);
		const bytes = new Uint8Array(block(8, 1, nibbles, END));
		const result = decodeBrr(bytes);
		// Hand-computed: s[i] = 128 + floor(s[i-1] * 15 / 16), s[-1] = 0.
		expect(Array.from(result.samples)).toEqual([
			128, 248, 360, 465, 563, 655, 742, 823, 899, 970, 1037, 1100,
			1159, 1214, 1266, 1314,
		]);
	});

	it('stops at the END flag by default', () => {
		const nibbles = new Array<number>(16).fill(1);
		const bytes = new Uint8Array([
			...block(1, 0, nibbles, END),
			...block(1, 0, nibbles),
		]);
		const result = decodeBrr(bytes);
		expect(result.blocks).toBe(1);
		expect(result.samples.length).toBe(16);
		expect(result.ended).toBe(true);

		const all = decodeBrr(bytes, { stopAtEnd: false });
		expect(all.blocks).toBe(2);
		expect(all.samples.length).toBe(32);
		expect(all.ended).toBe(true);
	});

	it('reports the LOOP flag', () => {
		const nibbles = new Array<number>(16).fill(0);
		const bytes = new Uint8Array([
			...block(0, 0, nibbles, LOOP),
			...block(0, 0, nibbles, END),
		]);
		const result = decodeBrr(bytes);
		expect(result.loop).toBe(true);
		expect(result.ended).toBe(true);
		expect(result.blocks).toBe(2);
	});

	it('clamps to 16-bit with shift 12 + filter-1 feedback', () => {
		// Positive runaway: nibble 7 at shift 12 → base 14336; filter 1
		// feedback pushes past 32767 by the 3rd sample.
		const pos = new Array<number>(16).fill(7);
		// Negative runaway in the second block.
		const neg = new Array<number>(16).fill(-8);
		const bytes = new Uint8Array([
			...block(12, 1, pos),
			...block(12, 1, neg, END),
		]);
		const result = decodeBrr(bytes);
		expect(result.samples[0]).toBe(14336);
		expect(result.samples[1]).toBe(27776);
		expect(result.samples[2]).toBe(32767);
		expect(result.samples[15]).toBe(32767);
		expect(result.samples[31]).toBe(-32768);
	});

	it('applies hardware behavior for invalid shift > 12', () => {
		// s = (n >> 3) << 11 → -2048 for negative nibbles, 0 otherwise.
		const nibbles = [0, 1, 7, -1, -8, 3, -4, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const bytes = new Uint8Array(block(13, 0, nibbles, END));
		const result = decodeBrr(bytes);
		expect(Array.from(result.samples.subarray(0, 7))).toEqual([
			0, 0, 0, -2048, -2048, 0, -2048,
		]);
	});

	it('ignores trailing partial blocks', () => {
		const nibbles = new Array<number>(16).fill(1);
		const bytes = new Uint8Array([
			...block(1, 0, nibbles),
			0x11,
			0x22, // 2 stray bytes — not a full block
		]);
		const result = decodeBrr(bytes);
		expect(result.blocks).toBe(1);
		expect(result.ended).toBe(false);
		expect(result.samples.length).toBe(16);
	});

	it('repeat decodes the input multiple times, carrying filter state', () => {
		// Two blocks, END on the second. repeat: 3 → 6 blocks / 96
		// samples total, each pass identical for filter 0 (state
		// carries but filter 0 ignores it).
		const nibbles = new Array<number>(16).fill(2);
		const bytes = new Uint8Array([
			...block(2, 0, nibbles),
			...block(2, 0, nibbles, END),
		]);
		const result = decodeBrr(bytes, { repeat: 3 });
		expect(result.blocks).toBe(6);
		expect(result.samples.length).toBe(96);
		expect(result.ended).toBe(true);
		// Every pass decodes the same values under filter 0.
		expect(result.samples[0]).toBe(result.samples[32]);
		expect(result.samples[31]).toBe(result.samples[95]);

		// With a filter-1 FIRST block, the carried p1 state makes
		// pass 2 differ from pass 1: pass 1 starts from p1 = 0,
		// pass 2 starts from p1 = the last sample of pass 1
		// (accumulating toward equilibrium, as a looping sample
		// would on hardware).
		const f1 = new Uint8Array(block(6, 1, nibbles, END));
		const once = decodeBrr(f1);
		const thrice = decodeBrr(f1, { repeat: 3 });
		expect(Array.from(thrice.samples.subarray(0, 16))).toEqual(
			Array.from(once.samples),
		);
		expect(thrice.samples[16]).not.toBe(thrice.samples[0]);
	});

	it('repeat stops each pass at the END flag', () => {
		const nibbles = new Array<number>(16).fill(2);
		// END on block 1 of 3 — blocks 2-3 are never decoded, in
		// any pass.
		const bytes = new Uint8Array([
			...block(2, 0, nibbles, END),
			...block(2, 0, nibbles),
			...block(2, 0, nibbles),
		]);
		const result = decodeBrr(bytes, { repeat: 4 });
		expect(result.blocks).toBe(4);
		expect(result.samples.length).toBe(64);
	});
});
