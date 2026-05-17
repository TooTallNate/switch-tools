/**
 * Tests for `@tootallnate/vbf`.
 *
 * Real VBF archives (from FFX/X-2 HD Remaster, FFXII TZA) are
 * many-gigabyte and aren't committed. Tests build synthetic VBFs
 * in-memory to exercise the parser surface and the lazy chunk
 * blob's slice / arrayBuffer / stream APIs. End-to-end against
 * real archives is covered by the ad-hoc smoke runs noted in the
 * package README.
 */

import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';

import { isVbf, parseVbf } from '../src/index.js';

const SRYK = [0x53, 0x52, 0x59, 0x4b];
const HEADER_SIZE = 16;
const ENTRY_SIZE = 32;
const HASH_SIZE = 16;
const CHUNK_DECOMPRESSED = 65536;

interface SyntheticFile {
	name: string;
	content: Uint8Array;
}

/**
 * Build a minimal valid VBF in memory containing the given files.
 * Uses the Switch layout (two hash tables) so the parser's
 * layout sniffer picks it up.
 *
 * Each file's content is split into 64 KiB chunks; chunks that
 * compress smaller than their raw size go in as zlib, otherwise
 * raw (matching real VBF behaviour).
 */
function buildSyntheticVbf(files: SyntheticFile[]): Blob {
	const numFiles = files.length;
	const enc = new TextEncoder();

	// Build the string table first.
	const nameBuffers: Uint8Array[] = [];
	const nameOffsets: number[] = [];
	let nameCursor = 0;
	for (const f of files) {
		const nameBytes = enc.encode(f.name);
		nameOffsets.push(nameCursor);
		// Null-terminated names.
		const buf = new Uint8Array(nameBytes.length + 1);
		buf.set(nameBytes, 0);
		nameBuffers.push(buf);
		nameCursor += buf.length;
	}
	const stringTable = new Uint8Array(nameCursor);
	{
		let off = 0;
		for (const buf of nameBuffers) {
			stringTable.set(buf, off);
			off += buf.length;
		}
	}

	// Compress each file's content into chunks. Track chunk sizes
	// for the block list, and total file body size.
	interface CompressedFile {
		blockListIndex: number;
		size: number;
		dataOffset: number;
		nameOffset: number;
		chunkSizes: number[];
		bytes: Uint8Array;
	}
	const compressed: CompressedFile[] = [];
	let totalChunks = 0;
	for (let i = 0; i < numFiles; i++) {
		const f = files[i];
		const numChunks = Math.max(1, Math.ceil(f.content.length / CHUNK_DECOMPRESSED));
		const chunkSizes: number[] = [];
		const pieces: Uint8Array[] = [];
		for (let c = 0; c < numChunks; c++) {
			const start = c * CHUNK_DECOMPRESSED;
			const end = Math.min(start + CHUNK_DECOMPRESSED, f.content.length);
			const raw = f.content.subarray(start, end);
			const z = zlibSync(raw);
			// Mirror real VBF behaviour: prefer the smaller of
			// (raw, zlib). The block list size is for the form
			// actually stored.
			if (z.length < raw.length) {
				chunkSizes.push(z.length);
				pieces.push(z);
			} else {
				chunkSizes.push(raw.length);
				pieces.push(raw);
			}
		}
		// Concatenate pieces.
		const total = pieces.reduce((s, p) => s + p.length, 0);
		const bytes = new Uint8Array(total);
		{
			let off = 0;
			for (const p of pieces) {
				bytes.set(p, off);
				off += p.length;
			}
		}
		compressed.push({
			blockListIndex: totalChunks,
			size: f.content.length,
			dataOffset: 0, // filled below
			nameOffset: nameOffsets[i],
			chunkSizes,
			bytes,
		});
		totalChunks += numChunks;
	}

	const blockList = new Uint8Array(totalChunks * 2);
	{
		const v = new DataView(blockList.buffer);
		let off = 0;
		for (const c of compressed) {
			for (const cs of c.chunkSizes) {
				v.setUint16(off, cs, /*littleEndian*/ true);
				off += 2;
			}
		}
	}

	// Layout:
	//   header                  : 16 B
	//   hash table A            : numFiles*16 B
	//   hash table B            : numFiles*16 B
	//   entries                 : numFiles*32 B
	//   stringTableLength u32   : 4 B
	//   stringTable             : nameCursor B
	//   blockList               : totalChunks*2 B
	//   file data               : sum(c.bytes.length)
	const hashesTotal = 2 * numFiles * HASH_SIZE;
	const entriesOff = HEADER_SIZE + hashesTotal;
	const stringTableLenOff = entriesOff + numFiles * ENTRY_SIZE;
	const stringTableOff = stringTableLenOff + 4;
	const blockListOff = stringTableOff + stringTable.length;
	const dataStart = blockListOff + blockList.length;

	// Set dataOffsets now that we know dataStart.
	let dataCursor = dataStart;
	for (const c of compressed) {
		c.dataOffset = dataCursor;
		dataCursor += c.bytes.length;
	}
	const totalSize = dataCursor;

	const buf = new Uint8Array(totalSize);
	const view = new DataView(buf.buffer);
	buf.set(SRYK, 0);
	view.setUint32(4, dataStart, true); // headerSize = first file's data offset
	view.setBigUint64(8, BigInt(numFiles), true);

	// Hash tables: leave as zeros (parser ignores hash contents).
	// Entries.
	for (let i = 0; i < numFiles; i++) {
		const c = compressed[i];
		const off = entriesOff + i * ENTRY_SIZE;
		view.setUint32(off + 0, c.blockListIndex, true);
		view.setUint32(off + 4, 0, true);
		view.setBigUint64(off + 8, BigInt(c.size), true);
		view.setBigUint64(off + 16, BigInt(c.dataOffset), true);
		view.setBigUint64(off + 24, BigInt(c.nameOffset), true);
	}
	// String table length + content. The on-disk length INCLUDES
	// the u32 length prefix itself, so we write `content.length + 4`.
	view.setUint32(stringTableLenOff, stringTable.length + 4, true);
	buf.set(stringTable, stringTableOff);
	// Block list.
	buf.set(blockList, blockListOff);
	// File data.
	for (const c of compressed) {
		buf.set(c.bytes, c.dataOffset);
	}
	return new Blob([buf]);
}

