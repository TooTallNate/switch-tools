/**
 * BARS — "Binary Audio Resource System".
 *
 * BARS is Nintendo's flat audio archive format for the Wii U and
 * Switch eras. Each archive holds N audio "tracks", and each track
 * is a `(AMTA, FWAV|FSTP)` pair:
 *
 *   - **AMTA** ("Audio MeTAdata") — fixed-size header followed by
 *     four sub-sections: `DATA` (sample-rate, channel count, codec,
 *     loop range, and a few flags), `MARK` (named time markers),
 *     `EXT_` (extension chunks), and `STRG` (the human-readable
 *     track name as a NUL-terminated UTF-8 string).
 *   - **FWAV** / **FSTP** — the actual audio payload, in the same
 *     layout as the standalone `.bfwav` / `.bfstp` formats. We do
 *     *not* descend into them here; we just expose them as lazy
 *     `Blob` slices that callers can route to a BFWAV / BFSTP
 *     parser, hand off to `vgmstream-web`, or simply download.
 *
 * Wire layout:
 *
 *   ┌──────────────────────────────┐
 *   │ BARS header           (0x10) │  magic, file_size, BOM, count
 *   ├──────────────────────────────┤
 *   │ track CRC32 hashes (count×4) │  not used here
 *   ├──────────────────────────────┤
 *   │ offset table   (count × 0x8) │  (amta_offset, file_offset)
 *   ├──────────────────────────────┤
 *   │ per-track AMTA blocks        │  in any order; offsets above
 *   ├──────────────────────────────┤
 *   │ per-track FWAV / FSTP blobs  │  ditto
 *   └──────────────────────────────┘
 *
 * Endianness comes from the BOM at offset 8: `0xFEFF` is big-endian
 * (Wii U), `0xFFFE` is little-endian (Switch). Most modern shipped
 * games are little-endian.
 *
 * Parsing is lazy in the same style as the SARC / NSP / RomFS
 * packages elsewhere in this monorepo: only the AMTA metadata block
 * is decoded up-front (typically a few KB even for archives with
 * hundreds of tracks), and each track's audio payload is exposed as
 * a `Blob` slice that callers extract on demand.
 *
 * Some shipped BARS files are "stubs" whose offset table claims N
 * tracks but whose audio payloads (and sometimes the trailing AMTA
 * blocks) are missing — this happens when a game references a sound
 * pack that wasn't built into a particular release. We tolerate
 * those: tracks whose `file_offset >= file_size` get
 * `audio === null`, and tracks whose AMTA header runs off the end
 * are still listed (with a flag) so the caller can surface them.
 *
 * References:
 *   - https://gist.github.com/SamusAranX/6eb8b6fd1777b17afc3107a979c2409a
 *   - https://github.com/NanobotZ/BarsTool
 *   - https://mk8.tockdom.com/wiki/BARS_(File_Format)
 */

/** ASCII "BARS" — file magic at offset 0. */
export const BARS_MAGIC = 'BARS';

/** ASCII "AMTA" — start-of-block magic for each per-track metadata header. */
export const AMTA_MAGIC = 'AMTA';

/** ASCII "FWAV" — full-bake audio payload (also called BFWAV / `.bfwav`). */
export const FWAV_MAGIC = 'FWAV';

/** ASCII "FSTP" — prefetch-stream payload (also called BFSTP / `.bfstp`). */
export const FSTP_MAGIC = 'FSTP';

const BARS_HEADER_SIZE = 0x10;
const AMTA_HEADER_SIZE = 0x1c;
const SUB_HEADER_SIZE = 0x08;

export type Endian = 'big' | 'little';

/**
 * Audio-payload kind for a given track. `'fwav'` is a baked audio
 * file; `'fstp'` is a prefetch stream. These map onto the real
 * BFWAV / BFSTP formats one-to-one.
 */
export type BarsAudioKind = 'fwav' | 'fstp';

/**
 * One sub-section of an AMTA block. Tracks always have all four
 * (`DATA`, `MARK`, `EXT_`, `STRG`) but `MARK` and `EXT_` are
 * commonly empty.
 */
