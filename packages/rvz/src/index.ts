/**
 * RVZ / WIA compressed disc images.
 *
 * WIA ("Wii ISO Archive") and its successor RVZ are the compressed
 * GameCube/Wii disc formats used by wit and Dolphin. Both split the
 * disc into fixed-size chunks and compress each one independently,
 * so the original image can be reconstructed with random access
 * rather than by decompressing the whole thing.
 *
 * Layout:
 *
 *   0x00  wia_file_head_t   magic, versions, sizes, hashes
 *   0x48  wia_disc_t        disc type, compression, chunk size, the
 *                           first 0x80 bytes of the disc, and the
 *                           locations of the three tables below
 *   ...   wia_part_t[]      Wii partition descriptors (uncompressed)
 *   ...   wia_raw_data_t[]  everything not inside a Wii partition
 *                           (compressed)
 *   ...   rvz_group_t[]     one entry per chunk, pointing at the
 *                           compressed bytes (compressed)
 *
 * All integers are big-endian.
 *
 * ## What this reader covers
 *
 * GameCube discs (`discType === 1`), which consist entirely of
 * `wia_raw_data_t` regions. Wii discs additionally store partition
 * data decrypted and stripped of its hash tree, and reconstructing
 * a byte-exact Wii image means recomputing that tree and re-applying
 * per-chunk hash exceptions — a substantial amount of work that
 * nothing here needs, so {@link parseRvz} reports Wii images as
 * unsupported rather than returning something subtly wrong.
 *
 * ## Compression
 *
 * The codec is named in the header (NONE, PURGE, BZIP2, LZMA, LZMA2,
 * or — RVZ only — Zstandard). Rather than bundle codecs, the caller
 * supplies a {@link Decompressor}; this keeps the package free of
 * WASM loading concerns and lets the host reuse whatever it already
 * has. Zstandard is what Dolphin writes by default.
 *
 * ## RVZ packing
 *
 * GameCube and Wii discs are padded with pseudorandom data, which
 * compresses terribly. RVZ stores that padding losslessly as a
 * 68-byte PRNG seed plus a length, and the reader regenerates it.
 * See {@link unpackRvz}.
 *
 * References:
 *   - dolphin-emu/dolphin `docs/WiaAndRvz.md`
 */

/** `"WIA\x01"`. */
export const WIA_MAGIC = 0x5749_4101;
/** `"RVZ\x01"`. */
export const RVZ_MAGIC = 0x5256_5a01;

/** Compression methods named in `wia_disc_t`. */
export const Compression = {
	NONE: 0,
	PURGE: 1,
	BZIP2: 2,
	LZMA: 3,
	LZMA2: 4,
	/** RVZ only. */
	ZSTD: 5,
} as const;

/** Human-readable compression name. */
export function compressionName(value: number): string {
	return (
		(['NONE', 'PURGE', 'BZIP2', 'LZMA', 'LZMA2', 'ZSTD'] as const)[value] ??
		`UNKNOWN(${value})`
	);
}

/** Disc kinds named in `wia_disc_t`. */
export const DiscType = {
	UNKNOWN: 0,
	GAMECUBE: 1,
	WII: 2,
} as const;

/**
 * Decompresses one chunk.
 *
 * `expectedSize` is what the format says the output should be; a
 * decompressor may use it to size its buffer but should not rely on
 * it being exact, because RVZ-packed groups decompress to a
 * different (smaller) size before unpacking.
 */
export type Decompressor = (
	compressed: Uint8Array,
	expectedSize: number,
) => Promise<Uint8Array>;

/** `wia_file_head_t`. */
export interface RvzFileHeader {
	magic: number;
	/** True for RVZ, false for plain WIA. */
	isRvz: boolean;
	version: number;
	versionCompatible: number;
	discStructSize: number;
	/** Size of the original disc image. */
	isoFileSize: number;
	/** Size of this file, per the header. */
	fileSize: number;
}

