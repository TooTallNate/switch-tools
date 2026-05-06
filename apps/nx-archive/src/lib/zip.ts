/**
 * Lazy ZIP archive parser for the nx-archive viewer.
 *
 * Reading strategy:
 *
 *   1. Locate the End-Of-Central-Directory record by scanning the last
 *      ~65 KB for the `0x06054b50` signature.
 *   2. If a ZIP64 locator (`0x07064b50`) is present 20 bytes before
 *      the EOCD, follow it to read the 64-bit central-directory
 *      offset/size. This is what lets us open multi-GB archives.
 *   3. Slice and parse the central directory in one shot — that's
 *      typically a few KB even for large archives.
 *   4. Each entry is exposed as a *lazy* object: its data isn't
 *      materialised until the user actually opens the file.
 *      Decompression uses {@link inflateSync} from `fflate` only at
 *      that moment.
 *
 * Compression support: STORED (method 0) and DEFLATE (method 8). Any
 * other method (bzip2/lzma/etc.) is reported as a parse error at
 * read time, never at parse time, so the rest of the archive is
 * still browsable.
 *
 * References:
 *   - APPNOTE.TXT (PKWARE) section 4 (central directory layout)
 *   - https://en.wikipedia.org/wiki/ZIP_(file_format)
 *   - APPNOTE section 4.5.3 (ZIP64 extra field)
 */

import { inflateSync } from 'fflate';

// --- Signatures (little-endian on disk; we read with `getUint32(_, true)`) ---
const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const EOCD_MIN_SIZE = 22;
/**
 * Worst-case distance from the end of the file to the start of the
 * EOCD — 22-byte record + 65535-byte trailing comment. We read this
 * many bytes (or the whole file if smaller) to find it.
 */
const EOCD_MAX_SCAN = 22 + 65535;

const ZIP64_LOCATOR_SIG = 0x07064b50; // "PK\x06\x07"
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIG = 0x06064b50; // "PK\x06\x06"

const CENTRAL_DIR_SIG = 0x02014b50; // "PK\x01\x02"
const CENTRAL_DIR_FIXED_SIZE = 46;

const LOCAL_FILE_HEADER_SIG = 0x04034b50; // "PK\x03\x04"
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;

const ZIP64_EXTRA_ID = 0x0001;

const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

export interface ZipEntry {
	/** Full path within the archive, with `/` separators. */
	name: string;
	/** Reported uncompressed size in bytes. */
	size: number;
	/** Compressed size (= `size` for STORED entries). */
	compressedSize: number;
	/** CRC-32 of the uncompressed data, from the central directory. */
	crc32: number;
	/** Compression method id (0 = stored, 8 = deflate, others unsupported). */
	method: number;
	/** True when the entry is a directory marker (no data). */
	isDirectory: boolean;
	/**
	 * Returns the entry's *uncompressed* bytes as a `Blob`. For
	 * stored entries this is a lazy slice; for deflated entries it
	 * triggers a one-shot in-memory inflate the first time it's
	 * called. Throws synchronously-from-Promise on unsupported
	 * methods.
	 */
	data: () => Promise<Blob>;
}

export interface ParsedZip {
	/** Total number of entries in the central directory. */
	entryCount: number;
	/** Parsed entries, in central-directory order. */
	entries: ZipEntry[];
}

/** Cheap (4-byte) check for the local-file-header signature. */
export async function isZip(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const sig =
		head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24);
	// Empty archives only contain an EOCD; treat any of the three
	// well-known PK headers as ZIP-ish.
	return (
		sig === LOCAL_FILE_HEADER_SIG ||
		sig === EOCD_SIG ||
		sig === CENTRAL_DIR_SIG
	);
}

