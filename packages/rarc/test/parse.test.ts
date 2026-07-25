import { describe, expect, it } from 'vitest';

import {
	RARC_ENTRY_SIZE,
	RARC_HEADER_SIZE,
	RARC_NODE_SIZE,
	RarcEntryFlags,
	isRarc,
	parseRarc,
	parseRarcHeader,
	rarcNameHash,
} from '../src/index.js';

/**
 * Synthetic RARC builder.
 *
 * Everything here is assembled byte-by-byte so the tests exercise the real
 * wire format (including the awkward "offsets are relative to 0x20" rule)
 * without shipping any game data.
 *
 * The fixture archive looks like:
 *
 *   archive/            (node 0, 'ROOT')
 *     a.bin             "AAAA"
 *     sub/              (node 1, 'SUB')
 *       c.bin           "CCCCCC"
 *     b.bin             "BBBBB"
 *
 * plus the synthetic "." and ".." entries that real archives carry.
 */

interface BuildOptions {
	/** Override the header's `headerSize` field to prove offsets follow it. */
	headerSize?: number;
	/** Flags OR-ed onto `a.bin`, for testing compression discrimination. */
	aFlags?: number;
	/** Make node 1's `..` point back at itself, creating a cycle. */
	cycle?: boolean;
	/** Inflate node 0's entryCount past the end of the entry table. */
	overlongRootRange?: boolean;
}

const NAMES = ['.', '..', 'archive', 'a.bin', 'sub', 'b.bin', 'c.bin'] as const;

function buildStringTable(): { bytes: Uint8Array; offsets: Record<string, number> } {
	const offsets: Record<string, number> = {};
	const parts: number[] = [];
	for (const name of NAMES) {
		offsets[name] = parts.length;
		for (let i = 0; i < name.length; i++) parts.push(name.charCodeAt(i));
		parts.push(0);
	}
	while (parts.length % 4 !== 0) parts.push(0);
	return { bytes: new Uint8Array(parts), offsets };
}

function buildRarc(opts: BuildOptions = {}): Uint8Array {
	const headerSize = opts.headerSize ?? RARC_HEADER_SIZE;
	const { bytes: strTab, offsets: strOff } = buildStringTable();

	const nodeCount = 2;
	const entryCount = 8;

	// Absolute layout. The info block always sits at `headerSize`.
	const infoBase = headerSize;
	const nodeAbs = infoBase + RARC_HEADER_SIZE;
	const entryAbs = nodeAbs + nodeCount * RARC_NODE_SIZE;
	const strAbs = entryAbs + entryCount * RARC_ENTRY_SIZE;
	const dataAbs = strAbs + strTab.length;

	// File payloads, spaced out so a wrong data base is obvious.
	const files = [
		{ name: 'a.bin', at: 0x00, body: 'AAAA' },
		{ name: 'b.bin', at: 0x20, body: 'BBBBB' },
		{ name: 'c.bin', at: 0x40, body: 'CCCCCC' },
	];
	const dataLength = 0x40 + 6;

	const total = dataAbs + dataLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	const w32 = (o: number, v: number) => view.setUint32(o, v >>> 0, false);
	const w16 = (o: number, v: number) => view.setUint16(o, v & 0xffff, false);

	// ---- Header ----
	out.set([0x52, 0x41, 0x52, 0x43], 0); // 'RARC'
	w32(0x04, total);
	w32(0x08, headerSize);
	w32(0x0c, dataAbs - infoBase); // relative to the info block
	w32(0x10, dataLength);
	w32(0x14, dataLength); // mram
	w32(0x18, 0); // aram
	w32(0x1c, 0); // dvd

	// ---- Info block ----
	w32(infoBase + 0x00, nodeCount);
	w32(infoBase + 0x04, nodeAbs - infoBase);
	w32(infoBase + 0x08, entryCount);
	w32(infoBase + 0x0c, entryAbs - infoBase);
	w32(infoBase + 0x10, strTab.length);
	w32(infoBase + 0x14, strAbs - infoBase);
	w16(infoBase + 0x18, 3); // nextFreeFileId
	out[infoBase + 0x1a] = 1; // keepFileIdsSynced

	// ---- Nodes ----
	const writeNode = (
		i: number,
		type: string,
		name: string,
		firstEntry: number,
		count: number,
	) => {
		const p = nodeAbs + i * RARC_NODE_SIZE;
		const padded = type.padEnd(4, ' ');
		for (let c = 0; c < 4; c++) out[p + c] = padded.charCodeAt(c);
		w32(p + 0x04, strOff[name]);
		w16(p + 0x08, rarcNameHash(name));
		w16(p + 0x0a, count);
		w32(p + 0x0c, firstEntry);
	};
	writeNode(0, 'ROOT', 'archive', 0, opts.overlongRootRange ? 99 : 5);
	writeNode(1, 'SUB', 'sub', 5, 3);

	// ---- Entries ----
	let ei = 0;
	const writeFile = (name: string, id: number, extraFlags = 0) => {
		const f = files.find((x) => x.name === name)!;
		const p = entryAbs + ei++ * RARC_ENTRY_SIZE;
		w16(p + 0x00, id);
		w16(p + 0x02, rarcNameHash(name));
		out[p + 0x04] = RarcEntryFlags.FILE | RarcEntryFlags.PRELOAD_TO_MRAM | extraFlags;
		w16(p + 0x06, strOff[name]);
		w32(p + 0x08, f.at);
		w32(p + 0x0c, f.body.length);
		for (let i = 0; i < f.body.length; i++) out[dataAbs + f.at + i] = f.body.charCodeAt(i);
	};
	const writeDirEntry = (name: string, nodeIndex: number) => {
		const p = entryAbs + ei++ * RARC_ENTRY_SIZE;
		w16(p + 0x00, 0xffff);
		w16(p + 0x02, rarcNameHash(name));
		out[p + 0x04] = RarcEntryFlags.DIRECTORY;
		w16(p + 0x06, strOff[name]);
		w32(p + 0x08, nodeIndex);
		w32(p + 0x0c, 0x10);
	};

	// Root: a.bin, sub, b.bin, ., ..   (real archives put . and .. last)
	writeFile('a.bin', 0, opts.aFlags ?? 0);
	writeDirEntry('sub', 1);
	writeFile('b.bin', 1);
	writeDirEntry('.', 0);
	writeDirEntry('..', 0xffffffff); // root has no parent
	// sub: c.bin, ., ..
	writeFile('c.bin', 2);
	writeDirEntry('.', 1);
	writeDirEntry('..', opts.cycle ? 1 : 0);

	out.set(strTab, strAbs);
	return out;
}

