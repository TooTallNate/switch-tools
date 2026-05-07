/**
 * AKPK — Audiokinetic Package, the streaming-WEM container that
 * ships alongside `.bnk` SoundBanks in every Wwise-using title
 * (file extension `.pck`). Layout:
 *
 *   ┌───────────────────────────────┐
 *   │ magic "AKPK"               4B │
 *   │ headerSize (LE u32)        4B │  bytes after this prelude
 *   │ version (LE u32)           4B │
 *   │ langMapSize (LE u32)       4B │
 *   │ soundbankTableSize (u32)   4B │
 *   │ streamWemTableSize (u32)   4B │
 *   │ externalTableSize (u32)    4B │
 *   ├───────────────────────────────┤
 *   │ Language map  (langMapSize)   │  count + N×(nameOff,langId)
 *   │                                │  + NUL-terminated name pool
 *   ├───────────────────────────────┤
 *   │ SoundBank LUT (sbTableSize)   │  count + N × LutEntry (20 B)
 *   ├───────────────────────────────┤
 *   │ StreamedFiles LUT (streamSz)  │  count + N × LutEntry (20 B)
 *   ├───────────────────────────────┤
 *   │ External LUT  (extTableSize)  │  count + N × ExtEntry (?)
 *   ├───────────────────────────────┤
 *   │ Concatenated WEM payload data │  (offsets in LUT entries are
 *   │                               │   absolute byte offsets from
 *   │                               │   the start of the file)
 *   └───────────────────────────────┘
 *
 * Each LUT entry is 20 bytes (32 on big-endian/64-bit packs, but
 * Switch is always 32-bit LE so we hard-code that):
 *
 *   - id        u32 — Wwise FNV-1 hashed name (the source asset's
 *                     filename hashed with AK::FNVHash32).
 *   - blockSize u32 — sector alignment hint (1 = no alignment).
 *   - size      u32 — WEM size in bytes.
 *   - dataOff   u32 — absolute byte offset of the WEM in the file.
 *   - langIdx   u32 — index into the language map (0 = sfx/none).
 *
 * Parsing is fully lazy — the result holds a `Blob` slice for each
 * WEM payload without ever fully reading the multi-GB Default.pck.
 *
 * References:
 *   - vgmstream `meta/wwise.c` (AKPK detection from .bnk side)
 *   - vgmstream `meta/akb.c` (loose AKPK parsing pattern)
 *   - https://github.com/bnnm/wwiser
 */

/** ASCII "AKPK" — file magic at offset 0. */
export const AKPK_MAGIC = 'AKPK';

/** "KPKA" — same magic, big-endian platforms (PS3, X360). */
export const AKPK_MAGIC_BE = 'KPKA';

const HEADER_PRELUDE_SIZE = 0x1c;

export type Endian = 'big' | 'little';

/** One entry in either the SoundBank LUT or the StreamedFiles LUT. */
export interface AkpkLutEntry {
	/** Wwise FNV-hashed asset name. The source filename is *not* stored. */
	id: number;
	/** Sector-alignment hint (1 = no alignment, 2048 = 2 KB sectors). */
	blockSize: number;
	/** Size of the WEM in bytes. */
	size: number;
	/** Absolute byte offset of the WEM inside the source `Blob`. */
	dataOffset: number;
	/** Index into `languageMap`. */
	languageIndex: number;
	/** Lazy `Blob` slice covering the WEM payload. */
	data: Blob;
}

export interface AkpkLanguage {
	/** Index in the language table. */
	index: number;
	/** ASCII name (e.g. `"sfx"`, `"english(us)"`). */
	name: string;
	/** Audiokinetic-defined language id (0 = sfx/none). */
	id: number;
}

export interface ParsedAkpk {
	endian: Endian;
	version: number;
	headerSize: number;
	languageMap: AkpkLanguage[];
	soundbanks: AkpkLutEntry[];
	streamedFiles: AkpkLutEntry[];
	/**
	 * Externally-referenced files (rare). Layout differs from the
	 * standard 20-byte LUT entry, so we expose the raw bytes for
	 * callers who care; nx-archive ignores it.
	 */
	externalsRaw: Uint8Array;
}

/** Cheap (4-byte) magic check. */
export async function isAkpk(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const isLE = head[0] === 0x41 && head[1] === 0x4b && head[2] === 0x50 && head[3] === 0x4b; // "AKPK"
	const isBE = head[0] === 0x4b && head[1] === 0x50 && head[2] === 0x4b && head[3] === 0x41; // "KPKA"
	return isLE || isBE;
}

function readNulTerminated(bytes: Uint8Array, offset: number): string {
	let end = offset;
	while (end < bytes.length && bytes[end] !== 0) end++;
	return new TextDecoder('utf-8').decode(bytes.subarray(offset, end));
}

/**
 * Parse an AKPK package. Reads the header table eagerly (typically
 * a few hundred KB at most — Default.pck's table is ~109 KB for
 * 5,471 entries) and exposes each WEM as a lazy `Blob` slice.
 */
