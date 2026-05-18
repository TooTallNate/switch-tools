/**
 * LGP archive parser.
 *
 * LGP (a.k.a. "SQUARESOFT" container) is the on-disk archive
 * format that Final Fantasy VII and Final Fantasy VIII use on
 * PC for textures, models, MIDI music, scripts, etc. Every
 * file ends with the magic string `FINAL FANTASY7` for FF7-era
 * archives (FF8 uses the same byte layout but does NOT
 * terminate with the footer string — we accept either).
 *
 * # File layout
 *
 *   header                 16 bytes
 *     0x00  uint16          reserved (zero)
 *     0x02  char[10]        "SQUARESOFT"
 *     0x0C  uint16          file count
 *     0x0E  uint16          reserved (zero)
 *
 *   table of contents      27 × fileCount bytes
 *     per entry:
 *       0x00  char[20]      filename (null-padded, no path)
 *       0x14  uint32        absolute offset to file header
 *       0x18  uint8         file type (always 14 / 0x0e)
 *       0x19  uint16        path-table group index (1-based, 0 = root)
 *
 *   hash table             3600 bytes (900 × 4)
 *     30 × 30 buckets keyed by first two chars of the filename
 *     stem. We don't need the hash for sequential reads — it's
 *     skipped here.
 *
 *   path table             variable
 *     uint16 group count
 *     per group:
 *       uint16 path count
 *       per path:
 *         char[128] path
 *         uint16 TOC index this path applies to
 *
 *   file data              variable
 *     per file (referenced by TOC offsets):
 *       0x00  char[20]      filename (matches TOC)
 *       0x14  uint32        file size in bytes
 *       0x18  byte[size]    file content
 *
 *   footer                 14 bytes: "FINAL FANTASY7"
 *
 * All multi-byte integers are little-endian.
 *
 * # Lazy reading
 *
 * {@link parseLgp} only reads the header + TOC + path table
 * up front (typically a few KB). Per-file content is returned
 * as a `Blob.slice()` over the input — accessing it materialises
 * just that file's bytes.
 */

/** Header size in bytes. */
const HEADER_SIZE = 16;
/** Bytes per TOC entry. */
const TOC_ENTRY_SIZE = 27;
/** Hash table is a fixed 900 × 4 bytes. */
const HASH_TABLE_SIZE = 3600;
/** Per-file header (name + size) inside the file data section. */
const FILE_HEADER_SIZE = 24;

export class LgpParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LgpParseError';
	}
}

/** One file inside an LGP archive. */
export interface LgpEntry {
	/** File name with any directory path resolved from the path table prefixed. */
	name: string;
	/** Just the file name, with no directory prefix (matches the TOC). */
	baseName: string;
	/**
	 * Optional path prefix (without trailing slash), or empty if the
	 * file is in the root.
	 */
	directory: string;
	/** File size in bytes (from the per-file header). */
	size: number;
	/**
	 * Lazy file content. The returned `Blob` is a slice view over the
	 * source archive — no copy, no upfront read. Calling
	 * `.arrayBuffer()` / `.stream()` triggers the actual byte read.
	 */
	data: Blob;
}

/** Parsed-archive metadata + lazy entry list. */
export interface ParsedLgp {
	/** Number of TOC entries the file claims. */
	fileCount: number;
	/** True when the file ends with the `FINAL FANTASY7` footer (FF7-era). */
	hasFooter: boolean;
	/** Resolved entries, in TOC order. */
	entries: LgpEntry[];
}

/**
 * Test whether `bytes` looks like the start of an LGP archive.
 *
 * Only sniffs the 12-byte prefix (`\0\0SQUARESOFT`); cheap
 * enough for magic-sniffing on every newly-discovered file.
 */
export function isLgp(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 12) return false;
	if (bytes[0] !== 0 || bytes[1] !== 0) return false;
	const sig = String.fromCharCode(...bytes.subarray(2, 12));
	return sig === 'SQUARESOFT';
}

/**
 * Parse an LGP archive from a `Blob`.
 *
 * Reads only the header + TOC + hash table + path table — typically
 * a few KB even for archives containing thousands of files. Per-
 * entry content is exposed as a lazy `Blob.slice()` over the
 * source; opening a single file pulls just that file's bytes.
 */
