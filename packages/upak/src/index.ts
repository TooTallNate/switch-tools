/**
 * Parser for Unreal Engine PAK archives.
 *
 * `.pak` is the legacy monolithic asset container UE shipped from
 * UE3 through UE5. UE 4.25+ also added a newer `.utoc` / `.ucas`
 * I/O store format that's covered by `@tootallnate/iostore`; PAK
 * files remained common alongside it for content that didn't fit
 * the I/O store model (and as the only option in earlier UE
 * versions). On Switch you'll typically find PAKs at
 * `/Game/Content/Paks/*.pak`.
 *
 * This parser supports **format v11** (UE 5.x) only — the layout
 * has changed several times across UE versions and v11 is the one
 * shipping in modern Switch / desktop UE5 titles. Older versions
 * are detected and rejected with a clear error rather than
 * silently mis-decoding.
 *
 * Compression: **Zlib** only. PAKs that use Oodle (a closed-
 * source codec) or AES-encrypted indexes / per-file encryption
 * surface a clear "unsupported" error — no decoder is shipped for
 * either yet.
 *
 * Wire format (little-endian throughout):
 *
 *   Footer (last 205 bytes for v11):
 *     u8        encrypted_index_flag
 *     u32       magic = 0x5A6F12E1
 *     i32       version (= 11)
 *     i64       index_offset
 *     i64       index_size
 *     u8[20]    index_sha1
 *     u8[32]×5  compression method names (zero-padded, NUL-terminated;
 *                                         entry 0 is implicitly "none";
 *                                         entries 1..5 are user-defined,
 *                                         e.g. "Zlib", "Oodle")
 *
 *   Primary index (at `index_offset`):
 *     i32       mount_point_len
 *     bytes     mount_point (UTF-8 incl. NUL when len > 0; UTF-16 when len < 0)
 *     i32       num_entries
 *     u64       path_hash_seed
 *     bool      has_path_hash_index
 *       if true:
 *         i64   path_hash_index_offset
 *         i64   path_hash_index_size
 *         u8[20] path_hash_index_sha1
 *     bool      has_full_directory_index
 *       if true:
 *         i64   full_directory_index_offset
 *         i64   full_directory_index_size
 *         u8[20] full_directory_index_sha1
 *     i32       encoded_pak_entries_size
 *     u8[…]     encoded_pak_entries (parsed lazily on demand)
 *     i32       num_files (deprecated; usually 0 in v10+)
 *
 *   Full Directory Index (at `full_directory_index_offset`):
 *     i32       num_dirs
 *     per dir:
 *       string  dir_path  (i32 len + bytes; ends in '/')
 *       i32     num_files_in_dir
 *       per file:
 *         string filename
 *         i32   entry_offset_into_encoded_entries
 *
 *   EncodedPakEntry (variable-length, packed; at `encoded_entries[entry_offset]`):
 *     u32       flags
 *       bits 0..5    compression_method_index (0 = none)
 *       bits 7..21   compression_block_size >> 11
 *       bit  22      encrypted
 *       bits 23..28  compression_blocks_count
 *       bit  29      is_size_32_bit_safe
 *       bit  30      is_uncompressed_size_32_bit_safe
 *       bit  31      is_offset_32_bit_safe
 *     offset             (u32 or u64 per flag)
 *     uncompressed_size  (u32 or u64 per flag)
 *     compressed_size    (u32 or u64; only if compression_method_index != 0)
 *     compression_blocks (per-block u64 start/end pairs; only if blocks_count > 1)
 *
 *   Per-file payload (at `entry.offset`, prefixed by an "entry header"):
 *     The entry header is a re-serialised version of the entry
 *     metadata (60+ bytes for compressed entries) — variable
 *     across UE versions. We compute its size from the entry's
 *     metadata (since the encoded form already gave us everything
 *     we need) and skip past it to find the actual data.
 *
 * Refs:
 *   - UE source: `Engine/Source/Runtime/PakFile/Public/IPlatformFilePak.h`
 *   - Clean-room implementation: https://github.com/trumank/repak
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UpakFooter {
	encryptedIndex: boolean;
	version: number;
	indexOffset: number;
	indexSize: number;
	indexSha1: Uint8Array;
	/**
	 * Per-slot compression-method names. Slot 0 is implicitly
	 * "none" (no entry in the footer); slot indices 1..N are
	 * 1-indexed into this array. So an entry whose
	 * `compressionMethodIndex` is 1 uses `compressionMethods[0]`.
	 */
	compressionMethods: string[];
}

