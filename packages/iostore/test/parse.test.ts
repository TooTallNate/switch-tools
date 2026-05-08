import { describe, it, expect } from 'vitest';
import {
	parseIoStoreToc,
	IoStoreTocVersion,
	IO_CONTAINER_FLAG,
	chunkBlockRange,
} from '../src/index.js';

/**
 * Build a minimal-but-valid `.utoc` blob from scratch so we don't
 * have to ship a real game's TOC. Mirrors CUE4Parse's writer enough
 * to exercise the reader end-to-end.
 */
function buildSyntheticToc(opts: {
	mountPoint: string;
	files: { path: string; chunkId?: Uint8Array; offset?: number; length?: number }[];
	compressionBlockSize?: number;
	containerFlags?: number;
	version?: number;
}): Uint8Array {
	const compressionBlockSize = opts.compressionBlockSize ?? 0x10000;
	const containerFlags =
		opts.containerFlags ??
		IO_CONTAINER_FLAG.Indexed | IO_CONTAINER_FLAG.Compressed;
	const version = opts.version ?? IoStoreTocVersion.PartitionSize;

	// Build the directory index buffer first (so we know its size).
	const dirIndex = buildDirectoryIndex(opts.mountPoint, opts.files);

	// One compression block per chunk, all uncompressed for simplicity.
	const compressionBlocks: {
		offset: number;
		compressedSize: number;
		uncompressedSize: number;
		methodIdx: number;
	}[] = [];
	let blockOffset = 0;
	for (const f of opts.files) {
		const len = f.length ?? 1024;
		const aligned = Math.ceil(len / compressionBlockSize) * compressionBlockSize;
		compressionBlocks.push({
			offset: blockOffset,
			compressedSize: len,
			uncompressedSize: len,
			methodIdx: 0, // None
		});
		blockOffset += aligned;
	}

	const tocEntryCount = opts.files.length;
	const tocCompressedBlockEntryCount = compressionBlocks.length;
	const compressionMethodNameLength = 32;
	const compressionMethodNameCount = 0; // only "None" (implicit index 0)

	// Compute total size and allocate.
	const SIZEOF_HEADER = 144;
	const SIZEOF_CHUNK_ID = 12;
	const SIZEOF_OFFSET_LENGTH = 10;
	const SIZEOF_BLOCK_ENTRY = 12;

	const total =
		SIZEOF_HEADER +
		tocEntryCount * SIZEOF_CHUNK_ID +
		tocEntryCount * SIZEOF_OFFSET_LENGTH +
		tocCompressedBlockEntryCount * SIZEOF_BLOCK_ENTRY +
		compressionMethodNameCount * compressionMethodNameLength +
		dirIndex.length;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);

	// ---- Header ----
	const TOC_MAGIC = [
		0x2d, 0x3d, 0x3d, 0x2d, 0x2d, 0x3d, 0x3d, 0x2d,
		0x2d, 0x3d, 0x3d, 0x2d, 0x2d, 0x3d, 0x3d, 0x2d,
	];
	for (let i = 0; i < 16; i++) buf[i] = TOC_MAGIC[i];
	let p = 16;
	buf[p++] = version; // version
	p += 1; // _reserved0
	p += 2; // _reserved1
	dv.setUint32(p, SIZEOF_HEADER, true); p += 4; // tocHeaderSize
	dv.setUint32(p, tocEntryCount, true); p += 4;
	dv.setUint32(p, tocCompressedBlockEntryCount, true); p += 4;
	dv.setUint32(p, SIZEOF_BLOCK_ENTRY, true); p += 4; // sanity
	dv.setUint32(p, compressionMethodNameCount, true); p += 4;
	dv.setUint32(p, compressionMethodNameLength, true); p += 4;
	dv.setUint32(p, compressionBlockSize, true); p += 4;
	dv.setUint32(p, dirIndex.length, true); p += 4;
	dv.setUint32(p, 1, true); p += 4; // partitionCount
	dv.setBigUint64(p, 0n, true); p += 8; // containerId
	p += 16; // encryptionKeyGuid (zeroed)
	dv.setUint32(p, containerFlags, true); p += 4;
	dv.setUint32(p, 0, true); p += 4; // tocChunkPerfectHashSeedsCount
	dv.setBigUint64(p, BigInt(blockOffset), true); p += 8; // partitionSize
	dv.setUint32(p, 0, true); p += 4; // tocChunksWithoutPerfectHashCount
	p += 4; // _reserved7
	p += 8 * 5; // _reserved8
	if (p !== SIZEOF_HEADER) throw new Error('header layout bug');

	// ---- ChunkIds ----
	for (let i = 0; i < tocEntryCount; i++) {
		const id =
			opts.files[i].chunkId ??
			(() => {
				const a = new Uint8Array(SIZEOF_CHUNK_ID);
				a[0] = i & 0xff;
				return a;
			})();
		buf.set(id, p);
		p += SIZEOF_CHUNK_ID;
	}

	// ---- ChunkOffsetLengths (5 BE bytes offset + 5 BE bytes length) ----
	for (let i = 0; i < tocEntryCount; i++) {
		const offset = compressionBlocks[i].offset;
		const length = opts.files[i].length ?? 1024;
		// 5-byte BE write helper
		const write5 = (val: number, at: number) => {
			buf[at + 0] = (val / 0x100000000) & 0xff; // bits 32..39
			buf[at + 1] = (val >>> 24) & 0xff;
			buf[at + 2] = (val >>> 16) & 0xff;
			buf[at + 3] = (val >>> 8) & 0xff;
			buf[at + 4] = val & 0xff;
		};
		write5(offset, p);
		write5(length, p + 5);
		p += SIZEOF_OFFSET_LENGTH;
	}

	// ---- Compression blocks (5 LE offset + 3 LE compressed + 3 LE uncompressed + 1 method) ----
	for (const b of compressionBlocks) {
		const o = b.offset;
		buf[p + 0] = o & 0xff;
		buf[p + 1] = (o >>> 8) & 0xff;
		buf[p + 2] = (o >>> 16) & 0xff;
		buf[p + 3] = (o >>> 24) & 0xff;
		buf[p + 4] = (o / 0x100000000) & 0xff;
		buf[p + 5] = b.compressedSize & 0xff;
		buf[p + 6] = (b.compressedSize >>> 8) & 0xff;
		buf[p + 7] = (b.compressedSize >>> 16) & 0xff;
		buf[p + 8] = b.uncompressedSize & 0xff;
		buf[p + 9] = (b.uncompressedSize >>> 8) & 0xff;
		buf[p + 10] = (b.uncompressedSize >>> 16) & 0xff;
		buf[p + 11] = b.methodIdx;
		p += SIZEOF_BLOCK_ENTRY;
	}

	// ---- Compression method names (none in this fixture) ----

	// ---- Directory index ----
	buf.set(dirIndex, p);
	p += dirIndex.length;

	if (p !== total) throw new Error(`fixture size mismatch: ${p} vs ${total}`);
	return buf;
}

