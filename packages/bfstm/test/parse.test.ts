import { describe, it, expect } from 'vitest';
import { isBfstmOrBfstp, parseBfstm, BFSTM_MAGIC, BFSTP_MAGIC } from '../src/index.js';

/**
 * BFSTM is too involved to hand-craft a complete fixture for in a
 * test (interleaved DATA, SEEK table, multiple cross-referenced
 * offset tables). Instead we lean on:
 *
 *   - magic-detection unit tests against synthetic 8-byte stubs;
 *   - a smoke test against a 64-byte header-only blob that proves
 *     the parser bails cleanly when the file is too small;
 *   - end-to-end decode validation in the app, where real BFSTMs
 *     are parsed and the resulting WAVs played in-browser.
 */

describe('isBfstmOrBfstp', () => {
	it('detects FSTM magic', async () => {
		const buf = new Uint8Array(8);
		buf.set([0x46, 0x53, 0x54, 0x4d]);
		expect(await isBfstmOrBfstp(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('detects FSTP magic', async () => {
		const buf = new Uint8Array(8);
		buf.set([0x46, 0x53, 0x54, 0x50]);
		expect(await isBfstmOrBfstp(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects unrelated magics', async () => {
		const buf = new Uint8Array([0x46, 0x57, 0x41, 0x56, 0, 0, 0, 0]); // FWAV
		expect(await isBfstmOrBfstp(new Blob([buf as BlobPart]))).toBe(false);
		expect(await isBfstmOrBfstp(new Blob([]))).toBe(false);
	});
});

describe('parseBfstm error paths', () => {
	it('throws on too-small blob', async () => {
		await expect(parseBfstm(new Blob([new Uint8Array(8)]))).rejects.toThrow(
			/too small/,
		);
	});
	it('throws on bad magic', async () => {
		const buf = new Uint8Array(0x40);
		await expect(parseBfstm(new Blob([buf as BlobPart]))).rejects.toThrow(
			/Bad BFSTM/,
		);
	});
	it('throws on bad BOM', async () => {
		const buf = new Uint8Array(0x40);
		buf.set([0x46, 0x53, 0x54, 0x4d]); // FSTM
		buf[4] = 0xaa;
		buf[5] = 0xbb;
		await expect(parseBfstm(new Blob([buf as BlobPart]))).rejects.toThrow(
			/byte-order mark/,
		);
	});
});

describe('exported magic constants', () => {
	it('match the on-disk magics', () => {
		expect(BFSTM_MAGIC).toBe('FSTM');
		expect(BFSTP_MAGIC).toBe('FSTP');
	});
});
