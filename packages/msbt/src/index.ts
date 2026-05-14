/**
 * Parser for Nintendo MSBT (`MsgStdBn`) message-table resources.
 *
 * MSBT is the localized-string container Nintendo has shipped since
 * the Wii — game dialog, UI labels, item descriptions, glossaries.
 * Each `.msbt` is a labelled lookup table: a list of `(label, text)`
 * pairs, where the labels are stable identifiers code references
 * (e.g. `Enemy_510`) and the texts carry the actual localized copy.
 *
 * The format is a generic chunked container with the following
 * sections (only the first three are commonly populated in retail
 * builds and the only ones we read):
 *
 *   - `LBL1` — hashed label table, mapping `label → text-index`
 *   - `ATR1` — per-text attributes (gameplay metadata; ignored by
 *              this parser since the contents are title-specific
 *              and frequently empty)
 *   - `TXT2` — text bodies, indexed by `text-index`
 *
 * File header (0x20 bytes):
 *
 *   0x00  u8[8]  'MsgStdBn'
 *   0x08  u16    BOM (0xFEFF; 0xFFFE byte sequence in LE files)
 *   0x0A  u16    padding (0)
 *   0x0C  u8     encoding (0=UTF-8, 1=UTF-16)
 *   0x0D  u8     version
 *   0x0E  u16    section count
 *   0x10  u16    padding
 *   0x12  u32    file size (matches the actual file length)
 *   0x16  ..0x20 reserved
 *
 * Each section starts with:
 *
 *   0x00  u8[4]  section magic ('LBL1', 'TXT2', …)
 *   0x04  u32    section size (NOT including this 0x10-byte header)
 *   0x08  ..0x10 reserved (8 bytes)
 *   0x10  payload
 *
 * Sections are padded to 16-byte alignment with `0xAB` filler bytes.
 *
 * LBL1 payload:
 *
 *   u32 bucketCount
 *   bucket[bucketCount]:
 *     u32 entryCount
 *     u32 firstEntryOffset (relative to LBL1 payload start)
 *   ...then a packed list of entries:
 *     u8 nameLen
 *     u8[nameLen] name (ASCII)
 *     u32 textIndex (index into the TXT2 strings table)
 *
 * TXT2 payload:
 *
 *   u32 stringCount
 *   u32 offsets[stringCount] (relative to TXT2 payload start)
 *   ...then the strings themselves; each string runs from its
 *   declared offset up to either the next string's offset or the
 *   end of the section. Strings are UTF-8 or UTF-16-LE depending
 *   on the header's encoding flag, and **null-terminated**.
 *
 * Reference: https://nintendo-formats.com/libs/msbt.html (the
 * single best public spec, maintained from Nintendo SDK leaks);
 * cross-checked against MSBTEditor's open-source format notes.
 * No Nintendo code was used in this parser.
 */

/**
 * Standard MSBT header magic. 8 bytes: 'MsgStdBn' in ASCII.
 */
export const MSBT_MAGIC = 'MsgStdBn';
export const MSBT_HEADER_SIZE = 0x20;
export const MSBT_SECTION_HEADER_SIZE = 0x10;

export const MSBT_ENCODING_UTF8 = 0;
export const MSBT_ENCODING_UTF16 = 1;

/** A single (label, text) pair. */
export interface MsbtEntry {
	/** Label as it appears in the LBL1 section — typically ASCII. */
	label: string;
	/** Index into the TXT2 strings table (also exposed for callers
	 * that want to align the original on-disc order). */
	textIndex: number;
	/** Decoded text body, with the null terminator stripped. */
	text: string;
}

