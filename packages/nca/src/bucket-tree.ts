/**
 * @license MIT
 *
 * Minimal reader for the on-disk "BucketTree" format used inside NCAs.
 *
 * The format is documented at https://switchbrew.org/wiki/NCA — it's a
 * 2-level (optionally 3-level) index that maps a virtual offset to an
 * "entry" of fixed size. There are several BucketTree variants in
 * Switch firmware (CompressedStorage, IndirectStorage, AesCtrExStorage,
 * SparseStorage); this reader is generic over the entry layout — the
 * caller specifies `entrySize` and interprets the returned bytes.
 *
 * On-disk layout for our purposes (single-level L1):
 *
 *   nodeStorage:  L1 NodeHeader(16) + L1 offsets[count]
 *                 (each i64 = the *start* virtual offset of the
 *                 corresponding entry set; the L1 NodeHeader's
 *                 `offset` field is the table's overall end offset.
 *                 Padding zeros follow up to `nodeSize`.)
 *
 *   entryStorage: For each entry set, `nodeSize` bytes laid out as
 *                 EntrySetHeader(16) + entries[count_in_set] (each
 *                 `entrySize` bytes). The entry set header's `index`
 *                 matches its position; `offset` is the end virtual
 *                 offset of that set.
 *
 * NOTE: The 16-byte BucketTree *top-level* header (magic "BKTR",
 * version, entry_count) lives **outside** of `nodeStorage` — for NCA
 * compression / sparse layers it's embedded in the FS header itself
 * (the `NcaBucketInfo::header[0x10]` field). Callers parse it once
 * (via {@link parseBucketTreeHeader}) and pass the resulting
 * `entryCount` in; this reader doesn't re-read it.
 *
 * The reader keeps only the L1 node in memory; entry sets are fetched
 * on demand via the supplied node/entry storages (either a `Uint8Array`
 * or a lazy `Blob`). A small LRU keeps the last few entry-set buffers
 * cached so sequential reads don't refetch.
 *
 * L2 (3-level) trees are not supported by this reader — see the README
 * for why this is unlikely to matter for any real NCA in the wild.
 */

const HEADER_SIZE = 16;
const NODE_HEADER_SIZE = 16;
const MAGIC_BKTR = 0x5254_4b42; // "BKTR" little-endian

export interface BucketTreeHeader {
	/** Magic constant; must be `0x52544B42` ("BKTR" LE). */
	magic: number;
	/** Format version; only `1` is supported. */
	version: number;
	/** Total number of entries across all entry sets. */
	entryCount: number;
	/** Header reserved word (typically zero). */
	reserved: number;
}

export interface BucketTreeNodeHeader {
	index: number;
	count: number;
	offset: bigint;
}

/** Virtual offset range covered by the bucket tree. */
export interface BucketTreeOffsets {
	startOffset: bigint;
	endOffset: bigint;
}

/** Result of {@link BucketTreeReader.find}. */
export interface BucketTreeFind {
	/** Raw bytes of the matched entry (length === `entrySize`). */
	entryBytes: Uint8Array;
	/**
	 * The virtual offset at which this entry stops covering bytes — i.e.
	 * the next entry's `virt_offset`, or the tree's overall `endOffset`
	 * if this is the last entry. Lets the caller compute the entry's
	 * decompressed size by reading the entry's `virt_offset` from
	 * `entryBytes` and subtracting.
	 */
	entryEnd: bigint;
}

/**
 * Parse the 16-byte BucketTree top-level header at the beginning of
 * `bytes`. Validates magic + version; throws otherwise.
 */
