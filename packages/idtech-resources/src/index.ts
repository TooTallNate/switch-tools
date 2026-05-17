/**
 * Parser for idTech BFG-era `.resources` archives.
 *
 * This format was introduced with DOOM 3 BFG Edition (id Software,
 * 2012) and reused by RAGE, Wolfenstein: The New Order, and the
 * Switch port of DOOM 3 BFG. It's a flat container — no directory
 * tree, just a list of full path strings — with all file data
 * stored uncompressed.
 *
 * Wire layout:
 *
 *   ┌─────────────────────────┐
 *   │ Header (12 bytes)       │   magic (0xD000000D), tableOffset,
 *   │                         │   tableLength — all BE int32
 *   ├─────────────────────────┤
 *   │ File data (lazy)        │   ← never materialised by this parser
 *   │   ...                   │
 *   │                         │
 *   ├─────────────────────────┤
 *   │ File table              │   at `tableOffset`, `tableLength` bytes
 *   │   int32 numFiles  (BE)  │
 *   │   for each entry:       │
 *   │     int32 nameLen (LE)  │
 *   │     char[nameLen] name  │
 *   │     int32 offset  (BE)  │
 *   │     int32 length  (BE)  │
 *   └─────────────────────────┘
 *
 * The mixed endianness comes from idTech's `idFile_Memory` API:
 *
 *   - `ReadBig` calls swap to native and produce big-endian numbers
 *     on disk; used for the magic, table offset/length, numFiles,
 *     and each entry's offset/length.
 *   - `ReadString` is a thin wrapper around `ReadInt` (which always
 *     reads little-endian), then `Read(len)`. So the filename
 *     length lives on disk as a little-endian int32.
 *
 * Reference: `neo/framework/File_Resource.cpp` in the
 * `id-Software/DOOM-3-BFG` GPL-3.0 source release, on which this
 * parser is based (this file is a clean-room rewrite — no GPL code
 * is copied).
 *
 * The parser slurps only the table block (typically a few tens of
 * KB even for multi-GB archives) and exposes each entry as a lazy
 * `Blob` slice into the source so multi-GB archives stay bounded
 * in memory.
 */

/** The single byte sequence identifying a `.resources` file. */
export const RESOURCE_FILE_MAGIC = 0xd000000d;

const HEADER_SIZE = 12;

export interface IdTechResourceEntry {
	/**
	 * Full path/name as recorded in the archive, e.g.
	 * `"materials/aaduffyTest.mtr"`. id's game runtime applies
	 * `BackSlashesToSlashes()` and `ToLower()` before hashing for
	 * lookups, but the on-disk value preserves the original casing
	 * and may use either separator — callers that want canonical
	 * names should normalise themselves.
	 */
	name: string;
	/** Absolute byte offset of this file within the source archive. */
	offset: number;
	/** Size of the file body in bytes. */
	size: number;
	/** Lazy `Blob` view of the file's bytes. */
	data: Blob;
}

export interface ParsedIdTechResources {
	/** Absolute offset of the file table within the source archive. */
	tableOffset: number;
	/** Size of the file table, in bytes. */
	tableLength: number;
	/** Number of file entries declared in the table header. */
	numFiles: number;
	/**
	 * Parsed entries, in declaration order. Names are kept verbatim
	 * (no case / separator normalisation).
	 */
	entries: IdTechResourceEntry[];
}

/** Cheap 4-byte magic check. */
export async function isIdTechResources(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0xd0 &&
		head[1] === 0x00 &&
		head[2] === 0x00 &&
		head[3] === 0x0d
	);
}

/**
 * Parse an idTech BFG `.resources` archive. Reads only the 12-byte
 * header up front, then slurps the file table from `tableOffset`.
 * Each entry's `data` is a lazy `Blob.slice()`; file bodies are
 * never read here.
 */
