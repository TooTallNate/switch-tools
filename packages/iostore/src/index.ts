/**
 * Unreal Engine 4 / Unreal Engine 5 IoStore container parser.
 *
 * IoStore is the modern UE asset container format used on Switch,
 * PS5, Xbox Series X|S, Stadia, and (optionally) PC builds. A
 * single container is split across two on-disk files:
 *
 *   - `.utoc`  Table of Contents — file index, chunk hashes, the
 *              compression-block table, and the directory index
 *              (mount point + tree of directories + files keyed by
 *              chunk index)
 *   - `.ucas`  Container — concatenated compression blocks holding
 *              the actual payload bytes
 *
 * This module parses the `.utoc` and exposes a directory tree that
 * lets the caller pull individual logical files out of the matching
 * `.ucas`. Compression decoding (zlib / oodle / zstd) is delegated
 * to the caller so the package itself stays free of native deps.
 *
 * Reference (canonical): CUE4Parse — IoStoreReader.cs and the
 *   FIoStoreToc* / FIoDirectoryIndex* / FIoFileIndex* structs in
 *   CUE4Parse/UE4/IO/Objects/.
 *
 * Limitations:
 *   - Encrypted containers (`EIoContainerFlags.Encrypted`) require
 *     an AES key that this parser does not provide. We surface the
 *     `EncryptionKeyGuid` so callers can look one up.
 *   - The actual UAsset / UExp payload format inside individual
 *     chunks is NOT parsed. Callers get raw decompressed bytes per
 *     entry.
 *   - On-demand TOCs (`EIoContainerFlags.OnDemand`) are not
 *     supported — those stream chunks over HTTP rather than from a
 *     local `.ucas`.
 */

const TOC_MAGIC = new Uint8Array([
	0x2d, 0x3d, 0x3d, 0x2d, 0x2d, 0x3d, 0x3d, 0x2d,
	0x2d, 0x3d, 0x3d, 0x2d, 0x2d, 0x3d, 0x3d, 0x2d,
]); // "-==--==--==--==-"

const TOC_HEADER_SIZE = 144;
const SIZEOF_FIO_CHUNK_ID = 12;
const SIZEOF_FIO_OFFSET_AND_LENGTH = 10;
const SIZEOF_FIO_COMPRESSED_BLOCK_ENTRY = 12;
const SIZEOF_FIO_DIRECTORY_INDEX_ENTRY = 16;
const SIZEOF_FIO_FILE_INDEX_ENTRY = 12;
const SIZEOF_FSHA_HASH = 20;

const INVALID_HANDLE = 0xffffffff;

/**
 * IoStore TOC version progression. Newer versions add fields after
 * the v1 header; we read the version byte and feature-gate
 * accordingly to support older Switch titles that ship pre-UE5
 * containers.
 */
export const enum IoStoreTocVersion {
	Invalid = 0,
	Initial = 1,
	DirectoryIndex = 2,
	PartitionSize = 3,
	PerfectHash = 4,
	PerfectHashWithOverflow = 5,
	OnDemandMetaData = 6,
	RemovedOnDemandMetaData = 7,
	ReplaceIoChunkHashWithIoHash = 8,
}

export const IO_CONTAINER_FLAG = {
	None: 0,
	Compressed: 1 << 0,
	Encrypted: 1 << 1,
	Signed: 1 << 2,
	Indexed: 1 << 3,
	OnDemand: 1 << 4,
} as const;

/** Parsed `.utoc` header fields. */
export interface IoStoreTocHeader {
	/** Raw magic bytes (always `"-==--==--==--==-"`). */
	magic: Uint8Array;
	version: number;
	tocHeaderSize: number;
	tocEntryCount: number;
	tocCompressedBlockEntryCount: number;
	tocCompressedBlockEntrySize: number;
	compressionMethodNameCount: number;
	compressionMethodNameLength: number;
	/** Size of one decompressed block (typically 0x10000 = 64 KiB). */
	compressionBlockSize: number;
	directoryIndexSize: number;
	partitionCount: number;
	containerId: bigint;
	encryptionKeyGuid: Uint8Array;
	containerFlags: number;
	tocChunkPerfectHashSeedsCount: number;
	partitionSize: bigint;
	tocChunksWithoutPerfectHashCount: number;
}

