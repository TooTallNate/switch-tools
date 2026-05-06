/**
 * SARC archive parser.
 *
 * SARC ("Sead Archive") is the standard archive format used across
 * Nintendo first-party games on the Wii U, 3DS, and Switch. It often
 * appears Yaz0-compressed inside `.szs` files; the inner archive is
 * always plain SARC. (Use {@link @tootallnate/yaz0} to decompress
 * `.szs` first.)
 *
 * Wire layout:
 *
 *   ┌─────────────────────┐
 *   │ SARC header  (0x14) │   magic, BOM, file_size, data_offset, …
 *   ├─────────────────────┤
 *   │ SFAT header  (0x0C) │   magic, node_count, hash_multiplier
 *   ├─────────────────────┤
 *   │ SFAT nodes   (0x10× │   one per file: hash, name-offset+flags,
 *   │             count)  │   data_begin, data_end (both relative to
 *   │                     │   the SARC header's `data_offset`)
 *   ├─────────────────────┤
 *   │ SFNT header  (0x08) │   magic, reserved
 *   ├─────────────────────┤
 *   │ name table          │   NUL-terminated names, each padded
 *   │                     │   to 4 bytes
 *   ├─────────────────────┤
 *   │ (alignment padding) │
 *   ├─────────────────────┤
 *   │ file data (lazy)    │   ← the only part we don't read up-front
 *   └─────────────────────┘
 *
 * All multi-byte integers are encoded in the order indicated by the
 * BOM at offset 6: `0xFEFF` ⇒ big-endian, `0xFFFE` ⇒ little-endian.
 * Switch titles are LE; Wii U titles are typically BE.
 *
 * The parser slices the entire metadata block (`[0, data_offset)`)
 * into memory in one shot — that's typically a few KB even for huge
 * archives — and exposes each file as a lazy `Blob` slice into the
 * source. This matches the PFS0 / HFS0 / NSP pattern used elsewhere
 * in this monorepo and means that 100 MB game packs can be browsed
 * without ever materializing the file data.
 *
 * Reference: https://github.com/zeldamods/sarc/blob/master/sarc/sarc.py
 */

export const SARC_MAGIC = 'SARC';

const SARC_HEADER_SIZE = 0x14;
const SFAT_HEADER_SIZE = 0x0c;
const SFAT_NODE_SIZE = 0x10;
const SFNT_HEADER_SIZE = 0x08;

export type Endian = 'big' | 'little';

export interface SarcEntry {
	/** Full path/name within the archive, e.g. `"foo/bar.bin"`. */
	name: string;
	/** FNV-style hash from the SFAT node (informational). */
	nameHash: number;
	/** Absolute byte offset of this file within the source `Blob`. */
	offset: number;
	/** Size of the file in bytes. */
	size: number;
	/** Lazy `Blob` view of the file's bytes. */
	data: Blob;
}

export interface ParsedSarc {
	/** Endianness used by the source archive. */
	endian: Endian;
	/**
	 * Hash multiplier from the SFAT header (almost always 0x65 in
	 * shipped games but Nintendo's writer allows it to be configured).
	 */
	hashMultiplier: number;
	/** Reported total file size from the SARC header. */
	fileSize: number;
	/** Absolute offset where file data begins. */
	dataOffset: number;
	/** Parsed file entries, in declaration order. */
	entries: SarcEntry[];
}

/** Cheap (4-byte) check for the SARC magic. */
export async function isSarc(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x53 /* S */ &&
		head[1] === 0x41 /* A */ &&
		head[2] === 0x52 /* R */ &&
		head[3] === 0x43 /* C */
	);
}

/**
 * Parse a SARC archive. The source `Blob` must point at the *plain*
 * SARC; if you have a `.szs`, decompress with `decompressYaz0` first.
 *
 * Only the metadata block at the front of the archive is read; file
 * bodies remain as lazy `Blob` slices.
 */
