/**
 * @license MIT
 *
 * `CompressedStorage` layer: given a BucketTree of compression entries
 * over the encrypted-then-decrypted NCA section, exposes a virtual
 * (decompressed) view that callers can `read(start, end)` from at
 * any offset.
 *
 * Per-entry struct (CompressedStorage), 0x18 bytes, little-endian:
 *
 *   off 0x00  s64  virt_offset       — virtual (decompressed) start
 *   off 0x08  s64  phys_offset       — physical (compressed) start
 *   off 0x10  u8   compression_type  — 0=None, 1=Zeros, 3=LZ4
 *   off 0x11  u8   reserved
 *   off 0x12  u16  reserved
 *   off 0x14  s32  phys_size         — compressed payload size
 *
 * Memory discipline (this is a browser-facing reader; we read 4 GB
 * sections lazily — no full materialisation, ever):
 *
 *   - **None** entries are read sub-slice directly. The entry's
 *     virtual size can be over 1 GB in real-world NCAs (large
 *     pre-compressed assets get a single passthrough entry);
 *     materialising those into a JS `Uint8Array` would balloon
 *     memory by gigabytes. Instead we issue exactly the bytes the
 *     caller asked for.
 *   - **Zeros** entries synthesise just the requested slice.
 *   - **LZ4** entries are decoded whole (block ciphers can't be
 *     partially decoded), but real-world LZ4 entries cap out at
 *     64 KiB each — affordable. We keep a byte-bounded LRU of
 *     decoded LZ4 blocks so back-to-back reads in the same entry
 *     hit the cache. The bound is fixed, NOT a count, so it can't
 *     accidentally retain huge passthrough buffers.
 */

import { decodeBlock } from '@tootallnate/lz4';
import type { BucketTreeReader } from './bucket-tree.js';

/** Pass-through (already plaintext). */
export const COMPRESSION_TYPE_NONE = 0;
/** Synthesize `virtualSize` zero bytes; never touches the data storage. */
export const COMPRESSION_TYPE_ZEROS = 1;
/** Raw LZ4 block (no frame wrapper); known output size. */
export const COMPRESSION_TYPE_LZ4 = 3;

/** Sanity cap on a single LZ4 entry's decoded size (16 MiB). */
const LZ4_ENTRY_MAX_BYTES = 16 * 1024 * 1024;

/** Maximum total bytes held in the LZ4 decode cache (1 MiB). */
const LZ4_CACHE_MAX_BYTES = 1 * 1024 * 1024;

/** Decoded form of a single CompressedStorage entry. */
export interface CompressedEntry {
	virtOffset: bigint;
	physOffset: bigint;
	compressionType: number;
	physSize: number;
}

export const COMPRESSED_ENTRY_SIZE = 0x18;

export function parseCompressedEntry(bytes: Uint8Array): CompressedEntry {
	if (bytes.byteLength < COMPRESSED_ENTRY_SIZE) {
		throw new Error(
			`CompressedStorage entry truncated: ${bytes.byteLength} bytes`,
		);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		virtOffset: dv.getBigInt64(0x00, true),
		physOffset: dv.getBigInt64(0x08, true),
		compressionType: dv.getUint8(0x10),
		physSize: dv.getInt32(0x14, true),
	};
}

export interface CompressedStorageReaderOptions {
	/**
	 * Read `[start, end)` bytes from the underlying *post-AES-CTR*
	 * section storage. The closure is called with byte ranges
	 * derived from CompressedStorage `phys_offset` / `phys_size`
	 * fields — i.e. positions inside the NCA section's logical body.
	 */
	readSectionRange: (start: bigint, end: bigint) => Promise<Uint8Array>;
	/** The BucketTree built from `CompressionInfo.tableOffset`. */
	table: BucketTreeReader;
	/**
	 * Total logical (decompressed) size of this view. Equal to the
	 * BucketTree's `endOffset`, which in turn equals
	 * `CompressionInfo.tableOffset` for an NCA section (the BKTR
	 * table sits right after the last logical byte).
	 *
	 * Accepts a thunk (`() => Promise<bigint>`) so the lookup can
	 * be deferred. The NCA parser uses this to avoid triggering an
	 * AES-CTR-protected read during the first (key-less)
	 * `parseNca` pass; the thunk is only invoked on actual data
	 * reads.
	 */
	logicalSize: bigint | (() => Promise<bigint>);
}

