import { describe, it, expect } from 'vitest';
import { isBarslist, parseBarslist, BARSLIST_MAGIC } from '../src/index.js';

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts.
 *
 * The BARSLIST format ("ARSL") is a tiny manifest mapping a single
 * archive name to a list of resource paths. Layout:
 *
 *   "ARSL" magic           (4 bytes)
 *   BOM-LE / BOM-BE        (2 bytes)
 *   version                (2 bytes, always 1)
 *   name_offset            (u32, currently always 0)
 *   resource_count         (u32)
 *   resource_offsets[]     (u32 × count)
 *   ── base = 0x10 + count*4 ──
 *   archive name           (NUL-terminated UTF-8 at offset 0)
 *   resource[i]            (NUL-terminated UTF-8 at offset resource_offsets[i])
 */

/** Build a synthetic BARSLIST with the given archive name + resources. */
function buildBarslist(name: string, resources: string[], version = 1): Uint8Array {
	const enc = new TextEncoder();
	const nameBytes = enc.encode(name + '\0');
	const resourceBytesArr = resources.map((r) => enc.encode(r + '\0'));

	// Layout:
	//   header (16 bytes) + offsets table (count * 4) + name bytes + resource bytes...
	const offsetsCount = resources.length;
	const stringsAreaStart = 0x10 + offsetsCount * 4;
	const nameOffset = 0; // always 0 for v1
	// Name is at base; resources are concatenated after the name.
	const resourceOffsets: number[] = [];
	let cursor = nameBytes.length;
	for (const rb of resourceBytesArr) {
		resourceOffsets.push(cursor);
		cursor += rb.length;
	}
	const totalStringsLen = cursor;

	const out = new Uint8Array(stringsAreaStart + totalStringsLen);
	const dv = new DataView(out.buffer);
	out.set([0x41, 0x52, 0x53, 0x4c], 0); // "ARSL"
	out.set([0xff, 0xfe], 4); // BOM-LE
	dv.setUint16(6, version, true);
	dv.setUint32(8, nameOffset, true);
	dv.setUint32(0x0c, offsetsCount, true);
	for (let i = 0; i < offsetsCount; i++) {
		dv.setUint32(0x10 + i * 4, resourceOffsets[i], true);
	}
	out.set(nameBytes, stringsAreaStart);
	for (let i = 0; i < resourceBytesArr.length; i++) {
		out.set(resourceBytesArr[i], stringsAreaStart + resourceOffsets[i]);
	}
	return out;
}

describe('isBarslist', () => {
	it('detects the magic', async () => {
		const bytes = buildBarslist('test', ['test.bars']);
		expect(await isBarslist(new Blob([bytes as BlobPart]))).toBe(true);
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
		const bytes = buildBarslist('archive_one', ['archive_one.bars']);
		const parsed = await parseBarslist(new Blob([bytes as BlobPart]));
		expect(parsed.endian).toBe('little');
		expect(parsed.version).toBe(1);
		expect(parsed.name).toBe('archive_one');
		expect(parsed.resources).toEqual(['archive_one.bars']);
	});

	it('parses a multi-entry archive sharing one name', async () => {
		const bytes = buildBarslist('shared_archive', [
			'shared_archive.bars',
			'shared_archive.alt.bars',
			'shared_archive.fallback.bars',
		]);
		const parsed = await parseBarslist(new Blob([bytes as BlobPart]));
		expect(parsed.name).toBe('shared_archive');
		expect(parsed.resources).toEqual([
			'shared_archive.bars',
			'shared_archive.alt.bars',
			'shared_archive.fallback.bars',
		]);
	});

	it('handles empty resource list', async () => {
		const bytes = buildBarslist('empty_archive', []);
		const parsed = await parseBarslist(new Blob([bytes as BlobPart]));
		expect(parsed.name).toBe('empty_archive');
		expect(parsed.resources).toEqual([]);
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
		const buf = buildBarslist('test', ['test.bars']);
		buf[4] = 0xaa;
		buf[5] = 0xbb;
		await expect(parseBarslist(new Blob([buf as BlobPart]))).rejects.toThrow(
			/byte-order mark/,
		);
	});

	it('throws on unsupported version', async () => {
		const buf = buildBarslist('test', ['test.bars'], /* version */ 2);
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
