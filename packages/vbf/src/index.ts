/**
 * Parser for VBF (Virtuos Big File) archives.
 *
 * `.vbf` is the archive format used by Virtuos for the Final
 * Fantasy X / X-2 HD Remaster and Final Fantasy XII The Zodiac
 * Age. The Switch port uses a slight variant of the PC format
 * documented in the ff7-mods FF10 wiki — see the layout
 * description below.
 *
 * Wire layout (all multi-byte fields little-endian unless noted):
 *
 *   Header (16 bytes):
 *     u32   magic = 'SRYK' (= 0x4B595253 LE, or "SRYK" read as
 *           bytes left-to-right).
 *     u32   headerSize (also = dataOffset of the first file).
 *     u64   numFiles.
 *
 *   Hash table A (numFiles × 16 bytes):
 *     MD5 hashes (purpose unclear; we don't use them).
 *
 *   Hash table B (numFiles × 16 bytes):
 *     Duplicate of A on the Switch builds we've examined. The PC
 *     version may have only one table; the parser tolerates both
 *     layouts by computing the entries offset from the layout
 *     anchors below rather than counting hash tables.
 *
 *   File entries (numFiles × 32 bytes):
 *     u32   blockListIndex   — u16 index into the block list of
 *                              this file's first chunk size.
 *     u32   unknown          — some kind of timestamp / generation
 *                              field; constant within a single
 *                              build. Ignored.
 *     u64   originalSize     — decompressed file size.
 *     u64   dataOffset       — absolute file offset of the first
 *                              compressed chunk. 0xFFFFFFFFFFFFFFFF
 *                              (= -1) means "empty / placeholder";
 *                              the entry should be ignored.
 *     u64   nameOffset       — byte offset into the string table.
 *
 *   u32 stringTableLength
 *   chars stringTable        — NUL-terminated UTF-8 file paths.
 *
 *   Block list (variable length):
 *     u16[] — one u16 per chunk across the entire archive. Each
 *             u16 is the compressed size of one 64 KiB
 *             decompressed chunk. A value of 0 means the chunk
 *             is stored uncompressed (full 64 KiB literal copy
 *             at `dataOffset + sum(prior chunk sizes)`).
 *
 *   File data — concatenated zlib-compressed chunks. Each file's
 *     chunks are contiguous starting at `dataOffset`, with the
 *     count = `ceil(originalSize / 65536)` and per-chunk
 *     compressed sizes pulled from the block list at indexes
 *     `[blockListIndex, blockListIndex + chunkCount)`.
 *
 * Compression: standard zlib (DEFLATE + zlib wrapper, magic
 * `0x78 0xDA`). Uncompressed chunks (block list u16 = 0) are
 * served verbatim as 65,536-byte blocks.
 *
 * References:
 *
 *   - ff7-mods FF10 file-format wiki:
 *     https://github.com/ff7-mods/ff7-flat-wiki/blob/master/docs/FF10/FileFormat_VBF.md
 *   - QuickBMS "virtuos_vbf.bms" script by RetingencyPlan
 *     (rewritten from aluigi's "ffxhd.bms"):
 *     https://github.com/RetingencyPlan/le_quickbms_script_compendium/blob/master/virtuos_vbf.bms
 *
 * This parser is a clean-room rewrite from the format spec; no
 * GPL or other restrictively-licensed code is copied.
 */

import { unzlib, unzlibSync } from 'fflate';

const SRYK_MAGIC = 0x4b595253; // 'SRYK' read LE: 'S'(0x53) at byte 0, 'R'(0x52) at byte 1, ...
const HEADER_SIZE = 16;
const ENTRY_SIZE = 32;
const HASH_SIZE = 16;
const CHUNK_DECOMPRESSED_SIZE = 65536;
const DATA_OFFSET_SENTINEL_EMPTY = 0xffffffffffffffffn;

