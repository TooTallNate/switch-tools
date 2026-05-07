/**
 * Wwise SoundBank — `.bnk` files. A Wwise-flavoured RIFF where
 * each top-level chunk has a 4-char ASCII id and a `u32` size:
 *
 *   ┌─────────────────────────────────────┐
 *   │ BKHD — Bank header                  │  version, bank id, lang id
 *   │ DIDX — Data index (optional)        │  N × (wem_id, off, size)
 *   │ DATA — Concatenated WEMs (optional) │  raw WEM bytes
 *   │ HIRC — Hierarchy (events, sounds…)  │  Wwise's logic graph
 *   │ STID — Soundbank string table       │  optional name lookups
 *   │ STMG — Streaming manager (init bnk) │
 *   │ ENVS — Environment settings (init)  │
 *   │ INIT — Init bank stuff              │
 *   │ FXPR / PLAT / etc.                   │
 *   └─────────────────────────────────────┘
 *
 * For browsing/extraction we only care about BKHD (metadata) and
 * DIDX/DATA (the embedded WEMs). HIRC is enormous (50+ object
 * types defining the Wwise event graph) and not needed to play
 * audio — we expose it as a raw `Blob` for callers that want it.
 *
 * Each DIDX entry is 12 bytes:
 *   - wem_id u32  — Wwise FNV-1 hashed name
 *   - off    u32  — offset within the DATA chunk's payload
 *   - size   u32  — WEM size in bytes
 *
 * Embedded WEM payload offsets are RELATIVE to the start of the
 * DATA chunk's payload (i.e. the 8 bytes after "DATA"+size).
 *
 * References:
 *   - https://github.com/bnnm/wwiser   — gold-standard tool
 *   - vgmstream `meta/wwise.c`          — DIDX/DATA pattern
 *   - https://www.audiokinetic.com/library/edge/?source=SDK
 */

/** ASCII "BKHD" — file magic at offset 0. */
export const BKHD_MAGIC = 'BKHD';

const KNOWN_CHUNK_IDS = new Set([
	'BKHD',
	'DIDX',
	'DATA',
	'HIRC',
	'STID',
	'STMG',
	'ENVS',
	'FXPR',
	'INIT',
	'PLAT',
]);

export interface BnkChunk {
	/** 4-char ASCII chunk id (e.g. "BKHD", "DIDX", "DATA"). */
	id: string;
	/** Absolute byte offset of the chunk header (the "BKHD" / etc.) in the source `Blob`. */
	offset: number;
	/** Size of the chunk's *payload* in bytes (does not include the 8-byte header). */
	size: number;
	/** Lazy `Blob` view of the chunk payload (header excluded). */
	data: Blob;
}

export interface BnkHeader {
	/** Chunk version. Common values: 100–141 (Wwise SDK v2017+). */
	version: number;
	/** SoundBank id — Wwise FNV-1 hash of the bank's filename. */
	bankId: number;
	/** Language id (0 = sfx/none, others reference the AKPK languageMap). */
	languageId: number;
	/** Project version / id alignment value (vendor-specific). */
	headerSize: number;
}

export interface BnkWem {
	/** Sequential index in the DIDX. */
	index: number;
	/** Wwise FNV-1 hashed name. */
	id: number;
	/** Absolute byte offset of the WEM in the source `Blob`. */
	offset: number;
	/** Size of the WEM in bytes. */
	size: number;
	/** Lazy `Blob` slice of the WEM payload. */
	data: Blob;
}

export interface ParsedBnk {
	header: BnkHeader;
	chunks: BnkChunk[];
	/** Embedded WEMs (DIDX entries pointing into the DATA chunk). May be empty for HIRC-only init banks. */
	wems: BnkWem[];
	/**
	 * Whether the file looks like a valid `.bnk`. Always `true` for
	 * a successfully-returned parse; included here so callers can
	 * round-trip the parse-then-discard pattern cheaply.
	 */
	valid: true;
}

/** Cheap (4-byte) magic check. */
export async function isBnk(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x42 /* B */ &&
		head[1] === 0x4b /* K */ &&
		head[2] === 0x48 /* H */ &&
		head[3] === 0x44 /* D */
	);
}

/**
 * Parse a Wwise SoundBank. Eagerly walks the chunk list (a few
 * dozen bytes per chunk) and materialises the BKHD header
 * + DIDX entries; chunk payloads (including DATA + HIRC) are
 * exposed as lazy `Blob` slices.
 */