export class CompressedStorageReader {
	private readonly readSectionRange: (start: bigint, end: bigint) => Promise<Uint8Array>;
	private readonly table: BucketTreeReader;
	private readonly logicalSizeInput: bigint | (() => Promise<bigint>);
	private resolvedLogicalSize: bigint | null;

	/**
	 * Byte-bounded LRU of decoded LZ4 blocks. Keyed by entry virt
	 * start; value is the fully decoded payload. None / Zeros
	 * entries are NOT cached — None passthroughs would balloon to
	 * GB-scale for large pre-compressed assets, and Zeros costs
	 * nothing to re-synthesise.
	 *
	 * Eviction is "drop the oldest until total bytes fit"; that's
	 * O(1) amortised since LZ4 entries are uniformly tiny in
	 * practice (~64 KiB each).
	 */
	private lz4Cache = new Map<string, Uint8Array>();
	private lz4CacheBytes = 0;

	constructor(opts: CompressedStorageReaderOptions) {
		this.readSectionRange = opts.readSectionRange;
		this.table = opts.table;
		this.logicalSizeInput = opts.logicalSize;
		this.resolvedLogicalSize =
			typeof opts.logicalSize === 'bigint' ? opts.logicalSize : null;
	}

	/** Resolve the logical size, awaiting the thunk on first call. */
	async getLogicalSize(): Promise<bigint> {
		if (this.resolvedLogicalSize === null) {
			const input = this.logicalSizeInput;
			this.resolvedLogicalSize =
				typeof input === 'function' ? await input() : input;
		}
		return this.resolvedLogicalSize;
	}

	/**
	 * Read `[start, end)` logical bytes, stitching together entries
	 * as needed. Reads only the bytes the caller asked for — large
	 * passthrough entries are NEVER materialised whole.
	 */
	async read(start: bigint, end: bigint): Promise<Uint8Array> {
		if (end <= start) return new Uint8Array(0);
		const logicalSize = await this.getLogicalSize();
		if (start < 0n || end > logicalSize) {
			throw new Error(
				`CompressedStorage read out of range: [${start}, ${end}) vs logicalSize=${logicalSize}`,
			);
		}
		const totalLen = Number(end - start);
		if (!Number.isSafeInteger(totalLen)) {
			throw new Error(`CompressedStorage read too large: ${totalLen}`);
		}
		const out = new Uint8Array(totalLen);
		let cur = start;
		let written = 0;
		while (cur < end) {
			const consumed = await this.readEntrySlice(cur, end, out, written);
			cur += BigInt(consumed);
			written += consumed;
		}
		return out;
	}