export interface UpakEntry {
	/** Path of the file inside the PAK (e.g. `Game/Content/Foo.uasset`). */
	path: string;
	/** Absolute byte offset of the entry's pre-data header in the PAK. */
	offset: number;
	/** Decoded (uncompressed) size in bytes. */
	uncompressedSize: number;
	/** On-disk size in bytes (= uncompressedSize when not compressed). */
	compressedSize: number;
	/**
	 * Compression-method index from the footer. `0` means no
	 * compression; `1..N` indexes into `footer.compressionMethods`
	 * (1-based — `1` → `methods[0]`, …).
	 */
	compressionMethodIndex: number;
	/** True when the per-file payload is AES-encrypted (not supported yet). */
	encrypted: boolean;
	/** Block size used when compressed (typically 64 KB). 0 when not compressed. */
	compressionBlockSize: number;
	/**
	 * Compressed-block ranges (absolute file offsets), one per
	 * block. For uncompressed entries this is empty. For entries
	 * with exactly one compressed block we synthesise a single
	 * range from `[offset+headerSize, offset+headerSize+compressedSize)`
	 * since the encoded entry omits per-block ranges in that case.
	 */
	compressionBlocks: Array<{ start: number; end: number }>;
}

export interface ParsedUpak {
	source: Blob;
	footer: UpakFooter;
	mountPoint: string;
	entries: UpakEntry[];
}

// ---------------------------------------------------------------------------
// Magic / detection
// ---------------------------------------------------------------------------

/** Footer magic for every PAK version. */
const PAK_MAGIC = 0x5a6f12e1;

/** Length in bytes of the v11 footer (encryptedIndex byte through final compression-method slot). */
const FOOTER_SIZE_V11 = 1 + 4 + 4 + 8 + 8 + 20 + 32 * 5; // = 205

/**
 * Cheap (4-byte) magic check at a tail offset. Caller passes the
 * 4 bytes immediately following the `encryptedIndex` flag, i.e.
 * `tail[file_size - FOOTER_SIZE_V11 + 1 .. + 5]`.
 */
