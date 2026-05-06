import { describe, it, expect } from 'vitest';
import { isSarc, parseSarc, SARC_MAGIC } from '../src/index.js';

/**
 * Minimal SARC writer used only for tests. Mirrors the bytes the
 * parser expects for each section:
 *   - SARC (0x14) + SFAT (0xC) + SFAT nodes (0x10×n) + SFNT (8) +
 *     name table (4-aligned) + file data (4-aligned per file).
 *
 * Always writes little-endian, version 0x100, hash_multiplier 0x65,
 * default_alignment 4. No alignment-by-extension heuristics — each
 * file just gets 4-byte alignment.
 */
function writeSarcLE(
	files: { name: string; data: Uint8Array }[],
): Uint8Array {
	const HASH_MULT = 0x65;
	const SARC_HDR = 0x14;
	const SFAT_HDR = 0xc;
	const SFAT_NODE = 0x10;
	const SFNT_HDR = 0x08;

	const sorted = [...files]
		.map((f) => ({ ...f, hash: hashName(f.name, HASH_MULT) }))
		.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

	// Compute name table layout (4-byte aligned strings, NUL-terminated).
	const nameOffsets: number[] = [];
	let nameBytes = 0;
	for (const f of sorted) {
		nameOffsets.push(nameBytes);
		const enc = new TextEncoder().encode(f.name);
		nameBytes += alignUp(enc.length + 1, 4);
	}
	const sfatOffset = SARC_HDR;
	const nodesOffset = sfatOffset + SFAT_HDR;
	const sfntOffset = nodesOffset + SFAT_NODE * sorted.length;
	const nameTableOffset = sfntOffset + SFNT_HDR;
	const dataOffset = alignUp(nameTableOffset + nameBytes, 4);

	// File-data layout (each at +4 alignment from the previous end).
	const fileOffsets: number[] = [];
	let cur = 0;
	for (const f of sorted) {
		cur = alignUp(cur, 4);
		fileOffsets.push(cur);
		cur += f.data.length;
	}
	const totalSize = dataOffset + cur;

	const out = new Uint8Array(totalSize);
	const view = new DataView(out.buffer);

	// --- SARC header ---
	out[0] = 0x53;
	out[1] = 0x41;
	out[2] = 0x52;
	out[3] = 0x43; // 'SARC'
	view.setUint16(4, SARC_HDR, true);
	out[6] = 0xff;
	out[7] = 0xfe; // BOM = LE
	view.setUint32(8, totalSize, true);
	view.setUint32(0xc, dataOffset, true);
	view.setUint16(0x10, 0x0100, true);
	view.setUint16(0x12, 0, true);

	// --- SFAT ---
	out[sfatOffset + 0] = 0x53;
	out[sfatOffset + 1] = 0x46;
	out[sfatOffset + 2] = 0x41;
	out[sfatOffset + 3] = 0x54; // 'SFAT'
	view.setUint16(sfatOffset + 4, SFAT_HDR, true);
	view.setUint16(sfatOffset + 6, sorted.length, true);
	view.setUint32(sfatOffset + 8, HASH_MULT, true);

	for (let i = 0; i < sorted.length; i++) {
		const off = nodesOffset + i * SFAT_NODE;
		view.setUint32(off, sorted[i].hash >>> 0, true);
		view.setUint32(off + 4, 0x01000000 | (nameOffsets[i] >>> 2), true);
		view.setUint32(off + 8, fileOffsets[i], true);
		view.setUint32(off + 0xc, fileOffsets[i] + sorted[i].data.length, true);
	}

	// --- SFNT ---
	out[sfntOffset + 0] = 0x53;
	out[sfntOffset + 1] = 0x46;
	out[sfntOffset + 2] = 0x4e;
	out[sfntOffset + 3] = 0x54; // 'SFNT'
	view.setUint16(sfntOffset + 4, SFNT_HDR, true);
	view.setUint16(sfntOffset + 6, 0, true);

	for (let i = 0; i < sorted.length; i++) {
		const enc = new TextEncoder().encode(sorted[i].name);
		out.set(enc, nameTableOffset + nameOffsets[i]);
		// trailing NUL implicit (Uint8Array is zero-initialised)
	}

	for (let i = 0; i < sorted.length; i++) {
		out.set(sorted[i].data, dataOffset + fileOffsets[i]);
	}

	return out;
}

function hashName(name: string, mult: number): number {
	const bytes = new TextEncoder().encode(name);
	let h = 0;
	for (let i = 0; i < bytes.length; i++) {
		// Match Nintendo's signed-char arithmetic: bytes ≥ 0x80 are
		// treated as negative, then truncated back to u32.
		const c = bytes[i] >= 0x80 ? bytes[i] - 256 : bytes[i];
		h = ((c + Math.imul(h, mult)) | 0) >>> 0;
	}
	return h;
}

function alignUp(n: number, a: number): number {
	return (n + a - 1) & ~(a - 1);
}

describe('isSarc', () => {
	it('detects the magic', async () => {
		const sarc = writeSarcLE([{ name: 'a', data: new Uint8Array([1]) }]);
		expect(await isSarc(new Blob([sarc as BlobPart]))).toBe(true);
	});
	it('rejects non-SARC blobs', async () => {
		expect(
			await isSarc(new Blob([new Uint8Array([0x59, 0x61, 0x7a, 0x30])])),
		).toBe(false);
		expect(await isSarc(new Blob([]))).toBe(false);
	});
});

