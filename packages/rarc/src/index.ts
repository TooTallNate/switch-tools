/**
 * RARC archive parser.
 *
 * RARC ("Revolution ARChive", though it predates the Wii and shipped on the
 * GameCube first) is Nintendo's general-purpose bundled-file container. It's
 * the `.arc` you find all over *The Legend of Zelda: The Wind Waker*, *Twilight
 * Princess*, *Super Mario Sunshine*, *Pikmin*, and most other first-party JSystem
 * titles. Very often the whole `.arc` is itself wrapped in Yaz0, so callers
 * should decompress first and hand the plain bytes here.
 *
 * Everything is big-endian, because the GameCube's Gekko is a PowerPC.
 *
 * Wire layout:
 *
 *   Header, 0x20 bytes at the very start of the file:
 *
 *     0x00 u32  magic ('R','A','R','C')
 *     0x04 u32  fileSize          — total size of the archive
 *     0x08 u32  headerSize        — always 0x20; also the offset of the info block
 *     0x0C u32  dataOffset        — start of the file-data blob, *relative to 0x20*
 *     0x10 u32  dataLength        — total bytes of file data
 *     0x14 u32  mramSize          — of `dataLength`, how much is main-RAM resident
 *     0x18 u32  aramSize          — ...how much goes to ARAM (the audio DSP's RAM)
 *     0x1C u32  dvdSize           — ...and how much is streamed from disc
 *
 *   Info block, 0x20 bytes at 0x20. Every offset in here is *relative to 0x20*,
 *   not to the start of the file. This is the single most common source of
 *   off-by-0x20 bugs when writing a RARC reader, so we normalise all of them to
 *   absolute file offsets immediately on parse.
 *
 *     0x00 u32  nodeCount
 *     0x04 u32  nodeOffset
 *     0x08 u32  fileEntryCount
 *     0x0C u32  fileEntryOffset
 *     0x10 u32  stringTableLength
 *     0x14 u32  stringTableOffset
 *     0x18 u16  nextFreeFileId
 *     0x1A u8   keepFileIdsSynced
 *     0x1B u8[5] padding
 *
 *   Node (a directory), 0x10 bytes each:
 *
 *     0x00 u32  type             — 4 ASCII chars, space-padded. 'ROOT' for node 0,
 *                                  otherwise the first four letters of the directory
 *                                  name upper-cased ('SCEN', 'BDL ', ...). Purely
 *                                  informational; the real name is in the string table.
 *     0x04 u32  nameOffset       — byte offset into the string table
 *     0x08 u16  nameHash
 *     0x0A u16  fileEntryCount   — number of entries belonging to this directory
 *     0x0C u32  firstFileEntry   — index of the first of them
 *
 *   File entry, 0x14 bytes each. Entries are laid out so that each node's
 *   entries are contiguous, which is why a node only needs a start index and
 *   a count:
 *
 *     0x00 u16  id               — sequential file index, or 0xFFFF for a directory
 *     0x02 u16  nameHash
 *     0x04 u8   flags            — see `RarcEntryFlags`
 *     0x05 u8   padding
 *     0x06 u16  nameOffset       — byte offset into the string table
 *     0x08 u32  dataOffset       — for a file: offset into the data blob.
 *                                  for a directory: the *index of the node* it points at.
 *     0x0C u32  dataLength       — for a directory: 0x10 (meaningless)
 *     0x10 u32  padding
 *
 * Two wrinkles that matter:
 *
 *  1. Every directory contains two synthetic entries named "." and ".." (the
 *     latter has `dataOffset == 0xFFFFFFFF` in the root). They're real entries in
 *     the table and you must skip them or you'll recurse forever. We filter them
 *     out of `readDir`/`walk` but still count them in `entryCount`.
 *
 *  2. Individual entries can be *independently* compressed, flagged by
 *     `COMPRESSED`. Whether that's Yaz0 or Yay0 is indicated by `YAZ0`. We
 *     deliberately don't decompress here — that would force a dependency and
 *     rob the caller of the choice — we just surface the flags and let the
 *     caller apply `@tootallnate/yaz0` / `@tootallnate/yay0` as needed.
 *
 * The string table is a blob of NUL-terminated shift-JIS-ish names. In practice
 * retail archives are pure ASCII, so we decode as UTF-8 and fall back to
 * latin-1 for stray high bytes rather than pulling in a shift-JIS table.
 *
 * References:
 *   - http://wiki.tockdom.com/wiki/RARC_(File_Format)
 *   - https://wiki.cloudmodding.com/tww/RARC
 */

export const RARC_MAGIC = 'RARC';

