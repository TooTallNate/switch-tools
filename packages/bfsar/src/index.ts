/**
 * BFSAR — "Binary caFe Sound ARchive".
 *
 * BFSAR is NintendoWare's master sound archive on the Wii U and
 * Switch. The internal magic is `'FSAR'` (the "B" is implicit, the
 * same way `'FNT '` becomes `'BFFNT'`). It's a sibling of:
 *
 *   - **BCSAR** (3DS, magic `'CSAR'`) — same shape, different keys
 *     and 3DS-specific inner-file formats.
 *   - **BRSAR** (Wii, magic `'RSAR'`) — older but structurally
 *     similar.
 *
 * A BFSAR contains up to seven kinds of items:
 *
 *   - **Sounds** (Stream / Wave / Sequence) — playable cues.
 *   - **Sound Groups** — index ranges of related sounds.
 *   - **Banks** — instrument banks for sequence playback.
 *   - **Wave Archives** — collections of raw wave samples.
 *   - **Groups** — sub-archives that bundle multiple files.
 *   - **Players** — runtime resource limits.
 *   - **Files** — the actual audio bytes (BFSTM / BFWAV / BFSTP /
 *     BFWAR / BFBNK / BFSEQ / BFGRP, plus external file paths).
 *
 * Wire layout:
 *
 *   ┌────────────────────────────────┐
 *   │ FSAR header           (~0x40)  │  magic, BOM, version, ...
 *   ├────────────────────────────────┤
 *   │ Block reference table          │  (id, offset, size) × N
 *   ├────────────────────────────────┤
 *   │ STRG block                     │  string table + search tree
 *   ├────────────────────────────────┤
 *   │ INFO block                     │  seven reference tables
 *   ├────────────────────────────────┤
 *   │ FILE block                     │  raw audio file payloads
 *   └────────────────────────────────┘
 *
 * This parser implements **Tier 1** support: enough to list every
 * named, internal file in the archive as a directory entry with its
 * (a) name, (b) inner format magic (`FSTM` / `FWAV` / etc.), and
 * (c) lazy {@link Blob} slice. Tools can then route those blobs to
 * BFSTM / BFWAV decoders, hand them to `vgmstream-web`, or just
 * download them. We do *not* parse the search tree, sound graphs,
 * 3D-info flags, or sequence track parameters — those are covered
 * by the raw `info.json` data already extracted from the seven
 * reference tables, but no first-class TypeScript types are exposed.
 *
 * References:
 *   - https://github.com/moonlightfox3/SWITCHjs/blob/main/bfsar.js
 *     (~600 LOC pure-JS reference; exhaustive)
 *   - https://github.com/KillzXGaming/Switch-Toolbox/blob/master/File_Format_Library/FileFormats/Audio/Archives/BFSAR.cs
 *   - https://www.3dbrew.org/wiki/BCSAR (sibling format; same layout)
 *   - https://mk8.tockdom.com/wiki/BFSAR_(File_Format)
 */

/** ASCII "FSAR" — magic at file offset 0. */
export const BFSAR_MAGIC = 'FSAR';

/** ASCII "STRG" — string-table block magic. */
export const STRG_MAGIC = 'STRG';

/** ASCII "INFO" — info-tables block magic. */
export const INFO_MAGIC = 'INFO';

/** ASCII "FILE" — raw-file payloads block magic. */
export const FILE_MAGIC = 'FILE';

const HEADER_MIN_SIZE = 0x14;

/** Top-level block IDs. */
const BLOCK_ID_STRG = 0x2000;
const BLOCK_ID_INFO = 0x2001;
const BLOCK_ID_FILE = 0x2002;

/** Reference IDs we look up in the INFO block. */
const REF_ID_SOUND_INFO_TABLE = 0x2100;
const REF_ID_BANK_INFO_TABLE = 0x2101;
const REF_ID_PLAYER_INFO_TABLE = 0x2102;
const REF_ID_WAVE_ARCHIVE_INFO_TABLE = 0x2103;
const REF_ID_SOUND_GROUP_INFO_TABLE = 0x2104;
const REF_ID_GROUP_INFO_TABLE = 0x2105;
const REF_ID_FILE_INFO_TABLE = 0x2106;