export interface VbfFileEntry {
	/** Path of the file inside the archive (NUL-terminated string from the name table). */
	name: string;
	/** Decompressed size in bytes. */
	size: number;
	/**
	 * Lazy `Blob`-shaped facade that decompresses chunks on
	 * demand. Reading a sub-slice via `.slice(start, end)` only
	 * decompresses the 64 KiB chunks that intersect the range.
	 *
	 * For empty / placeholder entries (dataOffset = -1) this is
	 * a zero-sized empty Blob.
	 */
	data: Blob;
}

export interface ParsedVbf {
	/** Total number of files declared in the header. */
	numFiles: number;
	/**
	 * Parsed file entries, in declaration order. Empty /
	 * placeholder entries (dataOffset = -1) are omitted from
	 * this list — they appear in real archives but have no
	 * accessible content.
	 */
	entries: VbfFileEntry[];
}

/** Cheap 4-byte magic check. */
export async function isVbf(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x53 /* S */ &&
		head[1] === 0x52 /* R */ &&
		head[2] === 0x59 /* Y */ &&
		head[3] === 0x4b /* K */
	);
}

/**
 * Parse a VBF archive's metadata and produce one lazy Blob per
 * file. Reads ~5 MB of metadata up front for a typical FFX
 * archive (~35 k files); file body decompression happens on
 * demand when callers read from the per-entry `data` Blob.
 */
