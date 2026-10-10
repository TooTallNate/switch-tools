/**
 * BFTTF / BFOTF deobfuscation.
 *
 * Nintendo ships fonts (both system fonts in the SystemData NCAs
 * `0x0100000000000810`..`0x0100000000000815`, and per-game fonts) as
 * files with the extension `.bfttf` (TrueType) or `.bfotf`
 * (OpenType-CFF). The format is a thin obfuscation wrapper around a
 * real TTF / OTF:
 *
 *   bytes 0..3  → scrambled magic (variant tag)
 *   bytes 4..7  → payload length, XOR'd with the key
 *   bytes 8..   → real TTF / OTF data XOR'd with the key
 *
 * The obfuscation is purely cosmetic — there's no key derivation
 * involved — so this works on any retail dump without prod.keys.
 *
 * Every 4-byte word (including the header) is XOR'd with the same
 * 32-bit key. Treating words as **big-endian** u32s, the key for a
 * file is fully determined by its first word:
 *
 *   key = firstWordBE ^ bswap(BFTTF_MAGIC)
 *
 * i.e. the first word decrypts to the fixed magic `0x18029A7F`
 * (stored little-endian). The three tags seen in the wild are:
 *
 *   | Tag (LE u32) | Key (BE u32) | Where it's used                      |
 *   |--------------|--------------|--------------------------------------|
 *   | 0x1E1AF836   | 0x49621806   | System fonts, Pokémon Let's Go, …    |
 *   | 0x1A879BD9   | 0xA6018502   | Mario Wonder, recent titles          |
 *   | 0xC1DE68F3   | 0x8CF2DCD9   | Third-party / older variant          |
 *
 * After decryption, the size field at offset 4 is a big-endian u32
 * equal to the payload length (file size − 8).
 *
 * Reference: Switch-Toolbox's `BFTTF.cs` (MIT) and BFTTFutil.
 */

const HEADER_SIZE = 0x08;

/** Fixed magic stored (LE) at the start of every BFTTF, after XOR. */
export const BFTTF_MAGIC = 0x18029a7f;

/** Body XOR key (BE u32) for the system-font variant (tag 0x1E1AF836). */
export const OBFUSCATION_KEY = 0x49621806;

/** Scrambled-magic tags (LE u32) of the variants known to exist. */
export const KNOWN_TAGS: readonly number[] = [
	0x1e1af836, // System fonts (FW NCAs), Pokémon Let's Go, …
	0x1a879bd9, // Mario Wonder & recent titles
	0xc1de68f3, // Third-party / older variant
];

export interface ParsedBfttf {
	/** The full deobfuscated font as a `Blob` ready for `FontFace` / download. */
	font: Blob;
	/** TTF, OTF, or TTC, sniffed from the deobfuscated sfnt magic. */
	format: 'ttf' | 'otf' | 'ttc' | 'unknown';
	/** Number of bytes of the *output* font (= input size − 8). */
	size: number;
	/**
	 * Whether the reported size in the BFTTF header matches the
	 * actual payload length. Always true for well-formed files.
	 */
	headerSizeOk: boolean;
}

/** Derive the BE-u32 XOR key from the first 4 bytes of a BFTTF. */
function deriveKey(view: DataView): number {
	return (view.getUint32(0, false) ^ bswap32(BFTTF_MAGIC)) >>> 0;
}

/**
 * Test whether a `Blob` looks like a BFTTF / BFOTF file. A file is
 * accepted if its first word is one of the {@link KNOWN_TAGS}, or if
 * the key derived from it decrypts the payload's first word to a
 * known sfnt magic (catching variants we haven't catalogued yet).
 */
export async function isBfttf(blob: Blob): Promise<boolean> {
	if (blob.size < HEADER_SIZE) return false;
	const len = Math.min(blob.size, HEADER_SIZE + 4);
	const head = new Uint8Array(await blob.slice(0, len).arrayBuffer());
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	if (KNOWN_TAGS.includes(view.getUint32(0, true))) return true;
	if (len < HEADER_SIZE + 4) return false;
	const key = deriveKey(view);
	const size = (view.getUint32(4, false) ^ key) >>> 0;
	const first = (view.getUint32(HEADER_SIZE, false) ^ key) >>> 0;
	return size === blob.size - HEADER_SIZE && isSfntTag(first);
}