/** `wia_disc_t`. */
export interface RvzDisc {
	discType: number;
	compression: number;
	compressionLevel: number;
	chunkSize: number;
	/** First 0x80 bytes of the disc, stored inline. */
	discHead: Uint8Array;
	numPartitions: number;
	partitionEntrySize: number;
	partitionOffset: number;
	numRawData: number;
	rawDataOffset: number;
	rawDataSize: number;
	numGroups: number;
	groupOffset: number;
	groupSize: number;
	compressorData: Uint8Array;
}

/** `wia_raw_data_t` — a run of disc data outside any Wii partition. */
export interface RvzRawData {
	/** Offset on the disc, rounded down to a 0x8000 boundary. */
	offset: number;
	/** Byte count, extended to match the rounded-down offset. */
	size: number;
	groupIndex: number;
	numGroups: number;
}

/** `rvz_group_t`. */
export interface RvzGroup {
	/** Byte offset of the compressed data in the file. */
	dataOffset: number;
	/** Compressed byte count; 0 means the chunk is all zeroes. */
	dataSize: number;
	/**
	 * False when this group was stored uncompressed regardless of the
	 * disc's compression method — RVZ decides per group.
	 */
	compressed: boolean;
	/** Size before RVZ unpacking; 0 means the group is not packed. */
	packedSize: number;
}

function readU16(b: Uint8Array, o: number): number {
	return (b[o] << 8) | b[o + 1];
}

