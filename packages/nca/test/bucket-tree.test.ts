import { describe, it, expect } from 'vitest';
import {
	BucketTreeReader,
	parseBucketTreeHeader,
	COMPRESSED_ENTRY_SIZE,
} from '../src/index.js';

// Helpers to construct a synthetic BKTR fixture.
// The format we want to produce:
//   nodeStorage = L1 NodeHeader(16) + L1 offsets[count] (padded to NODE_SIZE)
//   entryStorage = for each entry set: NodeHeader(16) + entries[count]
//                  (padded to NODE_SIZE)
//
// (The 16-byte BucketTree top-level header is *not* in nodeStorage —
// it lives in the FS header's CompressionInfo block.)
//
// We pick a small NODE_SIZE to make the test data manageable.

const NODE_HEADER_SIZE = 16;

function buildBktr(opts: {
	nodeSize: number;
	entrySize: number;
	// Pre-computed entry sets: each set is { start, entries: [{ virt }, ...] }.
	// The first 8 bytes of each entry must be the virt_offset (little-endian);
	// other bytes are zero unless overridden.
	entrySets: Array<{
		startVirt: bigint;
		endVirt: bigint;
		entries: Array<{ virt: bigint; payload?: Uint8Array }>;
	}>;
	endOffset: bigint;
}): { node: Uint8Array; entry: Uint8Array; entryCount: number } {
	const { nodeSize, entrySize, entrySets, endOffset } = opts;
	const entryCount = entrySets.reduce((acc, s) => acc + s.entries.length, 0);

	// nodeStorage: L1 NodeHeader + offsets (no top-level BKTR header).
	const node = new Uint8Array(nodeSize);
	const ndv = new DataView(node.buffer, node.byteOffset, node.byteLength);
	// L1 NodeHeader: index=0, count=entrySetCount, offset=endOffset
	ndv.setInt32(0, 0, true);
	ndv.setInt32(4, entrySets.length, true);
	ndv.setBigInt64(8, endOffset, true);
	// L1 offsets: starts of each entry set
	const offBase = NODE_HEADER_SIZE;
	entrySets.forEach((s, i) => {
		ndv.setBigInt64(offBase + i * 8, s.startVirt, true);
	});

	// entryStorage:
	const entry = new Uint8Array(entrySets.length * nodeSize);
	entrySets.forEach((s, i) => {
		const base = i * nodeSize;
		const edv = new DataView(entry.buffer, entry.byteOffset + base, nodeSize);
		// EntrySetHeader: index=i, count=entries.length, offset=endVirt
		edv.setInt32(0, i, true);
		edv.setInt32(4, s.entries.length, true);
		edv.setBigInt64(8, s.endVirt, true);
		// Entries
		s.entries.forEach((e, j) => {
			const eo = NODE_HEADER_SIZE + j * entrySize;
			edv.setBigInt64(eo, e.virt, true);
			if (e.payload) {
				entry.set(e.payload, base + eo + 8);
			}
		});
	});

	return { node, entry, entryCount };
}

describe('parseBucketTreeHeader', () => {
	it('parses valid header', () => {
		const buf = new Uint8Array(16);
		const dv = new DataView(buf.buffer);
		dv.setUint32(0, 0x5254_4b42, true); // "BKTR"
		dv.setUint32(4, 1, true);
		dv.setInt32(8, 42, true);
		dv.setUint32(12, 0, true);
		const h = parseBucketTreeHeader(buf);
		expect(h.magic).toBe(0x5254_4b42);
		expect(h.version).toBe(1);
		expect(h.entryCount).toBe(42);
		expect(h.reserved).toBe(0);
	});

	it('rejects bad magic', () => {
		const buf = new Uint8Array(16);
		const dv = new DataView(buf.buffer);
		dv.setUint32(0, 0xdeadbeef, true);
		dv.setUint32(4, 1, true);
		expect(() => parseBucketTreeHeader(buf)).toThrow(/Invalid BucketTree magic/);
	});

	it('rejects wrong version', () => {
		const buf = new Uint8Array(16);
		const dv = new DataView(buf.buffer);
		dv.setUint32(0, 0x5254_4b42, true);
		dv.setUint32(4, 2, true);
		expect(() => parseBucketTreeHeader(buf)).toThrow(/Unsupported BucketTree version/);
	});

	it('rejects truncated', () => {
		const buf = new Uint8Array(8);
		expect(() => parseBucketTreeHeader(buf)).toThrow(/truncated/);
	});
});