export async function parseVbf(blob: Blob): Promise<ParsedVbf> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a .vbf (${blob.size} bytes, need at least ${HEADER_SIZE})`,
		);
	}

	// Header.
	const headBytes = new Uint8Array(
		await blob.slice(0, HEADER_SIZE).arrayBuffer(),
	);
	const headView = new DataView(
		headBytes.buffer,
		headBytes.byteOffset,
		headBytes.byteLength,
	);
	const magic = headView.getUint32(0, /*littleEndian*/ true);
	if (magic !== SRYK_MAGIC) {
		throw new Error(
			`Bad .vbf magic 0x${magic.toString(16).padStart(8, '0')} (expected 'SRYK')`,
		);
	}
	const headerSize = headView.getUint32(4, true);
	const numFiles64 = headView.getBigUint64(8, true);
	if (numFiles64 > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`Implausible numFiles ${numFiles64}`);
	}
	const numFiles = Number(numFiles64);
	if (numFiles < 0 || numFiles > 1_000_000) {
		throw new Error(`Implausible numFiles ${numFiles}`);
	}

	// Locate the file-entries region by walking from the END of
	// the metadata block backwards: we know the first file's
	// `dataOffset == headerSize`, and we can find entries by
	// looking for that sentinel as one of the u64 fields.
	//
	// Cheaper approach in practice: the Switch builds have TWO
	// 16-byte-per-file hash tables (likely path-hash + content-
	// hash); the PC builds have one. We try both layouts and
	// validate by reading entry 0 — the one whose entry 0 has
	// a plausible (blockListIndex, originalSize, dataOffset)
	// triple wins. Plausibility = `originalSize` is non-zero
	// and < 2 GiB, `dataOffset == headerSize`, and
	// `blockListIndex < 0x40000000`.
	const layoutCandidates = [
		// Switch: header + 2 hash tables + entries.
		{
			label: 'two-hash-tables',
			entriesOffset: HEADER_SIZE + 2 * numFiles * HASH_SIZE,
		},
		// PC: header + 1 hash table + entries.
		{
			label: 'one-hash-table',
			entriesOffset: HEADER_SIZE + numFiles * HASH_SIZE,
		},
	];

	let entriesOffset = -1;
	// Sniff probe: walk the first N entries; the layout is
	// validated if AT LEAST ONE entry has a plausible
	// `dataOffset == headerSize` (= start of file data). We
	// can't require `originalSize > 0` because some archives
	// start with empty placeholder entries.
	const SNIFF_DEPTH = Math.min(numFiles, 16);
	for (const layout of layoutCandidates) {
		const probeEnd = layout.entriesOffset + SNIFF_DEPTH * ENTRY_SIZE;
		if (probeEnd > blob.size) continue;
		const probeBytes = new Uint8Array(
			await blob.slice(layout.entriesOffset, probeEnd).arrayBuffer(),
		);
		const view = new DataView(
			probeBytes.buffer,
			probeBytes.byteOffset,
			probeBytes.byteLength,
		);
		let foundPlausible = false;
		for (let i = 0; i < SNIFF_DEPTH; i++) {
			const off = i * ENTRY_SIZE;
			const blockListIndex = view.getUint32(off + 0, true);
			const originalSize = view.getBigUint64(off + 8, true);
			const dataOffset = view.getBigUint64(off + 16, true);
			if (
				blockListIndex < 0x40000000 &&
				originalSize < 1n << 32n &&
				dataOffset === BigInt(headerSize)
			) {
				foundPlausible = true;
				break;
			}
		}
		if (foundPlausible) {
			entriesOffset = layout.entriesOffset;
			break;
		}
	}
	if (entriesOffset < 0) {
		throw new Error(
			'Could not locate VBF entries section. No probed entry starts at the declared headerSize.',
		);
	}

	// Right after the entries we have:
	//   u32 stringTableLength    — INCLUDES the u32 itself; the
	//                              actual string content has length
	//                              `stringTableLength - 4` and
	//                              starts at `stringTableLenOffset
	//                              + 4`. (The wiki's definition is
	//                              misleading; the QuickBMS script
	//                              uses the "includes prefix"
	//                              interpretation, and that's what
	//                              produces a consistent block list
	//                              offset on real archives.)
	//   chars[stringTableLength - 4]  string content (NUL-terminated names)
	//   u16[]                    block list (one u16 per chunk
	//                              across the whole archive)
	const entriesBytesEnd = entriesOffset + numFiles * ENTRY_SIZE;
	const stringTableLenOffset = entriesBytesEnd;
	if (stringTableLenOffset + 4 > blob.size) {
		throw new Error('VBF truncated before string table length');
	}
	const stringTableLenBytes = new Uint8Array(
		await blob.slice(stringTableLenOffset, stringTableLenOffset + 4).arrayBuffer(),
	);
	const stringTableLengthField = new DataView(
		stringTableLenBytes.buffer,
	).getUint32(0, true);
	if (stringTableLengthField < 4) {
		throw new Error(
			`VBF stringTableLength field too small (${stringTableLengthField})`,
		);
	}
	const stringTableStart = stringTableLenOffset + 4;
	const stringTableEnd = stringTableLenOffset + stringTableLengthField;
	const stringTableContentLength = stringTableLengthField - 4;
	if (stringTableEnd > blob.size) {
		throw new Error(
			`VBF string table runs past end of archive (end=${stringTableEnd}, size=${blob.size})`,
		);
	}

	// Block list starts immediately after the string table content
	// and extends up to `headerSize` (start of file data). Each
	// u16 is one chunk's compressed size.
	const blockListStart = stringTableEnd;
	const blockListEnd = headerSize;
	if (blockListEnd < blockListStart) {
		throw new Error(
			`Block list region malformed (start=${blockListStart}, end=${blockListEnd})`,
		);
	}
	const blockListBytes = new Uint8Array(
		await blob.slice(blockListStart, blockListEnd).arrayBuffer(),
	);
	const blockListView = new DataView(
		blockListBytes.buffer,
		blockListBytes.byteOffset,
		blockListBytes.byteLength,
	);
	const blockListCount = Math.floor(blockListBytes.length / 2);

	// Read all entry records + their names.
	const entriesBytes = new Uint8Array(
		await blob.slice(entriesOffset, entriesBytesEnd).arrayBuffer(),
	);
	const entriesView = new DataView(
		entriesBytes.buffer,
		entriesBytes.byteOffset,
		entriesBytes.byteLength,
	);
	const stringTableBytes = new Uint8Array(
		await blob
			.slice(stringTableStart, stringTableStart + stringTableContentLength)
			.arrayBuffer(),
	);

	const decoder = new TextDecoder('utf-8', { fatal: false });
	const readName = (offset: number): string => {
		const nul = stringTableBytes.indexOf(0, offset);
		const end = nul < 0 ? stringTableBytes.length : nul;
		return decoder.decode(stringTableBytes.subarray(offset, end));
	};

	const entries: VbfFileEntry[] = [];
	for (let i = 0; i < numFiles; i++) {
		const off = i * ENTRY_SIZE;
		const blockListIndex = entriesView.getUint32(off + 0, true);
		// off + 4..8: unknown / generation
		const originalSize = entriesView.getBigUint64(off + 8, true);
		const dataOffset = entriesView.getBigUint64(off + 16, true);
		const nameOffset = entriesView.getBigUint64(off + 24, true);

		if (dataOffset === DATA_OFFSET_SENTINEL_EMPTY) {
			// Placeholder entry — skip. Real archives have a few.
			continue;
		}
		if (originalSize === 0n) {
			// Zero-byte file — keep but with an empty Blob.
			entries.push({
				name: readName(Number(nameOffset)),
				size: 0,
				data: new Blob([]),
			});
			continue;
		}
		if (originalSize > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new Error(
				`Entry ${i}: originalSize ${originalSize} exceeds safe-integer range`,
			);
		}
		if (dataOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new Error(
				`Entry ${i}: dataOffset ${dataOffset} exceeds safe-integer range`,
			);
		}

		const sizeN = Number(originalSize);
		const dataOff = Number(dataOffset);
		const numChunks = Math.ceil(sizeN / CHUNK_DECOMPRESSED_SIZE);
		if (
			blockListIndex < 0 ||
			blockListIndex + numChunks > blockListCount
		) {
			throw new Error(
				`Entry ${i}: block list span [${blockListIndex}, ${blockListIndex + numChunks}) outside [0, ${blockListCount})`,
			);
		}
		// Read this file's chunk-size list once.
		const chunkSizes = new Array<number>(numChunks);
		for (let c = 0; c < numChunks; c++) {
			chunkSizes[c] = blockListView.getUint16(
				(blockListIndex + c) * 2,
				true,
			);
		}

		entries.push({
			name: readName(Number(nameOffset)),
			size: sizeN,
			data: createVbfChunkBlob({
				source: blob,
				dataOffset: dataOff,
				originalSize: sizeN,
				chunkSizes,
			}),
		});
	}

	return { numFiles, entries };
}