describe('parseSarc', () => {
	it('parses a minimal LE archive', async () => {
		const sarc = writeSarcLE([
			{ name: 'foo.txt', data: new TextEncoder().encode('hello') },
			{ name: 'bar.bin', data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
		]);
		const parsed = await parseSarc(new Blob([sarc as BlobPart]));
		expect(parsed.endian).toBe('little');
		expect(parsed.hashMultiplier).toBe(0x65);
		expect(parsed.fileSize).toBe(sarc.length);
		expect(parsed.entries).toHaveLength(2);

		const byName = Object.fromEntries(
			parsed.entries.map((e) => [e.name, e]),
		);
		expect(byName['foo.txt']).toBeDefined();
		expect(byName['bar.bin']).toBeDefined();

		const fooBytes = new Uint8Array(
			await byName['foo.txt'].data.arrayBuffer(),
		);
		expect(new TextDecoder().decode(fooBytes)).toBe('hello');

		const barBytes = new Uint8Array(
			await byName['bar.bin'].data.arrayBuffer(),
		);
		expect(Array.from(barBytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
	});

	it('parses a BE archive (BOM = 0xFEFF)', async () => {
		// Write LE, then flip the BOM bytes and re-encode all multi-byte
		// fields in BE. Easier to just hand-craft a minimal BE archive.
		const beSarc = makeMinimalBESarc();
		const parsed = await parseSarc(new Blob([beSarc as BlobPart]));
		expect(parsed.endian).toBe('big');
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0].name).toBe('x');
		const bytes = new Uint8Array(
			await parsed.entries[0].data.arrayBuffer(),
		);
		expect(Array.from(bytes)).toEqual([0x42]);
	});

	it('preserves file paths with directory separators', async () => {
		const sarc = writeSarcLE([
			{ name: 'EventFlow/foo.bfevfl', data: new Uint8Array([1]) },
			{ name: 'Layout/bar.byml', data: new Uint8Array([2, 3]) },
		]);
		const parsed = await parseSarc(new Blob([sarc as BlobPart]));
		const names = parsed.entries.map((e) => e.name).sort();
		expect(names).toEqual(['EventFlow/foo.bfevfl', 'Layout/bar.byml']);
	});

	it('exposes lazy Blob slices', async () => {
		const sarc = writeSarcLE([
			{ name: 'a.bin', data: new Uint8Array(1024).fill(0xaa) },
		]);
		const parsed = await parseSarc(new Blob([sarc as BlobPart]));
		expect(parsed.entries[0].data).toBeInstanceOf(Blob);
		expect(parsed.entries[0].data.size).toBe(1024);
		expect(parsed.entries[0].size).toBe(1024);
	});

	it('throws on bad SARC magic', async () => {
		const buf = new Uint8Array(0x14);
		await expect(parseSarc(new Blob([buf as BlobPart]))).rejects.toThrow(
			/SARC magic/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseSarc(new Blob([]))).rejects.toThrow(/too small/);
	});
});

/**
 * Build a tiny 1-file BE SARC by hand. Layout matches the LE writer
 * above; just flips the BOM and uses BE u16/u32 encoding.
 */
function makeMinimalBESarc(): Uint8Array {
	const SARC_HDR = 0x14;
	const SFAT_HDR = 0xc;
	const SFAT_NODE = 0x10;
	const SFNT_HDR = 0x08;
	const name = 'x'; // 1 byte + NUL + 2 padding = 4-byte aligned
	const data = new Uint8Array([0x42]);
	const sfatOffset = SARC_HDR;
	const nodesOffset = sfatOffset + SFAT_HDR;
	const sfntOffset = nodesOffset + SFAT_NODE * 1;
	const nameTableOffset = sfntOffset + SFNT_HDR;
	const dataOffset = alignUp(nameTableOffset + 4 /* "x\0\0\0" */, 4);
	const totalSize = dataOffset + data.length;

	const out = new Uint8Array(totalSize);
	const view = new DataView(out.buffer);

	// SARC header — BE
	out[0] = 0x53;
	out[1] = 0x41;
	out[2] = 0x52;
	out[3] = 0x43;
	view.setUint16(4, SARC_HDR, false);
	out[6] = 0xfe;
	out[7] = 0xff; // BOM = BE
	view.setUint32(8, totalSize, false);
	view.setUint32(0xc, dataOffset, false);
	view.setUint16(0x10, 0x0100, false);
	view.setUint16(0x12, 0, false);

	// SFAT
	out[sfatOffset + 0] = 0x53;
	out[sfatOffset + 1] = 0x46;
	out[sfatOffset + 2] = 0x41;
	out[sfatOffset + 3] = 0x54;
	view.setUint16(sfatOffset + 4, SFAT_HDR, false);
	view.setUint16(sfatOffset + 6, 1, false);
	view.setUint32(sfatOffset + 8, 0x65, false);

	// Node
	view.setUint32(nodesOffset + 0, hashName(name, 0x65), false);
	view.setUint32(nodesOffset + 4, 0x01000000 | 0, false); // name at offset 0 in name-table words
	view.setUint32(nodesOffset + 8, 0, false);
	view.setUint32(nodesOffset + 0xc, data.length, false);

	// SFNT
	out[sfntOffset + 0] = 0x53;
	out[sfntOffset + 1] = 0x46;
	out[sfntOffset + 2] = 0x4e;
	out[sfntOffset + 3] = 0x54;
	view.setUint16(sfntOffset + 4, SFNT_HDR, false);
	view.setUint16(sfntOffset + 6, 0, false);

	// Name table: "x\0\0\0"
	out[nameTableOffset] = 0x78;

	// File data
	out[dataOffset] = 0x42;
	return out;
}

describe('SARC_MAGIC export', () => {
	it('is the four-character string "SARC"', () => {
		expect(SARC_MAGIC).toBe('SARC');
	});
});