export async function parseZip(blob: Blob): Promise<ParsedZip> {
	if (blob.size < EOCD_MIN_SIZE) {
		throw new Error(
			`Blob too small to be a ZIP (${blob.size} bytes, need at least ${EOCD_MIN_SIZE})`,
		);
	}

	// --- Step 1: read tail and find EOCD signature. ---
	const tailLen = Math.min(blob.size, EOCD_MAX_SCAN);
	const tailStart = blob.size - tailLen;
	const tail = new Uint8Array(
		await blob.slice(tailStart, blob.size).arrayBuffer(),
	);
	const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

	let eocdLocalOffset = -1;
	// Scan from the end (EOCD is at the very end if there's no comment).
	for (let off = tail.length - EOCD_MIN_SIZE; off >= 0; off--) {
		if (tailView.getUint32(off, true) === EOCD_SIG) {
			eocdLocalOffset = off;
			break;
		}
	}
	if (eocdLocalOffset < 0) {
		throw new Error('ZIP End-Of-Central-Directory record not found');
	}

	// EOCD layout (little-endian):
	//   0  u32 sig
	//   4  u16 disk number
	//   6  u16 disk where central directory starts
	//   8  u16 entries on this disk
	//   10 u16 total entries
	//   12 u32 central dir size
	//   16 u32 central dir offset
	//   20 u16 comment length
	let entryCount = tailView.getUint16(eocdLocalOffset + 10, true);
	let cdSize = tailView.getUint32(eocdLocalOffset + 12, true);
	let cdOffset = tailView.getUint32(eocdLocalOffset + 16, true);

	// --- Step 1b: ZIP64 promotion. ---
	const isZip64 =
		entryCount === 0xffff ||
		cdSize === 0xffffffff ||
		cdOffset === 0xffffffff;
	if (isZip64) {
		const locOff = eocdLocalOffset - ZIP64_LOCATOR_SIZE;
		if (
			locOff < 0 ||
			tailView.getUint32(locOff, true) !== ZIP64_LOCATOR_SIG
		) {
			throw new Error(
				'ZIP requires ZIP64 but no ZIP64 locator found before EOCD',
			);
		}
		// ZIP64 EOCD locator gives us the absolute offset of the
		// ZIP64 EOCD record. Read the locator's `relative offset`
		// (u64 LE) which is *file*-absolute despite the name.
		const z64EocdOffset = readUint64(tailView, locOff + 8);
		// Read the ZIP64 EOCD record itself. We need at least the
		// fixed 56 bytes; the variable-length "extensible data
		// sector" follows but we don't need it.
		const z64HeaderRange = await blob
			.slice(z64EocdOffset, z64EocdOffset + 56)
			.arrayBuffer();
		const z64 = new DataView(z64HeaderRange);
		if (z64.getUint32(0, true) !== ZIP64_EOCD_SIG) {
			throw new Error('Bad ZIP64 EOCD signature');
		}
		// Layout (selected fields):
		//   24 u64 total entries
		//   40 u64 central dir size
		//   48 u64 central dir offset
		entryCount = clampToInt(readUint64(z64, 24));
		cdSize = clampToInt(readUint64(z64, 40));
		cdOffset = clampToInt(readUint64(z64, 48));
	}

	// --- Step 2: read & parse the central directory. ---
	if (cdOffset + cdSize > blob.size) {
		throw new Error(
			`ZIP central directory range (${cdOffset}+${cdSize}) extends past end of blob (${blob.size})`,
		);
	}
	const cd = new Uint8Array(
		await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer(),
	);
	const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);

	const entries: ZipEntry[] = [];
	let pos = 0;
	for (let i = 0; i < entryCount; i++) {
		if (pos + CENTRAL_DIR_FIXED_SIZE > cd.length) {
			throw new Error(
				`Central directory entry ${i} runs past end of central directory`,
			);
		}
		if (cdView.getUint32(pos, true) !== CENTRAL_DIR_SIG) {
			throw new Error(
				`Bad central directory signature at offset ${pos} in CD`,
			);
		}
		// Layout:
		//   0  u32 sig
		//   4  u16 version made by
		//   6  u16 version needed
		//   8  u16 general purpose flags
		//   10 u16 compression method
		//   12 u16 mtime  | 14 u16 mdate
		//   16 u32 crc32
		//   20 u32 compressed size
		//   24 u32 uncompressed size
		//   28 u16 filename length
		//   30 u16 extra field length
		//   32 u16 comment length
		//   34 u16 disk number start
		//   36 u16 internal attributes
		//   38 u32 external attributes
		//   42 u32 local header offset
		const method = cdView.getUint16(pos + 10, true);
		const crc32 = cdView.getUint32(pos + 16, true);
		let compressedSize = cdView.getUint32(pos + 20, true);
		let uncompressedSize = cdView.getUint32(pos + 24, true);
		const fileNameLen = cdView.getUint16(pos + 28, true);
		const extraLen = cdView.getUint16(pos + 30, true);
		const commentLen = cdView.getUint16(pos + 32, true);
		let localHeaderOffset = cdView.getUint32(pos + 42, true);

		const nameStart = pos + CENTRAL_DIR_FIXED_SIZE;
		const extraStart = nameStart + fileNameLen;
		const commentStart = extraStart + extraLen;
		const recordEnd = commentStart + commentLen;
		if (recordEnd > cd.length) {
			throw new Error(
				`Central directory entry ${i} truncated (declared name+extra+comment exceeds CD bounds)`,
			);
		}

		const name = decodeName(cd.subarray(nameStart, extraStart));

		// Walk the extra-field area looking for the ZIP64 extension.
		// Field layout (each record): u16 id, u16 size, [size] bytes payload.
		// Inside the ZIP64 record, each 0xFFFFFFFF placeholder is replaced
		// in *the order it appears* in the central-directory entry:
		// uncompressedSize, compressedSize, localHeaderOffset, diskNumber.
		if (extraLen) {
			let ex = extraStart;
			const exEnd = extraStart + extraLen;
			while (ex + 4 <= exEnd) {
				const id = cdView.getUint16(ex, true);
				const size = cdView.getUint16(ex + 2, true);
				const payloadStart = ex + 4;
				if (id === ZIP64_EXTRA_ID) {
					let p = payloadStart;
					const payloadEnd = payloadStart + size;
					if (uncompressedSize === 0xffffffff && p + 8 <= payloadEnd) {
						uncompressedSize = clampToInt(readUint64(cdView, p));
						p += 8;
					}
					if (compressedSize === 0xffffffff && p + 8 <= payloadEnd) {
						compressedSize = clampToInt(readUint64(cdView, p));
						p += 8;
					}
					if (
						localHeaderOffset === 0xffffffff &&
						p + 8 <= payloadEnd
					) {
						localHeaderOffset = clampToInt(readUint64(cdView, p));
						p += 8;
					}
					break;
				}
				ex = payloadStart + size;
			}
		}

		const isDirectory = name.endsWith('/');

		entries.push(
			makeEntry(blob, {
				name,
				size: uncompressedSize,
				compressedSize,
				crc32,
				method,
				isDirectory,
				localHeaderOffset,
			}),
		);

		pos = recordEnd;
	}

	return { entryCount, entries };
}

