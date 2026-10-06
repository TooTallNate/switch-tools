/**
 * Parser for Unity AssetBundles (the "UnityFS" container).
 *
 * AssetBundles are how Unity-engine games ship their asset payloads:
 * textures, meshes, audio, prefabs, scripts (the metadata, not IL2CPP
 * code), animations, fonts, etc. On Switch this format shows up
 * everywhere — Hollow Knight, Stardew Valley, Hades, Disco Elysium,
 * Slay the Spire, Cuphead, Cult of the Lamb, ENDER LILIES, and many
 * more all bundle their content this way. RomFS layouts typically
 * include a `Data/` directory with `globalgamemanagers`, `levelN`,
 * `sharedassetsN.assets`, plus `StreamingAssets/aa/*.bundle` or
 * `*.unity3d` files — all of which start with the `UnityFS` magic.
 *
 * We parse the bundle envelope: header, block info, and node
 * directory, then expose each *node* (an inner virtual file like
 * `level0` or `CAB-xxxxxxxxxxxx`) as a lazy `Blob`. We DON'T parse
 * the inner Unity SerializedFile objects (Texture2D / AudioClip /
 * GameObject etc.) — that's a separate, much larger project handled
 * by tools like AssetStudio / AssetRipper. Browsing stops at "here
 * are the inner files", from which the user can drill into binary /
 * text / hex previews like any other archive.
 *
 * Wire format (multi-byte integers are big-endian throughout):
 *
 *   Header:
 *     signature    NUL-terminated string ("UnityFS" / "UnityWeb" / …)
 *     version      u32                   (we only support v6+ "UnityFS")
 *     unityVersion NUL-terminated string ("5.x.x")
 *     unityRevision NUL-terminated string ("2021.3.30f1")
 *     size         i64                   total bundle size
 *     blocksInfoCompressedSize    u32
 *     blocksInfoUncompressedSize  u32
 *     flags        u32                   compression + layout bits
 *
 *   [if version ≥ 7: align to 16 bytes]
 *
 *   blocksInfo block (compressed per `flags & 0x3F`, possibly LZ4):
 *     hash        16 bytes (ignored)
 *     blocksCount i32
 *     blocks[] each:
 *       uncompressedSize u32
 *       compressedSize   u32
 *       flags            u16   (compression bits in the low 6)
 *     nodesCount  i32
 *     nodes[] each:
 *       offset      i64   relative to start of decompressed block stream
 *       size        i64
 *       flags       u32
 *       path        NUL-terminated string
 *
 *   [if flags & 0x200: align to 16 bytes]
 *
 *   blocks[] concatenated, each LZ4/LZHAM/LZMA/None per the storage
 *   block's own flags. Decompressed concatenation = "block stream"
 *   that the node directory indexes into.
 *
 * Reference: AssetStudio's `BundleFile.cs` (Perfare/AssetStudio).
 */

import { decodeBlock as lz4DecodeBlock } from '@tootallnate/lz4';

// --- Compression type enum (low 6 bits of various `flags` fields) ---
const COMPRESSION_NONE = 0;
const COMPRESSION_LZMA = 1;
const COMPRESSION_LZ4 = 2;
const COMPRESSION_LZ4HC = 3;
const COMPRESSION_LZHAM = 4;

// --- Archive flag bits ---
/** Compression type for the blocksInfo block lives in the low 6 bits. */
const FLAG_COMPRESSION_MASK = 0x3f;
/** When set, blocksInfo lives at the END of the file rather than after the header. */
const FLAG_BLOCKS_INFO_AT_END = 0x80;
/** When set, the block stream is padded to a 16-byte boundary. */
const FLAG_BLOCK_INFO_NEED_PADDING_AT_START = 0x200;

// --- Storage-block flag bits ---
const STORAGE_FLAG_COMPRESSION_MASK = 0x3f;

export interface UnityFsHeader {
	signature: string;
	version: number;
	unityVersion: string;
	unityRevision: string;
	size: number;
	compressedBlocksInfoSize: number;
	uncompressedBlocksInfoSize: number;
	flags: number;
}