export function parseBucketTreeHeader(bytes: Uint8Array): BucketTreeHeader {
	if (bytes.byteLength < HEADER_SIZE) {
		throw new Error(
			`BucketTree header truncated: got ${bytes.byteLength} bytes, need ${HEADER_SIZE}`,
		);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = dv.getUint32(0, true);
	const version = dv.getUint32(4, true);
	const entryCount = dv.getInt32(8, true);
	const reserved = dv.getUint32(12, true);
	if (magic !== MAGIC_BKTR) {
		throw new Error(
			`Invalid BucketTree magic: got 0x${magic.toString(16)}, expected 0x${MAGIC_BKTR.toString(16)} ("BKTR")`,
		);
	}
	if (version !== 1) {
		throw new Error(`Unsupported BucketTree version: ${version} (only 1 supported)`);
	}
	return { magic, version, entryCount, reserved };
}

function parseNodeHeader(bytes: Uint8Array, off: number): BucketTreeNodeHeader {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		index: dv.getInt32(off + 0, true),
		count: dv.getInt32(off + 4, true),
		offset: dv.getBigInt64(off + 8, true),
	};
}

/**
 * Abstraction over a byte source: either an in-memory `Uint8Array` or
 * an asynchronous `Blob` (which may itself be lazy / cover a 4 GB
 * file). All reads return a freshly-owned `Uint8Array`.
 */
async function readRange(
	source: Uint8Array | Blob,
	start: number,
	end: number,
): Promise<Uint8Array> {
	if (source instanceof Uint8Array) {
		return source.subarray(start, end);
	}
	const ab = await source.slice(start, end).arrayBuffer();
	return new Uint8Array(ab);
}

export interface BucketTreeReaderOptions {
	/**
	 * Storage backing the L1 node region. The first 16 bytes are the
	 * top-level header (parsed once by {@link BucketTreeReader.init}),
	 * then the L1 NodeHeader + L1 offset array up to `nodeSize`.
	 */
	nodeStorage: Uint8Array | Blob;
	/**
	 * Storage backing the entry sets. Conceptually a contiguous array
	 * of `entrySetCount × nodeSize` byte regions, each starting with
	 * an EntrySetHeader and followed by per-entry payload.
	 */
	entryStorage: Uint8Array | Blob;
	/** Node size — 16 KiB for CompressedStorage. */
	nodeSize: number;
	/** Per-entry size, in bytes. 0x18 for CompressedStorage. */
	entrySize: number;
	/** Entry count parsed from the top-level header. */
	entryCount: number;
}

export class BucketTreeReader {
	readonly nodeStorage: Uint8Array | Blob;
	readonly entryStorage: Uint8Array | Blob;
	readonly nodeSize: number;
	readonly entrySize: number;
	readonly entryCount: number;

	/**
	 * Number of entry sets — i.e. how many `nodeSize`-sized regions
	 * live inside `entryStorage`. Lazily populated from the L1 node
	 * header (which is the ground truth; computing this from
	 * `entryCount` and `entriesPerSet` assumes maximal packing, but
	 * real-world entry sets aren't always full).
	 */
	private entrySetCountCached: number | null = null;
	/** Max entries per *entry set* (each entry set fits in one node). */
	readonly entriesPerSet: number;
	/** Max offsets per node (used to detect overflow into L2). */
	readonly offsetsPerNode: number;

	private offsetsCache: BucketTreeOffsets | null = null;
	/**
	 * L1 offsets: virtual-start boundaries of each entry set. Index
	 * `i` is the start offset of entry-set `i`; one past the last
	 * (== `entrySetCount`) is the tree's overall end offset.
	 *
	 * Lazily populated on the first read; once loaded, no further
	 * IO is needed against `nodeStorage`.
	 */
	private l1Starts: bigint[] | null = null;

	/**
	 * Small LRU of recently-fetched entry sets, keyed by index. We
	 * deliberately keep this tiny — entry sets are 16 KiB, and the
	 * typical access pattern (sequential reads through compressed
	 * RomFS) tolerates a small working set well.
	 */
	private entrySetCache = new Map<number, Uint8Array>();
	private static readonly ENTRY_SET_CACHE_MAX = 4;