interface ZipEntryInfo {
	name: string;
	size: number;
	compressedSize: number;
	crc32: number;
	method: number;
	isDirectory: boolean;
	localHeaderOffset: number;
}

function makeEntry(source: Blob, info: ZipEntryInfo): ZipEntry {
	let cached: Promise<Blob> | null = null;
	const data = (): Promise<Blob> => {
		if (!cached) cached = readEntryData(source, info);
		return cached;
	};
	return {
		name: info.name,
		size: info.size,
		compressedSize: info.compressedSize,
		crc32: info.crc32,
		method: info.method,
		isDirectory: info.isDirectory,
		data,
	};
}

async function readEntryData(source: Blob, info: ZipEntryInfo): Promise<Blob> {
	if (info.isDirectory) {
		return new Blob([]);
	}
	// Read the local file header to figure out the actual data offset
	// (its filename/extra lengths can differ from the central
	// directory, even though the names should match).
	const lhEnd = Math.min(
		source.size,
		info.localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE,
	);
	if (info.localHeaderOffset < 0 || lhEnd > source.size) {
		throw new Error(
			`Local file header for "${info.name}" at offset ${info.localHeaderOffset} is out of bounds`,
		);
	}
	const lhBuf = new Uint8Array(
		await source.slice(info.localHeaderOffset, lhEnd).arrayBuffer(),
	);
	const lhView = new DataView(lhBuf.buffer, lhBuf.byteOffset, lhBuf.byteLength);
	if (lhView.getUint32(0, true) !== LOCAL_FILE_HEADER_SIG) {
		throw new Error(
			`Bad local file header signature for "${info.name}" at offset ${info.localHeaderOffset}`,
		);
	}
	// Local file header layout (selected):
	//   0  u32 sig
	//   26 u16 filename length
	//   28 u16 extra field length
	const lhNameLen = lhView.getUint16(26, true);
	const lhExtraLen = lhView.getUint16(28, true);
	const dataStart =
		info.localHeaderOffset +
		LOCAL_FILE_HEADER_FIXED_SIZE +
		lhNameLen +
		lhExtraLen;
	const dataEnd = dataStart + info.compressedSize;
	if (dataEnd > source.size) {
		throw new Error(
			`Compressed data for "${info.name}" extends past end of archive`,
		);
	}

	if (info.method === COMPRESSION_STORED) {
		return source.slice(dataStart, dataEnd);
	}
	if (info.method === COMPRESSION_DEFLATE) {
		const compressed = new Uint8Array(
			await source.slice(dataStart, dataEnd).arrayBuffer(),
		);
		// ZIP stores raw DEFLATE streams (no zlib/gzip header). fflate's
		// `inflateSync` consumes raw DEFLATE directly — and as a bonus,
		// `out: new Uint8Array(size)` lets it write into a pre-allocated
		// buffer when we know the decompressed size up-front.
		const outBuf = new Uint8Array(info.size);
		try {
			inflateSync(compressed, { out: outBuf });
		} catch (e) {
			throw new Error(
				`Failed to inflate "${info.name}": ${(e as Error).message ?? e}`,
			);
		}
		return new Blob([outBuf as BlobPart]);
	}
	throw new Error(
		`Unsupported ZIP compression method ${info.method} for "${info.name}" (only stored and deflate are supported)`,
	);
}