describe('rarcNameHash', () => {
	it('matches the documented multiply-by-3 accumulation', () => {
		// Hand-computed: 'a' = 97; 'ab' = 97*3 + 98 = 389.
		expect(rarcNameHash('a')).toBe(97);
		expect(rarcNameHash('ab')).toBe(389);
		expect(rarcNameHash('')).toBe(0);
	});

	it('stays inside 16 bits for long names', () => {
		const h = rarcNameHash('a-very-long-file-name-that-would-overflow.bdl');
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffff);
	});
});

describe('isRarc', () => {
	it('accepts the magic', () => {
		expect(isRarc(buildRarc())).toBe(true);
	});

	it('rejects other containers and short buffers', () => {
		const yaz0 = new Uint8Array(64);
		yaz0.set([0x59, 0x61, 0x7a, 0x30], 0); // 'Yaz0'
		expect(isRarc(yaz0)).toBe(false);
		expect(isRarc(new Uint8Array(4))).toBe(false);
		expect(isRarc(new Uint8Array(0))).toBe(false);
		expect(isRarc(buildRarc(), -1)).toBe(false);
	});
});

describe('parseRarcHeader', () => {
	it('normalises every relative offset to an absolute one', () => {
		const bytes = buildRarc();
		const h = parseRarcHeader(bytes)!;
		expect(h).not.toBeNull();

		// The info block lives at 0x20, and the tables follow it. If we had
		// forgotten to add the 0x20 base, every one of these would be short by 0x20.
		expect(h.nodeOffset).toBe(0x40);
		expect(h.entryOffset).toBe(0x40 + 2 * RARC_NODE_SIZE);
		expect(h.nodeCount).toBe(2);
		expect(h.entryCount).toBe(8);
		expect(h.fileSize).toBe(bytes.length);
		expect(h.nextFreeFileId).toBe(3);
		expect(h.keepFileIdsSynced).toBe(true);

		// The string table must actually start with "." at its computed offset.
		expect(bytes[h.stringTableOffset]).toBe(0x2e);
		// And the data blob must start with a.bin's payload.
		expect(bytes[h.dataOffset]).toBe(0x41); // 'A'
	});

	it('honours a non-default headerSize rather than hardcoding 0x20', () => {
		const bytes = buildRarc({ headerSize: 0x40 });
		const h = parseRarcHeader(bytes)!;
		expect(h).not.toBeNull();
		// Offsets are relative to headerSize, so the node table moves with it.
		expect(h.nodeOffset).toBe(0x40 + RARC_HEADER_SIZE);
		expect(bytes[h.dataOffset]).toBe(0x41);
	});

	it('returns null on bad magic, truncation and absurd table sizes', () => {
		expect(parseRarcHeader(new Uint8Array(0x40))).toBeNull();

		const short = buildRarc().subarray(0, 0x30);
		expect(parseRarcHeader(short)).toBeNull();

		// headerSize smaller than the header itself is nonsense.
		const badHeaderSize = buildRarc();
		new DataView(badHeaderSize.buffer).setUint32(0x08, 0x10, false);
		expect(parseRarcHeader(badHeaderSize)).toBeNull();

		// A node count that would run off the end of the buffer.
		const bigNodes = buildRarc();
		new DataView(bigNodes.buffer).setUint32(0x20, 0x1000, false);
		expect(parseRarcHeader(bigNodes)).toBeNull();

		// Zero nodes can't even express a root.
		const noNodes = buildRarc();
		new DataView(noNodes.buffer).setUint32(0x20, 0, false);
		expect(parseRarcHeader(noNodes)).toBeNull();

		// Absurd counts must be rejected before the multiply, not overflow into range.
		const overflow = buildRarc();
		new DataView(overflow.buffer).setUint32(0x28, 0xffffffff, false);
		expect(parseRarcHeader(overflow)).toBeNull();
	});
});