	/**
	 * Resolve the entry covering `cur` and copy the overlap with
	 * `[cur, end)` into `out` starting at `outOffset`. Returns the
	 * number of bytes written (i.e. how far to advance `cur`).
	 *
	 * Critically, for None entries we read just the slice we need —
	 * no full-entry materialisation. For LZ4 we decode the full
	 * entry once and cache it (those entries are small in practice).
	 */
	private async readEntrySlice(
		cur: bigint,
		end: bigint,
		out: Uint8Array,
		outOffset: number,
	): Promise<number> {
		const found = await this.table.find(cur);
		if (!found) {
			throw new Error(
				`CompressedStorage: no entry covers virtual offset ${cur}`,
			);
		}
		const entry = parseCompressedEntry(found.entryBytes);
		const virtStart = entry.virtOffset;
		const virtEnd = found.entryEnd;
		const virtualSizeBig = virtEnd - virtStart;
		if (virtualSizeBig <= 0n) {
			throw new Error(
				`CompressedStorage: non-positive virtual size ${virtualSizeBig} for entry @ ${virtStart}`,
			);
		}
		// The overlap of `[cur, end)` with this entry:
		const entryEnd = virtEnd < end ? virtEnd : end;
		const sliceStartBig = cur - virtStart;
		const sliceLenBig = entryEnd - cur;
		const sliceStart = Number(sliceStartBig);
		const sliceLen = Number(sliceLenBig);
		if (!Number.isSafeInteger(sliceStart) || !Number.isSafeInteger(sliceLen)) {
			throw new Error(
				`CompressedStorage: slice arithmetic overflow at entry @ ${virtStart}`,
			);
		}

		switch (entry.compressionType) {
			case COMPRESSION_TYPE_NONE: {
				// Pass-through: physical size equals virtual size. Read
				// exactly the bytes asked for — the entry could be up
				// to GB-scale, and materialising the whole thing just
				// to serve a few KB would be catastrophic for memory.
				const physStart = entry.physOffset + BigInt(sliceStart);
				const physEnd = physStart + BigInt(sliceLen);
				const data = await this.readSectionRange(physStart, physEnd);
				const exact =
					data.byteLength === sliceLen ? data : data.subarray(0, sliceLen);
				out.set(exact, outOffset);
				return sliceLen;
			}
			case COMPRESSION_TYPE_ZEROS: {
				// Synthesise just the bytes asked for. `out` is already
				// zero-initialised by `new Uint8Array(totalLen)`, so we
				// could skip — but be explicit in case the buffer was
				// reused by future callers.
				out.fill(0, outOffset, outOffset + sliceLen);
				return sliceLen;
			}
			case COMPRESSION_TYPE_LZ4: {
				if (entry.physSize <= 0) {
					throw new Error(
						`CompressedStorage: LZ4 entry with non-positive physSize=${entry.physSize}`,
					);
				}
				const virtualSize = Number(virtualSizeBig);
				if (virtualSize > LZ4_ENTRY_MAX_BYTES) {
					throw new Error(
						`CompressedStorage: LZ4 entry too large (${virtualSize} > ${LZ4_ENTRY_MAX_BYTES}). Refusing to decode to avoid memory blow-up.`,
					);
				}
				const decoded = await this.decodeLz4Entry(entry, virtualSize);
				out.set(
					decoded.subarray(sliceStart, sliceStart + sliceLen),
					outOffset,
				);
				return sliceLen;
			}
			default:
				throw new Error(
					`Unknown CompressedStorage compression type: ${entry.compressionType}`,
				);
		}
	}

	/**
	 * Decode an LZ4 entry's full payload, caching the result. Cache
	 * eviction is bytes-bounded ({@link LZ4_CACHE_MAX_BYTES}) — a
	 * count-bounded LRU would let a handful of larger LZ4 entries
	 * retain tens of MB unnecessarily.
	 */
	private async decodeLz4Entry(
		entry: CompressedEntry,
		virtualSize: number,
	): Promise<Uint8Array> {
		const key = entry.virtOffset.toString();
		const cached = this.lz4Cache.get(key);
		if (cached) {
			// Refresh LRU.
			this.lz4Cache.delete(key);
			this.lz4Cache.set(key, cached);
			return cached;
		}
		const enc = await this.readSectionRange(
			entry.physOffset,
			entry.physOffset + BigInt(entry.physSize),
		);
		const encExact =
			enc.byteLength === entry.physSize
				? enc
				: enc.subarray(0, entry.physSize);
		const data = decodeBlock(encExact, virtualSize);
		this.lz4Cache.set(key, data);
		this.lz4CacheBytes += data.byteLength;
		while (
			this.lz4CacheBytes > LZ4_CACHE_MAX_BYTES &&
			this.lz4Cache.size > 1
		) {
			const oldestKey = this.lz4Cache.keys().next().value as string;
			const oldestVal = this.lz4Cache.get(oldestKey)!;
			this.lz4Cache.delete(oldestKey);
			this.lz4CacheBytes -= oldestVal.byteLength;
		}
		return data;
	}
}