/**
 * Decode an entry name from its raw bytes. ZIP technically allows
 * either CP437 or UTF-8 (selected by general-purpose-flag bit 11),
 * but in practice well-formed modern ZIPs use UTF-8 even when the
 * flag isn't set. UTF-8 is a strict superset of ASCII, so this is
 * safe for the common case; for legacy ZIPs with non-ASCII CP437
 * names, the result will be mojibake but the rest of the archive
 * will still parse.
 */
function decodeName(bytes: Uint8Array): string {
	return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Read a 64-bit little-endian unsigned integer as a JS number. Throws
 * for values exceeding `Number.MAX_SAFE_INTEGER` (which would be a
 * 2 PiB ZIP — let's not worry about it but fail loudly if we hit
 * one).
 */
function readUint64(view: DataView, offset: number): number {
	const lo = view.getUint32(offset, true);
	const hi = view.getUint32(offset + 4, true);
	if (hi > 0x001fffff) {
		throw new Error(
			`ZIP value at offset ${offset} exceeds Number.MAX_SAFE_INTEGER`,
		);
	}
	return hi * 0x100000000 + lo;
}

/**
 * Defensive cast for u64 → number after we've already validated via
 * {@link readUint64}. Lets us pretend the rest of the parser deals
 * in plain `number` without juggling `bigint` everywhere.
 */
function clampToInt(n: number): number {
	if (!Number.isFinite(n) || n < 0) return 0;
	return n;
}