export async function parseLgp(blob: Blob): Promise<ParsedLgp> {
	// Up-front read: header (16) + we'll need TOC after that, but
	// we don't yet know the file count. So read just the header
	// first, then come back for the variable-sized chunks.
	if (blob.size < HEADER_SIZE + 14) {
		throw new LgpParseError(
			`Archive too small (${blob.size} bytes) to be a valid LGP`,
		);
	}
	const headerBytes = new Uint8Array(
		await blob.slice(0, HEADER_SIZE).arrayBuffer(),
	);
	if (!isLgp(headerBytes)) {
		throw new LgpParseError('Missing SQUARESOFT magic at offset 0x02');
	}
	const headerView = new DataView(
		headerBytes.buffer,
		headerBytes.byteOffset,
		headerBytes.byteLength,
	);
	const fileCount = headerView.getUint16(0x0c, true);
	if (fileCount === 0) {
		// Technically a valid empty archive — just return early.
		return { fileCount: 0, hasFooter: false, entries: [] };
	}

	// Read TOC + hash table + path table all together. We don't
	// know the path table size up front, so we tentatively read a
	// generous buffer that includes the path-table header, then
	// re-read once we know the path table's true length.
	const tocSize = fileCount * TOC_ENTRY_SIZE;
	const tocStart = HEADER_SIZE;
	const hashTableStart = tocStart + tocSize;
	const pathTableStart = hashTableStart + HASH_TABLE_SIZE;

	if (pathTableStart + 2 > blob.size) {
		throw new LgpParseError(
			`Archive truncated: expected path-table header at 0x${pathTableStart.toString(16)} but only ${blob.size} bytes available`,
		);
	}

	const tocChunkBytes = new Uint8Array(
		await blob.slice(tocStart, pathTableStart + 2).arrayBuffer(),
	);
	const tocView = new DataView(
		tocChunkBytes.buffer,
		tocChunkBytes.byteOffset,
		tocChunkBytes.byteLength,
	);

	// Parse TOC entries.
	interface TocEntry {
		baseName: string;
		fileHeaderOffset: number;
		pathGroupIndex: number;
	}
	const toc: TocEntry[] = [];
	for (let i = 0; i < fileCount; i++) {
		const off = i * TOC_ENTRY_SIZE;
		const baseName = readCString(tocChunkBytes, off, 20);
		const fileHeaderOffset = tocView.getUint32(off + 20, true);
		const pathGroupIndex = tocView.getUint16(off + 25, true);
		toc.push({ baseName, fileHeaderOffset, pathGroupIndex });
	}

	// Read path-table group count. The path table is variable-
	// sized: <u16 groupCount> [<u16 pathCount> <path×130 B>] × N.
	const pathGroupCount = tocView.getUint16(
		hashTableStart + HASH_TABLE_SIZE - tocStart,
		true,
	);

	// Walk path groups by streaming a fresh slice — group sizes vary
	// because pathCount differs per group.
	const pathByTocIndex = new Map<number, string>();
	if (pathGroupCount > 0) {
		// Pull a conservative upper-bound slice for the path table:
		// up to the minimum file-header offset we saw in the TOC.
		// (Files always sit AFTER the path table in well-formed
		// archives; the first file's offset is the upper bound.)
		let minFileOffset = blob.size;
		for (const t of toc) {
			if (t.fileHeaderOffset < minFileOffset) {
				minFileOffset = t.fileHeaderOffset;
			}
		}
		const pathTableHeaderOffset = pathTableStart; // u16 of pathGroupCount
		const pathTableBytes = new Uint8Array(
			await blob
				.slice(pathTableHeaderOffset + 2, minFileOffset)
				.arrayBuffer(),
		);
		const pathView = new DataView(
			pathTableBytes.buffer,
			pathTableBytes.byteOffset,
			pathTableBytes.byteLength,
		);
		let cursor = 0;
		// Groups are 1-indexed (TOC.pathGroupIndex of 1 → first group).
		for (let g = 0; g < pathGroupCount; g++) {
			if (cursor + 2 > pathTableBytes.byteLength) break;
			const pathCount = pathView.getUint16(cursor, true);
			cursor += 2;
			for (let p = 0; p < pathCount; p++) {
				if (cursor + 130 > pathTableBytes.byteLength) break;
				const path = readCString(pathTableBytes, cursor, 128);
				const tocIndex = pathView.getUint16(cursor + 128, true);
				cursor += 130;
				// `tocIndex` is 1-based but archives in the wild also
				// use 0-based; accept either. The path applies to the
				// referenced TOC entry directly.
				const idx = tocIndex > 0 ? tocIndex - 1 : tocIndex;
				if (idx >= 0 && idx < toc.length) {
					pathByTocIndex.set(idx, path);
				}
			}
		}
	}

	// For each TOC entry, read its file header to get the size,
	// then build the lazy data Blob. We batch the file-header reads
	// in parallel — each is only 24 bytes, but they may be widely
	// scattered, so kicking them all off at once amortises the
	// browser's request overhead nicely.
	const headers = await Promise.all(
		toc.map(async (t) => {
			const start = t.fileHeaderOffset;
			const headerSlice = await blob
				.slice(start, start + FILE_HEADER_SIZE)
				.arrayBuffer();
			const headerArr = new Uint8Array(headerSlice);
			const size = new DataView(headerSlice).getUint32(20, true);
			// The file-header filename should match the TOC name —
			// the game itself doesn't enforce this (it trusts the
			// TOC), but verifying it catches corrupted archives.
			const headerName = readCString(headerArr, 0, 20);
			return { size, headerName };
		}),
	);

	const entries: LgpEntry[] = toc.map((t, i) => {
		const directory = pathByTocIndex.get(i) ?? '';
		const baseName = t.baseName;
		const fullName = directory ? `${directory}/${baseName}` : baseName;
		const fileBodyOffset = t.fileHeaderOffset + FILE_HEADER_SIZE;
		const { size } = headers[i]!;
		return {
			name: fullName,
			baseName,
			directory,
			size,
			data: blob.slice(fileBodyOffset, fileBodyOffset + size),
		};
	});

	// Footer detection — last 14 bytes should be `FINAL FANTASY7`
	// for FF7-era archives. FF8 uses a different (or omitted)
	// footer; we don't insist on it.
	let hasFooter = false;
	if (blob.size >= 14) {
		const footerBytes = new Uint8Array(
			await blob.slice(blob.size - 14, blob.size).arrayBuffer(),
		);
		hasFooter =
			String.fromCharCode(...footerBytes) === 'FINAL FANTASY7';
	}

	return { fileCount, hasFooter, entries };
}

/**
 * Read a NUL-terminated ASCII string starting at `offset`,
 * bounded by `maxLength` bytes. Bytes past the first NUL are
 * ignored (they're padding).
 */
function readCString(
	bytes: Uint8Array,
	offset: number,
	maxLength: number,
): string {
	const end = Math.min(bytes.byteLength, offset + maxLength);
	let nulIdx = end;
	for (let i = offset; i < end; i++) {
		if (bytes[i] === 0) {
			nulIdx = i;
			break;
		}
	}
	let s = '';
	for (let i = offset; i < nulIdx; i++) {
		s += String.fromCharCode(bytes[i]!);
	}
	return s;
}