export interface UnityFsNode {
	/** Path relative to the bundle root (`/`-delimited). */
	path: string;
	/** Offset within the decompressed block stream. */
	offset: number;
	/** Size in bytes. */
	size: number;
	/** Per-node flags (typically 0 or a Streamed flag). */
	flags: number;
	/** Lazy `Blob` holding the decompressed bytes for this node. */
	data: Blob;
}

export interface ParsedUnityFs {
	header: UnityFsHeader;
	nodes: UnityFsNode[];
}

/** Cheap (8-byte) check for the `UnityFS` magic. */
export async function isUnityFs(blob: Blob): Promise<boolean> {
	if (blob.size < 8) return false;
	const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
	// "UnityFS" + NUL = 8 bytes
	return (
		head[0] === 0x55 && // U
		head[1] === 0x6e && // n
		head[2] === 0x69 && // i
		head[3] === 0x74 && // t
		head[4] === 0x79 && // y
		head[5] === 0x46 && // F
		head[6] === 0x53 && // S
		head[7] === 0x00 // NUL
	);
}

/**
 * Parse a UnityFS bundle's header + directory and expose its inner
 * nodes as lazy `Blob`s. The block stream is decompressed eagerly
 * the first time any node is read (then cached) — bundles are
 * typically a few MB to tens of MB, so holding the decompressed
 * bytes in memory is a fine trade-off for simpler code.
 *
 * Throws on:
 *   - Non-`UnityFS` magic.
 *   - Unsupported header `version` (only v6+ is implemented).
 *   - Unsupported compression types (LZMA / LZHAM not bundled).
 *
 * Lazy node `data` getters throw on first read for unsupported
 * compressions inside individual blocks; the parse itself succeeds
 * so the rest of the directory is still browsable.
 */
