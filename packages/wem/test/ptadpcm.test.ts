import { describe, expect, it } from 'vitest';

import { decodePtadpcm, ptadpcmSampleCount } from '../src/index.js';

describe('PTADPCM', () => {
	it('outputs the header history then predicts from it', () => {
		// One 0x24-byte mono frame: hist2 = 100, hist1 = 110, index 0,
		// then all nibbles 7 (step 0): a straight line continuing +10/sample.
		const f = new Uint8Array(0x24);
		new DataView(f.buffer).setInt16(0, 100, true);
		new DataView(f.buffer).setInt16(2, 110, true);
		f[4] = 0;
		f.fill(0x77, 5);
		const pcm = decodePtadpcm(f, 1, 0x24);
		expect(pcm.length).toBe(ptadpcmSampleCount(0x24, 1, 0x24));
		expect(pcm.length).toBe(64);
		expect([...pcm.subarray(0, 5)]).toEqual([100, 110, 120, 130, 140]);
	});

	it('applies the step table and index updates', () => {
		const f = new Uint8Array(0x24);
		f[4] = 0;
		f[5] = 0x0f; // low nibble 15 (+14, index 2), then 0 at index 2 (−56, index 4)
		const pcm = decodePtadpcm(f, 1, 0x24);
		expect(pcm[2]).toBe(14);
		expect(pcm[3]).toBe(-56 + 2 * 14 - 0);
	});

	it('de-interleaves channels frame by frame', () => {
		const block = new Uint8Array(0x48);
		const dv = new DataView(block.buffer);
		dv.setInt16(0, 1, true);
		dv.setInt16(0x24, 2, true);
		const pcm = decodePtadpcm(block, 2, 0x48);
		expect(pcm[0]).toBe(1);
		expect(pcm[1]).toBe(2);
	});
});
