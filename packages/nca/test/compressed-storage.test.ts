import { describe, it, expect } from 'vitest';
import {
	BucketTreeReader,
	CompressedStorageReader,
	COMPRESSED_ENTRY_SIZE,
	COMPRESSION_TYPE_NONE,
	COMPRESSION_TYPE_ZEROS,
} from '../src/index.js';

const NODE_HEADER_SIZE = 16;

interface SyntheticEntry {
	virt: bigint;
	phys: bigint;
	type: number;
	physSize: number;
}

/**
 * Construct nodeStorage + entryStorage for a synthetic
 * CompressedStorage-layout BucketTree with a single entry set.
 *
 * Each entry is laid out per Atmosphere's `Entry` (0x18 bytes):
 *   s64 virt_offset (0x00)
 *   s64 phys_offset (0x08)
 *   u8  compression_type (0x10)
 *   u8  reserved
 *   u16 reserved
 *   s32 phys_size  (0x14)
 */
function buildCompressedStorageBktr(opts: {
	nodeSize: number;
	entries: SyntheticEntry[];
	endVirt: bigint;
}): { node: Uint8Array; entry: Uint8Array; entryCount: number } {
	const { nodeSize, entries, endVirt } = opts;
	const entryCount = entries.length;
	const entrySize = COMPRESSED_ENTRY_SIZE;
	const startVirt = entries[0]?.virt ?? 0n;

	const node = new Uint8Array(nodeSize);
	const ndv = new DataView(node.buffer);
	// L1 NodeHeader (no top-level header — that's in the FS header)
	ndv.setInt32(0, 0, true);
	ndv.setInt32(4, 1, true);
	ndv.setBigInt64(8, endVirt, true);
	// L1 offsets (just one entry set, starts at startVirt)
	ndv.setBigInt64(NODE_HEADER_SIZE + 0, startVirt, true);

	const entry = new Uint8Array(nodeSize);
	const edv = new DataView(entry.buffer);
	// EntrySetHeader: index=0, count=entryCount, offset=endVirt
	edv.setInt32(0, 0, true);
	edv.setInt32(4, entryCount, true);
	edv.setBigInt64(8, endVirt, true);
	entries.forEach((e, i) => {
		const off = NODE_HEADER_SIZE + i * entrySize;
		edv.setBigInt64(off + 0x00, e.virt, true);
		edv.setBigInt64(off + 0x08, e.phys, true);
		entry[off + 0x10] = e.type;
		edv.setInt32(off + 0x14, e.physSize, true);
	});
	return { node, entry, entryCount };
}