/**
 * Deobfuscate a BFTTF / BFOTF blob into a real TTF / OTF. The XOR
 * key is derived from the file's 4-byte scrambled-magic tag.
 *
 * The output is wrapped in a `Blob` whose `type` is set to the
 * appropriate font MIME so it's drop-in usable with
 * `URL.createObjectURL()` and the CSS Font Loading API.
 */
export async function parseBfttf(blob: Blob): Promise<ParsedBfttf> {
	if (blob.size < HEADER_SIZE + 4) {
		throw new Error(
			`Blob too small to be a BFTTF (${blob.size} bytes, need at least ${HEADER_SIZE + 4})`,
		);
	}
	const all = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(all.buffer, all.byteOffset, all.byteLength);
	const tag = view.getUint32(0, true);
	const key = deriveKey(view);
	const payloadLen = all.length - HEADER_SIZE;
	const reportedSize = (view.getUint32(4, false) ^ key) >>> 0;
	const firstWord = (view.getUint32(HEADER_SIZE, false) ^ key) >>> 0;

	if (
		!KNOWN_TAGS.includes(tag) &&
		!(reportedSize === payloadLen && isSfntTag(firstWord))
	) {
		throw new Error(
			`Not a recognised BFTTF / BFOTF (first u32 LE = 0x${tag.toString(16)}; expected one of: ${KNOWN_TAGS.map(
				(k) => '0x' + k.toString(16),
			).join(', ')})`,
		);
	}

	// Deobfuscate the body: each 4-byte chunk as a BE u32, XOR'd with
	// the key, written back as BE.
	const out = new Uint8Array(payloadLen);
	const outView = new DataView(out.buffer);
	const aligned = payloadLen - (payloadLen % 4);
	for (let i = 0; i < aligned; i += 4) {
		const w = view.getUint32(HEADER_SIZE + i, false);
		outView.setUint32(i, (w ^ key) >>> 0, false);
	}
	// Copy any trailing 1..3 bytes (well-formed files never have these).
	for (let i = aligned; i < payloadLen; i++) out[i] = all[HEADER_SIZE + i];

	const format = sniffSfntFormat(out);
	const mime =
		format === 'otf'
			? 'font/otf'
			: format === 'ttf'
				? 'font/ttf'
				: format === 'ttc'
					? 'font/collection'
					: 'application/octet-stream';
	return {
		font: new Blob([out as BlobPart], { type: mime }),
		format,
		size: payloadLen,
		headerSizeOk: reportedSize === payloadLen,
	};
}

/** Byte-reverse a 32-bit unsigned integer. */
function bswap32(v: number): number {
	return (
		(((v & 0xff000000) >>> 24) |
			((v & 0x00ff0000) >>> 8) |
			((v & 0x0000ff00) << 8) |
			((v & 0x000000ff) << 24)) >>>
		0
	);
}

function isSfntTag(tag: number): boolean {
	return sniffTag(tag) !== 'unknown';
}

function sniffTag(tag: number): 'ttf' | 'otf' | 'ttc' | 'unknown' {
	if (tag === 0x00010000) return 'ttf';
	if (tag === 0x4f54544f /* "OTTO" */) return 'otf';
	if (tag === 0x74727565 /* "true" */) return 'ttf';
	if (tag === 0x74797031 /* "typ1" */) return 'ttf';
	if (tag === 0x74746366 /* "ttcf" */) return 'ttc';
	return 'unknown';
}

/**
 * Sniff `'ttf' | 'otf' | 'ttc' | 'unknown'` from the first 4 bytes
 * of an sfnt-format font payload.
 */
function sniffSfntFormat(bytes: Uint8Array): 'ttf' | 'otf' | 'ttc' | 'unknown' {
	if (bytes.length < 4) return 'unknown';
	const tag =
		((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
	return sniffTag(tag);
}
