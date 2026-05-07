import { describe, it, expect } from 'vitest';
import { isBarslist, parseBarslist, BARSLIST_MAGIC } from '../src/index.js';

/**
 * Tests use real BARSLIST files captured from Mario Kart 8 Deluxe.
 * They're tiny (under 200 bytes each), so we inline them as
 * Uint8Array literals rather than as base64.
 */

// Mario Kart 8 Deluxe — `Audio/Ground/Ground_Animal.barslist`.
// Single-entry list: name "Ground_Animal", resource "Ground_Animal.bars".
const SAMPLE_GROUND_ANIMAL = new Uint8Array([
	0x41, 0x52, 0x53, 0x4c, 0xff, 0xfe, 0x01, 0x00, // ARSL, BOM-LE, version 1
	0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // name_offset=0, count=1
	0x0e, 0x00, 0x00, 0x00, // resource_offset[0] = 0x0e
	// base = 0x10 + 1*4 = 0x14
	// name (offset 0): "Ground_Animal\0"
	0x47, 0x72, 0x6f, 0x75, 0x6e, 0x64, 0x5f, 0x41, 0x6e, 0x69, 0x6d, 0x61, 0x6c, 0x00,
	// resource[0] (offset 0x0e): "Ground_Animal.bars\0"
	0x47, 0x72, 0x6f, 0x75, 0x6e, 0x64, 0x5f, 0x41, 0x6e, 0x69, 0x6d, 0x61, 0x6c, 0x2e,
	0x62, 0x61, 0x72, 0x73, 0x00,
]);

// Mario Kart 8 Deluxe — `Course/Du_Animal_Autumn/Course_Du_Animal_Autumn.barslist`.
// Three resources sharing a single name.
const SAMPLE_COURSE_AUTUMN = new Uint8Array([
	0x41, 0x52, 0x53, 0x4c, 0xff, 0xfe, 0x01, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
	// resource_offset[0..2] = 0x18, 0x35, 0x4b
	0x18, 0x00, 0x00, 0x00, 0x35, 0x00, 0x00, 0x00, 0x4b, 0x00, 0x00, 0x00,
	// base = 0x1c
	// name (offset 0): "Course_Du_Animal_Autumn\0"  (24 chars + NUL = 24 bytes)
	0x43, 0x6f, 0x75, 0x72, 0x73, 0x65, 0x5f, 0x44, 0x75, 0x5f, 0x41, 0x6e, 0x69, 0x6d, 0x61, 0x6c,
	0x5f, 0x41, 0x75, 0x74, 0x75, 0x6d, 0x6e, 0x00,
	// resource[0] (base+0x18 = 0x34): "Course_Du_Animal_Autumn.bars\0"
	0x43, 0x6f, 0x75, 0x72, 0x73, 0x65, 0x5f, 0x44, 0x75, 0x5f, 0x41, 0x6e, 0x69, 0x6d, 0x61, 0x6c,
	0x5f, 0x41, 0x75, 0x74, 0x75, 0x6d, 0x6e, 0x2e, 0x62, 0x61, 0x72, 0x73, 0x00,
	// resource[1] (base+0x35 = 0x51): "Course_Du_Animal.bars\0"
	0x43, 0x6f, 0x75, 0x72, 0x73, 0x65, 0x5f, 0x44, 0x75, 0x5f, 0x41, 0x6e, 0x69, 0x6d, 0x61, 0x6c,
	0x2e, 0x62, 0x61, 0x72, 0x73, 0x00,
	// resource[2] (base+0x4b = 0x67): "Course.bars\0"
	0x43, 0x6f, 0x75, 0x72, 0x73, 0x65, 0x2e, 0x62, 0x61, 0x72, 0x73, 0x00,
]);

describe('isBarslist', () => {
	it('detects the magic', async () => {
		expect(await isBarslist(new Blob([SAMPLE_GROUND_ANIMAL as BlobPart]))).toBe(
			true,
		);
	});
	it('rejects non-ARSL blobs', async () => {
		expect(
			await isBarslist(new Blob([new Uint8Array([0x42, 0x41, 0x52, 0x53])])),
		).toBe(false);
		expect(await isBarslist(new Blob([]))).toBe(false);
	});
});

describe('parseBarslist', () => {
	it('parses a single-entry archive', async () => {
		const parsed = await parseBarslist(
			new Blob([SAMPLE_GROUND_ANIMAL as BlobPart]),
		);
		expect(parsed.endian).toBe('little');
		expect(parsed.version).toBe(1);
		expect(parsed.name).toBe('Ground_Animal');
		expect(parsed.resources).toEqual(['Ground_Animal.bars']);
	});

	it('parses a multi-entry archive sharing one name', async () => {
		const parsed = await parseBarslist(
			new Blob([SAMPLE_COURSE_AUTUMN as BlobPart]),
		);
		expect(parsed.name).toBe('Course_Du_Animal_Autumn');
		expect(parsed.resources).toEqual([
			'Course_Du_Animal_Autumn.bars',
			'Course_Du_Animal.bars',
			'Course.bars',
		]);
	});

	it('throws on bad magic', async () => {
		const buf = new Uint8Array(0x20);
		await expect(parseBarslist(new Blob([buf as BlobPart]))).rejects.toThrow(
			/BARSLIST magic/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseBarslist(new Blob([]))).rejects.toThrow(/too small/);
	});

	it('throws on bogus BOM', async () => {
		const buf = SAMPLE_GROUND_ANIMAL.slice();
		buf[4] = 0xaa;
		buf[5] = 0xbb;
		await expect(parseBarslist(new Blob([buf as BlobPart]))).rejects.toThrow(
			/byte-order mark/,
		);
	});

	it('throws on unsupported version', async () => {
		const buf = SAMPLE_GROUND_ANIMAL.slice();
		buf[6] = 0x02; // version 2
		await expect(parseBarslist(new Blob([buf as BlobPart]))).rejects.toThrow(
			/version/,
		);
	});
});

describe('BARSLIST_MAGIC export', () => {
	it('matches the on-disk value', () => {
		expect(BARSLIST_MAGIC).toBe('ARSL');
	});
});
