import { describe, it, expect } from 'vitest';
import {
	isBfres,
	parseBfres,
	BFRES_MAGIC,
	extractGeometry,
} from '../src/index.js';

/**
 * BFRES is a 600+ field format that's hard to fully synthesise in
 * a test. We validate:
 *
 *   - the cheap magic / Switch-padding sniff,
 *   - error paths for non-Switch / too-small inputs,
 *   - and (where samples are available) integration against real
 *     captured BFRES files. The smoke test below uses a 64-byte
 *     "FRES + spaces" header with everything else zero, which
 *     exercises the header-decoding path without requiring a real
 *     dict / model walk.
 */

function buildSmokeHeader(versionRaw = 0x00050003) {
	const buf = new Uint8Array(0x100);
	const enc = new TextEncoder();
	const v = new DataView(buf.buffer);
	buf.set(enc.encode('FRES'), 0);
	buf[4] = 0x20;
	buf[5] = 0x20;
	buf[6] = 0x20;
	buf[7] = 0x20;
	v.setUint32(0x08, versionRaw, true);
	// BOM bytes "FF FE"
	buf[0x0c] = 0xff;
	buf[0x0d] = 0xfe;
	buf[0x0e] = 0x0c; // alignment exponent
	return buf;
}

describe('isBfres', () => {
	it('detects "FRES" magic', async () => {
		const buf = buildSmokeHeader();
		expect(await isBfres(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects unrelated blobs', async () => {
		expect(await isBfres(new Blob([new Uint8Array([0x46, 0x53, 0x41, 0x52])]))).toBe(false);
		expect(await isBfres(new Blob([]))).toBe(false);
	});
});

describe('parseBfres — error paths', () => {
	it('throws on Wii U BFRES (non-space padding at offset 4)', async () => {
		const buf = buildSmokeHeader();
		buf[4] = 0x00;
		await expect(parseBfres(new Blob([buf as BlobPart]))).rejects.toThrow(
			/non-Switch padding/,
		);
	});

	it('throws on bogus BOM', async () => {
		const buf = buildSmokeHeader();
		buf[0x0c] = 0xaa;
		buf[0x0d] = 0xbb;
		await expect(parseBfres(new Blob([buf as BlobPart]))).rejects.toThrow(
			/BOM/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseBfres(new Blob([]))).rejects.toThrow(/too small/);
	});
});

describe('parseBfres — smoke header', () => {
	it('parses an empty / dict-less Switch BFRES header', async () => {
		const buf = buildSmokeHeader();
		const parsed = await parseBfres(new Blob([buf as BlobPart]));
		expect(parsed.version.major).toBe(5);
		expect(parsed.version.minor).toBe(0);
		expect(parsed.version.patch).toBe(3);
		expect(parsed.models).toHaveLength(0);
		expect(parsed.externalFiles).toHaveLength(0);
		expect(parsed.embeddedBntx).toBeNull();
		// All five animation groups should be present, all empty.
		expect(parsed.animationGroups).toHaveLength(5);
		for (const g of parsed.animationGroups) {
			expect(g.names).toHaveLength(0);
		}
	});
});

describe('BFRES_MAGIC export', () => {
	it('matches the on-disk value', () => {
		expect(BFRES_MAGIC).toBe('FRES');
	});
});

describe('extractGeometry', () => {
	// We can't reasonably synthesize a full BFRES with valid FMDL +
	// FSHP + FVTX records (the format has hundreds of fields with
	// cross-references), so these are smoke tests for the error
	// paths. Real geometry is exercised end-to-end via the Node
	// debug script `dump-bfres-mesh.mjs` against captured game data.
	it('returns [] for a header-only BFRES with no FMDLs', async () => {
		const buf = buildSmokeHeader();
		const geoms = await extractGeometry(new Blob([buf as BlobPart]));
		expect(geoms).toEqual([]);
	});

	it('rejects a Wii U BFRES (non-space padding at offset 4)', async () => {
		const buf = buildSmokeHeader();
		buf[4] = 0;
		await expect(
			extractGeometry(new Blob([buf as BlobPart])),
		).rejects.toThrow(/Wii U/);
	});

	it('rejects a too-small blob', async () => {
		await expect(extractGeometry(new Blob([]))).rejects.toThrow(/too small/);
	});

	it('rejects a too-old version (< v5)', async () => {
		const buf = buildSmokeHeader(0x00040003);
		await expect(
			extractGeometry(new Blob([buf as BlobPart])),
		).rejects.toThrow(/too old/);
	});
});