describe('isVbf', () => {
	it('returns true for the SRYK magic', async () => {
		const blob = new Blob([new Uint8Array(SRYK)]);
		expect(await isVbf(blob)).toBe(true);
	});
	it('returns false for non-matching bytes', async () => {
		const blob = new Blob([new Uint8Array([0x53, 0x52, 0x59, 0x4c])]);
		expect(await isVbf(blob)).toBe(false);
	});
	it('returns false for empty blobs', async () => {
		expect(await isVbf(new Blob([]))).toBe(false);
	});
});

describe('parseVbf', () => {
	it('rejects non-SRYK input', async () => {
		const buf = new Uint8Array(64);
		await expect(parseVbf(new Blob([buf]))).rejects.toThrow(/magic/i);
	});

	it('parses a single small file', async () => {
		const content = new TextEncoder().encode('hello world');
		const vbf = buildSyntheticVbf([{ name: 'greeting.txt', content }]);
		const parsed = await parseVbf(vbf);
		expect(parsed.numFiles).toBe(1);
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0].name).toBe('greeting.txt');
		expect(parsed.entries[0].size).toBe(content.length);
		const out = new Uint8Array(await parsed.entries[0].data.arrayBuffer());
		expect(out).toEqual(content);
	});

	it('round-trips multiple files in declaration order', async () => {
		const files = [
			{ name: 'a.txt', content: new TextEncoder().encode('hello A') },
			{ name: 'b.txt', content: new TextEncoder().encode('world B') },
			{ name: 'sub/c.bin', content: new Uint8Array([1, 2, 3, 4, 5]) },
		];
		const parsed = await parseVbf(buildSyntheticVbf(files));
		expect(parsed.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
		for (let i = 0; i < files.length; i++) {
			const out = new Uint8Array(
				await parsed.entries[i].data.arrayBuffer(),
			);
			expect(out, `entry ${i}`).toEqual(files[i].content);
		}
	});

	it('decompresses multi-chunk files', async () => {
		// Build a 200 KB file with semi-redundant content so each
		// 64 KB chunk compresses well.
		const content = new Uint8Array(200_000);
		for (let i = 0; i < content.length; i++) {
			content[i] = (i & 0xff) ^ ((i >> 7) & 0xff);
		}
		const parsed = await parseVbf(
			buildSyntheticVbf([{ name: 'big.bin', content }]),
		);
		const out = new Uint8Array(await parsed.entries[0].data.arrayBuffer());
		expect(out.length).toBe(content.length);
		expect(out).toEqual(content);
	});

	it('supports lazy slicing across chunk boundaries', async () => {
		// 100 KB file → 2 chunks at 64 KiB boundary.
		const content = new Uint8Array(100_000);
		for (let i = 0; i < content.length; i++) content[i] = (i * 31) & 0xff;
		const parsed = await parseVbf(
			buildSyntheticVbf([{ name: 'big.bin', content }]),
		);
		// Cross-chunk slice [65500, 65600) — touches both chunks.
		const out = new Uint8Array(
			await parsed.entries[0].data.slice(65_500, 65_600).arrayBuffer(),
		);
		expect(out.length).toBe(100);
		for (let i = 0; i < out.length; i++) {
			expect(out[i]).toBe(content[65_500 + i]);
		}
	});

	it('handles zero-byte files', async () => {
		const parsed = await parseVbf(
			buildSyntheticVbf([{ name: 'empty', content: new Uint8Array(0) }]),
		);
		expect(parsed.entries[0].size).toBe(0);
		expect(parsed.entries[0].data.size).toBe(0);
		const out = new Uint8Array(await parsed.entries[0].data.arrayBuffer());
		expect(out.length).toBe(0);
	});

	it('streams via ReadableStream', async () => {
		const content = new TextEncoder().encode(
			'lorem ipsum '.repeat(2_000),
		);
		const parsed = await parseVbf(
			buildSyntheticVbf([{ name: 'doc.txt', content }]),
		);
		const reader = parsed.entries[0].data.stream().getReader();
		const pieces: Uint8Array[] = [];
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) pieces.push(value);
		}
		const total = pieces.reduce((s, p) => s + p.length, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of pieces) {
			out.set(p, off);
			off += p.length;
		}
		expect(out.length).toBe(content.length);
		expect(out).toEqual(content);
	});
});