const REF_ID_FILE_INTERNAL = 0x220c;
const REF_ID_FILE_EXTERNAL = 0x220d;

const REF_ID_STRING_TABLE = 0x2400;

export type Endian = 'big' | 'little';

/**
 * Information about a single internal file extracted from the
 * archive, fully resolved with its name (when one is available).
 */
export interface BfsarInternalFile {
	/** Sequential file index, 0-based. */
	index: number;
	/**
	 * Resolved human-readable name. We pull the name from whichever
	 * info-table entry references this file; if multiple do, the
	 * priority order is Sound > SoundGroup > Bank > WaveArchive >
	 * Group > Player > none. Tracks that no info-table refers to
	 * (rare) get an auto-generated `file_<index>` name.
	 */
	name: string;
	/** Origin of the name, for display in UIs. */
	nameSource:
		| 'sound'
		| 'soundGroup'
		| 'bank'
		| 'waveArchive'
		| 'group'
		| 'player'
		| 'auto';
	/**
	 * Magic of the inner file (e.g. `'FSTM'`, `'FWAV'`, `'FSTP'`,
	 * `'FWAR'`, `'FBNK'`, `'FSEQ'`, `'FGRP'`), sniffed from the
	 * first four bytes of the payload. `null` if the file is empty
	 * or its bytes aren't accessible.
	 */
	innerMagic: string | null;
	/**
	 * Conventional file extension for the inner format (e.g.
	 * `'bfstm'`, `'bfwav'`, `'bfstp'`, `'bfwar'`, `'bfbnk'`,
	 * `'bfseq'`, `'bfgrp'`). `'bin'` for unknown magics.
	 */
	innerExt: string;
	/**
	 * Where the file's bytes physically live within the host BFSAR.
	 * `'inline'` for files whose bytes are embedded in the FILE
	 * block; `'group'` for files stored inside a sub-`FGRP` payload
	 * (the BFSAR's group-file mechanism — we don't recurse into
	 * those here, but we still list the file). `null` for entries
	 * with no payload at all.
	 */
	location: 'inline' | 'group' | null;
	/** Absolute byte offset in the source `Blob`, or `null` if not inline. */
	offset: number | null;
	/** Size of the payload in bytes. */
	size: number;
	/** Lazy `Blob` view of the inline payload, or `null`. */
	data: Blob | null;
	/** Sound-info kind, when this file is referenced by a sound entry. */
	soundKind?: 'stream' | 'wave' | 'sequence';
}

/**
 * Lightweight record for an entry from the BFSAR's external file
 * table. These reference assets that live *outside* the archive
 * (e.g. on-disc streamed audio); we expose just the path string.
 */
export interface BfsarExternalFile {
	index: number;
	name: string;
	path: string;
}

/**
 * Counts of each item kind as declared by the seven INFO tables.
 * We surface these primarily so a metadata view can show "12 sounds,
 * 3 wave archives, …" without re-counting.
 */
export interface BfsarCounts {
	sounds: number;
	soundGroups: number;
	banks: number;
	waveArchives: number;
	groups: number;
	players: number;
	files: number;
}

export interface ParsedBfsar {
	endian: Endian;
	/** BFSAR format version, e.g. `0x00020400` for Switch FSAR v2.4.0. */
	version: number;
	/** Reported total file size from the header. */
	fileSize: number;
	/** Number of top-level blocks (STRG + INFO + FILE; usually 3). */
	blockCount: number;
	/** Decoded string-table entries (one entry per name). */
	strings: string[];
	/** Per-table item counts. */
	counts: BfsarCounts;
	/** All internal files, in their declared order. */
	internalFiles: BfsarInternalFile[];
	/** All external (non-embedded) file references. */
	externalFiles: BfsarExternalFile[];
}

/** Cheap (4-byte) magic check. */
export async function isBfsar(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x46 /* F */ &&
		head[1] === 0x53 /* S */ &&
		head[2] === 0x41 /* A */ &&
		head[3] === 0x52 /* R */
	);
}