describe('BucketTreeReader', () => {
	const NODE_SIZE = 1024; // small node size for tests
	const ENTRY_SIZE = COMPRESSED_ENTRY_SIZE;

	it('finds entries in a single-set tree', async () => {
		// 4 entries: virt 0, 100, 200, 350 with end 500.
		const { node, entry, entryCount } = buildBktr({
			nodeSize: NODE_SIZE,
			entrySize: ENTRY_SIZE,
			entrySets: [
				{
					startVirt: 0n,
					endVirt: 500n,
					entries: [
						{ virt: 0n },
						{ virt: 100n },
						{ virt: 200n },
						{ virt: 350n },
					],
				},
			],
			endOffset: 500n,
		});
		const r = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: ENTRY_SIZE,
			entryCount,
		});

		const offs = await r.getOffsets();
		expect(offs.startOffset).toBe(0n);
		expect(offs.endOffset).toBe(500n);

		// Probe each entry boundary.
		const at0 = await r.find(0n);
		expect(at0).not.toBeNull();
		expect(new DataView(at0!.entryBytes.buffer, at0!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(0n);
		expect(at0!.entryEnd).toBe(100n);

		const at99 = await r.find(99n);
		expect(new DataView(at99!.entryBytes.buffer, at99!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(0n);

		const at100 = await r.find(100n);
		expect(new DataView(at100!.entryBytes.buffer, at100!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(100n);
		expect(at100!.entryEnd).toBe(200n);

		const at349 = await r.find(349n);
		expect(new DataView(at349!.entryBytes.buffer, at349!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(200n);

		const at350 = await r.find(350n);
		expect(new DataView(at350!.entryBytes.buffer, at350!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(350n);
		expect(at350!.entryEnd).toBe(500n);

		const at499 = await r.find(499n);
		expect(new DataView(at499!.entryBytes.buffer, at499!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(350n);
	});

	it('returns null for out-of-range queries', async () => {
		const { node, entry, entryCount } = buildBktr({
			nodeSize: NODE_SIZE,
			entrySize: ENTRY_SIZE,
			entrySets: [
				{
					startVirt: 10n,
					endVirt: 100n,
					entries: [{ virt: 10n }, { virt: 50n }],
				},
			],
			endOffset: 100n,
		});
		const r = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: ENTRY_SIZE,
			entryCount,
		});
		expect(await r.find(9n)).toBeNull(); // below start
		expect(await r.find(100n)).toBeNull(); // at end (exclusive)
		expect(await r.find(1000n)).toBeNull(); // way past end
	});

	it('finds entries across multiple entry sets', async () => {
		// 2 sets, 3 entries each.
		const { node, entry, entryCount } = buildBktr({
			nodeSize: NODE_SIZE,
			entrySize: ENTRY_SIZE,
			entrySets: [
				{
					startVirt: 0n,
					endVirt: 300n,
					entries: [{ virt: 0n }, { virt: 100n }, { virt: 200n }],
				},
				{
					startVirt: 300n,
					endVirt: 600n,
					entries: [{ virt: 300n }, { virt: 400n }, { virt: 500n }],
				},
			],
			endOffset: 600n,
		});
		const r = new BucketTreeReader({
			nodeStorage: node,
			entryStorage: entry,
			nodeSize: NODE_SIZE,
			entrySize: ENTRY_SIZE,
			entryCount,
		});

		// Hit set 0
		const at150 = await r.find(150n);
		expect(new DataView(at150!.entryBytes.buffer, at150!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(100n);

		// Boundary: 299 in set 0, 300 in set 1
		const at299 = await r.find(299n);
		expect(new DataView(at299!.entryBytes.buffer, at299!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(200n);

		const at300 = await r.find(300n);
		expect(new DataView(at300!.entryBytes.buffer, at300!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(300n);

		// Last entry
		const at599 = await r.find(599n);
		expect(new DataView(at599!.entryBytes.buffer, at599!.entryBytes.byteOffset).getBigInt64(0, true)).toBe(500n);
		expect(at599!.entryEnd).toBe(600n);
	});

});