/** Size of the fixed file header, and the offset that info-block offsets are relative to. */
export const RARC_HEADER_SIZE = 0x20;
export const RARC_NODE_SIZE = 0x10;
export const RARC_ENTRY_SIZE = 0x14;

/**
 * Flags on a file entry.
 *
 * `FILE` and `DIRECTORY` are mutually exclusive and one is always set, so
 * `isDir` is derived from `DIRECTORY` rather than from the 0xFFFF id (some
 * archives in the wild set one but not the other).
 */
export const RarcEntryFlags = {
	FILE: 0x01,
	DIRECTORY: 0x02,
	COMPRESSED: 0x04,
	PRELOAD_TO_MRAM: 0x10,
	PRELOAD_TO_ARAM: 0x20,
	LOAD_FROM_DVD: 0x40,
	/** Only meaningful when `COMPRESSED` is set: Yaz0 if set, Yay0 if clear. */
	YAZ0: 0x80,
} as const;

export interface RarcHeader {
	/** Total archive size as claimed by the header. */
	fileSize: number;
	/** Absolute offset of the file-data blob. */
	dataOffset: number;
	dataLength: number;
	mramSize: number;
	aramSize: number;
	dvdSize: number;
	nodeCount: number;
	/** Absolute offset of the node table. */
	nodeOffset: number;
	entryCount: number;
	/** Absolute offset of the file-entry table. */
	entryOffset: number;
	stringTableLength: number;
	/** Absolute offset of the string table. */
	stringTableOffset: number;
	nextFreeFileId: number;
	keepFileIdsSynced: boolean;
}

export interface RarcNode {
	index: number;
	/** The 4-character type tag, trailing spaces trimmed ('ROOT', 'SCEN', 'BDL'). */
	type: string;
	name: string;
	nameHash: number;
	entryCount: number;
	firstEntry: number;
}

export interface RarcEntry {
	index: number;
	id: number;
	name: string;
	nameHash: number;
	flags: number;
	isDir: boolean;
	/** For a directory, the index of the node it points at; otherwise -1. */
	nodeIndex: number;
	/** For a file, the absolute offset of its bytes within the archive; otherwise -1. */
	offset: number;
	/** For a file, its byte length; otherwise 0. */
	length: number;
	/** True when the entry's bytes are Yaz0/Yay0 compressed. */
	compressed: boolean;
	/** When `compressed`, which scheme: Yaz0 vs Yay0. */
	compression: 'yaz0' | 'yay0' | null;
}

/** A file discovered by `walk`, with its full slash-separated path. */
export interface RarcWalkEntry extends RarcEntry {
	/** Path relative to the root node, e.g. `bdl/model.bdl`. Excludes the root's own name. */
	path: string;
}

/**
 * Nintendo's name hash, used to look a name up without string comparison.
 * Included so we can validate an archive cheaply and so writers can round-trip.
 */
export function rarcNameHash(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		// The multiply-by-3 keeps this cheap on a 486-era-ish integer unit while
		// still spreading short ASCII names across the full 16 bits.
		hash = (hash * 3 + (name.charCodeAt(i) & 0xff)) & 0xffff;
	}
	return hash;
}

function u32(view: DataView, offset: number): number {
	return view.getUint32(offset, false);
}

/** Cheap magic check. Safe to call on arbitrary bytes. */
export function isRarc(bytes: Uint8Array, offset = 0): boolean {
	if (offset < 0 || offset + RARC_HEADER_SIZE > bytes.length) return false;
	return (
		bytes[offset] === 0x52 && // 'R'
		bytes[offset + 1] === 0x41 && // 'A'
		bytes[offset + 2] === 0x52 && // 'R'
		bytes[offset + 3] === 0x43 // 'C'
	);
}

/**
 * Decode a NUL-terminated name out of the string table.
 *
 * We stop at the table's end even if there's no terminator, so a truncated
 * archive yields short names rather than throwing.
 */
function readName(bytes: Uint8Array, start: number, tableEnd: number): string {
	if (start < 0 || start >= tableEnd) return '';
	let end = start;
	while (end < tableEnd && bytes[end] !== 0) end++;
	const raw = bytes.subarray(start, end);
	// Retail archives are ASCII. Try UTF-8 first (correct for ASCII, and handles
	// the rare UTF-8 name), and fall back to latin-1 so a shift-JIS name degrades
	// to mojibake instead of U+FFFD soup or an exception.
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(raw);
	} catch {
		let s = '';
		for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
		return s;
	}
}

/**
 * Parse the header and info block, normalising every relative offset to an
 * absolute file offset. Returns `null` if the magic is wrong or if any table
 * would fall outside the buffer — we validate up front so the rest of the API
 * can index without bounds checks on every access.
 */