/**
 * Parse a BFSAR archive. Reads the entire metadata region eagerly
 * (header + STRG + INFO; typically a few KB even for huge archives)
 * and exposes each internal file's bytes as a lazy `Blob` slice.
 *
 * Tolerant of partially-malformed archives in the same way as the
 * BARS / SARC parsers in this monorepo: we surface
 * empty / `null`-named entries rather than throwing on any single
 * bad reference, since shipped Switch games sometimes ship BFSARs
 * with dangling indices (e.g. names referenced by index but the
 * string was stripped).
 */
export async function parseBfsar(blob: Blob): Promise<ParsedBfsar> {
	if (blob.size < HEADER_MIN_SIZE) {
		throw new Error(
			`Blob too small to be a BFSAR (${blob.size} bytes, need at least ${HEADER_MIN_SIZE})`,
		);
	}
	const head = new Uint8Array(
		await blob.slice(0, HEADER_MIN_SIZE).arrayBuffer(),
	);
	if (
		head[0] !== 0x46 ||
		head[1] !== 0x53 ||
		head[2] !== 0x41 ||
		head[3] !== 0x52
	) {
		throw new Error('Bad BFSAR magic');
	}

	const bomBE = head[4] === 0xfe && head[5] === 0xff;
	const bomLE = head[4] === 0xff && head[5] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid BFSAR byte-order mark: 0x${head[4].toString(16)}${head[5].toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;
	const headView = new DataView(
		head.buffer,
		head.byteOffset,
		head.byteLength,
	);
	const headerSize = headView.getUint16(6, isLittle);
	const version = headView.getUint32(8, isLittle);
	const fileSize = headView.getUint32(0x0c, isLittle);
	const blockCount = headView.getUint16(0x10, isLittle);

	if (headerSize < HEADER_MIN_SIZE || headerSize > 0x100) {
		throw new Error(`Implausible BFSAR header size: 0x${headerSize.toString(16)}`);
	}
	if (blockCount < 1 || blockCount > 16) {
		throw new Error(`Implausible BFSAR block count: ${blockCount}`);
	}

	// Re-read the actual header (block table is part of it).
	const fullHeader = new Uint8Array(
		await blob.slice(0, headerSize).arrayBuffer(),
	);
	const fullView = new DataView(
		fullHeader.buffer,
		fullHeader.byteOffset,
		fullHeader.byteLength,
	);

	// Block table starts at 0x14: each entry is (id u16, pad u16,
	// offset u32, size u32) — 12 bytes.
	const blocks: { id: number; offset: number; size: number }[] = [];
	for (let i = 0; i < blockCount; i++) {
		const o = 0x14 + i * 0x0c;
		if (o + 0x0c > fullHeader.length) break;
		const id = fullView.getUint16(o, isLittle);
		const offset = fullView.getUint32(o + 4, isLittle);
		const size = fullView.getUint32(o + 8, isLittle);
		blocks.push({ id, offset, size });
	}

	const strgBlock = blocks.find((b) => b.id === BLOCK_ID_STRG);
	const infoBlock = blocks.find((b) => b.id === BLOCK_ID_INFO);
	const fileBlock = blocks.find((b) => b.id === BLOCK_ID_FILE);

	if (!strgBlock || !infoBlock || !fileBlock) {
		throw new Error(
			'BFSAR missing one of STRG / INFO / FILE blocks (got ids: ' +
				blocks.map((b) => '0x' + b.id.toString(16)).join(', ') +
				')',
		);
	}

	// Slurp STRG and INFO eagerly — typically a few KB total.
	const strgBytes = new Uint8Array(
		await blob
			.slice(strgBlock.offset, strgBlock.offset + strgBlock.size)
			.arrayBuffer(),
	);
	const infoBytes = new Uint8Array(
		await blob
			.slice(infoBlock.offset, infoBlock.offset + infoBlock.size)
			.arrayBuffer(),
	);

	const strings = parseStrings(strgBytes, isLittle);
	const info = parseInfo(infoBytes, isLittle, strings);

	// Build the per-file records, mapping each file's payload to a
	// lazy Blob slice into the source.
	const internalFiles: BfsarInternalFile[] = [];
	const externalFiles: BfsarExternalFile[] = [];
	for (let i = 0; i < info.fileEntries.length; i++) {
		const entry = info.fileEntries[i];
		if (entry.kind === 'external') {
			externalFiles.push({
				index: i,
				name: info.nameByFileIndex.get(i) ?? `external_${i}`,
				path: entry.path,
			});
			continue;
		}
		// Internal file. May be inline (in the FILE block) or stored
		// inside a group's sub-archive. We can't extract the latter
		// without recursing into the group's `FGRP`, so we record the
		// `'group'` location and leave `data` null.
		const name =
			info.nameByFileIndex.get(i) ?? `file_${i.toString().padStart(4, '0')}`;
		const nameSource = info.nameSourceByFileIndex.get(i) ?? 'auto';
		if (entry.inGroup) {
			internalFiles.push({
				index: i,
				name,
				nameSource,
				innerMagic: null,
				innerExt: 'bin',
				location: 'group',
				offset: null,
				size: 0,
				data: null,
				soundKind: info.soundKindByFileIndex.get(i),
			});
			continue;
		}
		const absOffset = fileBlock.offset + 8 + entry.fileBlockOffset;
		const absEnd = absOffset + entry.fileSize;
		// Sniff the inner magic so the UI can label entries (FSTM / FWAV / …).
		let innerMagic: string | null = null;
		if (entry.fileSize >= 4 && absEnd <= blob.size) {
			const head4 = new Uint8Array(
				await blob.slice(absOffset, absOffset + 4).arrayBuffer(),
			);
			innerMagic = String.fromCharCode(
				head4[0],
				head4[1],
				head4[2],
				head4[3],
			);
		}
		internalFiles.push({
			index: i,
			name,
			nameSource,
			innerMagic,
			innerExt: extForMagic(innerMagic),
			location: 'inline',
			offset: absOffset,
			size: entry.fileSize,
			data:
				absEnd <= blob.size
					? blob.slice(absOffset, absEnd)
					: blob.slice(absOffset, blob.size),
			soundKind: info.soundKindByFileIndex.get(i),
		});
	}

	return {
		endian,
		version,
		fileSize,
		blockCount,
		strings,
		counts: {
			sounds: info.soundCount,
			soundGroups: info.soundGroupCount,
			banks: info.bankCount,
			waveArchives: info.waveArchiveCount,
			groups: info.groupCount,
			players: info.playerCount,
			files: info.fileEntries.length,
		},
		internalFiles,
		externalFiles,
	};
}

/**
 * Map a BFSAR inner-file magic to a conventional file extension
 * for download / display. Unknown magics fall through to `'bin'`.
 *
 * The Switch family of audio formats: each is the same NintendoWare
 * container with a different head magic — `'FSTM'`/`.bfstm`,
 * `'FWAV'`/`.bfwav`, etc.
 */
export function extForMagic(magic: string | null): string {
	switch (magic) {
		case 'FSTM':
			return 'bfstm';
		case 'FWAV':
			return 'bfwav';
		case 'FSTP':
			return 'bfstp';
		case 'FWAR':
			return 'bfwar';
		case 'FBNK':
			return 'bfbnk';
		case 'FSEQ':
			return 'bfseq';
		case 'FGRP':
			return 'bfgrp';
		case 'FWSD':
			// Wave-sound data — used inside BFSARs to bundle a wave-
			// sound graph for sound-effects playback. Not a separately
			// shipped format on disc, so the ".bfwsd" extension is just
			// a convention.
			return 'bfwsd';
		default:
			return 'bin';
	}
}

// =====================================================================
// STRG block
// =====================================================================

/**
 * Read the `[count, (offset, size+1) × count, … strings …]` string
 * table embedded in the STRG block. We deliberately ignore the
 * patricia search-tree that follows it — the tree is only useful
 * for runtime name lookup, not for listing.
 */
function parseStrings(strgBytes: Uint8Array, isLittle: boolean): string[] {
	const v = new DataView(
		strgBytes.buffer,
		strgBytes.byteOffset,
		strgBytes.byteLength,
	);
	if (strgBytes.length < 8) return [];
	// Block header: magic(4) + size(4); skip.
	// Then a Reference (8 bytes) to the string table at offset 0x08.
	if (strgBytes.length < 0x10) return [];
	const refTableId = v.getUint16(0x08, isLittle);
	if (refTableId !== REF_ID_STRING_TABLE) return [];
	const refTableOffsetRel = v.getUint32(0x0c, isLittle);
	if (refTableOffsetRel === 0xffffffff) return [];
	// `+0x08` because the reference offset is relative to the start
	// of the block payload (i.e. *after* the 8-byte block header).
	const tableStart = 0x08 + refTableOffsetRel;
	if (tableStart + 4 > strgBytes.length) return [];
	const count = v.getUint32(tableStart, isLittle);
	if (count > 0x10000) return []; // sanity bound
	const out: string[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const entryOff = tableStart + 4 + i * 12;
		if (entryOff + 12 > strgBytes.length) {
			out[i] = '';
			continue;
		}
		// Each entry: id(u16) + pad(u16) + offsetRel(u32) + sizeWithNul(u32).
		// `offsetRel` is relative to the string table itself
		// (`tableStart`).
		const offsetRel = v.getUint32(entryOff + 4, isLittle);
		const sizeWithNul = v.getUint32(entryOff + 8, isLittle);
		if (offsetRel === 0xffffffff || sizeWithNul === 0) {
			out[i] = '';
			continue;
		}
		const start = tableStart + offsetRel;
		const end = Math.min(
			start + Math.max(0, sizeWithNul - 1),
			strgBytes.length,
		);
		if (start >= strgBytes.length) {
			out[i] = '';
			continue;
		}
		out[i] = new TextDecoder('utf-8').decode(strgBytes.subarray(start, end));
	}
	return out;
}

// =====================================================================
// INFO block
// =====================================================================

interface ParsedFileEntry {
	kind: 'internal' | 'external';
	/** For internal: byte offset of file's payload, relative to
	 * the FILE block payload (i.e. *after* the 8-byte FILE header). */
	fileBlockOffset: number;
	/** For internal: declared file size, or `0` when the file lives
	 * inside a sub-group archive (`inGroup === true`). */
	fileSize: number;
	/** For internal: whether the file is stored inside a group sub-
	 * archive rather than directly in the FILE block. */
	inGroup: boolean;
	/** For external: the referenced file path. */
	path: string;
}

interface ParsedInfo {
	soundCount: number;
	soundGroupCount: number;
	bankCount: number;
	waveArchiveCount: number;
	groupCount: number;
	playerCount: number;
	fileEntries: ParsedFileEntry[];
	/** Resolved name per file index, when discovered. */
	nameByFileIndex: Map<number, string>;
	nameSourceByFileIndex: Map<number, BfsarInternalFile['nameSource']>;
	soundKindByFileIndex: Map<number, 'stream' | 'wave' | 'sequence'>;
}

/**
 * Parse the INFO block. We're after a small set of facts here:
 *
 *   - the seven table sizes (so callers can show counts),
 *   - the per-file (offset, size, in-group?) records,
 *   - the names of files referenced by the sound / sound-group /
 *     bank / wave-archive / group / player tables, and
 *   - whether each file is referenced as a stream / wave / sequence
 *     sound, so the UI can label e.g. background-music streams.
 *
 * We deliberately don't parse:
 *
 *   - the per-sound 3D / track / send-value sub-blocks,
 *   - the search-tree (only the string table is used here),
 *   - the BCSAR/BFSAR variant flags that live behind the
 *     `bfsar_parseReference`-style optional-flags machinery.
 *
 * A future Tier-2 metadata parser could expose those, but they're
 * not needed for a directory view.
 */
function parseInfo(
	infoBytes: Uint8Array,
	isLittle: boolean,
	strings: string[],
): ParsedInfo {
	const v = new DataView(
		infoBytes.buffer,
		infoBytes.byteOffset,
		infoBytes.byteLength,
	);
	// Each block starts with magic(4) + size(4). The seven info-table
	// references begin at offset 0x08, every 8 bytes.
	const refSlot = (i: number) => 0x08 + i * 8;

	const readReference = (
		off: number,
	): { id: number; offsetRel: number } | null => {
		if (off + 8 > infoBytes.length) return null;
		const id = v.getUint16(off, isLittle);
		const offsetRel = v.getUint32(off + 4, isLittle);
		if (offsetRel === 0xffffffff) return null;
		return { id, offsetRel };
	};

	const soundRef = readReference(refSlot(0)); // 0x2100
	const soundGroupRef = readReference(refSlot(2)); // 0x2104
	const bankRef = readReference(refSlot(3)); // 0x2101
	const waveArchiveRef = readReference(refSlot(4)); // 0x2103
	const groupRef = readReference(refSlot(5)); // 0x2105
	const playerRef = readReference(refSlot(6)); // 0x2102
	const fileRef = readReference(refSlot(7)); // 0x2106

	// The seven INFO-table reference slots are in a fixed order that
	// the SWITCHjs reference enumerates as 0x08+8*i for i in [0..6].
	// SWITCHjs uses table indices 0..6 → (sound, soundGroup, bank,
	// waveArchive, group, player, file) but the reference IDs at
	// each slot are the canonical truth. We re-map by id rather
	// than by slot to be robust to any reordering future Switch
	// firmware updates introduce.
	const refsBySlot = [
		soundRef,
		readReference(refSlot(1)),
		soundGroupRef,
		bankRef,
		waveArchiveRef,
		groupRef,
		playerRef,
		fileRef,
	];
	const lookupRef = (id: number) =>
		refsBySlot.find((r) => r?.id === id) ?? null;

	const refSoundInfoTable = lookupRef(REF_ID_SOUND_INFO_TABLE);
	const refSoundGroupInfoTable = lookupRef(REF_ID_SOUND_GROUP_INFO_TABLE);
	const refBankInfoTable = lookupRef(REF_ID_BANK_INFO_TABLE);
	const refWaveArchiveInfoTable = lookupRef(REF_ID_WAVE_ARCHIVE_INFO_TABLE);
	const refGroupInfoTable = lookupRef(REF_ID_GROUP_INFO_TABLE);
	const refPlayerInfoTable = lookupRef(REF_ID_PLAYER_INFO_TABLE);
	const refFileInfoTable = lookupRef(REF_ID_FILE_INFO_TABLE);

	// Helper: read a "reference table" — `count` followed by `count`
	// references (8 bytes each). The references' `offsetRel` are
	// relative to the *start of the reference table*, i.e. the
	// `count` u32 itself.
	const readReferenceTable = (
		baseOff: number,
	): { id: number; absOffset: number }[] => {
		if (baseOff + 4 > infoBytes.length) return [];
		const count = v.getUint32(baseOff, isLittle);
		if (count > 0x10000) return [];
		const entries: { id: number; absOffset: number }[] = new Array(count);
		for (let i = 0; i < count; i++) {
			const eo = baseOff + 4 + i * 8;
			if (eo + 8 > infoBytes.length) {
				entries[i] = { id: 0, absOffset: 0 };
				continue;
			}
			const id = v.getUint16(eo, isLittle);
			const offsetRel = v.getUint32(eo + 4, isLittle);
			entries[i] = {
				id,
				absOffset: offsetRel === 0xffffffff ? 0 : baseOff + offsetRel,
			};
		}
		return entries;
	};

	// Each per-table `Reference` lands at `refTable.offsetRel + 0x08`
	// (the +0x08 skips the 8-byte block header of the INFO block,
	// since references in the BFSAR are all relative to the
	// payload-start of the enclosing block).
	const tableBase = (ref: { offsetRel: number } | null) =>
		ref ? 0x08 + ref.offsetRel : -1;

	const soundEntries = refSoundInfoTable
		? readReferenceTable(tableBase(refSoundInfoTable))
		: [];
	const soundGroupEntries = refSoundGroupInfoTable
		? readReferenceTable(tableBase(refSoundGroupInfoTable))
		: [];
	const bankEntries = refBankInfoTable
		? readReferenceTable(tableBase(refBankInfoTable))
		: [];
	const waveArchiveEntries = refWaveArchiveInfoTable
		? readReferenceTable(tableBase(refWaveArchiveInfoTable))
		: [];
	const groupEntries = refGroupInfoTable
		? readReferenceTable(tableBase(refGroupInfoTable))
		: [];
	const playerEntries = refPlayerInfoTable
		? readReferenceTable(tableBase(refPlayerInfoTable))
		: [];
	const fileEntries = refFileInfoTable
		? readReferenceTable(tableBase(refFileInfoTable))
		: [];

	// --- Resolve file metadata (offset, size, inGroup, external/internal) ---
	const parsedFileEntries: ParsedFileEntry[] = new Array(fileEntries.length);
	for (let i = 0; i < fileEntries.length; i++) {
		const e = fileEntries[i];
		if (!e.absOffset) {
			parsedFileEntries[i] = makeUnknownFileEntry();
			continue;
		}
		const off = e.absOffset;
		// Each File-Info entry: Reference(8) → 0x220C/0x220D, then
		// type-specific payload. The reference's `offsetRel` is
		// relative to the FileInfo entry itself.
		if (off + 8 > infoBytes.length) {
			parsedFileEntries[i] = makeUnknownFileEntry();
			continue;
		}
		const fileRefId = v.getUint16(off, isLittle);
		const fileRefRel = v.getUint32(off + 4, isLittle);
		if (fileRefRel === 0xffffffff) {
			parsedFileEntries[i] = makeUnknownFileEntry();
			continue;
		}
		const payloadOff = off + fileRefRel;
		if (fileRefId === REF_ID_FILE_INTERNAL) {
			// Internal file. Layout (relative to payloadOff):
			//   0x00 Reference → 0x1F00 (file data; isPresent? if not,
			//                      file is in a group)
			//   0x08 u32 fileSize  (0xFFFFFFFF for in-group files)
			//   0x0C Reference → 0x0100 (group table; usually empty)
			if (payloadOff + 0x10 > infoBytes.length) {
				parsedFileEntries[i] = makeUnknownFileEntry();
				continue;
			}
			const dataRefId = v.getUint16(payloadOff, isLittle);
			const dataRefRel = v.getUint32(payloadOff + 4, isLittle);
			const fileSizeRaw = v.getUint32(payloadOff + 8, isLittle);
			const isInGroup = !(dataRefId !== 0 || dataRefRel !== 0xffffffff);
			parsedFileEntries[i] = {
				kind: 'internal',
				fileBlockOffset: isInGroup ? 0 : dataRefRel,
				fileSize: isInGroup || fileSizeRaw === 0xffffffff ? 0 : fileSizeRaw,
				inGroup: isInGroup,
				path: '',
			};
		} else if (fileRefId === REF_ID_FILE_EXTERNAL) {
			// External file: the payload is a NUL-terminated UTF-8 path.
			const start = payloadOff;
			let end = start;
			while (end < infoBytes.length && infoBytes[end] !== 0) end++;
			const path = new TextDecoder('utf-8').decode(
				infoBytes.subarray(start, end),
			);
			parsedFileEntries[i] = {
				kind: 'external',
				fileBlockOffset: 0,
				fileSize: 0,
				inGroup: false,
				path,
			};
		} else {
			parsedFileEntries[i] = makeUnknownFileEntry();
		}
	}

	// --- Resolve per-file names by walking the six "named" tables. ---
	const nameByFileIndex = new Map<number, string>();
	const nameSourceByFileIndex = new Map<
		number,
		BfsarInternalFile['nameSource']
	>();
	const soundKindByFileIndex = new Map<
		number,
		'stream' | 'wave' | 'sequence'
	>();

	const setName = (
		fileIndex: number,
		name: string,
		source: BfsarInternalFile['nameSource'],
	) => {
		if (fileIndex < 0 || fileIndex >= parsedFileEntries.length) return;
		if (!name) return;
		if (!nameByFileIndex.has(fileIndex)) {
			nameByFileIndex.set(fileIndex, name);
			nameSourceByFileIndex.set(fileIndex, source);
		}
	};

	// SoundInfo entries: fileIndex(u32), playerItemId(u32),
	//                    initialVolume(u8), remoteFilter(u8), pad(u16),
	//                    Reference → 0x2201/0x2202/0x2203 (stream/wave/sequence info),
	//                    flags(u32) at +0x14, name string-table index in flags & 1.
	for (const e of soundEntries) {
		if (!e.absOffset) continue;
		if (e.absOffset + 0x18 > infoBytes.length) continue;
		const fileIndex = v.getUint32(e.absOffset, isLittle);
		const subRefId = v.getUint16(e.absOffset + 0x0c, isLittle);
		const flags = v.getUint32(e.absOffset + 0x14, isLittle);
		if (subRefId === 0x2201) soundKindByFileIndex.set(fileIndex, 'stream');
		else if (subRefId === 0x2202) soundKindByFileIndex.set(fileIndex, 'wave');
		else if (subRefId === 0x2203)
			soundKindByFileIndex.set(fileIndex, 'sequence');
		if (flags & 0x1) {
			// First flag bit ⇒ 32-bit name index follows the flags word.
			const nameIdx = v.getUint32(e.absOffset + 0x18, isLittle);
			if (nameIdx < strings.length) setName(fileIndex, strings[nameIdx], 'sound');
		}
	}

	// SoundGroup entries: similar structure; name-index follows the
	// flags word at +0x18.
	for (const e of soundGroupEntries) {
		if (!e.absOffset) continue;
		if (e.absOffset + 0x1c > infoBytes.length) continue;
		const fileIndex = v.getUint32(e.absOffset, isLittle);
		const flags = v.getUint32(e.absOffset + 0x18, isLittle);
		if (flags & 0x1) {
			const nameIdx = v.getUint32(e.absOffset + 0x1c, isLittle);
			if (nameIdx < strings.length)
				setName(fileIndex, strings[nameIdx], 'soundGroup');
		}
	}

	// Bank entries: fileIndex(u32), waveArchiveTableRef(8 bytes),
	//               flags(u32) at +0x0C. Name idx at +0x10.
	for (const e of bankEntries) {
		if (!e.absOffset) continue;
		if (e.absOffset + 0x14 > infoBytes.length) continue;
		const fileIndex = v.getUint32(e.absOffset, isLittle);
		const flags = v.getUint32(e.absOffset + 0x0c, isLittle);
		if (flags & 0x1) {
			const nameIdx = v.getUint32(e.absOffset + 0x10, isLittle);
			if (nameIdx < strings.length) setName(fileIndex, strings[nameIdx], 'bank');
		}
	}

	// WaveArchive entries: fileIndex(u32), unknown1(u8), pad(u24),
	//                      flags(u32) at +0x08. Name idx at +0x0C.
	for (const e of waveArchiveEntries) {
		if (!e.absOffset) continue;
		if (e.absOffset + 0x10 > infoBytes.length) continue;
		const fileIndex = v.getUint32(e.absOffset, isLittle);
		const flags = v.getUint32(e.absOffset + 0x08, isLittle);
		if (flags & 0x1) {
			const nameIdx = v.getUint32(e.absOffset + 0x0c, isLittle);
			if (nameIdx < strings.length)
				setName(fileIndex, strings[nameIdx], 'waveArchive');
		}
	}

	// Group entries: fileIndex(u32) at +0x00 (0xFFFFFFFF for external),
	//                flags(u32) at +0x04, name idx at +0x08.
	for (const e of groupEntries) {
		if (!e.absOffset) continue;
		if (e.absOffset + 0x0c > infoBytes.length) continue;
		const fileIndex = v.getUint32(e.absOffset, isLittle);
		if (fileIndex === 0xffffffff) continue;
		const flags = v.getUint32(e.absOffset + 0x04, isLittle);
		if (flags & 0x1) {
			const nameIdx = v.getUint32(e.absOffset + 0x08, isLittle);
			if (nameIdx < strings.length)
				setName(fileIndex, strings[nameIdx], 'group');
		}
	}

	// Player entries don't directly reference a file index in the
	// FILE block — they're runtime resource limits — but we still
	// note their names so a metadata-view table can list them.
	// Skipping the name-to-fileIndex mapping intentionally.

	return {
		soundCount: soundEntries.length,
		soundGroupCount: soundGroupEntries.length,
		bankCount: bankEntries.length,
		waveArchiveCount: waveArchiveEntries.length,
		groupCount: groupEntries.length,
		playerCount: playerEntries.length,
		fileEntries: parsedFileEntries,
		nameByFileIndex,
		nameSourceByFileIndex,
		soundKindByFileIndex,
	};
}

function makeUnknownFileEntry(): ParsedFileEntry {
	return {
		kind: 'internal',
		fileBlockOffset: 0,
		fileSize: 0,
		inGroup: false,
		path: '',
	};
}