export function isUpakMagic(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	const m =
		(bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
	return m === PAK_MAGIC;
}

/**
 * Return true when `blob`'s last 205 bytes parse as a v11 PAK
 * footer. Used by container-detection sniffing in archive.ts.
 */
export async function isUpakV11(blob: Blob): Promise<boolean> {
	if (blob.size < FOOTER_SIZE_V11) return false;
	const tail = new Uint8Array(
		await blob.slice(blob.size - FOOTER_SIZE_V11).arrayBuffer(),
	);
	// magic lives at offset 1 (after the encryptedIndex byte)
	if (!isUpakMagic(tail.subarray(1, 5))) return false;
	// version at offset 5..9
	const ver =
		(tail[5]! | (tail[6]! << 8) | (tail[7]! << 16) | (tail[8]! << 24)) | 0;
	return ver === 11;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a UE PAK v11 archive. Reads the footer + primary index +
 * full directory index up-front (typically a few MB total even
 * for multi-GB PAKs); per-file payloads stay lazy.
 *
 * Throws on:
 *   - blob too small / wrong magic / unsupported version (only v11 is implemented)
 *   - encrypted index (no AES key support yet)
 *   - missing full directory index (older v10 PAKs without it not
 *     yet implemented; v11 always ships one)
 */
export async function parseUpak(blob: Blob): Promise<ParsedUpak> {
	if (blob.size < FOOTER_SIZE_V11) {
		throw new Error(
			`Blob too small for a PAK v11 footer (${blob.size} bytes; need ≥ ${FOOTER_SIZE_V11})`,
		);
	}
	const footerBytes = new Uint8Array(
		await blob.slice(blob.size - FOOTER_SIZE_V11).arrayBuffer(),
	);
	const footer = parseFooter(footerBytes);
	if (footer.version !== 11) {
		throw new Error(
			`Unsupported UE PAK version ${footer.version} (only v11 is implemented). Older PAKs use a different footer layout — try a tool like AssetRipper or umodel.`,
		);
	}
	if (footer.encryptedIndex) {
		throw new Error(
			'PAK has an encrypted index. AES-encrypted PAKs are not supported yet (need an AES-256 key from the game).',
		);
	}

	// Read the primary index in one go.
	const indexBytes = new Uint8Array(
		await blob
			.slice(footer.indexOffset, footer.indexOffset + footer.indexSize)
			.arrayBuffer(),
	);
	const index = parsePrimaryIndex(indexBytes);

	if (!index.fullDirIndex) {
		throw new Error(
			'PAK has no full directory index — older v10 layout without one is not supported yet.',
		);
	}

	// Read the full directory index.
	const fdiBytes = new Uint8Array(
		await blob
			.slice(
				index.fullDirIndex.offset,
				index.fullDirIndex.offset + index.fullDirIndex.size,
			)
			.arrayBuffer(),
	);
	const directories = parseFullDirectoryIndex(fdiBytes);

	// Walk the directory tree, decode each entry from the
	// encoded-entries blob, and produce a flat `UpakEntry[]`.
	const entries: UpakEntry[] = [];
	for (const dir of directories) {
		for (const file of dir.files) {
			const decoded = decodeEntry(
				index.encodedEntries,
				file.entryOffset,
				footer,
			);
			const fullPath = (
				index.mountPoint +
				dir.path +
				file.name
			).replace(/^\.\.\/(\.\.\/)*/, ''); // strip leading "../../../"
			entries.push({
				path: fullPath,
				...decoded,
			});
		}
	}

	return {
		source: blob,
		footer,
		mountPoint: index.mountPoint,
		entries,
	};
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function parseFooter(bytes: Uint8Array): UpakFooter {
	if (bytes.length !== FOOTER_SIZE_V11) {
		throw new Error(
			`parseFooter: expected ${FOOTER_SIZE_V11} bytes, got ${bytes.length}`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const encryptedIndex = bytes[0]! !== 0;
	const magic = view.getUint32(1, true);
	if (magic !== PAK_MAGIC) {
		throw new Error(
			`parseFooter: wrong magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x${PAK_MAGIC.toString(16)})`,
		);
	}
	const version = view.getInt32(5, true);
	const indexOffset = readI64Number(view, 9);
	const indexSize = readI64Number(view, 17);
	const indexSha1 = bytes.slice(25, 45);
	const compressionMethods: string[] = [];
	for (let i = 0; i < 5; i++) {
		const start = 45 + i * 32;
		const slice = bytes.subarray(start, start + 32);
		const nul = slice.indexOf(0);
		const name = new TextDecoder('utf-8').decode(
			slice.subarray(0, nul >= 0 ? nul : 32),
		);
		// Skip empty slots — the array is sparse from a v11
		// PAK that only declares `Zlib`. Padding is just NULs.
		if (name) compressionMethods.push(name);
	}
	return {
		encryptedIndex,
		version,
		indexOffset,
		indexSize,
		indexSha1,
		compressionMethods,
	};
}

// ---------------------------------------------------------------------------
// Primary index
// ---------------------------------------------------------------------------

interface PrimaryIndex {
	mountPoint: string;
	numEntries: number;
	pathHashSeed: bigint;
	pathHashIndex: { offset: number; size: number; sha1: Uint8Array } | null;
	fullDirIndex: { offset: number; size: number; sha1: Uint8Array } | null;
	encodedEntries: Uint8Array;
}

function parsePrimaryIndex(bytes: Uint8Array): PrimaryIndex {
	const r = new Reader(bytes);
	const mountPoint = r.fstring();
	const numEntries = r.u32();
	const pathHashSeed = r.u64();
	const hasPathHashIndex = r.u32() !== 0;
	let pathHashIndex: PrimaryIndex['pathHashIndex'] = null;
	if (hasPathHashIndex) {
		const offset = r.i64Number();
		const size = r.i64Number();
		const sha1 = r.bytes(20);
		pathHashIndex = { offset, size, sha1 };
	}
	const hasFullDirIndex = r.u32() !== 0;
	let fullDirIndex: PrimaryIndex['fullDirIndex'] = null;
	if (hasFullDirIndex) {
		const offset = r.i64Number();
		const size = r.i64Number();
		const sha1 = r.bytes(20);
		fullDirIndex = { offset, size, sha1 };
	}
	const encodedSize = r.i32();
	const encodedEntries = r.bytes(encodedSize);
	// We don't read the trailing deprecated `i32 num_files` — it's
	// always zero in v10+ and the slice already covers it.
	return {
		mountPoint,
		numEntries,
		pathHashSeed,
		pathHashIndex,
		fullDirIndex,
		encodedEntries,
	};
}

// ---------------------------------------------------------------------------
// Full directory index
// ---------------------------------------------------------------------------

interface DirectoryRecord {
	path: string;
	files: Array<{ name: string; entryOffset: number }>;
}

function parseFullDirectoryIndex(bytes: Uint8Array): DirectoryRecord[] {
	const r = new Reader(bytes);
	const numDirs = r.i32();
	const out: DirectoryRecord[] = new Array(numDirs);
	for (let i = 0; i < numDirs; i++) {
		const path = r.fstring();
		const numFiles = r.i32();
		const files: DirectoryRecord['files'] = new Array(numFiles);
		for (let j = 0; j < numFiles; j++) {
			const name = r.fstring();
			const entryOffset = r.i32();
			files[j] = { name, entryOffset };
		}
		out[i] = { path, files };
	}
	return out;
}

// ---------------------------------------------------------------------------
// Encoded pak entry decoder
// ---------------------------------------------------------------------------

/**
 * Decode a single bit-packed entry from the encoded-entries
 * blob. Bit layout taken from `repak`'s clean-room
 * implementation:
 *
 *   bits 0..5    compression_block_size (in units of 2048;
 *                                        sentinel 0x3f → real
 *                                        value follows as u32)
 *   bits 6..21   compression_blocks_count (16 bits)
 *   bit  22      encrypted
 *   bits 23..28  (compression_method_index + 1)  — 0 means
 *                                                  uncompressed
 *   bit  29      is_size_32_bit_safe
 *   bit  30      is_uncompressed_size_32_bit_safe
 *   bit  31      is_offset_32_bit_safe
 *
 * After the flags (and the optional u32 "real block size" when
 * the sentinel triggered), fields appear in this order: offset,
 * uncompressed_size, compressed_size (only if compressed), then
 * per-block sizes (only when blocks_count > 1 OR encrypted).
 *
 * For `blocks_count == 1 && !encrypted` the single block is
 * synthesised: it spans the entire payload from
 * `[offset + headerSize, offset + headerSize + compressed_size)`.
 *
 * Bit positions in the per-block format also differ from what
 * one might guess: each block is just a `u32 block_size`, not a
 * `(u64 start, u64 end)` pair like the unencoded entry form
 * uses. Block start/end are computed by chaining sizes from the
 * payload base offset.
 */
function decodeEntry(
	encoded: Uint8Array,
	entryOffset: number,
	footer: UpakFooter,
): Omit<UpakEntry, 'path'> {
	const view = new DataView(
		encoded.buffer,
		encoded.byteOffset,
		encoded.byteLength,
	);
	let off = entryOffset;
	const flags = view.getUint32(off, true);
	off += 4;

	// Compression method: 6 bits at 23..28; the stored value is
	// (real_index + 1), so 0 means uncompressed.
	const compressionField = (flags >>> 23) & 0x3f;
	const compressionMethodIndex = compressionField; // 0 = none, 1..N = footer.compressionMethods[N-1]
	const compressionBlocksCount = (flags >>> 6) & 0xffff;
	const encrypted = (flags & (1 << 22)) !== 0;
	const isSize32Safe = (flags & (1 << 29)) !== 0;
	const isUncompressedSize32Safe = (flags & (1 << 30)) !== 0;
	const isOffset32Safe = (flags & (1 << 31)) !== 0;

	// Block size: bits 0..5; sentinel 0x3f means "next u32 holds
	// the real value". Otherwise the stored value is shifted
	// left by 11 (× 2048) to get bytes.
	let compressionBlockSize = flags & 0x3f;
	if (compressionBlockSize === 0x3f) {
		compressionBlockSize = view.getUint32(off, true);
		off += 4;
	} else {
		compressionBlockSize <<= 11;
	}

	const readVarInt = (bit: 29 | 30 | 31): number => {
		if ((flags & (1 << bit)) !== 0) {
			const v = view.getUint32(off, true);
			off += 4;
			return v;
		}
		const v = readI64Number(view, off);
		off += 8;
		return v;
	};

	const absOffset = readVarInt(31);
	const uncompressedSize = readVarInt(30);
	const compressedSize =
		compressionMethodIndex === 0
			? uncompressedSize
			: readVarInt(29);

	// Block ranges. Two forms:
	//
	//   - blocks_count > 1 OR encrypted: per-block u32 size,
	//     chained from `payloadBase` (= entry.offset + per-file
	//     header size).
	//   - blocks_count == 1 && !encrypted: single block spanning
	//     the entire compressed payload, starts at `payloadBase`.
	const compressionBlocks: UpakEntry['compressionBlocks'] = [];
	if (compressionMethodIndex !== 0) {
		const headerSize = computeFileHeaderSize(compressionBlocksCount);
		const payloadBase = absOffset + headerSize;
		if (compressionBlocksCount === 1 && !encrypted) {
			compressionBlocks.push({
				start: payloadBase,
				end: payloadBase + compressedSize,
			});
		} else if (compressionBlocksCount > 0) {
			let cur = payloadBase;
			for (let i = 0; i < compressionBlocksCount; i++) {
				let blockSize = view.getUint32(off, true);
				off += 4;
				const start = cur;
				const end = cur + blockSize;
				compressionBlocks.push({ start, end });
				if (encrypted) {
					// Encrypted blocks are padded up to the AES
					// block boundary (16 bytes) on disk.
					blockSize = (blockSize + 15) & ~0xf;
				}
				cur += blockSize;
			}
		}
	}
	void footer;
	return {
		offset: absOffset,
		uncompressedSize,
		compressedSize,
		compressionMethodIndex,
		encrypted,
		compressionBlockSize,
		compressionBlocks,
	};
}

/**
 * Size in bytes of the per-file `FPakEntry` header that UE
 * re-serialises at the start of each file's payload. The
 * encoded-entry form in the index gives us all the metadata we
 * need; we just have to know how much to skip past to find the
 * actual data bytes.
 *
 * v11 layout:
 *   i64       offset (always 0 in this copy — relative to itself)
 *   i64       compressed_size
 *   i64       uncompressed_size
 *   u32       compression_method_index
 *   u8[20]    sha1
 *   if compressed:
 *     i32     num_blocks
 *     per block: u64 start, u64 end
 *   u8        encrypted
 *   u32       compression_block_size  (always present in v11)
 */
function computeFileHeaderSize(blocksCount: number): number {
	const base = 8 + 8 + 8 + 4 + 20; // offset + sizes + method + sha1
	const blocks = blocksCount > 0 ? 4 + blocksCount * (8 + 8) : 0;
	return base + blocks + 1 /* encrypted */ + 4; /* block_size */
}

// ---------------------------------------------------------------------------
// Per-entry Blob materialisation
// ---------------------------------------------------------------------------

/**
 * Resolve a single PAK entry's payload to a Blob. For
 * uncompressed entries this is a cheap `Blob.slice` of the
 * source. For Zlib-compressed entries we fetch each block,
 * decompress via the browser's `DecompressionStream('deflate')`,
 * and concatenate the result.
 *
 * Throws on:
 *   - encrypted entries (no AES key support)
 *   - compression methods other than `Zlib`
 *
 * The returned `Blob` is constructed eagerly (we materialise the
 * full decompressed bytes) — chunked / streaming materialisation
 * would be possible but adds complexity for the typical
 * sub-megabyte UE asset where the whole-file approach is fine.
 */
/**
 * Decompression callback for compressors that we don't implement
 * natively in this package. Currently used for Oodle (Kraken /
 * Mermaid / Selkie / Leviathan), which requires a separately-built
 * WASM module — see `@tootallnate/oodle-wasm` and its README for
 * the redistribution-free build recipe.
 *
 * The callback receives one block's compressed bytes and the
 * decompressed size that block must produce, and returns the
 * decompressed bytes.
 *
 * Async so the host can lazy-load the WASM module on first call.
 */
export type ExternalDecompressor = (
	compressed: Uint8Array,
	uncompressedSize: number,
	methodName: string,
) => Promise<Uint8Array>;

/**
 * Options for {@link readUpakEntry}. Lets the caller plug in an
 * external decompressor for compressors this package doesn't ship
 * built-in (currently: anything other than Zlib).
 */
export interface ReadUpakEntryOptions {
	/**
	 * Called when an entry uses a compressor this package can't
	 * decode by itself. If not provided, decoding such an entry
	 * throws {@link UpakUnsupportedCompressionError}.
	 */
	externalDecompressor?: ExternalDecompressor;
}

/**
 * Thrown when {@link readUpakEntry} encounters a compression
 * algorithm it doesn't implement and no `externalDecompressor`
 * callback was supplied. The `methodName` field carries the slot's
 * string identifier from the PAK footer (e.g. `"Oodle"`,
 * `"Kraken"`, `"LZ4"`), so the host can decide which dependency to
 * lazy-load.
 */
export class UpakUnsupportedCompressionError extends Error {
	readonly entryPath: string;
	readonly methodName: string;
	constructor(entryPath: string, methodName: string) {
		super(
			`PAK entry "${entryPath}" uses ${methodName} compression; pass an externalDecompressor option to readUpakEntry to handle it.`,
		);
		this.name = 'UpakUnsupportedCompressionError';
		this.entryPath = entryPath;
		this.methodName = methodName;
	}
}

export async function readUpakEntry(
	source: Blob,
	entry: UpakEntry,
	footer: UpakFooter,
	options: ReadUpakEntryOptions = {},
): Promise<Blob> {
	if (entry.encrypted) {
		throw new Error(
			`PAK entry "${entry.path}" is AES-encrypted; encryption is not supported yet.`,
		);
	}
	if (entry.compressionMethodIndex === 0) {
		// Uncompressed: skip the per-file header and slice.
		const headerSize = computeFileHeaderSize(0);
		const start = entry.offset + headerSize;
		return source.slice(start, start + entry.uncompressedSize);
	}
	const methodName =
		footer.compressionMethods[entry.compressionMethodIndex - 1];
	if (!methodName) {
		throw new Error(
			`PAK entry "${entry.path}" references unknown compression slot ${entry.compressionMethodIndex} (only ${footer.compressionMethods.length} method(s) declared).`,
		);
	}
	const lower = methodName.toLowerCase();
	const decoded: Uint8Array[] = [];
	if (lower === 'zlib') {
		// Native path — DecompressionStream handles zlib/deflate.
		for (const block of entry.compressionBlocks) {
			const compressed = await source.slice(block.start, block.end).arrayBuffer();
			decoded.push(await inflateOnce(new Uint8Array(compressed)));
		}
	} else if (options.externalDecompressor) {
		// External path (typically Oodle via @tootallnate/oodle-wasm).
		// UE splits a file into N blocks of `compressionBlockSize`
		// each; the final block holds whatever's left of
		// `uncompressedSize`.
		const fullBlockSize = entry.compressionBlockSize;
		for (let i = 0; i < entry.compressionBlocks.length; i++) {
			const block = entry.compressionBlocks[i]!;
			const remaining = entry.uncompressedSize - i * fullBlockSize;
			const blockRawSize = Math.min(fullBlockSize, remaining);
			const compressed = new Uint8Array(
				await source.slice(block.start, block.end).arrayBuffer(),
			);
			decoded.push(
				await options.externalDecompressor(compressed, blockRawSize, methodName),
			);
		}
	} else {
		throw new UpakUnsupportedCompressionError(entry.path, methodName);
	}
	return new Blob(decoded as BlobPart[]);
}

async function inflateOnce(compressed: Uint8Array): Promise<Uint8Array> {
	// Wrap the bytes in a Blob → stream → DecompressionStream →
	// Response pipeline. Same idiom the WOFF1 inflater uses; the
	// `Response` shim handles the pipeThrough type-narrowing
	// quirks (DecompressionStream's output type doesn't match
	// `pipeThrough`'s input type cleanly).
	const stream = new Blob([compressed as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

class Reader {
	pos = 0;
	view: DataView;
	#buf: Uint8Array;

	constructor(buf: Uint8Array) {
		this.#buf = buf;
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	bytes(n: number): Uint8Array {
		const out = this.#buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
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
	i64Number(): number {
		const v = readI64Number(this.view, this.pos);
		this.pos += 8;
		return v;
	}
	/**
	 * Read an Unreal "FString": `i32 len + bytes`. When `len > 0`
	 * the string is ANSI/UTF-8 with a trailing NUL inside the
	 * byte count. When `len < 0` it's UTF-16 with `|len|` code
	 * units (each 2 bytes) including a trailing NUL.
	 */
	fstring(): string {
		const len = this.i32();
		if (len === 0) return '';
		if (len > 0) {
			const slice = this.bytes(len);
			// Strip the trailing NUL the encoder includes.
			const trimEnd = slice[slice.length - 1] === 0 ? slice.length - 1 : slice.length;
			return new TextDecoder('utf-8').decode(slice.subarray(0, trimEnd));
		}
		const codeUnits = -len;
		const slice = this.bytes(codeUnits * 2);
		const trimEnd =
			slice[slice.length - 2] === 0 && slice[slice.length - 1] === 0
				? slice.length - 2
				: slice.length;
		return new TextDecoder('utf-16le').decode(slice.subarray(0, trimEnd));
	}
}

/**
 * Read a 64-bit signed/unsigned integer as a JS `number`. PAK
 * offsets and sizes are u64 / i64 in the wire format; in
 * practice they fit in `Number.MAX_SAFE_INTEGER` for any sane
 * archive (≤ 9 PB). Throws if the value would lose precision.
 */
function readI64Number(view: DataView, offset: number): number {
	const v = view.getBigInt64(offset, true);
	if (v < BigInt(Number.MIN_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(
			`PAK: 64-bit value ${v} doesn't fit in JS safe integer range`,
		);
	}
	return Number(v);
}