// ---------------------------------------------------------------------------
// Lazy per-file chunk blob
// ---------------------------------------------------------------------------

interface VbfChunkBlobParams {
	source: Blob;
	dataOffset: number;
	originalSize: number;
	/** Compressed size of each 64 KiB-uncompressed chunk. 0 = literal stored chunk. */
	chunkSizes: number[];
}

/**
 * Build a `Blob`-shaped facade backed by zlib-chunked storage in
 * `source`. Reads / slices decompress only the chunks that
 * intersect the requested range.
 *
 * Per-chunk metadata is computed lazily on first access and
 * cached so subsequent reads from the same chunk are
 * O(decompressed-bytes).
 *
 * The facade implements the subset of the `Blob` interface that
 * our consumers (lazy NCA / RomFS / archive walkers, the vfs SW
 * bridge, fflate's Zip writer's `ZipPassThrough.stream()`) rely
 * on: `size`, `type`, `slice`, `arrayBuffer`, `text`, `bytes`,
 * `stream`. It does NOT pass `instanceof Blob` — callers that
 * need a real Blob (`URL.createObjectURL` etc) should
 * materialise via the vfs service worker or `Response.blob()`.
 */
function createVbfChunkBlob(params: VbfChunkBlobParams): Blob {
	const reader = new VbfChunkReader(
		params.source,
		params.dataOffset,
		params.originalSize,
		params.chunkSizes,
	);
	return reader.toBlob(0, params.originalSize);
}

/**
 * Shared state for one file's lazy chunked storage. A single
 * reader can be shared across multiple `slice` views.
 */
class VbfChunkReader {
	/** Cumulative compressed offset of chunk i (in bytes relative to dataOffset). */
	private readonly chunkCompressedOffsets: number[];
	/** Per-chunk decompressed cache (filled on first read). */
	private readonly chunkCache: (Uint8Array | undefined)[];
	/** In-flight decode promises so concurrent slices don't double-decompress. */
	private readonly inflight: (Promise<Uint8Array> | undefined)[];