/** Whole parsed file. */
export interface ParsedMsbt {
	/** Encoding the strings were stored in (informational). */
	encoding: 'utf8' | 'utf16le';
	/** MSBT file version (3 in every retail file inspected). */
	version: number;
	/** Number of sections present in the container. */
	sectionCount: number;
	/** Section magics in disc order — useful for debugging. */
	sectionsPresent: string[];
	/** All entries with both label + decoded text, sorted by `textIndex`. */
	entries: MsbtEntry[];
	/** Texts that weren't referenced by any label (rare). */
	unlabeledTexts: Array<{ textIndex: number; text: string }>;
}

export class MsbtParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MsbtParseError';
	}
}

/** True iff `bytes` starts with the MSBT magic. */
export function isMsbtMagic(bytes: Uint8Array): boolean {
	if (bytes.length < 8) return false;
	const magic = 'MsgStdBn';
	for (let i = 0; i < 8; i++) {
		if (bytes[i] !== magic.charCodeAt(i)) return false;
	}
	return true;
}

/** Round `n` up to the next multiple of 16. */
function alignUp16(n: number): number {
	return (n + 15) & ~15;
}

/** Read the 4-byte section magic at `offset` as ASCII. */
function readMagic4(bytes: Uint8Array, offset: number): string {
	return (
		String.fromCharCode(bytes[offset]) +
		String.fromCharCode(bytes[offset + 1]) +
		String.fromCharCode(bytes[offset + 2]) +
		String.fromCharCode(bytes[offset + 3])
	);
}

/**
 * Strip the trailing null terminator from a decoded string, if any.
 * MSBT strings are usually written `…\0` (UTF-16: `…\0\0`); some
 * tools omit them. We tolerate both.
 */
function stripTerminator(s: string): string {
	if (s.endsWith('\0')) return s.slice(0, -1);
	return s;
}

