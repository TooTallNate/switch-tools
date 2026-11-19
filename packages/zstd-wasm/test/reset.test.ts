import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compressBytes, ZstdDecoder } from '../src/index.js';

const wasm = readFileSync(new URL('../src/zstd.wasm', import.meta.url));

describe('ZstdDecoder.reset', () => {
	it('decodes many frames with one decoder, recovering from a truncated one', async () => {
		const a = new TextEncoder().encode('hello hello hello'.repeat(50));
		const frame = await compressBytes(wasm, a);
		const dec = await ZstdDecoder.create(wasm);
		dec.decode(frame.subarray(0, frame.length >> 1));
		dec.reset();
		for (let i = 0; i < 3; i++) {
			expect(dec.decode(frame)).toEqual(a);
			dec.reset();
		}
		dec.dispose();
	});
});