export async function parseBnk(blob: Blob): Promise<ParsedBnk> {
	if (blob.size < 16) {
		throw new Error(
			`Blob too small to be a Wwise BNK (${blob.size} bytes)`,
		);
	}
	// Read first 16 bytes to confirm magic + grab BKHD size.
	const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
	if (
		head[0] !== 0x42 ||
		head[1] !== 0x4b ||
		head[2] !== 0x48 ||
		head[3] !== 0x44
	) {
		throw new Error('Bad BKHD magic — not a Wwise SoundBank');
	}

	// Walk chunks linearly. Each chunk has a fixed 8-byte (id+size)
	// header, followed by `size` bytes of payload. Wwise BNKs are
	// always little-endian on Switch (and on every platform we care
	// about — Wwise on PS3/X360 uses RIFX with BE sizes, but those
	// games aren't on Switch).
	const chunks: BnkChunk[] = [];
	let off = 0;
	const fileSize = blob.size;
	// We need to read each chunk's 8-byte header. Do this in batches
	// of 4 KB headers (i.e. 4096/8 = 512 chunks per fetch) — but in
	// practice BNKs have ≤ 10 top-level chunks so a single 64-byte
	// scout read at each offset is fine.
	while (off + 8 <= fileSize) {
		const hdrBytes = new Uint8Array(
			await blob.slice(off, off + 8).arrayBuffer(),
		);
		const id = String.fromCharCode(hdrBytes[0], hdrBytes[1], hdrBytes[2], hdrBytes[3]);
		const size = new DataView(hdrBytes.buffer, hdrBytes.byteOffset).getUint32(4, true);
		// Sanity: chunk id must be ASCII printable (A-Z 0-9 mostly).
		// If it isn't, we've fallen off the end of a malformed bank.
		if (!isAsciiId(id)) break;
		if (off + 8 + size > fileSize) {
			// Truncated bank — keep what we have and stop.
			chunks.push({
				id,
				offset: off,
				size: Math.max(0, fileSize - off - 8),
				data: blob.slice(off + 8, fileSize),
			});
			break;
		}
		chunks.push({
			id,
			offset: off,
			size,
			data: blob.slice(off + 8, off + 8 + size),
		});
		off += 8 + size;
		// Wwise BNK chunks are NOT padded to even alignment (unlike
		// real RIFFs). vgmstream's parse_wwise comments confirm this.
	}

	// Parse BKHD payload.
	const bkhd = chunks.find((c) => c.id === 'BKHD');
	if (!bkhd) throw new Error('BNK missing BKHD chunk');
	const bkhdBytes = new Uint8Array(await bkhd.data.arrayBuffer());
	const bkhdDv = new DataView(bkhdBytes.buffer, bkhdBytes.byteOffset, bkhdBytes.byteLength);
	if (bkhdBytes.length < 8) throw new Error('BKHD too small');
	const version = bkhdDv.getUint32(0, true);
	const bankId = bkhdDv.getUint32(4, true);
	const languageId = bkhdBytes.length >= 12 ? bkhdDv.getUint32(8, true) : 0;
	const headerSizeField = bkhdBytes.length >= 16 ? bkhdDv.getUint32(12, true) : 0;

	// Parse DIDX → DATA wems.
	const wems: BnkWem[] = [];
	const didx = chunks.find((c) => c.id === 'DIDX');
	const data = chunks.find((c) => c.id === 'DATA');
	if (didx && data) {
		const didxBytes = new Uint8Array(await didx.data.arrayBuffer());
		const ddv = new DataView(
			didxBytes.buffer,
			didxBytes.byteOffset,
			didxBytes.byteLength,
		);
		const count = Math.floor(didxBytes.length / 12);
		const dataPayloadBase = data.offset + 8;
		for (let i = 0; i < count; i++) {
			const eo = i * 12;
			const id = ddv.getUint32(eo, true);
			const wemOff = ddv.getUint32(eo + 4, true);
			const wemSize = ddv.getUint32(eo + 8, true);
			const absStart = dataPayloadBase + wemOff;
			const absEnd = Math.min(blob.size, absStart + wemSize);
			wems.push({
				index: i,
				id,
				offset: absStart,
				size: wemSize,
				data: blob.slice(absStart, absEnd),
			});
		}
	}

	return {
		header: {
			version,
			bankId,
			languageId,
			headerSize: headerSizeField,
		},
		chunks,
		wems,
		valid: true,
	};
}

function isAsciiId(id: string): boolean {
	if (id.length !== 4) return false;
	for (let i = 0; i < 4; i++) {
		const c = id.charCodeAt(i);
		if (c < 0x20 || c > 0x7e) return false;
	}
	return true;
}

/**
 * Whether a 4-char chunk id is one of the standard Wwise top-level
 * BNK chunks. Useful for UIs that want to highlight unknown chunks
 * without flagging well-known ones.
 */
export function isKnownBnkChunkId(id: string): boolean {
	return KNOWN_CHUNK_IDS.has(id);
}
