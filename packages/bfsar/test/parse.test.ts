import { describe, it, expect } from 'vitest';
import {
	BFSAR_MAGIC,
	STRG_MAGIC,
	INFO_MAGIC,
	FILE_MAGIC,
	isBfsar,
	parseBfsar,
	extForMagic,
} from '../src/index.js';

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts.
 *
 * The BFSAR format is large + nested (STRG / INFO / FILE blocks
 * with offset tables, info sub-tables for sounds / banks / wave
 * archives / groups, plus optional 3D and track sub-blocks). A
 * full synthetic builder would itself be ~300 lines of test
 * scaffolding. For now we cover only the entry points + error
 * paths; deeper structural coverage relies on the parser being
 * exercised end-to-end via the nx-archive app's manual workflow.
 */

describe('exported magic strings', () => {
	it('match the expected on-disk values', () => {
		expect(BFSAR_MAGIC).toBe('FSAR');
		expect(STRG_MAGIC).toBe('STRG');
		expect(INFO_MAGIC).toBe('INFO');
		expect(FILE_MAGIC).toBe('FILE');
	});
});

describe('isBfsar', () => {
	it('detects FSAR magic at offset 0', async () => {
		const ok = new Uint8Array([0x46, 0x53, 0x41, 0x52]); // "FSAR"
		expect(await isBfsar(new Blob([ok as BlobPart]))).toBe(true);
	});

	it('rejects non-BFSAR magics', async () => {
		expect(
			await isBfsar(new Blob([new Uint8Array([0x42, 0x41, 0x52, 0x53])])), // "BARS"
		).toBe(false);
		expect(await isBfsar(new Blob([new Uint8Array([0xff, 0xff, 0xff, 0xff])])))
			.toBe(false);
	});

	it('rejects empty / undersized blobs', async () => {
		expect(await isBfsar(new Blob([]))).toBe(false);
		expect(await isBfsar(new Blob([new Uint8Array([0x46, 0x53])]))).toBe(false);
	});
});

describe('parseBfsar error cases', () => {
	function buildHead(opts: {
		magic?: number[];
		bom?: number[];
		headerSize?: number;
		blockCount?: number;
	}): Uint8Array {
		const out = new Uint8Array(64);
		const dv = new DataView(out.buffer);
		out.set(opts.magic ?? [0x46, 0x53, 0x41, 0x52], 0);
		out.set(opts.bom ?? [0xff, 0xfe], 4); // LE BOM
		dv.setUint16(6, opts.headerSize ?? 0x40, true);
		dv.setUint32(8, 0x00020300, true); // version
		dv.setUint32(0x0c, 64, true); // file size
		dv.setUint16(0x10, opts.blockCount ?? 3, true);
		return out;
	}

	it('throws on bad magic', async () => {
		const bad = buildHead({ magic: [0x42, 0x41, 0x52, 0x53] }); // "BARS"
		await expect(parseBfsar(new Blob([bad as BlobPart]))).rejects.toThrow(
			/BFSAR magic/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseBfsar(new Blob([]))).rejects.toThrow(/too small/);
	});

	it('throws on bogus byte-order mark', async () => {
		const bad = buildHead({ bom: [0xaa, 0xbb] });
		await expect(parseBfsar(new Blob([bad as BlobPart]))).rejects.toThrow(
			/byte-order mark/,
		);
	});

	it('throws on implausible block count', async () => {
		const bad = buildHead({ blockCount: 99 });
		await expect(parseBfsar(new Blob([bad as BlobPart]))).rejects.toThrow(
			/block count/,
		);
	});

	it('throws on implausible header size', async () => {
		const bad = buildHead({ headerSize: 0xfff0 });
		await expect(parseBfsar(new Blob([bad as BlobPart]))).rejects.toThrow(
			/header size/,
		);
	});
});

describe('extForMagic', () => {
	it('maps known BFSAR inner magics to standard extensions', () => {
		expect(extForMagic('FSTM')).toBe('bfstm');
		expect(extForMagic('FWAV')).toBe('bfwav');
		expect(extForMagic('FSTP')).toBe('bfstp');
		expect(extForMagic('FWAR')).toBe('bfwar');
		expect(extForMagic('FBNK')).toBe('bfbnk');
		expect(extForMagic('FSEQ')).toBe('bfseq');
		expect(extForMagic('FGRP')).toBe('bfgrp');
		expect(extForMagic('FWSD')).toBe('bfwsd');
	});
	it("falls back to 'bin' for unknown magics", () => {
		expect(extForMagic(null)).toBe('bin');
		expect(extForMagic('XXXX')).toBe('bin');
	});
});