function readU32(b: Uint8Array, o: number): number {
	return (
		((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
	);
}

function readI32(b: Uint8Array, o: number): number {
	const v = readU32(b, o);
	return v >= 0x8000_0000 ? v - 0x1_0000_0000 : v;
}

/**
 * Read a big-endian u64 as a JS number.
 *
 * Disc images top out at ~9 GB, far below 2^53, so precision is not
 * at risk.
 */
function readU64(b: Uint8Array, o: number): number {
	return readU32(b, o) * 0x1_0000_0000 + readU32(b, o + 4);
}

/** Sector size used for the raw-data offset rounding rule. */
const SECTOR_SIZE = 0x8000;

/** Parse `wia_file_head_t` from the first 0x48 bytes. */
export function parseFileHeader(bytes: Uint8Array): RvzFileHeader | null {
	if (bytes.length < 0x48) return null;
	const magic = readU32(bytes, 0);
	if (magic !== RVZ_MAGIC && magic !== WIA_MAGIC) return null;
	return {
		magic,
		isRvz: magic === RVZ_MAGIC,
		version: readU32(bytes, 0x04),
		versionCompatible: readU32(bytes, 0x08),
		discStructSize: readU32(bytes, 0x0c),
		isoFileSize: readU64(bytes, 0x24),
		fileSize: readU64(bytes, 0x2c),
	};
}

/** Is this buffer the start of a WIA or RVZ file? */
export function isRvz(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	const magic = readU32(bytes, 0);
	return magic === RVZ_MAGIC || magic === WIA_MAGIC;
}

/** Parse `wia_disc_t`, which begins at 0x48. */
export function parseDisc(bytes: Uint8Array): RvzDisc {
	return {
		discType: readU32(bytes, 0x00),
		compression: readU32(bytes, 0x04),
		// Signed: Zstandard allows negative levels.
		compressionLevel: readI32(bytes, 0x08),
		chunkSize: readU32(bytes, 0x0c),
		discHead: bytes.slice(0x10, 0x90),
		numPartitions: readU32(bytes, 0x90),
		partitionEntrySize: readU32(bytes, 0x94),
		partitionOffset: readU64(bytes, 0x98),
		// 0xA0..0xB3 is the partition hash.
		numRawData: readU32(bytes, 0xb4),
		rawDataOffset: readU64(bytes, 0xb8),
		rawDataSize: readU32(bytes, 0xc0),
		numGroups: readU32(bytes, 0xc4),
		groupOffset: readU64(bytes, 0xc8),
		groupSize: readU32(bytes, 0xd0),
		compressorData: bytes.slice(0xd5, 0xd5 + Math.min(7, bytes[0xd4] ?? 0)),
	};
}

/**
 * Decode RVZ packing.
 *
 * The stream is a series of runs: a big-endian u32 length, then
 * either that many literal bytes, or — when the length's top bit is
 * set — a 68-byte PRNG seed that expands to that many bytes of
 * pseudorandom disc padding.
 *
 * `discOffset` is where this data lands on the disc; the generator
 * has to be advanced to the right phase when a run does not begin on
 * a 32 KiB boundary.
 */
export function unpackRvz(
	packed: Uint8Array,
	outputSize: number,
	discOffset: number,
): Uint8Array {
	const out = new Uint8Array(outputSize);
	let inPos = 0;
	let outPos = 0;

	while (inPos + 4 <= packed.length && outPos < outputSize) {
		const raw = readU32(packed, inPos);
		inPos += 4;
		const isPrng = (raw & 0x8000_0000) !== 0;
		const size = raw & 0x7fff_ffff;
		if (!isPrng) {
			const n = Math.min(size, outputSize - outPos, packed.length - inPos);
			out.set(packed.subarray(inPos, inPos + n), outPos);
			inPos += size;
			outPos += n;
			continue;
		}
		if (inPos + 68 > packed.length) break;
		const seed = packed.subarray(inPos, inPos + 68);
		inPos += 68;
		const n = Math.min(size, outputSize - outPos);
		generatePadding(seed, out, outPos, n, discOffset + outPos);
		outPos += n;
	}
	return out;
}

/**
 * Lagged Fibonacci generator used for GameCube/Wii disc padding
 * (f = xor, j = 32, k = 521).
 */
function generatePadding(
	seed: Uint8Array,
	out: Uint8Array,
	outStart: number,
	length: number,
	discOffset: number,
): void {
	const buffer = new Uint32Array(521);
	for (let i = 0; i < 17; i++) buffer[i] = readU32(seed, i * 4);
	for (let i = 17; i < 521; i++) {
		buffer[i] = (buffer[i - 17] << 23) ^ (buffer[i - 16] >>> 9) ^ buffer[i - 1];
	}

	const advance = () => {
		for (let i = 0; i < 32; i++) buffer[i] ^= buffer[i + 521 - 32];
		for (let i = 32; i < 521; i++) buffer[i] ^= buffer[i - 32];
	};
	// The generator is warmed up by four full passes before it
	// produces disc-accurate output.
	for (let i = 0; i < 4; i++) advance();

	// Padding is phase-locked to 32 KiB boundaries, so a run starting
	// mid-sector has to skip the words that precede it.
	let skipBytes = discOffset % SECTOR_SIZE;
	let index = 521;

	const nextWord = (): number => {
		if (index >= 521) {
			advance();
			index = 0;
		}
		return buffer[index++];
	};
	// The first advance() inside nextWord would over-advance, so seed
	// the index to trigger it exactly once at the start.
	index = 521;

	while (skipBytes >= 4) {
		nextWord();
		skipBytes -= 4;
	}

	let written = 0;
	let pending: number[] = [];
	if (skipBytes > 0) {
		const w = nextWord();
		pending = wordToBytes(w).slice(skipBytes);
	}
	while (written < length) {
		if (pending.length === 0) pending = wordToBytes(nextWord());
		const take = Math.min(pending.length, length - written);
		for (let i = 0; i < take; i++) out[outStart + written + i] = pending[i];
		pending = pending.slice(take);
		written += take;
	}
}

/**
 * Split a PRNG word into bytes.
 *
 * The third shift is 18, not 16. That is not a typo: the GameCube's
 * padding routine has this quirk and a byte-exact image depends on
 * reproducing it.
 */
function wordToBytes(word: number): number[] {
	return [
		(word >>> 24) & 0xff,
		(word >>> 18) & 0xff,
		(word >>> 8) & 0xff,
		word & 0xff,
	];
}

export interface OpenRvzOptions {
	/**
	 * Decompresses a chunk. Required unless the image uses the NONE
	 * method throughout.
	 */
	decompress?: Decompressor;
	/** Chunks to keep decompressed in memory (default 4). */
	cacheSize?: number;
}

/** A reconstructed disc image with random access. */
export class RvzImage {
	readonly header: RvzFileHeader;
	readonly disc: RvzDisc;
	readonly rawData: RvzRawData[];
	readonly groups: RvzGroup[];
	/** Size of the original disc image, in bytes. */
	readonly isoSize: number;

	private readonly blob: Blob;
	private readonly decompress?: Decompressor;
	private readonly cacheSize: number;
	private readonly cache = new Map<number, Uint8Array>();

	constructor(
		blob: Blob,
		header: RvzFileHeader,
		disc: RvzDisc,
		rawData: RvzRawData[],
		groups: RvzGroup[],
		options: OpenRvzOptions,
	) {
		this.blob = blob;
		this.header = header;
		this.disc = disc;
		this.rawData = rawData;
		this.groups = groups;
		this.isoSize = header.isoFileSize;
		this.decompress = options.decompress;
		this.cacheSize = options.cacheSize ?? 4;
	}

	/** Decompress and unpack one group, with a small LRU cache. */
	private async readGroup(
		groupIndex: number,
		decompressedSize: number,
		discOffset: number,
	): Promise<Uint8Array> {
		const cached = this.cache.get(groupIndex);
		if (cached) return cached;

		const group = this.groups[groupIndex];
		let out: Uint8Array;
		if (!group || group.dataSize === 0) {
			// A zero size is the format's shorthand for an all-zero
			// chunk, which is why a mostly-empty disc costs nothing.
			out = new Uint8Array(decompressedSize);
		} else {
			const raw = new Uint8Array(
				await this.blob
					.slice(group.dataOffset, group.dataOffset + group.dataSize)
					.arrayBuffer(),
			);
			let data: Uint8Array;
			if (!group.compressed || this.disc.compression === Compression.NONE) {
				data = raw;
			} else {
				if (!this.decompress) {
					throw new Error(
						`RVZ: image uses ${compressionName(
							this.disc.compression,
						)} but no decompressor was supplied`,
					);
				}
				const target =
					group.packedSize > 0 ? group.packedSize : decompressedSize;
				data = await this.decompress(raw, target);
			}
			out =
				group.packedSize > 0
					? unpackRvz(data, decompressedSize, discOffset)
					: data;
		}

		if (out.length !== decompressedSize) {
			const fixed = new Uint8Array(decompressedSize);
			fixed.set(out.subarray(0, decompressedSize));
			out = fixed;
		}
		this.cache.set(groupIndex, out);
		if (this.cache.size > this.cacheSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		return out;
	}

	/**
	 * Read `length` bytes from `offset` of the reconstructed image.
	 *
	 * Regions the image does not describe read as zeroes, matching how
	 * the format treats absent data.
	 */
	async read(offset: number, length: number): Promise<Uint8Array> {
		const out = new Uint8Array(length);
		if (length === 0) return out;

		// The first 0x80 bytes live in the header rather than a group.
		if (offset < 0x80) {
			const n = Math.min(length, 0x80 - offset);
			out.set(this.disc.discHead.subarray(offset, offset + n), 0);
		}

		for (const entry of this.rawData) {
			const start = Math.max(offset, entry.offset);
			const end = Math.min(offset + length, entry.offset + entry.size);
			if (start >= end) continue;

			let position = start;
			while (position < end) {
				const withinEntry = position - entry.offset;
				const groupOrdinal = Math.floor(withinEntry / this.disc.chunkSize);
				const groupStart =
					entry.offset + groupOrdinal * this.disc.chunkSize;
				const groupSize = Math.min(
					this.disc.chunkSize,
					entry.offset + entry.size - groupStart,
				);
				const chunk = await this.readGroup(
					entry.groupIndex + groupOrdinal,
					groupSize,
					groupStart,
				);
				const chunkFrom = position - groupStart;
				const take = Math.min(end - position, groupSize - chunkFrom);
				out.set(
					chunk.subarray(chunkFrom, chunkFrom + take),
					position - offset,
				);
				position += take;
			}
		}

		// Re-apply the head: a raw-data entry can overlap it, and the
		// header's copy is authoritative.
		if (offset < 0x80) {
			const n = Math.min(length, 0x80 - offset);
			out.set(this.disc.discHead.subarray(offset, offset + n), 0);
		}
		return out;
	}
}

/**
 * Open an RVZ or WIA image.
 *
 * Throws for Wii images and for compression methods the caller has
 * not provided a decompressor for.
 */
export async function parseRvz(
	blob: Blob,
	options: OpenRvzOptions = {},
): Promise<RvzImage> {
	const headBytes = new Uint8Array(await blob.slice(0, 0x48).arrayBuffer());
	const header = parseFileHeader(headBytes);
	if (!header) throw new Error('RVZ: bad magic (expected "RVZ\\x01" or "WIA\\x01")');

	const discBytes = new Uint8Array(
		await blob.slice(0x48, 0x48 + Math.max(header.discStructSize, 0xdc)).arrayBuffer(),
	);
	const disc = parseDisc(discBytes);

	if (disc.discType === DiscType.WII) {
		throw new Error(
			'RVZ: Wii images are not supported — their partition data is stored ' +
				'decrypted and stripped of its hash tree, which must be rebuilt to ' +
				'reconstruct the disc',
		);
	}

	// The raw-data and group tables are themselves compressed.
	const inflateTable = async (
		offset: number,
		size: number,
		expected: number,
	): Promise<Uint8Array> => {
		if (size === 0) return new Uint8Array(0);
		const raw = new Uint8Array(
			await blob.slice(offset, offset + size).arrayBuffer(),
		);
		if (disc.compression === Compression.NONE) return raw;
		if (!options.decompress) {
			throw new Error(
				`RVZ: image uses ${compressionName(
					disc.compression,
				)} but no decompressor was supplied`,
			);
		}
		return options.decompress(raw, expected);
	};

	const rawBytes = await inflateTable(
		disc.rawDataOffset,
		disc.rawDataSize,
		disc.numRawData * 24,
	);
	const rawData: RvzRawData[] = [];
	for (let i = 0; i < disc.numRawData; i++) {
		const o = i * 24;
		if (o + 24 > rawBytes.length) break;
		const rawOffset = readU64(rawBytes, o);
		const rawSize = readU64(rawBytes, o + 8);
		// Offsets are rounded down to a sector boundary, with the size
		// extended so the end stays put. The spec calls this out
		// because the first entry looks like a special case otherwise.
		const aligned = Math.floor(rawOffset / SECTOR_SIZE) * SECTOR_SIZE;
		rawData.push({
			offset: aligned,
			size: rawSize + (rawOffset - aligned),
			groupIndex: readU32(rawBytes, o + 16),
			numGroups: readU32(rawBytes, o + 20),
		});
	}

	const groupBytes = await inflateTable(
		disc.groupOffset,
		disc.groupSize,
		disc.numGroups * (header.isRvz ? 12 : 8),
	);
	const groupStride = header.isRvz ? 12 : 8;
	const groups: RvzGroup[] = [];
	for (let i = 0; i < disc.numGroups; i++) {
		const o = i * groupStride;
		if (o + groupStride > groupBytes.length) break;
		const dataOffset4 = readU32(groupBytes, o);
		const sizeField = readU32(groupBytes, o + 4);
		// RVZ reuses the top bit of the size to say whether this group
		// was actually compressed; WIA has no such bit.
		const compressed = header.isRvz ? (sizeField & 0x8000_0000) !== 0 : true;
		groups.push({
			dataOffset: dataOffset4 * 4,
			dataSize: header.isRvz ? sizeField & 0x7fff_ffff : sizeField,
			compressed,
			packedSize: header.isRvz ? readU32(groupBytes, o + 8) : 0,
		});
	}

	return new RvzImage(blob, header, disc, rawData, groups, options);
}