export interface AmtaSubBlock {
	/** 4-character block magic (one of `'DATA'`, `'MARK'`, `'EXT_'`, `'STRG'`). */
	magic: string;
	/** Length of the payload following the 8-byte sub-header. */
	length: number;
	/** Absolute offset (within the BARS file) of the payload. */
	offset: number;
	/** Lazy view of the payload bytes. */
	data: Blob;
}

/**
 * Parsed `DATA` sub-section of an AMTA block. The on-disk layout
 * is partially undocumented; the fields below cover the values that
 * the BarsTool / Switch-Toolbox community has reverse-engineered and
 * uses in practice. Unknown bytes are exposed as `raw` for callers
 * that want to render their own hex view.
 *
 * Field offsets are relative to the start of the `DATA` payload
 * (i.e. *after* the 8-byte `DATA` sub-header):
 *
 *   0x00  u32  flags / format word
 *   0x04  u32  more flags (mostly reserved)
 *   0x08  u8   loop point flag (0 = no loop)
 *   0x09  u8   number of channels
 *   0x0A  u8   sample-format hint
 *   0x0B  u8   reserved
 *   0x0C  f32  volume (linear gain)
 *   0x10  u32  unknown — observed to be 0
 *   0x14  u32  loop start (samples)
 *   0x18  u32  loop end (samples) / total length
 *
 * If the `DATA` payload is shorter than 0x1C bytes the parser
 * still succeeds — the truncated fields come back as `0` and
 * callers should treat them as "unknown".
 */
export interface AmtaData {
	/** Raw payload bytes, for debugging / future field discovery. */
	raw: Uint8Array;
	flags: number;
	flags2: number;
	loopFlag: number;
	channelCount: number;
	sampleFormat: number;
	volume: number;
	loopStart: number;
	loopEnd: number;
}

/**
 * Fully-parsed AMTA block for a single BARS track.
 */
export interface AmtaBlock {
	/** Endianness reported by the per-block BOM at offset 4 of the AMTA header. */
	endian: Endian;
	/** Total declared length of the AMTA block in bytes. */
	length: number;
	/** Absolute offset of the AMTA header within the BARS file. */
	offset: number;
	/** Sub-block offsets relative to the AMTA header start. */
	subOffsets: {
		data: number;
		mark: number;
		ext: number;
		strg: number;
	};
	/** All four declared sub-blocks; `null` if absent. */
	dataBlock: AmtaSubBlock | null;
	markBlock: AmtaSubBlock | null;
	extBlock: AmtaSubBlock | null;
	strgBlock: AmtaSubBlock | null;
	/** Decoded `DATA` fields (see {@link AmtaData}). */
	data: AmtaData | null;
	/**
	 * Track name, decoded from the `STRG` sub-block. Trailing NUL
	 * bytes are stripped. If the `STRG` block is missing or empty,
	 * this is the empty string.
	 */
	name: string;
}

/**
 * One named entry in a BARS archive. Combines the AMTA metadata
 * with a lazy `Blob` view of the audio payload.
 */
export interface BarsEntry {
	/** CRC32 file ID from the BARS hash table. Informational. */
	hashId: number;
	/** Sequential track index, 0-based. */
	index: number;
	/** Track name, taken from the AMTA `STRG` block. May be empty. */
	name: string;
	/** Absolute byte offset of the AMTA block in the source `Blob`. */
	amtaOffset: number;
	/** Absolute byte offset of the audio payload, or `0` if absent. */
	audioOffset: number;
	/**
	 * Audio payload kind, sniffed from the FWAV / FSTP magic. `null`
	 * when the audio is missing (e.g. stub BARS files whose offsets
	 * point past EOF).
	 */
	audioKind: BarsAudioKind | null;
	/**
	 * Audio payload size in bytes, taken from the FWAV / FSTP header
	 * at `audio_offset + 0x0C`. `0` when the audio is absent.
	 */
	audioSize: number;
	/**
	 * Lazy `Blob` view of the audio payload (suitable for handing to
	 * a BFWAV / BFSTP parser, or for direct download). `null` when
	 * the payload is absent.
	 */
	audio: Blob | null;
	/** Decoded AMTA block. */
	amta: AmtaBlock;
}