export async function parseUnityFs(blob: Blob): Promise<ParsedUnityFs> {
	if (blob.size < 64) {
		throw new Error(
			`Blob too small to be a UnityFS bundle (${blob.size} bytes)`,
		);
	}

	// Read enough of the start to cover the header + reasonable
	// strings. Headers are typically < 80 bytes; 256 is comfortable.
	const headBuf = new Uint8Array(
		await blob.slice(0, Math.min(blob.size, 256)).arrayBuffer(),
	);
	const headerReader = new BigEndianReader(headBuf);
	const signature = headerReader.readCString();
	if (signature !== 'UnityFS') {
		// The signature is a NUL-terminated string from arbitrary file
		// bytes — for non-UnityFS inputs (e.g. encrypted/wrapped
		// AssetBundles) it's full of high-byte garbage that Unicode-
		// renders as replacement characters. Show the first few bytes
		// in hex so the error stays readable.
		const previewHex = [...headBuf.subarray(0, 16)]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join(' ');
		throw new Error(
			`Not a UnityFS bundle (expected "UnityFS\\0" magic at offset 0, got bytes ${previewHex})`,
		);
	}
	const version = headerReader.readU32();
	if (version < 6) {
		throw new Error(
			`Unsupported UnityFS version ${version} (need v6 or higher)`,
		);
	}
	const unityVersion = headerReader.readCString();
	const unityRevision = headerReader.readCString();
	// `size` is i64 BE. We clamp via Number — bundles never approach
	// MAX_SAFE_INTEGER so this is fine.
	const size = headerReader.readI64();
	const compressedBlocksInfoSize = headerReader.readU32();
	const uncompressedBlocksInfoSize = headerReader.readU32();
	const flags = headerReader.readU32();

	// Version ≥ 7 requires a 16-byte alignment after the header.
	let postHeaderPos = headerReader.pos;
	if (version >= 7) postHeaderPos = alignUp(postHeaderPos, 16);

	const header: UnityFsHeader = {
		signature,
		version,
		unityVersion,
		unityRevision,
		size,
		compressedBlocksInfoSize,
		uncompressedBlocksInfoSize,
		flags,
	};

	// --- Read the compressed blocksInfo block. It may be at the end
	// of the file (flag 0x80) or right after the header. ---
	const blocksInfoOffset =
		(flags & FLAG_BLOCKS_INFO_AT_END) !== 0
			? blob.size - compressedBlocksInfoSize
			: postHeaderPos;
	const blocksInfoCompressed = new Uint8Array(
		await blob
			.slice(
				blocksInfoOffset,
				blocksInfoOffset + compressedBlocksInfoSize,
			)
			.arrayBuffer(),
	);
	const blocksInfoUncompressed = decompressBlock(
		blocksInfoCompressed,
		uncompressedBlocksInfoSize,
		flags & FLAG_COMPRESSION_MASK,
		'blocksInfo',
	);

	// --- Parse the blocksInfo: hash, storage-block list, node list. ---
	const biReader = new BigEndianReader(blocksInfoUncompressed);
	biReader.skip(16); // uncompressedDataHash
	const blocksCount = biReader.readI32();
	const storageBlocks: StorageBlock[] = [];
	for (let i = 0; i < blocksCount; i++) {
		storageBlocks.push({
			uncompressedSize: biReader.readU32(),
			compressedSize: biReader.readU32(),
			flags: biReader.readU16(),
		});
	}
	const nodesCount = biReader.readI32();
	const directory: DirectoryEntry[] = [];
	for (let i = 0; i < nodesCount; i++) {
		directory.push({
			offset: biReader.readI64(),
			size: biReader.readI64(),
			flags: biReader.readU32(),
			path: biReader.readCString(),
		});
	}

	// --- Locate the start of the actual block stream. ---
	// When blocksInfo lives after the header, the block stream
	// follows immediately after the (compressed) blocksInfo block.
	// When it lives at the end, the block stream starts right after
	// the header (or its 16-byte-aligned successor).
	let blockStreamFileOffset =
		(flags & FLAG_BLOCKS_INFO_AT_END) !== 0
			? postHeaderPos
			: blocksInfoOffset + compressedBlocksInfoSize;
	if ((flags & FLAG_BLOCK_INFO_NEED_PADDING_AT_START) !== 0) {
		blockStreamFileOffset = alignUp(blockStreamFileOffset, 16);
	}

	// --- Random-access block stream. ---
	// Node reads decompress only the storage blocks they overlap
	// (typically 128 KiB LZ4 chunks), via a shared size-bounded cache.
	// Materialising the whole stream instead would pin every bundle
	// the user (or a tree search) has touched in memory.
	const stream = new BlockStream(blob, blockStreamFileOffset, storageBlocks);

	// --- Build the lazy node list. ---
	const nodes: UnityFsNode[] = directory.map((entry) => {
		const data = makeRangeBlob(stream, entry.offset, entry.size);
		return {
			path: entry.path,
			offset: entry.offset,
			size: entry.size,
			flags: entry.flags,
			data,
		};
	});

	return { header, nodes };
}

interface StorageBlock {
	uncompressedSize: number;
	compressedSize: number;
	flags: number;
}

interface DirectoryEntry {
	offset: number;
	size: number;
	flags: number;
	path: string;
}

/**
 * Global cache of decompressed storage blocks, bounded by total
 * bytes. `Map` iteration order doubles as LRU order (re-inserted on
 * hit). Shared across bundles so the bound holds no matter how many
 * bundles are open.
 */
const BLOCK_CACHE_BUDGET = 96 * 1024 * 1024;
const blockCache = new Map<string, Promise<Uint8Array>>();
const blockCacheSizes = new Map<string, number>();
let blockCacheBytes = 0;
let nextStreamId = 0;

function cacheGet(key: string): Promise<Uint8Array> | undefined {
	const hit = blockCache.get(key);
	if (hit) {
		blockCache.delete(key);
		blockCache.set(key, hit);
	}
	return hit;
}

function cachePut(key: string, value: Promise<Uint8Array>, size: number): void {
	blockCache.set(key, value);
	blockCacheSizes.set(key, size);
	blockCacheBytes += size;
	for (const k of blockCache.keys()) {
		if (blockCacheBytes <= BLOCK_CACHE_BUDGET || k === key) break;
		blockCacheBytes -= blockCacheSizes.get(k) ?? 0;
		blockCache.delete(k);
		blockCacheSizes.delete(k);
	}
}