	constructor(
		readonly source: Blob,
		readonly dataOffset: number,
		readonly originalSize: number,
		readonly chunkSizes: number[],
	) {
		this.chunkCompressedOffsets = new Array(chunkSizes.length + 1);
		let cumul = 0;
		this.chunkCompressedOffsets[0] = 0;
		for (let i = 0; i < chunkSizes.length; i++) {
			const cs = chunkSizes[i];
			// 0 in the block list means "uncompressed full 64 KiB
			// stored block" — the stored size is 0x10000 bytes.
			cumul += cs === 0 ? CHUNK_DECOMPRESSED_SIZE : cs;
			this.chunkCompressedOffsets[i + 1] = cumul;
		}
		this.chunkCache = new Array(chunkSizes.length);
		this.inflight = new Array(chunkSizes.length);
	}

	/**
	 * Fetch (and cache) the decompressed bytes for chunk
	 * `index`. The returned `Uint8Array` is a view into the
	 * cached buffer; callers must not mutate it.
	 */
	private async getChunk(index: number): Promise<Uint8Array> {
		const cached = this.chunkCache[index];
		if (cached) return cached;
		const pending = this.inflight[index];
		if (pending) return pending;

		const compressedSize = this.chunkSizes[index];
		const start = this.dataOffset + this.chunkCompressedOffsets[index];
		const end = this.dataOffset + this.chunkCompressedOffsets[index + 1];
		// The last chunk may decompress to fewer than 64 KiB; the
		// final-chunk decompressed size is `originalSize % 65536`
		// (or 65536 if originalSize is a multiple). All non-final
		// chunks always decompress to exactly 65,536 bytes.
		const isFinal = index === this.chunkSizes.length - 1;
		const decompressedSize = isFinal
			? this.originalSize - index * CHUNK_DECOMPRESSED_SIZE
			: CHUNK_DECOMPRESSED_SIZE;

		const promise = (async (): Promise<Uint8Array> => {
			const raw = new Uint8Array(
				await this.source.slice(start, end).arrayBuffer(),
			);
			// VBF uses `comtype zlib_noerror`: chunks are zlib-
			// compressed *if* compression saves space, otherwise
			// the raw uncompressed bytes are written. A
			// `chunkSize == 0` slot in the block list is the
			// special-case "a stored chunk of exactly 64 KiB
			// uncompressed bytes follows" (the size field can't
			// represent 65,536 as a u16, so 0 means "full block").
			//
			// For other chunks we try inflate; if that fails we
			// assume the chunk is stored raw and use the bytes
			// directly. The "compressed == decompressed length"
			// case (typical for small files) lands here.
			let out: Uint8Array;
			if (compressedSize === 0) {
				out = raw.subarray(0, decompressedSize);
			} else {
				try {
					out = await inflateAsync(raw);
				} catch {
					// Not zlib — treat as raw stored bytes.
					out = raw.subarray(0, decompressedSize);
				}
				if (out.byteLength > decompressedSize) {
					// Defensive trim: inflate yielded more bytes than
					// expected. Shouldn't happen for well-formed
					// archives but it's cheap to guard.
					out = out.subarray(0, decompressedSize);
				}
			}
			this.chunkCache[index] = out;
			this.inflight[index] = undefined;
			return out;
		})();
		this.inflight[index] = promise;
		return promise;
	}