export function parseRarcHeader(bytes: Uint8Array, offset = 0): RarcHeader | null {
	if (!isRarc(bytes, offset)) return null;
	if (offset + RARC_HEADER_SIZE * 2 > bytes.length) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const base = offset;

	const fileSize = u32(view, base + 0x04);
	const headerSize = u32(view, base + 0x08);
	// `headerSize` is 0x20 in every archive ever shipped, but it's also the
	// documented base for the info block's offsets, so honour it rather than
	// hardcoding — while still rejecting nonsense.
	if (headerSize < RARC_HEADER_SIZE) return null;
	const infoBase = base + headerSize;
	if (infoBase + RARC_HEADER_SIZE > bytes.length) return null;

	const dataOffset = infoBase + u32(view, base + 0x0c);
	const dataLength = u32(view, base + 0x10);
	const mramSize = u32(view, base + 0x14);
	const aramSize = u32(view, base + 0x18);
	const dvdSize = u32(view, base + 0x1c);

	const nodeCount = u32(view, infoBase + 0x00);
	const nodeOffset = infoBase + u32(view, infoBase + 0x04);
	const entryCount = u32(view, infoBase + 0x08);
	const entryOffset = infoBase + u32(view, infoBase + 0x0c);
	const stringTableLength = u32(view, infoBase + 0x10);
	const stringTableOffset = infoBase + u32(view, infoBase + 0x14);
	const nextFreeFileId = view.getUint16(infoBase + 0x18, false);
	const keepFileIdsSynced = view.getUint8(infoBase + 0x1a) !== 0;

	// An archive with no directories can't even express a root, so it's junk.
	if (nodeCount === 0) return null;
	// Guard against absurd counts before we multiply, so we can't overflow into
	// a small in-range product.
	if (nodeCount > 0xffffff || entryCount > 0xffffff) return null;
	if (nodeOffset + nodeCount * RARC_NODE_SIZE > bytes.length) return null;
	if (entryOffset + entryCount * RARC_ENTRY_SIZE > bytes.length) return null;
	if (stringTableOffset + stringTableLength > bytes.length) return null;
	// The data blob is allowed to be truncated (some archives are extracted
	// partially, and `.arc` files embedded in a disc are sometimes padded oddly),
	// so we range-check individual file reads instead of the blob as a whole.

	return {
		fileSize,
		dataOffset,
		dataLength,
		mramSize,
		aramSize,
		dvdSize,
		nodeCount,
		nodeOffset,
		entryCount,
		entryOffset,
		stringTableLength,
		stringTableOffset,
		nextFreeFileId,
		keepFileIdsSynced,
	};
}

/**
 * A parsed archive. Holds a reference to the original bytes; `read` returns
 * subarray views into them rather than copies, so this is cheap to construct
 * even for the 30 MB archives in Wind Waker.
 */
export class RarcArchive {
	readonly bytes: Uint8Array;
	readonly base: number;
	readonly header: RarcHeader;
	readonly nodes: readonly RarcNode[];
	readonly entries: readonly RarcEntry[];

	constructor(bytes: Uint8Array, header: RarcHeader, base: number) {
		this.bytes = bytes;
		this.base = base;
		this.header = header;

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const strStart = header.stringTableOffset;
		const strEnd = strStart + header.stringTableLength;

		const nodes: RarcNode[] = [];
		for (let i = 0; i < header.nodeCount; i++) {
			const p = header.nodeOffset + i * RARC_NODE_SIZE;
			let type = '';
			for (let c = 0; c < 4; c++) type += String.fromCharCode(bytes[p + c]);
			nodes.push({
				index: i,
				type: type.trimEnd(),
				name: readName(bytes, strStart + u32(view, p + 0x04), strEnd),
				nameHash: view.getUint16(p + 0x08, false),
				entryCount: view.getUint16(p + 0x0a, false),
				firstEntry: u32(view, p + 0x0c),
			});
		}
		this.nodes = nodes;

		const entries: RarcEntry[] = [];
		for (let i = 0; i < header.entryCount; i++) {
			const p = header.entryOffset + i * RARC_ENTRY_SIZE;
			const id = view.getUint16(p + 0x00, false);
			const nameHash = view.getUint16(p + 0x02, false);
			const flags = view.getUint8(p + 0x04);
			const nameOffset = view.getUint16(p + 0x06, false);
			const rawOffset = u32(view, p + 0x08);
			const rawLength = u32(view, p + 0x0c);
			const isDir = (flags & RarcEntryFlags.DIRECTORY) !== 0;
			const compressed = !isDir && (flags & RarcEntryFlags.COMPRESSED) !== 0;
			entries.push({
				index: i,
				id,
				name: readName(bytes, strStart + nameOffset, strEnd),
				nameHash,
				flags,
				isDir,
				// For a directory the "data offset" field is really a node index.
				// 0xFFFFFFFF appears on the root's ".." and means "no parent".
				nodeIndex: isDir ? (rawOffset === 0xffffffff ? -1 : rawOffset) : -1,
				offset: isDir ? -1 : header.dataOffset + rawOffset,
				length: isDir ? 0 : rawLength,
				compressed,
				compression: compressed
					? (flags & RarcEntryFlags.YAZ0) !== 0
						? 'yaz0'
						: 'yay0'
					: null,
			});
		}
		this.entries = entries;
	}

