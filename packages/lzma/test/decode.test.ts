import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeLzma, decodeLzmaAlone, parseLzmaProperties } from '../src/index.js';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url)));

describe('LZMA', () => {
	const expected = fixture('fixture.bin');

	it('decodes a .lzma stream (python lzma, lc=3 lp=0 pb=2)', () => {
		expect(Buffer.from(decodeLzmaAlone(fixture('fixture.lzma'), 1 << 20)).equals(Buffer.from(expected))).toBe(true);
	});

	it('decodes with non-default lc/lp/pb', () => {
		const out = decodeLzmaAlone(fixture('fixture-lp2.lzma'), 1 << 20);
		expect(Buffer.from(out).equals(Buffer.from(expected.subarray(0, 5000)))).toBe(true);
	});

	it('decodes a raw props+stream block (Unity bundle layout) to a known size', () => {
		const alone = fixture('fixture.lzma');
		const block = new Uint8Array(alone.length - 8);
		block.set(alone.subarray(0, 5));
		block.set(alone.subarray(13), 5);
		expect(decodeLzma(block, 1000)).toEqual(expected.subarray(0, 1000));
	});

	it('parses properties', () => {
		expect(parseLzmaProperties(new Uint8Array([0x5d, 0, 0, 0x10, 0]))).toEqual({ lc: 3, lp: 0, pb: 2, dictSize: 0x100000 });
	});

	it('rejects garbage', () => {
		expect(() => decodeLzma(new Uint8Array([0x5d, 0, 0, 1, 0, 9, 9, 9, 9, 9]), 10)).toThrow();
	});
});