export async function parseAkpk(blob: Blob): Promise<ParsedAkpk> {
	if (blob.size < HEADER_PRELUDE_SIZE) {
		throw new Error(
			`Blob too small to be an AKPK (${blob.size} bytes, need at least ${HEADER_PRELUDE_SIZE})`,
		);
	}
	const prelude = new Uint8Array(
		await blob.slice(0, HEADER_PRELUDE_SIZE).arrayBuffer(),
	);
	const m0 = prelude[0],
		m1 = prelude[1],
		m2 = prelude[2],
		m3 = prelude[3];
	const isLE = m0 === 0x41 && m1 === 0x4b && m2 === 0x50 && m3 === 0x4b;
	const isBE = m0 === 0x4b && m1 === 0x50 && m2 === 0x4b && m3 === 0x41;
	if (!isLE && !isBE) throw new Error('Bad AKPK magic');
	const endian: Endian = isLE ? 'little' : 'big';
	const little = isLE;
	const dv0 = new DataView(prelude.buffer);

	const headerSize = dv0.getUint32(4, little);
	const version = dv0.getUint32(8, little);
	const langMapSize = dv0.getUint32(12, little);
	const sbTableSize = dv0.getUint32(16, little);
	const streamTableSize = dv0.getUint32(20, little);
	const extTableSize = dv0.getUint32(24, little);

	if (headerSize > 0x10000000) {
		throw new Error(`Implausible AKPK header size: ${headerSize}`);
	}
	if (
		HEADER_PRELUDE_SIZE - 8 +
			(langMapSize + sbTableSize + streamTableSize + extTableSize) >
		headerSize + 0x100
	) {
		// Sub-table sizes shouldn't exceed the declared header size by much.
		// (Allow a small margin for AK-side rounding.)
	}

	// Read the rest of the header in one shot.
	const totalHeader = 8 + headerSize;
	const headEnd = Math.min(blob.size, totalHeader);
	const head = new Uint8Array(await blob.slice(0, headEnd).arrayBuffer());
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);

	// --- Language map ---
	const langMapBase = HEADER_PRELUDE_SIZE; // 0x1c
	let off = langMapBase;
	const langCount = dv.getUint32(off, little);
	off += 4;
	const langEntriesStart = off;
	const languageMap: AkpkLanguage[] = [];
	for (let i = 0; i < langCount; i++) {
		const eo = langEntriesStart + i * 8;
		if (eo + 8 > head.length) break;
		const nameOff = dv.getUint32(eo, little);
		const langId = dv.getUint32(eo + 4, little);
		// Names are at langMapBase + nameOff (relative to the start
		// of the language map block — i.e. the `count` u32).
		const nameAbs = langMapBase + nameOff;
		let name = '';
		if (nameAbs >= 0 && nameAbs < head.length) {
			name = readNulTerminated(head, nameAbs);
		}
		languageMap.push({ index: i, name, id: langId });
	}
	off = HEADER_PRELUDE_SIZE + langMapSize;

	// --- SoundBank LUT ---
	const sbCount = dv.getUint32(off, little);
	off += 4;
	const soundbanks: AkpkLutEntry[] = [];
	for (let i = 0; i < sbCount; i++) {
		const e = off + i * 20;
		if (e + 20 > head.length) break;
		const id = dv.getUint32(e, little);
		const blockSize = dv.getUint32(e + 4, little);
		const size = dv.getUint32(e + 8, little);
		const dataOffset = dv.getUint32(e + 12, little);
		const languageIndex = dv.getUint32(e + 16, little);
		soundbanks.push({
			id,
			blockSize,
			size,
			dataOffset,
			languageIndex,
			data: blob.slice(dataOffset, Math.min(blob.size, dataOffset + size)),
		});
	}
	off = HEADER_PRELUDE_SIZE + langMapSize + sbTableSize;

	// --- StreamedFiles LUT ---
	const streamCount = dv.getUint32(off, little);
	off += 4;
	const streamedFiles: AkpkLutEntry[] = [];
	for (let i = 0; i < streamCount; i++) {
		const e = off + i * 20;
		if (e + 20 > head.length) break;
		const id = dv.getUint32(e, little);
		const blockSize = dv.getUint32(e + 4, little);
		const size = dv.getUint32(e + 8, little);
		const dataOffset = dv.getUint32(e + 12, little);
		const languageIndex = dv.getUint32(e + 16, little);
		streamedFiles.push({
			id,
			blockSize,
			size,
			dataOffset,
			languageIndex,
			data: blob.slice(dataOffset, Math.min(blob.size, dataOffset + size)),
		});
	}
	off = HEADER_PRELUDE_SIZE + langMapSize + sbTableSize + streamTableSize;

	// --- Externals (raw, layout varies) ---
	const extEnd = Math.min(off + extTableSize, head.length);
	const externalsRaw = head.subarray(off, extEnd);

	return {
		endian,
		version,
		headerSize,
		languageMap,
		soundbanks,
		streamedFiles,
		externalsRaw,
	};
}