function buildDirectoryIndex(
	mountPoint: string,
	files: { path: string }[],
): Uint8Array {
	// Build a tree from the file paths.
	type Node = {
		name: string;
		// Index of first child dir, or -1 / null if none.
		children: Node[];
		// Files directly under this dir.
		files: { name: string; userData: number }[];
	};
	const root: Node = { name: '', children: [], files: [] };
	for (let i = 0; i < files.length; i++) {
		const parts = files[i].path.split('/').filter((p) => p.length > 0);
		const fileName = parts.pop()!;
		let cur = root;
		for (const part of parts) {
			let next = cur.children.find((c) => c.name === part);
			if (!next) {
				next = { name: part, children: [], files: [] };
				cur.children.push(next);
			}
			cur = next;
		}
		cur.files.push({ name: fileName, userData: i });
	}

	// Allocate sequential indices via depth-first traversal.
	type DirEntry = {
		name: number;
		firstChild: number;
		nextSibling: number;
		firstFile: number;
	};
	type FileEntry = { name: number; nextFile: number; userData: number };
	const directories: DirEntry[] = [];
	const fileEntries: FileEntry[] = [];
	const stringTable: string[] = [];
	const stringIndex = (s: string): number => {
		if (!s) return 0xffffffff;
		const idx = stringTable.indexOf(s);
		if (idx >= 0) return idx;
		stringTable.push(s);
		return stringTable.length - 1;
	};

	function emitDir(node: Node, isRoot: boolean): number {
		const idx = directories.length;
		directories.push({
			name: isRoot ? 0xffffffff : stringIndex(node.name),
			firstChild: 0xffffffff,
			nextSibling: 0xffffffff,
			firstFile: 0xffffffff,
		});
		// Files (singly-linked-listed)
		let prevFileIdx = 0xffffffff;
		for (let i = node.files.length - 1; i >= 0; i--) {
			const fe: FileEntry = {
				name: stringIndex(node.files[i].name),
				nextFile: prevFileIdx,
				userData: node.files[i].userData,
			};
			const fi = fileEntries.length;
			fileEntries.push(fe);
			prevFileIdx = fi;
		}
		directories[idx].firstFile = prevFileIdx;
		// Children (singly-linked-list via nextSibling)
		let prevDirIdx = 0xffffffff;
		for (let i = node.children.length - 1; i >= 0; i--) {
			const childIdx = emitDir(node.children[i], false);
			directories[childIdx].nextSibling = prevDirIdx;
			prevDirIdx = childIdx;
		}
		directories[idx].firstChild = prevDirIdx;
		return idx;
	}
	emitDir(root, true);

	// Now serialize: FString mountPoint + i32 dirCount + dirs + i32 fileCount + files + i32 stringCount + strings
	const writeFString = (s: string): Uint8Array => {
		// ANSI; include trailing NUL; length includes the NUL.
		const ansi = new TextEncoder().encode(s);
		const out = new Uint8Array(4 + ansi.length + 1);
		const dv = new DataView(out.buffer);
		dv.setInt32(0, ansi.length + 1, true);
		out.set(ansi, 4);
		out[4 + ansi.length] = 0;
		return out;
	};

	const parts: Uint8Array[] = [];
	parts.push(writeFString(mountPoint));

	// Dir array
	const dirBuf = new Uint8Array(4 + directories.length * 16);
	const ddv = new DataView(dirBuf.buffer);
	ddv.setInt32(0, directories.length, true);
	for (let i = 0; i < directories.length; i++) {
		const d = directories[i];
		const o = 4 + i * 16;
		ddv.setUint32(o + 0, d.name, true);
		ddv.setUint32(o + 4, d.firstChild, true);
		ddv.setUint32(o + 8, d.nextSibling, true);
		ddv.setUint32(o + 12, d.firstFile, true);
	}
	parts.push(dirBuf);

	// File array
	const fileBuf = new Uint8Array(4 + fileEntries.length * 12);
	const fdv = new DataView(fileBuf.buffer);
	fdv.setInt32(0, fileEntries.length, true);
	for (let i = 0; i < fileEntries.length; i++) {
		const f = fileEntries[i];
		const o = 4 + i * 12;
		fdv.setUint32(o + 0, f.name, true);
		fdv.setUint32(o + 4, f.nextFile, true);
		fdv.setUint32(o + 8, f.userData, true);
	}
	parts.push(fileBuf);

	// String table
	const countBuf = new Uint8Array(4);
	new DataView(countBuf.buffer).setInt32(0, stringTable.length, true);
	parts.push(countBuf);
	for (const s of stringTable) parts.push(writeFString(s));

	// Concat
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

describe('parseIoStoreToc', () => {
	it('parses a small synthetic .utoc', async () => {
		// The mount point and per-file paths in real UE containers
		// share a `../../../` prefix that points back to the project
		// root from `Engine/Saved/StagedBuilds/<Platform>/Content/`.
		// We pass clean per-file paths in this fixture so the assertion
		// expectations stay readable.
		const buf = buildSyntheticToc({
			mountPoint: '../../../',
			files: [
				{ path: 'Game/Maps/MyMap.uasset', length: 100 },
				{ path: 'Game/Textures/Pixel.uasset', length: 250 },
				{ path: 'Game/Audio/Music.uasset', length: 500 },
			],
		});
		const toc = await parseIoStoreToc(new Blob([buf]));
		expect(toc.header.version).toBe(IoStoreTocVersion.PartitionSize);
		expect(toc.compressionMethods).toEqual(['None']);
		expect(toc.mountPoint).toBe('');
		expect(toc.entries.size).toBe(3);
		const paths = [...toc.entries.keys()].sort();
		expect(paths).toContain('Game/Maps/MyMap.uasset');
		expect(paths).toContain('Game/Textures/Pixel.uasset');
		expect(paths).toContain('Game/Audio/Music.uasset');
		// Check chunk -> offset/length round-trip
		const map = toc.entries.get('Game/Maps/MyMap.uasset')!;
		expect(Number(map.length)).toBe(100);
		expect(map.chunkIndex).toBeGreaterThanOrEqual(0);
	});

	it('throws on encrypted containers', async () => {
		const buf = buildSyntheticToc({
			mountPoint: '../../../',
			files: [{ path: '../../../X.uasset' }],
			containerFlags: IO_CONTAINER_FLAG.Encrypted | IO_CONTAINER_FLAG.Indexed,
		});
		await expect(parseIoStoreToc(new Blob([buf]))).rejects.toThrow(/encrypted/i);
	});

	it('returns an empty entry map for index-less containers', async () => {
		const buf = buildSyntheticToc({
			mountPoint: '',
			files: [{ path: 'noindex' }],
			containerFlags: 0, // no Indexed flag
		});
		const toc = await parseIoStoreToc(new Blob([buf]));
		expect(toc.entries.size).toBe(0);
		// We still parsed the chunk-offset table.
		expect(toc.compressionBlocks.length).toBe(1);
	});

	it('rejects bytes that aren\'t a TOC', async () => {
		const garbage = new Uint8Array(256);
		await expect(parseIoStoreToc(new Blob([garbage]))).rejects.toThrow(/magic/i);
	});

	it('chunkBlockRange computes block ranges', async () => {
		const buf = buildSyntheticToc({
			mountPoint: '',
			files: [
				{ path: 'A', length: 100 },
				{ path: 'B', length: 200 },
			],
			compressionBlockSize: 0x100, // small block size for the test
		});
		const toc = await parseIoStoreToc(new Blob([buf]));
		const a = toc.entries.get('A')!;
		const r = chunkBlockRange(toc, a)!;
		expect(r.firstBlock).toBe(0);
		expect(r.totalLength).toBe(100);
	});
});
