import { describe, it, expect } from 'vitest';
import {
	isBfres,
	parseBfres,
	BFRES_MAGIC,
	extractGeometry,
	extractMaterials,
	extractSkeletons,
	extractAnimations,
	evaluateCurve,
	type BfresAnimCurve,
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

describe('extractMaterials', () => {
	// Same caveat as `extractGeometry`: synthesizing a full FMAT
	// record-by-record isn't worth it. Smoke tests for the error
	// paths only.
	it('returns [] for a header-only BFRES with no FMDLs', async () => {
		const buf = buildSmokeHeader();
		const mats = await extractMaterials(new Blob([buf as BlobPart]));
		expect(mats).toEqual([]);
	});

	it('rejects a Wii U BFRES', async () => {
		const buf = buildSmokeHeader();
		buf[4] = 0;
		await expect(
			extractMaterials(new Blob([buf as BlobPart])),
		).rejects.toThrow(/Wii U/);
	});
});

describe('extractSkeletons', () => {
	// Same caveat as the other extract* tests — full FSKL parsing is
	// exercised against real captured game data via Node debug
	// scripts. Smoke + error-path coverage here.
	it('returns [] for a header-only BFRES with no FMDLs', async () => {
		const buf = buildSmokeHeader();
		const skels = await extractSkeletons(new Blob([buf as BlobPart]));
		expect(skels).toEqual([]);
	});

	it('rejects a Wii U BFRES', async () => {
		const buf = buildSmokeHeader();
		buf[4] = 0;
		await expect(
			extractSkeletons(new Blob([buf as BlobPart])),
		).rejects.toThrow(/Wii U/);
	});

	it('rejects a too-small blob', async () => {
		await expect(extractSkeletons(new Blob([]))).rejects.toThrow(/too small/);
	});
});

describe('extractAnimations', () => {
	it('returns empty groups for a header-only BFRES', async () => {
		const buf = buildSmokeHeader();
		const a = await extractAnimations(new Blob([buf as BlobPart]));
		expect(a.skeletal).toEqual([]);
		expect(a.material).toEqual([]);
		expect(a.boneVis).toEqual([]);
		expect(a.shape).toEqual([]);
		expect(a.scene).toEqual([]);
	});

	it('rejects a Wii U BFRES', async () => {
		const buf = buildSmokeHeader();
		buf[4] = 0;
		await expect(
			extractAnimations(new Blob([buf as BlobPart])),
		).rejects.toThrow(/Wii U/);
	});

	it('rejects a too-small blob', async () => {
		await expect(extractAnimations(new Blob([]))).rejects.toThrow(/too small/);
	});
});

describe('evaluateCurve', () => {
	function makeCurve(partial: Partial<BfresAnimCurve>): BfresAnimCurve {
		return {
			animDataOffset: 0,
			curveType: 'linear',
			startFrame: 0,
			endFrame: 10,
			scale: 1,
			offset: 0,
			frames: new Float32Array([0, 5, 10]),
			keys: new Float32Array([0, 1, 5, 1, 10, 0]), // (val, delta) pairs
			preWrap: 'clamp',
			postWrap: 'clamp',
			...partial,
		};
	}

	it('linear interpolates within a segment', () => {
		const c = makeCurve({});
		expect(evaluateCurve(c, 0)).toBeCloseTo(0);
		expect(evaluateCurve(c, 2.5)).toBeCloseTo(2.5); // 0 + 0.5 * 5
		expect(evaluateCurve(c, 5)).toBeCloseTo(5);
		expect(evaluateCurve(c, 7.5)).toBeCloseTo(7.5); // 5 + 0.5 * 5
	});

	it('clamps out-of-range frames by default', () => {
		const c = makeCurve({});
		expect(evaluateCurve(c, -10)).toBeCloseTo(0); // clamp to startFrame
		expect(evaluateCurve(c, 100)).toBeCloseTo(10); // clamp to endFrame
	});

	it('cubic curves apply the Hermite polynomial across segments', () => {
		// keys = (P0, P1, P2, P3) per segment; the evaluator computes
		// `value(u) = P0 + u·P1 + u²·P2 + u³·P3` between frames
		// [0, 10].
		const c = makeCurve({
			curveType: 'cubic',
			frames: new Float32Array([0, 10]),
			// Two keys: first carries the polynomial; second is end-of-curve.
			// At u = 0 → 0; at u = 0.5 → 0 + 0.5 + 0.25*4 + 0.125*8 = 2.5;
			// at u = 1 → 0 + 1 + 4 + 8 = 13.
			keys: new Float32Array([0, 1, 4, 8, 13, 0, 0, 0]),
		});
		expect(evaluateCurve(c, 0)).toBeCloseTo(0);
		expect(evaluateCurve(c, 5)).toBeCloseTo(0 + 0.5 + 0.25 * 4 + 0.125 * 8);
		// At endFrame the search lands at the last key, which is P0=13.
		expect(evaluateCurve(c, 10)).toBeCloseTo(13);
	});

	it('post-wrap "repeat" wraps modulo (endFrame - startFrame)', () => {
		const c = makeCurve({ postWrap: 'repeat' });
		expect(evaluateCurve(c, 12.5)).toBeCloseTo(2.5); // 12.5 % 10 = 2.5
		expect(evaluateCurve(c, 25)).toBeCloseTo(5); // 25 % 10 = 5
	});

	it('returns offset for empty curves', () => {
		const c = makeCurve({
			frames: new Float32Array(0),
			keys: new Float32Array(0),
			offset: 7,
		});
		expect(evaluateCurve(c, 0)).toBe(7);
	});
});