describe('RarcArchive', () => {
	it('reads the node table with names and trimmed type tags', () => {
		const a = parseRarc(buildRarc())!;
		expect(a.nodes).toHaveLength(2);
		expect(a.root.type).toBe('ROOT');
		expect(a.root.name).toBe('archive');
		expect(a.root.nameHash).toBe(rarcNameHash('archive'));
		// 'SUB ' is space-padded on disc; the trailing space must be trimmed.
		expect(a.nodes[1].type).toBe('SUB');
		expect(a.nodes[1].name).toBe('sub');
	});

	it('skips the synthetic . and .. entries in readDir', () => {
		const a = parseRarc(buildRarc())!;
		const names = a.readDir(a.root).map((e) => e.name);
		// Five raw entries, but "." and ".." must not surface.
		expect(a.root.entryCount).toBe(5);
		expect(names).toEqual(['a.bin', 'sub', 'b.bin']);
		expect(names).not.toContain('.');
		expect(names).not.toContain('..');
	});

	it('distinguishes files from directories and resolves node indices', () => {
		const a = parseRarc(buildRarc())!;
		const [aBin, sub, bBin] = a.readDir(a.root);
		expect(aBin.isDir).toBe(false);
		expect(aBin.id).toBe(0);
		expect(sub.isDir).toBe(true);
		expect(sub.id).toBe(0xffff);
		expect(sub.nodeIndex).toBe(1);
		expect(sub.offset).toBe(-1);
		expect(bBin.isDir).toBe(false);

		// The root's ".." carries 0xFFFFFFFF, which must become -1 rather than
		// a nonsense 4-billion node index.
		const dotDot = a.entries.find((e) => e.name === '..')!;
		expect(dotDot.nodeIndex).toBe(-1);
	});

	it('reads exact file bytes as views into the source buffer', () => {
		const bytes = buildRarc();
		const a = parseRarc(bytes)!;
		const td = new TextDecoder();

		const aBin = a.find('a.bin')!;
		const body = a.read(aBin)!;
		expect(td.decode(body)).toBe('AAAA');
		// A view, not a copy — mutating the archive must show through, which is
		// what makes this cheap on 30 MB archives.
		expect(body.buffer).toBe(bytes.buffer);

		expect(td.decode(a.read(a.find('b.bin')!)!)).toBe('BBBBB');
		expect(td.decode(a.read(a.find('sub/c.bin')!)!)).toBe('CCCCCC');
	});

	it('returns null when reading a directory', () => {
		const a = parseRarc(buildRarc())!;
		expect(a.read(a.find('sub')!)).toBeNull();
	});

	it('returns null when a file range escapes the buffer', () => {
		const bytes = buildRarc();
		const a = parseRarc(bytes)!;
		const entry = { ...a.find('a.bin')!, length: bytes.length + 1000 };
		expect(a.read(entry)).toBeNull();
	});

	it('resolves nested paths case-insensitively', () => {
		const a = parseRarc(buildRarc())!;
		expect(a.find('sub/c.bin')?.name).toBe('c.bin');
		// JSystem hashes the upper-cased name, so case must not matter.
		expect(a.find('SUB/C.BIN')?.name).toBe('c.bin');
		expect(a.find('/sub/./c.bin')?.name).toBe('c.bin');
		expect(a.find('sub')?.isDir).toBe(true);
	});

	it('returns null for paths that do not resolve', () => {
		const a = parseRarc(buildRarc())!;
		expect(a.find('nope.bin')).toBeNull();
		expect(a.find('sub/nope.bin')).toBeNull();
		// Traversing *through* a file is not a directory walk.
		expect(a.find('a.bin/c.bin')).toBeNull();
		expect(a.find('')).toBeNull();
	});

	it('walks every file depth-first with full paths and no directories', () => {
		const a = parseRarc(buildRarc())!;
		const walked = a.walk();
		expect(walked.map((e) => e.path)).toEqual(['a.bin', 'sub/c.bin', 'b.bin']);
		expect(walked.every((e) => !e.isDir)).toBe(true);
		// Walk must reach exactly the non-directory entries — the invariant we
		// rely on when browsing a real disc.
		expect(walked).toHaveLength(a.entries.filter((e) => !e.isDir).length);
	});

	it('terminates on a cyclic directory graph instead of hanging', () => {
		const a = parseRarc(buildRarc({ cycle: true }))!;
		const walked = a.walk();
		expect(walked.map((e) => e.path)).toEqual(['a.bin', 'sub/c.bin', 'b.bin']);
	});

	it('clamps a node whose entry range overruns the table', () => {
		const a = parseRarc(buildRarc({ overlongRootRange: true }))!;
		// Claims 99 entries but only 8 exist; must clamp rather than read undefined.
		expect(() => a.walk()).not.toThrow();
		expect(a.readDir(a.root).length).toBeLessThanOrEqual(a.entries.length);
	});

	it('returns an empty list for an out-of-range node index', () => {
		const a = parseRarc(buildRarc())!;
		expect(a.readDir(99)).toEqual([]);
	});

	it('discriminates Yaz0 from Yay0 compressed entries', () => {
		const plain = parseRarc(buildRarc())!.find('a.bin')!;
		expect(plain.compressed).toBe(false);
		expect(plain.compression).toBeNull();

		const yaz0 = parseRarc(
			buildRarc({ aFlags: RarcEntryFlags.COMPRESSED | RarcEntryFlags.YAZ0 }),
		)!.find('a.bin')!;
		expect(yaz0.compressed).toBe(true);
		expect(yaz0.compression).toBe('yaz0');

		// COMPRESSED without the YAZ0 bit means the older Yay0 scheme.
		const yay0 = parseRarc(buildRarc({ aFlags: RarcEntryFlags.COMPRESSED }))!.find('a.bin')!;
		expect(yay0.compressed).toBe(true);
		expect(yay0.compression).toBe('yay0');
	});

	it('never reports a directory as compressed', () => {
		const a = parseRarc(buildRarc())!;
		expect(a.find('sub')!.compressed).toBe(false);
	});

	it('parses at a non-zero offset inside a larger buffer', () => {
		const inner = buildRarc();
		const wrapped = new Uint8Array(0x100 + inner.length);
		wrapped.set(inner, 0x100);
		const a = parseRarc(wrapped, 0x100)!;
		expect(a).not.toBeNull();
		expect(new TextDecoder().decode(a.read(a.find('a.bin')!)!)).toBe('AAAA');
	});

	it('agrees with Nintendo own name hash for every entry', () => {
		// This is the check that proves our string-table offsets are right: the
		// hash was computed by the packer from the real name, so if we decoded
		// the name from the wrong offset the two would disagree.
		const a = parseRarc(buildRarc())!;
		for (const e of a.entries) {
			expect(rarcNameHash(e.name)).toBe(e.nameHash);
		}
	});

	it('returns null from parseRarc on invalid input', () => {
		expect(parseRarc(new Uint8Array(0x40))).toBeNull();
	});
});