export async function parseSarc(blob: Blob): Promise<ParsedSarc> {
	if (blob.size < SARC_HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a SARC (${blob.size} bytes, need at least ${SARC_HEADER_SIZE})`,
		);
	}

	// Read the SARC header first — we need `data_offset` to know how
	// much of the front of the file to slurp for full metadata parsing.
	const headBytes = new Uint8Array(
		await blob.slice(0, SARC_HEADER_SIZE).arrayBuffer(),
	);
	if (
		headBytes[0] !== 0x53 ||
		headBytes[1] !== 0x41 ||
		headBytes[2] !== 0x52 ||
		headBytes[3] !== 0x43
	) {
		throw new Error('Bad SARC magic');
	}

	const bomBE = headBytes[6] === 0xfe && headBytes[7] === 0xff;
	const bomLE = headBytes[6] === 0xff && headBytes[7] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid SARC byte-order mark: 0x${headBytes[6].toString(16)}${headBytes[7].toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;

	const headerView = new DataView(
		headBytes.buffer,
		headBytes.byteOffset,
		headBytes.byteLength,
	);
	const headerSize = headerView.getUint16(4, isLittle);
	if (headerSize !== SARC_HEADER_SIZE) {
		throw new Error(
			`Unexpected SARC header size 0x${headerSize.toString(16)} (expected 0x14)`,
		);
	}
	const fileSize = headerView.getUint32(8, isLittle);
	const dataOffset = headerView.getUint32(0x0c, isLittle);
	const version = headerView.getUint16(0x10, isLittle);
	if (version !== 0x100) {
		throw new Error(
			`Unsupported SARC version 0x${version.toString(16)} (expected 0x100)`,
		);
	}

	if (dataOffset > blob.size) {
		throw new Error(
			`SARC data_offset (${dataOffset}) > blob size (${blob.size})`,
		);
	}

	// Slurp the entire metadata block. This is typically a few KB:
	// SFAT header + 16 bytes per file + name table.
	const meta = new Uint8Array(await blob.slice(0, dataOffset).arrayBuffer());
	const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);

	// --- SFAT ---
	const sfatOffset = SARC_HEADER_SIZE;
	if (
		meta[sfatOffset] !== 0x53 ||
		meta[sfatOffset + 1] !== 0x46 ||
		meta[sfatOffset + 2] !== 0x41 ||
		meta[sfatOffset + 3] !== 0x54
	) {
		throw new Error('Bad SFAT magic');
	}
	const sfatHeaderSize = view.getUint16(sfatOffset + 4, isLittle);
	if (sfatHeaderSize !== SFAT_HEADER_SIZE) {
		throw new Error(
			`Unexpected SFAT header size 0x${sfatHeaderSize.toString(16)} (expected 0xc)`,
		);
	}
	const nodeCount = view.getUint16(sfatOffset + 6, isLittle);
	if (nodeCount >>> 14 !== 0) {
		// Top 2 bits set ⇒ either a corrupt file or some unknown extension.
		throw new Error(`Too many SFAT entries (${nodeCount})`);
	}
	const hashMultiplier = view.getUint32(sfatOffset + 8, isLittle);

	const nodesOffset = sfatOffset + sfatHeaderSize;
	const sfntOffset = nodesOffset + SFAT_NODE_SIZE * nodeCount;
	if (sfntOffset + SFNT_HEADER_SIZE > meta.length) {
		throw new Error('SFAT/SFNT runs past metadata block');
	}

	// --- SFNT ---
	if (
		meta[sfntOffset] !== 0x53 ||
		meta[sfntOffset + 1] !== 0x46 ||
		meta[sfntOffset + 2] !== 0x4e ||
		meta[sfntOffset + 3] !== 0x54
	) {
		throw new Error('Bad SFNT magic');
	}
	const sfntHeaderSize = view.getUint16(sfntOffset + 4, isLittle);
	if (sfntHeaderSize !== SFNT_HEADER_SIZE) {
		throw new Error(
			`Unexpected SFNT header size 0x${sfntHeaderSize.toString(16)} (expected 0x8)`,
		);
	}
	const nameTableOffset = sfntOffset + sfntHeaderSize;

	if (dataOffset < nameTableOffset) {
		throw new Error(
			`SARC data_offset (${dataOffset}) precedes name table (${nameTableOffset})`,
		);
	}

	// --- Nodes + names ---
	const entries: SarcEntry[] = [];
	for (let i = 0; i < nodeCount; i++) {
		const nodeOff = nodesOffset + i * SFAT_NODE_SIZE;
		const nameHash = view.getUint32(nodeOff, isLittle);
		const flagsAndNameOffset = view.getUint32(nodeOff + 4, isLittle);
		// Top 8 bits = flags (always 0x01 in well-formed archives,
		// indicating the SFNT name field is in use). Bottom 24 bits =
		// name offset *in 4-byte units* relative to the start of the
		// name table.
		if (flagsAndNameOffset === 0) {
			throw new Error(
				`Unnamed SARC entries are not supported (entry ${i})`,
			);
		}
		const nameOffWords = flagsAndNameOffset & 0x00ffffff;
		const absNameOffset = nameTableOffset + nameOffWords * 4;
		if (absNameOffset >= dataOffset) {
			throw new Error(
				`SARC name offset out of range for hash 0x${nameHash.toString(16)}`,
			);
		}
		const name = readCString(meta, absNameOffset, dataOffset);

		const fileBegin = view.getUint32(nodeOff + 8, isLittle);
		const fileEnd = view.getUint32(nodeOff + 0x0c, isLittle);
		if (fileEnd < fileBegin) {
			throw new Error(`SARC entry "${name}" has end < begin`);
		}
		const absStart = dataOffset + fileBegin;
		const absEnd = dataOffset + fileEnd;
		if (absEnd > blob.size) {
			throw new Error(
				`SARC entry "${name}" runs past end of blob (${absEnd} > ${blob.size})`,
			);
		}

		entries.push({
			name,
			nameHash,
			offset: absStart,
			size: absEnd - absStart,
			data: blob.slice(absStart, absEnd),
		});
	}

	return {
		endian,
		hashMultiplier,
		fileSize,
		dataOffset,
		entries,
	};
}

/**
 * Read a NUL-terminated UTF-8 string from `bytes` starting at
 * `offset`, bounded above by `maxEnd` (exclusive). Throws if no NUL
 * is found before `maxEnd`.
 */
function readCString(bytes: Uint8Array, offset: number, maxEnd: number): string {
	let end = offset;
	while (end < maxEnd && bytes[end] !== 0) end++;
	if (end >= maxEnd) {
		throw new Error('Unterminated SARC name string');
	}
	return new TextDecoder('utf-8').decode(bytes.subarray(offset, end));
}