	constructor(opts: BucketTreeReaderOptions) {
		this.nodeStorage = opts.nodeStorage;
		this.entryStorage = opts.entryStorage;
		this.nodeSize = opts.nodeSize;
		this.entrySize = opts.entrySize;
		this.entryCount = opts.entryCount;

		this.entriesPerSet = Math.floor(
			(this.nodeSize - NODE_HEADER_SIZE) / this.entrySize,
		);
		this.offsetsPerNode = Math.floor(
			(this.nodeSize - NODE_HEADER_SIZE) / 8,
		);
	}

	/**
	 * Number of entry sets in the tree, as recorded in the L1
	 * NodeHeader's `count` field. Requires the L1 node to be
	 * loaded — use `getOffsets()` first when calling from outside.
	 */
	get entrySetCount(): number {
		if (this.entrySetCountCached === null) {
			throw new Error('BucketTreeReader: entrySetCount accessed before ensureL1()');
		}
		return this.entrySetCountCached;
	}

	/**
	 * Load (and cache) the L1 node — the small region that drives all
	 * entry-set lookups. Idempotent.
	 */
	private async ensureL1(): Promise<bigint[]> {
		if (this.l1Starts) return this.l1Starts;
		// Read the L1 node region. For NCA bucket trees, the top-level
		// 16-byte BKTR header lives elsewhere (in the FS header's
		// CompressionInfo / SparseInfo struct); `nodeStorage` starts
		// directly at the L1 NodeHeader.
		const node = await readRange(this.nodeStorage, 0, this.nodeSize);
		const l1 = parseNodeHeader(node, 0);

		// For single-level trees, the L1 NodeHeader's `count` field IS
		// the number of entry sets — and it's the source of truth, since
		// real-world entry sets aren't always maximally packed. We
		// detect "needs L2" by comparing against the precomputed
		// maximum entry-set count that *would* be required if every
		// set were full; if that minimum exceeds offsetsPerNode, we
		// must have L2, which we don't support.
		const maxEntriesPerSet = this.entriesPerSet;
		const minRequiredEntrySetCount =
			this.entryCount > 0
				? Math.ceil(this.entryCount / maxEntriesPerSet)
				: 0;
		if (minRequiredEntrySetCount > this.offsetsPerNode) {
			// We'd need to walk an L2 layer to map a virtual offset to its
			// entry set. CompressedStorage in the wild always fits in L1
			// (the L1 node holds ~2046 offsets, supporting ~2046 × 681 ≈
			// 1.4M entries; real NCAs have at most ~100k). If we ever see
			// one that needs L2, the user can file an issue.
			throw new Error(
				`L2 BKTR not supported (entryCount=${this.entryCount} requires ${minRequiredEntrySetCount} entry sets, but only ${this.offsetsPerNode} offsets fit in L1)`,
			);
		}

		// L1 offsets start at byte NODE_HEADER_SIZE (16) of nodeStorage.
		// The count is authoritative — real entry sets aren't always full.
		const offsetsBase = NODE_HEADER_SIZE;
		const starts: bigint[] = [];
		const dv = new DataView(node.buffer, node.byteOffset, node.byteLength);
		for (let i = 0; i < l1.count; i++) {
			starts.push(dv.getBigInt64(offsetsBase + i * 8, true));
		}

		this.entrySetCountCached = l1.count;
		this.l1Starts = starts;
		// The L1 node header's `offset` field is the tree's overall end offset.
		this.offsetsCache = {
			startOffset: starts.length > 0 ? starts[0] : 0n,
			endOffset: l1.offset,
		};
		return starts;
	}

	async getOffsets(): Promise<BucketTreeOffsets> {
		await this.ensureL1();
		// `ensureL1` always sets this together with `l1Starts`.
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return this.offsetsCache!;
	}