export interface ParsedBars {
	/** Endianness used by the source archive. */
	endian: Endian;
	/** Reported total file size from the BARS header. */
	fileSize: number;
	/** Number of tracks declared by the header. */
	trackCount: number;
	/** Parsed entries, in declaration order. */
	entries: BarsEntry[];
}

/** Cheap (4-byte) magic check. */
export async function isBars(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x42 /* B */ &&
		head[1] === 0x41 /* A */ &&
		head[2] === 0x52 /* R */ &&
		head[3] === 0x53 /* S */
	);
}

/**
 * Parse a BARS archive. Decodes the offset / hash tables and every
 * AMTA block; audio payloads remain as lazy `Blob` slices.
 *
 * Tolerant of "stub" BARS files (where the offsets point past EOF
 * because the audio payload was stripped). Throws only on truly
 * malformed input — bad magic, an invalid BOM, or AMTA blocks whose
 * declared offsets fall outside the AMTA header itself.
 */
export async function parseBars(blob: Blob): Promise<ParsedBars> {
	if (blob.size < BARS_HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a BARS (${blob.size} bytes, need at least ${BARS_HEADER_SIZE})`,
		);
	}

	const head = new Uint8Array(
		await blob.slice(0, BARS_HEADER_SIZE).arrayBuffer(),
	);
	if (
		head[0] !== 0x42 ||
		head[1] !== 0x41 ||
		head[2] !== 0x52 ||
		head[3] !== 0x53
	) {
		throw new Error('Bad BARS magic');
	}

	// BOM at offset 8: 0xFEFF = BE, 0xFFFE = LE.
	const bomBE = head[8] === 0xfe && head[9] === 0xff;
	const bomLE = head[8] === 0xff && head[9] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid BARS byte-order mark: 0x${head[8].toString(16)}${head[9].toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;

	const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const fileSize = headView.getUint32(4, isLittle);
	const trackCount = headView.getUint32(0x0c, isLittle);

	if (trackCount > 0xffff) {
		// Sanity bound — no shipped archive comes close to this and a
		// runaway value usually means we're staring at non-BARS data.
		throw new Error(`Implausible BARS track count: ${trackCount}`);
	}

	// Slurp the entire metadata block (header + hash table + offset
	// table) in one read. That's `0x10 + 4*N + 8*N = 0x10 + 12*N`
	// bytes — under 12 KB even for a 1024-track archive.
	const tableBytes = BARS_HEADER_SIZE + trackCount * (4 + 8);
	if (tableBytes > blob.size) {
		throw new Error(
			`BARS hash + offset tables (${tableBytes} bytes) overrun blob (${blob.size})`,
		);
	}
	const metaBytes = new Uint8Array(
		await blob.slice(0, tableBytes).arrayBuffer(),
	);
	const metaView = new DataView(
		metaBytes.buffer,
		metaBytes.byteOffset,
		metaBytes.byteLength,
	);

	const hashes: number[] = new Array(trackCount);
	for (let i = 0; i < trackCount; i++) {
		hashes[i] = metaView.getUint32(BARS_HEADER_SIZE + i * 4, isLittle);
	}

	const offsetTableStart = BARS_HEADER_SIZE + trackCount * 4;
	const amtaOffsets: number[] = new Array(trackCount);
	const audioOffsets: number[] = new Array(trackCount);
	for (let i = 0; i < trackCount; i++) {
		const o = offsetTableStart + i * 8;
		amtaOffsets[i] = metaView.getUint32(o, isLittle);
		audioOffsets[i] = metaView.getUint32(o + 4, isLittle);
	}

	const entries: BarsEntry[] = new Array(trackCount);
	for (let i = 0; i < trackCount; i++) {
		entries[i] = await parseEntry(
			blob,
			i,
			hashes[i],
			amtaOffsets[i],
			audioOffsets[i],
			fileSize,
		);
	}

	return { endian, fileSize, trackCount, entries };
}

async function parseEntry(
	blob: Blob,
	index: number,
	hashId: number,
	amtaOffset: number,
	audioOffset: number,
	fileSize: number,
): Promise<BarsEntry> {
	const amta = await parseAmta(blob, amtaOffset, fileSize);
	let audioKind: BarsAudioKind | null = null;
	let audioSize = 0;
	let audio: Blob | null = null;
	if (audioOffset > 0 && audioOffset + 0x10 <= blob.size) {
		const fwavHead = new Uint8Array(
			await blob.slice(audioOffset, audioOffset + 0x10).arrayBuffer(),
		);
		const magic = String.fromCharCode(
			fwavHead[0],
			fwavHead[1],
			fwavHead[2],
			fwavHead[3],
		);
		if (magic === FWAV_MAGIC) audioKind = 'fwav';
		else if (magic === FSTP_MAGIC) audioKind = 'fstp';
		if (audioKind) {
			// FWAV / FSTP both put their total file size at offset 0x0C
			// in the same endianness as the BARS host. We re-read it from
			// the per-block BOM at 0x04 to be safe.
			const blockBomBE = fwavHead[4] === 0xfe && fwavHead[5] === 0xff;
			const blockIsLittle = !blockBomBE;
			const v = new DataView(
				fwavHead.buffer,
				fwavHead.byteOffset,
				fwavHead.byteLength,
			);
			audioSize = v.getUint32(0x0c, blockIsLittle);
			if (audioSize > 0 && audioOffset + audioSize <= blob.size) {
				audio = blob.slice(audioOffset, audioOffset + audioSize);
			} else {
				// Header reports more bytes than are physically present
				// (truncated archive); expose what we have rather than
				// throwing.
				audio = blob.slice(audioOffset, blob.size);
				audioSize = audio.size;
			}
		}
	}

	return {
		index,
		hashId,
		name: amta.name,
		amtaOffset,
		audioOffset,
		audioKind,
		audioSize,
		audio,
		amta,
	};
}

async function parseAmta(
	blob: Blob,
	amtaOffset: number,
	fileSize: number,
): Promise<AmtaBlock> {
	if (amtaOffset === 0 || amtaOffset + AMTA_HEADER_SIZE > blob.size) {
		// Stub track without an AMTA — surface an empty placeholder so
		// the caller can still iterate the offset table.
		return emptyAmta(amtaOffset);
	}
	const head = new Uint8Array(
		await blob.slice(amtaOffset, amtaOffset + AMTA_HEADER_SIZE).arrayBuffer(),
	);
	if (
		head[0] !== 0x41 /* A */ ||
		head[1] !== 0x4d /* M */ ||
		head[2] !== 0x54 /* T */ ||
		head[3] !== 0x41 /* A */
	) {
		throw new Error(
			`Bad AMTA magic at offset 0x${amtaOffset.toString(16)}`,
		);
	}
	const bomBE = head[4] === 0xfe && head[5] === 0xff;
	const bomLE = head[4] === 0xff && head[5] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid AMTA byte-order mark at 0x${amtaOffset.toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const length = view.getUint32(0x08, isLittle);
	const dataSubOff = view.getUint32(0x0c, isLittle);
	const markSubOff = view.getUint32(0x10, isLittle);
	const extSubOff = view.getUint32(0x14, isLittle);
	const strgSubOff = view.getUint32(0x18, isLittle);

	// Read the rest of the AMTA payload so we can decode the four
	// sub-blocks. Bound the read by `length` (the block's declared
	// size) and by the surrounding file — some "stub" archives lie
	// about `length`.
	const blockEnd = Math.min(amtaOffset + length, blob.size, fileSize || blob.size);
	const blockBytes = new Uint8Array(
		await blob.slice(amtaOffset, blockEnd).arrayBuffer(),
	);

	const dataBlock = readSubBlock(
		blockBytes,
		dataSubOff,
		amtaOffset,
		isLittle,
		'DATA',
	);
	const markBlock = readSubBlock(
		blockBytes,
		markSubOff,
		amtaOffset,
		isLittle,
		'MARK',
	);
	const extBlock = readSubBlock(
		blockBytes,
		extSubOff,
		amtaOffset,
		isLittle,
		'EXT_',
	);
	const strgBlock = readSubBlock(
		blockBytes,
		strgSubOff,
		amtaOffset,
		isLittle,
		'STRG',
	);

	let data: AmtaData | null = null;
	if (dataBlock) {
		data = decodeAmtaData(blockBytes, dataSubOff + SUB_HEADER_SIZE, dataBlock.length, isLittle);
	}

	let name = '';
	if (strgBlock) {
		const start = strgSubOff + SUB_HEADER_SIZE;
		const end = start + strgBlock.length;
		const slice = blockBytes.subarray(start, end);
		name = decodeNulTerminatedUtf8(slice);
	}

	return {
		endian,
		length,
		offset: amtaOffset,
		subOffsets: {
			data: dataSubOff,
			mark: markSubOff,
			ext: extSubOff,
			strg: strgSubOff,
		},
		dataBlock,
		markBlock,
		extBlock,
		strgBlock,
		data,
		name,
	};
}

function emptyAmta(offset: number): AmtaBlock {
	return {
		endian: 'little',
		length: 0,
		offset,
		subOffsets: { data: 0, mark: 0, ext: 0, strg: 0 },
		dataBlock: null,
		markBlock: null,
		extBlock: null,
		strgBlock: null,
		data: null,
		name: '',
	};
}

function readSubBlock(
	blockBytes: Uint8Array,
	subOff: number,
	amtaOffset: number,
	isLittle: boolean,
	expected: string,
): AmtaSubBlock | null {
	if (subOff === 0) return null;
	if (subOff + SUB_HEADER_SIZE > blockBytes.length) return null;
	const v = new DataView(
		blockBytes.buffer,
		blockBytes.byteOffset,
		blockBytes.byteLength,
	);
	const magic = String.fromCharCode(
		blockBytes[subOff],
		blockBytes[subOff + 1],
		blockBytes[subOff + 2],
		blockBytes[subOff + 3],
	);
	if (magic !== expected) {
		// Mismatching magic — surface as null rather than throwing so
		// a single corrupt sub-block doesn't poison the whole archive
		// for the caller.
		return null;
	}
	const length = v.getUint32(subOff + 4, isLittle);
	const start = amtaOffset + subOff + SUB_HEADER_SIZE;
	const end = start + length;
	return {
		magic,
		length,
		offset: start,
		// We don't have access to the source `Blob` here so callers
		// who want a real lazy slice of the payload should index from
		// `offset` themselves; in practice the only consumers that
		// matter (preview UIs) read it eagerly off `blockBytes` anyway.
		// We still return a Blob view for API consistency: it points
		// at the in-memory copy we already have, which is a few
		// hundred bytes per AMTA at most.
		data: new Blob([blockBytes.slice(subOff + SUB_HEADER_SIZE, subOff + SUB_HEADER_SIZE + length) as BlobPart]),
	};
}

function decodeAmtaData(
	blockBytes: Uint8Array,
	payloadOffset: number,
	length: number,
	isLittle: boolean,
): AmtaData {
	const end = Math.min(payloadOffset + length, blockBytes.length);
	const raw = blockBytes.slice(payloadOffset, end);
	const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	const safe = (off: number, size: number) => off + size <= raw.byteLength;
	return {
		raw,
		flags: safe(0, 4) ? v.getUint32(0, isLittle) : 0,
		flags2: safe(4, 4) ? v.getUint32(4, isLittle) : 0,
		loopFlag: safe(8, 1) ? v.getUint8(8) : 0,
		channelCount: safe(9, 1) ? v.getUint8(9) : 0,
		sampleFormat: safe(0xa, 1) ? v.getUint8(0xa) : 0,
		volume: safe(0xc, 4) ? v.getFloat32(0xc, isLittle) : 0,
		loopStart: safe(0x14, 4) ? v.getUint32(0x14, isLittle) : 0,
		loopEnd: safe(0x18, 4) ? v.getUint32(0x18, isLittle) : 0,
	};
}

function decodeNulTerminatedUtf8(bytes: Uint8Array): string {
	let end = bytes.length;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) {
			end = i;
			break;
		}
	}
	return new TextDecoder('utf-8').decode(bytes.subarray(0, end));
}