/**
 * Random access into a bundle's decompressed block stream. Node
 * offsets index this stream; each storage block decompresses
 * independently, so a read only touches the blocks it overlaps.
 */
class BlockStream {
	private readonly id = nextStreamId++;
	/** Uncompressed start offset of each block (plus a final total). */
	private readonly starts: number[] = [];
	/** File offset of each block's compressed bytes. */
	private readonly fileOffsets: number[] = [];

	constructor(
		private readonly blob: Blob,
		streamFileOffset: number,
		private readonly blocks: StorageBlock[],
	) {
		let u = 0;
		let f = streamFileOffset;
		for (const b of blocks) {
			this.starts.push(u);
			this.fileOffsets.push(f);
			u += b.uncompressedSize;
			f += b.compressedSize;
		}
		this.starts.push(u);
	}

	/** Index of the block containing uncompressed offset `pos`. */
	private blockAt(pos: number): number {
		let lo = 0;
		let hi = this.blocks.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.starts[mid]! <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}

	private block(i: number): Promise<Uint8Array> {
		const key = `${this.id}:${i}`;
		const hit = cacheGet(key);
		if (hit) return hit;
		const b = this.blocks[i]!;
		const p = (async () => {
			const off = this.fileOffsets[i]!;
			const compressed = new Uint8Array(
				await this.blob.slice(off, off + b.compressedSize).arrayBuffer(),
			);
			return decompressBlock(
				compressed,
				b.uncompressedSize,
				b.flags & STORAGE_FLAG_COMPRESSION_MASK,
				'block',
			);
		})();
		// Failed reads mustn't poison the cache.
		p.catch(() => {
			if (blockCache.get(key) === p) {
				blockCacheBytes -= blockCacheSizes.get(key) ?? 0;
				blockCache.delete(key);
				blockCacheSizes.delete(key);
			}
		});
		cachePut(key, p, b.uncompressedSize);
		return p;
	}

	/** Copy uncompressed bytes `[start, end)` out of the stream. */
	async read(start: number, end: number): Promise<Uint8Array> {
		const out = new Uint8Array(Math.max(0, end - start));
		if (out.length === 0 || this.blocks.length === 0) return out;
		const first = this.blockAt(start);
		const last = this.blockAt(end - 1);
		const parts = await Promise.all(
			Array.from({ length: last - first + 1 }, (_, k) => this.block(first + k)),
		);
		for (let k = 0; k < parts.length; k++) {
			const i = first + k;
			const blockStart = this.starts[i]!;
			const from = Math.max(start, blockStart) - blockStart;
			const to = Math.min(end, this.starts[i + 1]!) - blockStart;
			out.set(parts[k]!.subarray(from, to), blockStart + from - start);
		}
		return out;
	}
}

/**
 * Run a single block (or the blocksInfo block) through the right
 * decompressor based on its compression-type bits. Returns a
 * `Uint8Array` of exactly `expectedSize` bytes.
 */
function decompressBlock(
	compressed: Uint8Array,
	expectedSize: number,
	compressionType: number,
	context: 'blocksInfo' | 'block',
): Uint8Array {
	switch (compressionType) {
		case COMPRESSION_NONE:
			if (compressed.length !== expectedSize) {
				throw new Error(
					`UnityFS: ${context} reports compressionType=None but compressedSize (${compressed.length}) ≠ uncompressedSize (${expectedSize})`,
				);
			}
			return compressed;
		case COMPRESSION_LZ4:
		case COMPRESSION_LZ4HC:
			// LZ4 and LZ4HC use the same on-disk block format — only
			// the encoder differs. Our decoder handles both.
			return lz4DecodeBlock(compressed, expectedSize);
		case COMPRESSION_LZMA:
			throw new Error(
				`UnityFS: ${context} uses LZMA compression, which is not supported. (Most Switch bundles use LZ4 — try a different file or convert with UnityPy / AssetStudio.)`,
			);
		case COMPRESSION_LZHAM:
			throw new Error(
				`UnityFS: ${context} uses LZHAM compression, which is not supported.`,
			);
		default:
			throw new Error(
				`UnityFS: ${context} uses unknown compression type ${compressionType}`,
			);
	}
}