/** A single (offset, length) pair within the logical container space. */
export interface IoOffsetAndLength {
	offset: bigint;
	length: bigint;
}

/** Compression block entry in the global compression block table. */
export interface IoCompressionBlock {
	/** Byte offset within the (potentially partitioned) `.ucas`. */
	offset: bigint;
	/** Compressed (on-disk) size in bytes. */
	compressedSize: number;
	/** Decompressed size in bytes. */
	uncompressedSize: number;
	/**
	 * Index into `IoStoreToc.compressionMethods`. `0` means
	 * uncompressed (the block is copied verbatim).
	 */
	compressionMethodIndex: number;
}

/**
 * Logical chunk entry — one file in the container. The file's bytes
 * are the concatenation of all compression blocks covering
 * `[offset, offset + length)` in the container's logical space.
 */
export interface IoChunkEntry {
	/**
	 * Logical path inside the container, e.g.
	 * `"../../../CCFF7R/Content/Maps/Map.uasset"`. Relative to the
	 * mount point.
	 */
	path: string;
	chunkIndex: number;
	chunkId: Uint8Array;
	offset: bigint;
	length: bigint;
}

/** Top-level parsed IoStore TOC. */
export interface IoStoreToc {
	header: IoStoreTocHeader;
	/** Mount point prepended to every entry path. Often `"../../../"`. */
	mountPoint: string;
	/** Compression method names (e.g. `["Zlib", "Oodle"]`). */
	compressionMethods: string[];
	/** Compression block table; each chunk references one or more by index. */
	compressionBlocks: IoCompressionBlock[];
	/**
	 * All logical files in the container, keyed by mount-point-
	 * relative path. Iteration order matches the directory-index
	 * walk so callers that just want a tree can build one in order.
	 */
	entries: Map<string, IoChunkEntry>;
}