	/** The root directory. */
	get root(): RarcNode {
		return this.nodes[0];
	}

	/**
	 * Entries belonging to a node, with the synthetic "." and ".." skipped.
	 *
	 * A malformed archive could claim a range extending past the entry table;
	 * we clamp rather than throw so a partially-corrupt archive still browses.
	 */
	readDir(node: RarcNode | number): RarcEntry[] {
		const n = typeof node === 'number' ? this.nodes[node] : node;
		if (!n) return [];
		const start = Math.min(n.firstEntry, this.entries.length);
		const end = Math.min(n.firstEntry + n.entryCount, this.entries.length);
		const out: RarcEntry[] = [];
		for (let i = start; i < end; i++) {
			const e = this.entries[i];
			if (e.isDir && (e.name === '.' || e.name === '..')) continue;
			out.push(e);
		}
		return out;
	}

	/**
	 * The bytes of a file entry, as a view into the archive buffer.
	 *
	 * Returns `null` for directories or when the range escapes the buffer.
	 * The result is still compressed if `entry.compressed` is set.
	 */
	read(entry: RarcEntry): Uint8Array | null {
		if (entry.isDir || entry.offset < 0) return null;
		const end = entry.offset + entry.length;
		if (entry.offset < 0 || end > this.bytes.length) return null;
		return this.bytes.subarray(entry.offset, end);
	}

	/**
	 * Resolve a slash-separated path to an entry, e.g. `bdl/model.bdl`.
	 *
	 * Matching is case-insensitive because the games themselves are: JSystem
	 * looks names up by hash of the upper-cased name, so `Model.bdl` and
	 * `model.bdl` are the same file as far as the game is concerned. Paths are
	 * relative to the root, and the root's own name is not part of the path.
	 */
	find(path: string): RarcEntry | null {
		const parts = path.split('/').filter((p) => p.length > 0 && p !== '.');
		if (parts.length === 0) return null;
		let node: RarcNode | undefined = this.root;
		for (let i = 0; i < parts.length; i++) {
			if (!node) return null;
			const want = parts[i].toLowerCase();
			const match: RarcEntry | undefined = this.readDir(node).find(
				(e) => e.name.toLowerCase() === want,
			);
			if (!match) return null;
			if (i === parts.length - 1) return match;
			if (!match.isDir) return null;
			node = this.nodes[match.nodeIndex];
		}
		return null;
	}

	/**
	 * Every file in the archive, depth-first, with full paths.
	 *
	 * Directories are not yielded. We track visited node indices because a
	 * corrupt archive could contain a cycle, and an infinite walk in a file
	 * browser is a hang rather than an error message.
	 */
	walk(): RarcWalkEntry[] {
		const out: RarcWalkEntry[] = [];
		const seen = new Set<number>();
		const visit = (nodeIndex: number, prefix: string): void => {
			if (nodeIndex < 0 || nodeIndex >= this.nodes.length) return;
			if (seen.has(nodeIndex)) return;
			seen.add(nodeIndex);
			for (const e of this.readDir(this.nodes[nodeIndex])) {
				const path = prefix ? `${prefix}/${e.name}` : e.name;
				if (e.isDir) {
					visit(e.nodeIndex, path);
				} else {
					out.push({ ...e, path });
				}
			}
		};
		visit(0, '');
		return out;
	}
}

/**
 * Parse a RARC archive. Returns `null` when the bytes aren't a valid RARC,
 * rather than throwing, so callers can use this as a sniff-and-parse in one
 * step while walking an unknown file tree.
 *
 * If the input might be Yaz0-compressed (very common for `.arc`), decompress
 * it first — this function deliberately does no decompression of its own.
 */
export function parseRarc(bytes: Uint8Array, offset = 0): RarcArchive | null {
	const header = parseRarcHeader(bytes, offset);
	if (!header) return null;
	return new RarcArchive(bytes, header, offset);
}