describe('CompressedStorageReader (None + Zeros)', () => {
	it('reads None-compressed entries by passing through', async () => {
		// Single None entry: virt [0, 256), phys [0, 256) with known data.
		const physData = new Uint8Array(256);
		for (let i = 0; i < 256; i++) physData[i] = i;

		const NODE_SIZE = 1024;
		const { node, entry, entryCount } = buildCompressedStorageBktr({
			nodeSize: NODE_SIZE,
			entries: [{ virt: 0n, phys: 0n, type: COMPRESSION_TYPE_NONE, physSize: 256 }],
			endVirt: 256n,
		});
		const table = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: COMPRESSED_ENTRY_SIZE,
			entryCount,
		});
		const reader = new CompressedStorageReader({
			readSectionRange: async (s, e) => physData.subarray(Number(s), Number(e)),
			table,
			logicalSize: 256n,
		});

		// Full read.
		const all = await reader.read(0n, 256n);
		expect(all.byteLength).toBe(256);
		expect(Array.from(all.subarray(0, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(all[255]).toBe(255);

		// Partial read.
		const mid = await reader.read(64n, 80n);
		expect(mid.byteLength).toBe(16);
		expect(Array.from(mid)).toEqual([
			64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
		]);
	});

	it('reads Zeros entries without touching section storage', async () => {
		let sectionReads = 0;
		const NODE_SIZE = 1024;
		const { node, entry, entryCount } = buildCompressedStorageBktr({
			nodeSize: NODE_SIZE,
			entries: [{ virt: 0n, phys: 0n, type: COMPRESSION_TYPE_ZEROS, physSize: 0 }],
			endVirt: 1024n,
		});
		const table = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: COMPRESSED_ENTRY_SIZE,
			entryCount,
		});
		const reader = new CompressedStorageReader({
			readSectionRange: async () => {
				sectionReads++;
				throw new Error('readSectionRange must not be called for Zeros entries');
			},
			table,
			logicalSize: 1024n,
		});
		const data = await reader.read(0n, 1024n);
		expect(data.byteLength).toBe(1024);
		expect(data.every((b) => b === 0)).toBe(true);
		expect(sectionReads).toBe(0);
	});

	it('stitches reads across multiple entries (None + Zeros + None)', async () => {
		// Layout (virt):
		//   [0,   100)  None, phys [0, 100), data = 0..99
		//   [100, 200)  Zeros
		//   [200, 300)  None, phys [100, 200), data = 100..199
		const phys = new Uint8Array(200);
		for (let i = 0; i < 200; i++) phys[i] = i;

		const NODE_SIZE = 1024;
		const { node, entry, entryCount } = buildCompressedStorageBktr({
			nodeSize: NODE_SIZE,
			entries: [
				{ virt: 0n, phys: 0n, type: COMPRESSION_TYPE_NONE, physSize: 100 },
				{ virt: 100n, phys: 0n, type: COMPRESSION_TYPE_ZEROS, physSize: 0 },
				{ virt: 200n, phys: 100n, type: COMPRESSION_TYPE_NONE, physSize: 100 },
			],
			endVirt: 300n,
		});
		const table = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: COMPRESSED_ENTRY_SIZE,
			entryCount,
		});
		const reader = new CompressedStorageReader({
			readSectionRange: async (s, e) => phys.subarray(Number(s), Number(e)),
			table,
			logicalSize: 300n,
		});

		// Whole-range read crosses all three entries.
		const all = await reader.read(0n, 300n);
		expect(all.byteLength).toBe(300);
		// First 100: data 0..99
		for (let i = 0; i < 100; i++) expect(all[i]).toBe(i);
		// Next 100: zeros
		for (let i = 100; i < 200; i++) expect(all[i]).toBe(0);
		// Last 100: 100..199
		for (let i = 0; i < 100; i++) expect(all[200 + i]).toBe(100 + i);

		// Mid-boundary read: [90, 210) crosses None→Zeros→None.
		const mid = await reader.read(90n, 210n);
		expect(mid.byteLength).toBe(120);
		expect(Array.from(mid.subarray(0, 10))).toEqual([
			90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
		]);
		for (let i = 10; i < 110; i++) expect(mid[i]).toBe(0);
		expect(Array.from(mid.subarray(110, 120))).toEqual([
			100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
		]);
	});

	it('throws for unknown compression type', async () => {
		const NODE_SIZE = 1024;
		const { node, entry, entryCount } = buildCompressedStorageBktr({
			nodeSize: NODE_SIZE,
			entries: [{ virt: 0n, phys: 0n, type: 99, physSize: 10 }],
			endVirt: 10n,
		});
		const table = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: COMPRESSED_ENTRY_SIZE,
			entryCount,
		});
		const reader = new CompressedStorageReader({
			readSectionRange: async () => new Uint8Array(10),
			table,
			logicalSize: 10n,
		});
		await expect(reader.read(0n, 10n)).rejects.toThrow(/Unknown CompressedStorage compression type: 99/);
	});

	it('throws for out-of-range reads', async () => {
		const NODE_SIZE = 1024;
		const { node, entry, entryCount } = buildCompressedStorageBktr({
			nodeSize: NODE_SIZE,
			entries: [{ virt: 0n, phys: 0n, type: COMPRESSION_TYPE_ZEROS, physSize: 0 }],
			endVirt: 100n,
		});
		const table = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: COMPRESSED_ENTRY_SIZE,
			entryCount,
		});
		const reader = new CompressedStorageReader({
			readSectionRange: async () => new Uint8Array(0),
			table,
			logicalSize: 100n,
		});
		await expect(reader.read(0n, 101n)).rejects.toThrow(/out of range/);
	});
});