	/**
	 * Locate the entry covering `virtualOffset` and return its raw
	 * bytes plus the (exclusive) end offset at which it stops
	 * covering data.
	 *
	 * Returns `null` when `virtualOffset` is outside the tree's
	 * `[startOffset, endOffset)` range.
	 */
	async find(virtualOffset: bigint): Promise<BucketTreeFind | null> {
		const starts = await this.ensureL1();
		const offsets = await this.getOffsets();
		if (
			virtualOffset < offsets.startOffset ||
			virtualOffset >= offsets.endOffset
		) {
			return null;
		}

		// Binary search L1 for the largest index `i` with starts[i] <= virtualOffset.
		const entrySetIndex = upperBoundBigint(starts, virtualOffset) - 1;
		if (entrySetIndex < 0 || entrySetIndex >= this.entrySetCount) {
			return null;
		}

		// Determine the end of this entry set's virtual range.
		const entrySetEnd =
			entrySetIndex + 1 < starts.length
				? starts[entrySetIndex + 1]
				: offsets.endOffset;

		// Fetch (or hit the cache) the entry set bytes.
		const setBytes = await this.fetchEntrySet(entrySetIndex);

		// Parse the entry set header. The entry set header's `offset`
		// matches `entrySetEnd` for non-final sets; we trust the L1
		// offsets array as the source of truth.
		const setHeader = parseNodeHeader(setBytes, 0);
		if (setHeader.count <= 0) {
			return null;
		}

		// Binary search inside the entry set. Each entry's first 8 bytes
		// are its virtual offset (this layout is shared between every
		// BucketTree variant we care about — Compressed, AesCtrEx,
		// Indirect, Sparse; the rest of the entry differs but the
		// `virt_offset` prefix doesn't).
		const entriesBase = NODE_HEADER_SIZE;
		const dv = new DataView(setBytes.buffer, setBytes.byteOffset, setBytes.byteLength);
		const readVirt = (idx: number): bigint =>
			dv.getBigInt64(entriesBase + idx * this.entrySize, true);

		// Find the largest `i` with virt_offset[i] <= virtualOffset.
		let lo = 0;
		let hi = setHeader.count;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (readVirt(mid) <= virtualOffset) lo = mid + 1;
			else hi = mid;
		}
		const entryIdx = lo - 1;
		if (entryIdx < 0) return null;

		const entryStart = entriesBase + entryIdx * this.entrySize;
		// Always hand back a fresh Uint8Array — the slice may live in a
		// shared cached buffer.
		const entryBytes = setBytes.slice(entryStart, entryStart + this.entrySize);
		// Compute this entry's coverage end: either the next entry in
		// this set, or the entry set's overall end.
		const entryEnd =
			entryIdx + 1 < setHeader.count ? readVirt(entryIdx + 1) : entrySetEnd;

		return { entryBytes, entryEnd };
	}

	private async fetchEntrySet(index: number): Promise<Uint8Array> {
		const cached = this.entrySetCache.get(index);
		if (cached) {
			// Bump LRU recency: re-insert.
			this.entrySetCache.delete(index);
			this.entrySetCache.set(index, cached);
			return cached;
		}
		const start = index * this.nodeSize;
		const end = start + this.nodeSize;
		const bytes = await readRange(this.entryStorage, start, end);
		// Copy out of any shared subarray-of-Uint8Array view so the
		// cache controls its own memory.
		const owned =
			bytes.buffer === (this.entryStorage as Uint8Array).buffer
				? bytes.slice()
				: bytes;
		this.entrySetCache.set(index, owned);
		while (this.entrySetCache.size > BucketTreeReader.ENTRY_SET_CACHE_MAX) {
			const oldest = this.entrySetCache.keys().next().value as number;
			this.entrySetCache.delete(oldest);
		}
		return owned;
	}
}

/**
 * Standard `upper_bound`: returns the first index `i` with `arr[i] > target`,
 * or `arr.length` if no such index exists. Works on a strictly-non-decreasing
 * bigint array (the L1 starts are strictly increasing).
 */
function upperBoundBigint(arr: bigint[], target: bigint): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid] <= target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
