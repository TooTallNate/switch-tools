import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Mpeg1VideoDecoder, tmpgencDcPrecision } from '../src/index.js';

// A synthetic clip (FFmpeg `testsrc`, 32×32, 7 frames as I P B B I B B),
// and FFmpeg's own decode of it as planar YUV 4:2:0.
const es = new Uint8Array(readFileSync(new URL('./fixtures/testsrc-32x32.m1v', import.meta.url)));
const ref = new Uint8Array(readFileSync(new URL('./fixtures/testsrc-32x32.yuv', import.meta.url)));

describe('Mpeg1VideoDecoder', () => {
	it('decodes I, P and B pictures in display order, matching FFmpeg', () => {
		const dec = new Mpeg1VideoDecoder(es);
		expect(dec.info).toEqual({ width: 32, height: 32, frameRate: 30 });
		const frameSize = 32 * 32 * 1.5;
		let n = 0;
		for (let f; (f = dec.decode()); n++) {
			let se = 0;
			for (let i = 0; i < 32 * 32; i++) se += (f.y[i]! - ref[n * frameSize + i]!) ** 2;
			// Only IDCT rounding differs: well above 35 dB PSNR.
			expect(10 * Math.log10((255 * 255) / Math.max(se / 1024, 1e-9))).toBeGreaterThan(35);
		}
		expect(n).toBe(7);
	});

	it('reads TMPGEnc intra DC precision from user data', () => {
		const text = (s: string) => new TextEncoder().encode(s);
		expect(tmpgencDcPrecision(text('TMPGEXS\0IDCPREC\x000000000800000003TMPGEXE\0'))).toBe(3);
		expect(tmpgencDcPrecision(text('TMPGEXS\0'))).toBe(3);
		expect(tmpgencDcPrecision(es)).toBe(0);
	});
});