	/**
	 * Read decompressed bytes for the range `[start, end)` within
	 * the file, decompressing whichever chunks intersect.
	 */
	async readRange(start: number, end: number): Promise<Uint8Array> {
		if (end <= start) return new Uint8Array(0);
		const out = new Uint8Array(end - start);
		let written = 0;
		const firstChunk = Math.floor(start / CHUNK_DECOMPRESSED_SIZE);
		const lastChunk = Math.min(
			Math.floor((end - 1) / CHUNK_DECOMPRESSED_SIZE),
			this.chunkSizes.length - 1,
		);
		for (let c = firstChunk; c <= lastChunk; c++) {
			const chunkBytes = await this.getChunk(c);
			const chunkStart = c * CHUNK_DECOMPRESSED_SIZE;
			const localStart = Math.max(0, start - chunkStart);
			const localEnd = Math.min(
				chunkBytes.byteLength,
				end - chunkStart,
			);
			if (localEnd <= localStart) continue;
			out.set(
				chunkBytes.subarray(localStart, localEnd),
				written,
			);
			written += localEnd - localStart;
		}
		return written < out.byteLength ? out.subarray(0, written) : out;
	}

	/**
	 * Build a `Blob`-shaped facade that views the decompressed
	 * range `[start, end)` of this file. The facade reads
	 * through `readRange` on access, decompressing chunks lazily.
	 */
	toBlob(start: number, end: number): Blob {
		const reader = this;
		const length = Math.max(0, end - start);

		const facade: Blob = {
			get size() {
				return length;
			},
			get type() {
				return '';
			},
			async arrayBuffer(): Promise<ArrayBuffer> {
				const u8 = await reader.readRange(start, end);
				const ab = new ArrayBuffer(u8.byteLength);
				new Uint8Array(ab).set(u8);
				return ab;
			},
			async bytes(): Promise<Uint8Array> {
				const u8 = await reader.readRange(start, end);
				return new Uint8Array(u8);
			},
			async text(): Promise<string> {
				const u8 = await reader.readRange(start, end);
				return new TextDecoder().decode(u8);
			},
			slice(s?: number, e?: number, _ct?: string): Blob {
				const lo = clamp(s ?? 0, 0, length);
				const hi = clamp(e ?? length, lo, length);
				return reader.toBlob(start + lo, start + hi);
			},
			stream(): ReadableStream<Uint8Array> {
				// Stream chunk by chunk so consumers (the vfs SW
				// bridge, fflate's Zip writer) get backpressure
				// for free.
				let pos = start;
				return new ReadableStream<Uint8Array>({
					async pull(controller) {
						if (pos >= end) {
							controller.close();
							return;
						}
						const chunkIndex = Math.floor(pos / CHUNK_DECOMPRESSED_SIZE);
						const chunkStart = chunkIndex * CHUNK_DECOMPRESSED_SIZE;
						const next = Math.min(
							chunkStart + CHUNK_DECOMPRESSED_SIZE,
							end,
						);
						try {
							const piece = await reader.readRange(pos, next);
							if (piece.byteLength > 0) controller.enqueue(piece);
							pos = next;
						} catch (err) {
							controller.error(err);
						}
					},
				});
			},
		} as unknown as Blob;
		return facade;
	}
}

function clamp(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) return lo;
	return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * Inflate a zlib (`78 DA …`) chunk using fflate. We prefer the
 * async variant so a 64 KiB decompression doesn't block the
 * main thread, but fall back to sync on any failure — fflate's
 * async path runs in a Web Worker and breaks in some
 * environments (Node 24's worker scoping bug, CSPs that
 * disallow `Worker(blob:…)`, etc.). Sync is universally
 * available.
 *
 * Throws only when sync ALSO fails — i.e. the bytes aren't
 * valid zlib at all. The caller (`getChunk`) treats that as a
 * signal to use the raw chunk verbatim.
 */
function inflateAsync(compressed: Uint8Array): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const fallbackToSync = (asyncErr: unknown): void => {
			if (settled) return;
			settled = true;
			try {
				resolve(unzlibSync(compressed));
			} catch (sync) {
				reject(
					new Error(
						`zlib inflate failed (async: ${asyncErr instanceof Error ? asyncErr.message : asyncErr}; sync: ${sync instanceof Error ? sync.message : sync})`,
					),
				);
			}
		};
		try {
			unzlib(compressed, (err, data) => {
				if (settled) return;
				if (err) {
					fallbackToSync(err);
					return;
				}
				settled = true;
				resolve(data);
			});
		} catch (err) {
			fallbackToSync(err);
		}
	});
}