/** Parse an MSBT file. */
export function parseMsbt(bytes: Uint8Array): ParsedMsbt {
	if (!isMsbtMagic(bytes)) {
		throw new MsbtParseError('not an MSBT file (missing MsgStdBn magic)');
	}
	if (bytes.length < MSBT_HEADER_SIZE) {
		throw new MsbtParseError(
			`MSBT header truncated (${bytes.length} < ${MSBT_HEADER_SIZE})`,
		);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const bom = dv.getUint16(0x08, true);
	// Both 0xFFFE-as-LE and 0xFEFF-as-LE are observed in the wild
	// because the format documents the BOM as 0xFEFF written in the
	// file's native byte order. Accept either.
	if (bom !== 0xfffe && bom !== 0xfeff) {
		throw new MsbtParseError(
			`Unexpected MSBT BOM 0x${bom.toString(16)} (expected 0xFEFF / 0xFFFE)`,
		);
	}
	const encoding =
		bytes[0x0c] === MSBT_ENCODING_UTF16 ? 'utf16le' : 'utf8';
	const version = bytes[0x0d];
	const sectionCount = dv.getUint16(0x0e, true);
	if (sectionCount === 0) {
		return {
			encoding,
			version,
			sectionCount,
			sectionsPresent: [],
			entries: [],
			unlabeledTexts: [],
		};
	}

	// Walk sections to find LBL1 + TXT2.
	let offset = MSBT_HEADER_SIZE;
	let lbl1Payload: Uint8Array | null = null;
	let txt2Payload: Uint8Array | null = null;
	const sectionsPresent: string[] = [];
	for (let i = 0; i < sectionCount; i++) {
		if (offset + MSBT_SECTION_HEADER_SIZE > bytes.length) {
			throw new MsbtParseError(
				`MSBT section header at offset 0x${offset.toString(16)} runs past EOF`,
			);
		}
		const magic = readMagic4(bytes, offset);
		const sectionSize = dv.getUint32(offset + 0x04, true);
		const payloadStart = offset + MSBT_SECTION_HEADER_SIZE;
		const payloadEnd = payloadStart + sectionSize;
		if (payloadEnd > bytes.length) {
			throw new MsbtParseError(
				`MSBT section '${magic}' payload (size ${sectionSize}) at 0x${payloadStart.toString(16)} runs past EOF`,
			);
		}
		const payload = bytes.subarray(payloadStart, payloadEnd);
		sectionsPresent.push(magic);
		if (magic === 'LBL1') lbl1Payload = payload;
		else if (magic === 'TXT2') txt2Payload = payload;
		// Skip ATR1, TSY1, NLI1, ATO1: we don't render those.
		offset = alignUp16(payloadEnd);
	}

	if (!txt2Payload) {
		throw new MsbtParseError(
			`MSBT has no TXT2 section (sections present: ${sectionsPresent.join(', ')})`,
		);
	}
	const texts = readTxt2(txt2Payload, encoding);
	const labels = lbl1Payload ? readLbl1(lbl1Payload) : new Map<number, string>();

	// Join labels to texts. A label points at a textIndex; texts that
	// don't appear in any label become `unlabeledTexts`.
	const entries: MsbtEntry[] = [];
	const labelByIndex = labels;
	const usedTextIndexes = new Set<number>();
	for (const [textIndex, label] of labelByIndex) {
		const text = texts[textIndex] ?? '';
		entries.push({ label, textIndex, text });
		usedTextIndexes.add(textIndex);
	}
	const unlabeledTexts: Array<{ textIndex: number; text: string }> = [];
	for (let i = 0; i < texts.length; i++) {
		if (!usedTextIndexes.has(i)) {
			unlabeledTexts.push({ textIndex: i, text: texts[i] });
		}
	}
	// Sort entries by text index for stable, easy-to-skim output.
	entries.sort((a, b) => a.textIndex - b.textIndex);

	return {
		encoding,
		version,
		sectionCount,
		sectionsPresent,
		entries,
		unlabeledTexts,
	};
}

/** Read an LBL1 payload into a `textIndex → label` map. */
function readLbl1(payload: Uint8Array): Map<number, string> {
	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	if (payload.length < 4) return new Map();
	const bucketCount = dv.getUint32(0, true);
	// Bucket headers: each is 8 bytes (entryCount + firstEntryOffset).
	// Total prelude = 4 + bucketCount * 8.
	const out = new Map<number, string>();
	const decoder = new TextDecoder('ascii', { fatal: false });
	for (let b = 0; b < bucketCount; b++) {
		const headerOffset = 4 + b * 8;
		if (headerOffset + 8 > payload.length) break;
		const entryCount = dv.getUint32(headerOffset, true);
		let off = dv.getUint32(headerOffset + 4, true);
		for (let i = 0; i < entryCount; i++) {
			if (off + 1 > payload.length) break;
			const nameLen = payload[off];
			off += 1;
			if (off + nameLen + 4 > payload.length) break;
			const name = decoder.decode(payload.subarray(off, off + nameLen));
			off += nameLen;
			const textIndex = dv.getUint32(off, true);
			off += 4;
			out.set(textIndex, name);
		}
	}
	return out;
}

/** Read a TXT2 payload into a flat array of decoded strings. */
function readTxt2(payload: Uint8Array, encoding: 'utf8' | 'utf16le'): string[] {
	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	if (payload.length < 4) return [];
	const stringCount = dv.getUint32(0, true);
	const offsets: number[] = [];
	const tableEnd = 4 + stringCount * 4;
	if (tableEnd > payload.length) return [];
	for (let i = 0; i < stringCount; i++) {
		offsets.push(dv.getUint32(4 + i * 4, true));
	}
	// Sentinel for the last string: end of payload.
	offsets.push(payload.length);
	const decoder = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-8', {
		fatal: false,
		ignoreBOM: true,
	});
	const out: string[] = [];
	for (let i = 0; i < stringCount; i++) {
		const start = offsets[i];
		const end = offsets[i + 1];
		if (start >= payload.length || end <= start) {
			out.push('');
			continue;
		}
		const raw = decoder.decode(payload.subarray(start, end));
		out.push(stripTerminator(raw));
	}
	return out;
}