/** Bytes per chunk when streaming a range blob. */
const STREAM_CHUNK = 1024 * 1024;

/**
 * `Blob`-shaped view of `[offset, offset + size)` in a block stream.
 * Reports `size` synchronously. Every read goes straight to
 * {@link BlockStream.read}, so no intermediate `Blob` is created.
 * That matters: browsers keep `Blob` bytes in a bounded blob store,
 * and copying every entry of a large game into fresh Blobs eventually
 * fails reads with `NotReadableError`.
 */
function makeRangeBlob(stream: BlockStream, offset: number, size: number): Blob {
	const readAll = () => stream.read(offset, offset + size);
	const facade = {
		size,
		type: '',
		async arrayBuffer() {
			const b = await readAll();
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		},
		async bytes() {
			return readAll();
		},
		async text() {
			return new TextDecoder().decode(await readAll());
		},
		stream() {
			let pos = 0;
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (pos >= size) {
						controller.close();
						return;
					}
					const n = Math.min(STREAM_CHUNK, size - pos);
					try {
						controller.enqueue(await stream.read(offset + pos, offset + pos + n));
						pos += n;
					} catch (e) {
						controller.error(e);
					}
				},
			});
		},
		slice(start?: number, end?: number) {
			const s = clampInt(start ?? 0);
			const e = clampInt(end ?? size);
			const lo = Math.min(Math.max(s < 0 ? size + s : s, 0), size);
			const hi = Math.min(Math.max(e < 0 ? size + e : e, lo), size);
			return makeRangeBlob(stream, offset + lo, hi - lo);
		},
	};
	return facade as unknown as Blob;
}

function clampInt(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.trunc(n);
}

function alignUp(n: number, alignment: number): number {
	const r = n % alignment;
	return r === 0 ? n : n + (alignment - r);
}

// ---------------------------------------------------------------------------
// Big-endian binary reader — UnityFS uses BE throughout, unlike most
// other formats in this app. Tracks `pos` so callers can pick up where
// the previous read left off (important for variable-length CStrings).
// ---------------------------------------------------------------------------

class BigEndianReader {
	pos = 0;
	private view: DataView;

	constructor(private bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	skip(n: number): void {
		this.pos += n;
	}

	readU16(): number {
		const v = this.view.getUint16(this.pos, false);
		this.pos += 2;
		return v;
	}

	readU32(): number {
		const v = this.view.getUint32(this.pos, false);
		this.pos += 4;
		return v;
	}

	readI32(): number {
		const v = this.view.getInt32(this.pos, false);
		this.pos += 4;
		return v;
	}

	/**
	 * Read a 64-bit big-endian signed integer as a JS `number`. Throws
	 * for values exceeding `MAX_SAFE_INTEGER`. Bundles never approach
	 * this in practice, but failing loudly beats silent precision loss.
	 */
	readI64(): number {
		const hi = this.view.getInt32(this.pos, false);
		const lo = this.view.getUint32(this.pos + 4, false);
		this.pos += 8;
		if (hi < 0) {
			throw new Error('UnityFS: negative i64 value not supported');
		}
		if (hi > 0x001fffff) {
			throw new Error('UnityFS: i64 value exceeds Number.MAX_SAFE_INTEGER');
		}
		return hi * 0x100000000 + lo;
	}

	/**
	 * Read a NUL-terminated UTF-8 string starting at the current
	 * position. Advances `pos` past the terminator.
	 */
	readCString(): string {
		const start = this.pos;
		while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0) {
			this.pos++;
		}
		if (this.pos >= this.bytes.length) {
			throw new Error('UnityFS: unterminated string at end of buffer');
		}
		const str = new TextDecoder('utf-8').decode(
			this.bytes.subarray(start, this.pos),
		);
		this.pos++; // skip NUL
		return str;
	}
}