class Reader {
	pos = 0;
	private readonly view: DataView;
	constructor(public readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	u8(): number {
		const v = this.view.getUint8(this.pos);
		this.pos += 1;
		return v;
	}
	u16(): number {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}
	u32(): number {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}
	i32(): number {
		const v = this.view.getInt32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u64(): bigint {
		const v = this.view.getBigUint64(this.pos, true);
		this.pos += 8;
		return v;
	}
	bytes_(n: number): Uint8Array {
		const v = this.bytes.subarray(this.pos, this.pos + n);
		this.pos += n;
		return v;
	}
	skip(n: number): void {
		this.pos += n;
	}
	align(boundary: number): void {
		const rem = this.pos % boundary;
		if (rem !== 0) this.pos += boundary - rem;
	}
}

/**
 * UE-style FString:
 *   i32 length;
 *     length > 0  → ANSI, `length` bytes including trailing NUL
 *     length == 0 → empty string
 *     length < 0  → UTF-16 LE, `-length` chars (i.e. -length*2 bytes)
 *                   including trailing NUL
 */
function readFString(r: Reader): string {
	const length = r.i32();
	if (length === 0) return '';
	if (length > 0) {
		// ANSI; trim trailing NUL
		const slice = r.bytes_(length);
		const end = slice[slice.length - 1] === 0 ? slice.length - 1 : slice.length;
		return new TextDecoder('latin1').decode(slice.subarray(0, end));
	}
	// UTF-16 LE
	const charCount = -length;
	const byteLen = charCount * 2;
	const slice = r.bytes_(byteLen);
	// Trim trailing NUL char (last 2 bytes if both zero).
	const end =
		slice[byteLen - 2] === 0 && slice[byteLen - 1] === 0 ? byteLen - 2 : byteLen;
	return new TextDecoder('utf-16le').decode(slice.subarray(0, end));
}

/**
 * Read the `.utoc` header.
 *
 * The on-disk struct is fixed-size (`TOC_HEADER_SIZE` = 144 bytes)
 * regardless of TOC version; older versions just leave newer fields
 * zeroed. We don't validate `tocHeaderSize` against `SIZE` because
 * the spec allows it to grow.
 */
function readTocHeader(r: Reader): IoStoreTocHeader {
	const magic = r.bytes_(16);
	for (let i = 0; i < 16; i++) {
		if (magic[i] !== TOC_MAGIC[i]) {
			throw new Error(
				`Not an IoStore TOC: magic bytes don't match (expected "-==--==--==--==-")`,
			);
		}
	}
	const version = r.u8();
	r.skip(1); // _reserved0
	r.skip(2); // _reserved1
	const tocHeaderSize = r.u32();
	const tocEntryCount = r.u32();
	const tocCompressedBlockEntryCount = r.u32();
	const tocCompressedBlockEntrySize = r.u32();
	const compressionMethodNameCount = r.u32();
	const compressionMethodNameLength = r.u32();
	const compressionBlockSize = r.u32();
	const directoryIndexSize = r.u32();
	let partitionCount = r.u32();
	const containerId = r.u64();
	const encryptionKeyGuid = r.bytes_(16);
	const containerFlags = r.u32();
	const tocChunkPerfectHashSeedsCount = r.u32();
	let partitionSize = r.u64();
	const tocChunksWithoutPerfectHashCount = r.u32();
	r.skip(4); // _reserved7
	r.skip(8 * 5); // _reserved8

	if (version < IoStoreTocVersion.PartitionSize) {
		partitionCount = 1;
		partitionSize = 0xffffffffffffffffn;
	}

	return {
		magic,
		version,
		tocHeaderSize,
		tocEntryCount,
		tocCompressedBlockEntryCount,
		tocCompressedBlockEntrySize,
		compressionMethodNameCount,
		compressionMethodNameLength,
		compressionBlockSize,
		directoryIndexSize,
		partitionCount,
		containerId,
		encryptionKeyGuid,
		containerFlags,
		tocChunkPerfectHashSeedsCount,
		partitionSize,
		tocChunksWithoutPerfectHashCount,
	};
}

/**
 * `FIoOffsetAndLength` is packed as 5 big-endian bytes for `offset`
 * + 5 big-endian bytes for `length` (10 bytes total, sized for
 * 40-bit values). 40 bits is plenty: 2^40 = 1 TB.
 */
function readOffsetAndLength(r: Reader): IoOffsetAndLength {
	const b = r.bytes_(SIZEOF_FIO_OFFSET_AND_LENGTH);
	const offset =
		(BigInt(b[0]) << 32n) |
		(BigInt(b[1]) << 24n) |
		(BigInt(b[2]) << 16n) |
		(BigInt(b[3]) << 8n) |
		BigInt(b[4]);
	const length =
		(BigInt(b[5]) << 32n) |
		(BigInt(b[6]) << 24n) |
		(BigInt(b[7]) << 16n) |
		(BigInt(b[8]) << 8n) |
		BigInt(b[9]);
	return { offset, length };
}

/**
 * `FIoStoreTocCompressedBlockEntry` is bit-packed:
 *
 *   bytes 0..4   offset (40-bit little-endian)
 *   bytes 5..7   compressedSize (24-bit little-endian)
 *   bytes 8..10  uncompressedSize (24-bit little-endian)
 *   byte  11     compressionMethodIndex (0 = uncompressed)
 *
 * Total 12 bytes, no padding.
 */
function readCompressionBlock(r: Reader): IoCompressionBlock {
	const b = r.bytes_(SIZEOF_FIO_COMPRESSED_BLOCK_ENTRY);
	const offset =
		BigInt(b[0]) |
		(BigInt(b[1]) << 8n) |
		(BigInt(b[2]) << 16n) |
		(BigInt(b[3]) << 24n) |
		(BigInt(b[4]) << 32n);
	const compressedSize = b[5] | (b[6] << 8) | (b[7] << 16);
	const uncompressedSize = b[8] | (b[9] << 8) | (b[10] << 16);
	const compressionMethodIndex = b[11];
	return { offset, compressedSize, uncompressedSize, compressionMethodIndex };
}

/**
 * Parse an IoStore `.utoc` file into a directory tree of logical
 * files. The matching `.ucas` is not read here — call
 * {@link readChunk} or build your own reader on top of
 * {@link IoChunkEntry.offset} / `length` and the `compressionBlocks`
 * table.
 *
 * @throws if the magic is wrong, the container is encrypted (no key
 *   support is provided), or the directory index is missing.
 */
export async function parseIoStoreToc(blob: Blob): Promise<IoStoreToc> {
	// Read the whole TOC into memory. TOCs are small (single-digit
	// MB even for huge containers) so this is fine.
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const r = new Reader(bytes);

	const header = readTocHeader(r);

	if (header.containerFlags & IO_CONTAINER_FLAG.Encrypted) {
		throw new Error(
			`IoStore container is encrypted (key GUID ${guidToString(header.encryptionKeyGuid)}); decryption is not supported by this parser`,
		);
	}
	if (header.containerFlags & IO_CONTAINER_FLAG.OnDemand) {
		throw new Error(
			'IoStore on-demand containers (HTTP-streamed) are not supported',
		);
	}
	if (header.version < IoStoreTocVersion.DirectoryIndex) {
		throw new Error(
			`IoStore TOC version ${header.version} is too old (need v${IoStoreTocVersion.DirectoryIndex}+)`,
		);
	}
	// `Indexed` flag missing is fine — `global.utoc` and similar
	// metadata-only containers don't ship a directory index. Callers
	// can still access bytes via the chunk-ID/offset/length tables;
	// `entries` will simply be empty.
	const hasDirectoryIndex =
		(header.containerFlags & IO_CONTAINER_FLAG.Indexed) !== 0;

	// 1. ChunkIds (12 bytes each)
	const chunkIds = bytes.subarray(
		r.pos,
		r.pos + header.tocEntryCount * SIZEOF_FIO_CHUNK_ID,
	);
	r.skip(header.tocEntryCount * SIZEOF_FIO_CHUNK_ID);

	// 2. ChunkOffsetLengths (10 bytes each)
	const chunkOffsetLengths: IoOffsetAndLength[] = new Array(header.tocEntryCount);
	for (let i = 0; i < header.tocEntryCount; i++) {
		chunkOffsetLengths[i] = readOffsetAndLength(r);
	}

	// 3. Perfect-hash maps (skip — we don't need them for tree
	//    listing; the directory index has all the per-file links).
	if (header.version >= IoStoreTocVersion.PerfectHashWithOverflow) {
		r.skip(header.tocChunkPerfectHashSeedsCount * 4);
		r.skip(header.tocChunksWithoutPerfectHashCount * 4);
	} else if (header.version >= IoStoreTocVersion.PerfectHash) {
		r.skip(header.tocChunkPerfectHashSeedsCount * 4);
	}

	// 4. Compression block entries
	const compressionBlocks: IoCompressionBlock[] = new Array(
		header.tocCompressedBlockEntryCount,
	);
	for (let i = 0; i < header.tocCompressedBlockEntryCount; i++) {
		compressionBlocks[i] = readCompressionBlock(r);
	}

	// 5. Compression method names — fixed-width slots, padded with NULs
	const compressionMethods: string[] = ['None'];
	for (let i = 0; i < header.compressionMethodNameCount; i++) {
		const slot = r.bytes_(header.compressionMethodNameLength);
		// Find first NUL
		let end = 0;
		while (end < slot.length && slot[end] !== 0) end++;
		const name = new TextDecoder('latin1').decode(slot.subarray(0, end));
		if (name) compressionMethods.push(name);
	}

	// 6. Skip signatures if present
	if (header.containerFlags & IO_CONTAINER_FLAG.Signed) {
		const hashSize = r.i32();
		r.skip(hashSize); // tocSignature
		r.skip(hashSize); // blockSignature
		r.skip(SIZEOF_FSHA_HASH * header.tocCompressedBlockEntryCount);
	}

	// 7. Directory index buffer
	let mountPoint = '';
	let entries: Map<string, IoChunkEntry> = new Map();
	if (hasDirectoryIndex && header.directoryIndexSize > 0) {
		const dirIndex = bytes.subarray(r.pos, r.pos + header.directoryIndexSize);
		r.skip(header.directoryIndexSize);
		entries = walkDirectoryIndex(dirIndex, chunkOffsetLengths, chunkIds);
		// Mount point lives inside the dir index buffer; re-read from
		// there for our return value.
		const dirReader = new Reader(dirIndex);
		mountPoint = normalizeMountPoint(readFString(dirReader));
	}

	return {
		header,
		mountPoint,
		compressionMethods,
		compressionBlocks,
		entries,
	};
}

/**
 * Walk the directory index buffer and produce a path → chunk
 * mapping. The buffer is laid out as:
 *
 *   FString             mountPoint
 *   FIoDirectoryIndexEntry[]   directories  (i32 count + 16 B each)
 *   FIoFileIndexEntry[]        files        (i32 count + 12 B each)
 *   FStringMemoryArray         stringTable  (i32 count + per-FString)
 *
 * Directories form a sibling/child tree rooted at index 0.
 */
function walkDirectoryIndex(
	dirIndex: Uint8Array,
	chunkOffsetLengths: IoOffsetAndLength[],
	chunkIds: Uint8Array,
): Map<string, IoChunkEntry> {
	const r = new Reader(dirIndex);
	const mountPoint = normalizeMountPoint(readFString(r));

	// Directories
	const dirCount = r.i32();
	const dirView = new DataView(dirIndex.buffer, dirIndex.byteOffset);
	const dirsStart = r.pos;
	r.skip(dirCount * SIZEOF_FIO_DIRECTORY_INDEX_ENTRY);

	// Files
	const fileCount = r.i32();
	const filesStart = r.pos;
	r.skip(fileCount * SIZEOF_FIO_FILE_INDEX_ENTRY);

	// String table
	const stringCount = r.i32();
	const stringTable: string[] = new Array(stringCount);
	for (let i = 0; i < stringCount; i++) stringTable[i] = readFString(r);

	function dirAt(idx: number): {
		name: number;
		firstChild: number;
		nextSibling: number;
		firstFile: number;
	} {
		const o = dirsStart + idx * SIZEOF_FIO_DIRECTORY_INDEX_ENTRY;
		return {
			name: dirView.getUint32(o + 0, true),
			firstChild: dirView.getUint32(o + 4, true),
			nextSibling: dirView.getUint32(o + 8, true),
			firstFile: dirView.getUint32(o + 12, true),
		};
	}
	function fileAt(idx: number): {
		name: number;
		nextFile: number;
		userData: number;
	} {
		const o = filesStart + idx * SIZEOF_FIO_FILE_INDEX_ENTRY;
		return {
			name: dirView.getUint32(o + 0, true),
			nextFile: dirView.getUint32(o + 4, true),
			userData: dirView.getUint32(o + 8, true),
		};
	}

	const out = new Map<string, IoChunkEntry>();
	const visited = new Set<number>();

	function recurse(dirIdx: number, currentPath: string): void {
		let cur = dirIdx;
		while (cur !== INVALID_HANDLE) {
			if (visited.has(cur)) return; // defend against cycles
			visited.add(cur);
			const d = dirAt(cur);
			let dirPath = currentPath;
			if (d.name !== INVALID_HANDLE) {
				const part = stringTable[d.name];
				if (part) dirPath = dirPath ? `${dirPath}/${part}` : part;
			}

			// Files in this directory
			let fileIdx = d.firstFile;
			while (fileIdx !== INVALID_HANDLE) {
				const f = fileAt(fileIdx);
				const namePart = stringTable[f.name];
				const fullPath = dirPath ? `${dirPath}/${namePart}` : namePart;
				const userData = f.userData;
				if (userData < chunkOffsetLengths.length) {
					const ol = chunkOffsetLengths[userData];
					const chunkId = chunkIds.subarray(
						userData * SIZEOF_FIO_CHUNK_ID,
						(userData + 1) * SIZEOF_FIO_CHUNK_ID,
					);
					out.set(fullPath, {
						path: fullPath,
						chunkIndex: userData,
						chunkId,
						offset: ol.offset,
						length: ol.length,
					});
				}
				fileIdx = f.nextFile;
			}

			recurse(d.firstChild, dirPath);
			cur = d.nextSibling;
		}
	}

	if (dirCount > 0) recurse(0, mountPoint);
	return out;
}

function normalizeMountPoint(mp: string): string {
	// Drop trailing slash and the leading `../../../...` chain (it's
	// a UE-build-tree artifact and adds noise to the listing).
	let s = mp.replace(/\/+$/, '');
	while (s.startsWith('../')) s = s.slice(3);
	if (s === '..') s = '';
	return s.replace(/^\/+/, '');
}

function guidToString(g: Uint8Array): string {
	const hex = (i: number) => g[i].toString(16).padStart(2, '0');
	return `${hex(3)}${hex(2)}${hex(1)}${hex(0)}-${hex(5)}${hex(4)}-${hex(7)}${hex(6)}-${hex(8)}${hex(9)}-${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`;
}

/**
 * Returns the on-disk byte range in the `.ucas` covering a given
 * chunk's logical bytes. Each chunk maps to one or more
 * compression blocks; this function returns the range of
 * compression-block indices and the byte offset within the first
 * block at which the chunk actually starts. Use that with the
 * caller's decompressor of choice (zlib / oodle / zstd / etc.).
 *
 * @returns `null` if the chunk's offset/length don't fall on
 *   compression-block-size boundaries (shouldn't happen for valid
 *   containers).
 */
export function chunkBlockRange(
	toc: IoStoreToc,
	entry: IoChunkEntry,
): {
	firstBlock: number;
	lastBlockExclusive: number;
	offsetInFirstBlock: number;
	totalLength: number;
} | null {
	const blockSize = BigInt(toc.header.compressionBlockSize);
	const firstBlock = Number(entry.offset / blockSize);
	const offsetInFirstBlock = Number(entry.offset % blockSize);
	const lastBlockExclusive = Number(
		(entry.offset + entry.length + blockSize - 1n) / blockSize,
	);
	if (
		firstBlock < 0 ||
		lastBlockExclusive > toc.compressionBlocks.length
	) {
		return null;
	}
	return {
		firstBlock,
		lastBlockExclusive,
		offsetInFirstBlock,
		totalLength: Number(entry.length),
	};
}

/**
 * Read the raw on-disk bytes for a single compression block from
 * the `.ucas`. The caller is responsible for selecting the right
 * `.ucas` partition (the parser doesn't track partitions because
 * single-`.ucas` containers cover ~99% of real-world cases). For
 * multi-partition containers, the partition index is
 * `floor(block.offset / toc.header.partitionSize)` and the offset
 * within that partition is `block.offset % toc.header.partitionSize`.
 */
export function ucasBlockRange(
	block: IoCompressionBlock,
): { start: number; end: number } {
	const start = Number(block.offset);
	return { start, end: start + block.compressedSize };
}