export async function parseIdTechResources(
	blob: Blob,
): Promise<ParsedIdTechResources> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a .resources file (${blob.size} bytes, need at least ${HEADER_SIZE})`,
		);
	}

	const headBytes = new Uint8Array(
		await blob.slice(0, HEADER_SIZE).arrayBuffer(),
	);
	const headView = new DataView(
		headBytes.buffer,
		headBytes.byteOffset,
		headBytes.byteLength,
	);
	const magic = headView.getUint32(0, /*littleEndian*/ false);
	if (magic !== RESOURCE_FILE_MAGIC) {
		throw new Error(
			`Bad .resources magic 0x${magic.toString(16).padStart(8, '0')} (expected 0xd000000d)`,
		);
	}

	const tableOffset = headView.getInt32(4, /*littleEndian*/ false);
	const tableLength = headView.getInt32(8, /*littleEndian*/ false);

	if (tableOffset <= 0 || tableLength <= 0) {
		throw new Error(
			`Invalid table header: offset=${tableOffset}, length=${tableLength}`,
		);
	}
	const tableEnd = tableOffset + tableLength;
	if (tableEnd > blob.size) {
		throw new Error(
			`Table runs past end of archive (table end=${tableEnd}, blob size=${blob.size})`,
		);
	}

	// Slurp the table in one shot. Typical sizes are a few KB to a
	// few tens of MB at the very extreme — well within memory budget.
	const tableBytes = new Uint8Array(
		await blob.slice(tableOffset, tableEnd).arrayBuffer(),
	);
	const tv = new DataView(
		tableBytes.buffer,
		tableBytes.byteOffset,
		tableBytes.byteLength,
	);

	const numFiles = tv.getInt32(0, /*littleEndian*/ false);
	if (numFiles < 0 || numFiles > 1_000_000) {
		// A million-entry archive would be exceptional; this catches
		// corrupt files that report a bogus count without trying to
		// allocate the resulting array.
		throw new Error(`Unreasonable file count ${numFiles}`);
	}

	const decoder = new TextDecoder('utf-8', { fatal: false });
	const entries: IdTechResourceEntry[] = new Array(numFiles);
	let p = 4;

	for (let i = 0; i < numFiles; i++) {
		if (p + 4 > tableBytes.length) {
			throw new Error(
				`Entry ${i}: filename-length field runs past end of table (offset ${p}, table size ${tableBytes.length})`,
			);
		}
		// idTech's idFile::ReadString uses ReadInt (LittleLong). The
		// rest of the fields are written via ReadBig. Don't ask.
		const nameLen = tv.getInt32(p, /*littleEndian*/ true);
		p += 4;
		if (nameLen < 0 || nameLen > 4096 || p + nameLen + 8 > tableBytes.length) {
			throw new Error(
				`Entry ${i}: bad filename length ${nameLen} at table offset ${p - 4}`,
			);
		}
		const name = decoder.decode(tableBytes.subarray(p, p + nameLen));
		p += nameLen;
		const fileOffset = tv.getInt32(p, /*littleEndian*/ false);
		p += 4;
		const fileSize = tv.getInt32(p, /*littleEndian*/ false);
		p += 4;

		if (fileOffset < 0 || fileSize < 0) {
			throw new Error(
				`Entry ${i} (${JSON.stringify(name)}): negative offset/size (offset=${fileOffset}, size=${fileSize})`,
			);
		}
		if (fileSize > 0 && fileOffset + fileSize > blob.size) {
			throw new Error(
				`Entry ${i} (${JSON.stringify(name)}): runs past end of archive (offset=${fileOffset}, size=${fileSize}, blob size=${blob.size})`,
			);
		}

		entries[i] = {
			name,
			offset: fileOffset,
			size: fileSize,
			data: blob.slice(fileOffset, fileOffset + fileSize),
		};
	}

	return {
		tableOffset,
		tableLength,
		numFiles,
		entries,
	};
}
