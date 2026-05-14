/**
 * BFTTF / BFOTF deobfuscation.
 *
 * Nintendo ships system fonts inside SystemData NCAs (title IDs
 * `0x0100000000000810`..`0x0100000000000815`) as files with the
 * extension `.bfttf` (TrueType) or `.bfotf` (OpenType-CFF). The
 * format is a thin obfuscation wrapper around a real TTF / OTF:
 *
 *   bytes 0..7  → 8-byte header (an "encrypted magic" + size)
 *   bytes 8..   → real TTF / OTF data XOR'd with a constant key
 *
 * The obfuscation is purely cosmetic — there's no key derivation
 * involved — so this works on any retail dump without prod.keys.
 *
 * There are **three known variants** with different fixed keys. The
 * disk-encoded first u32 (read little-endian) is itself the variant
 * tag — call it the "scrambled magic":
 *
 *   | Tag        | Body XOR key (LE u32) | Where it's used                |
 *   |------------|-----------------------|--------------------------------|
 *   | 0x1E1AF836 | 0x06186249            | System fonts (firmware NCAs)   |
 *   | 0x1A879BD9 | 0xA6018502            | Mario Wonder, recent titles    |
 *   | 0xC1DE68F3 | 0x8CF1C8D9            | Third-party / older variant    |
 *
 * The body XOR is done on **big-endian** u32 reads — the disk u32
 * is treated as BE, XOR'd, and written back as BE. (The "scrambled
 * magic" itself is the LE read of the same first 4 bytes, which is
 * why the three tag values look unrelated to the body keys.)
 *
 * Reference: Switch-Toolbox's `BFTTF.cs` (MIT) — see
 * https://github.com/KillzXGaming/Switch-Toolbox. The exact decode
 * shown there is mirrored here in TS. Verified end-to-end against
 * `nintendo_ext_003.bfttf` (firmware) + Wonder's
 * `nintendoP_RodinNTLG-B_003.bfotf` (tag 0x1A879BD9): both decrypt
 * to valid sfnt fonts with a complete table directory.
 */

const HEADER_SIZE = 0x08;

/** Body XOR key for the system-font (firmware) variant. */
export const OBFUSCATION_KEY = 0x06186249;

/** Fixed magic stored at the start of every system-font BFTTF, after XOR. */
export const BFTTF_MAGIC = 0x18029a7f;

/**
 * Per-variant lookup: the first-u32-LE "scrambled magic" maps to
 * a body XOR key. Tagged so the parser knows which key to use
 * without re-deriving it from the magic.
 */
const BFTTF_VARIANTS: Record<number, number> = {
	0x1e1af836: 0x06186249, // System fonts (FW NCAs)
	0x1a879bd9: 0xa6018502, // Mario Wonder & recent titles
	0xc1de68f3: 0x8cf1c8d9, // Third-party / older variant
};

export interface ParsedBfttf {
	/** The full deobfuscated font as a `Blob` ready for `FontFace` / download. */
	font: Blob;
	/** TTF, OTF, or TTC, sniffed from the deobfuscated sfnt magic. */
	format: 'ttf' | 'otf' | 'ttc' | 'unknown';
	/** Number of bytes of the *output* font (= input size − 8). */
	size: number;
	/**
	 * Whether the reported size in the BFTTF header matches the
	 * actual file length. Always true for well-formed files.
	 */
	headerSizeOk: boolean;
}

/**
 * Test whether a `Blob` looks like a BFTTF / BFOTF file by checking
 * that the first 4 bytes (read LE u32) match one of the known
 * "scrambled magic" tag values. Cheap (4 bytes read).
 */
export async function isBfttf(blob: Blob): Promise<boolean> {
	if (blob.size < HEADER_SIZE) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const tag = view.getUint32(0, true);
	return tag in BFTTF_VARIANTS;
}

/**
 * Deobfuscate a BFTTF / BFOTF blob into a real TTF / OTF. Auto-
 * detects which of the three known XOR-key variants the file uses
 * from its 4-byte scrambled-magic tag.
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
	const key = BFTTF_VARIANTS[tag];
	if (key === undefined) {
		throw new Error(
			`Not a recognised BFTTF / BFOTF (first u32 LE = 0x${tag.toString(16)}; expected one of: ${Object.keys(BFTTF_VARIANTS)
				.map((k) => '0x' + Number(k).toString(16))
				.join(', ')})`,
		);
	}
	// The size at offset 4 is the original byte count, XOR'd with the
	// body key. Per Switch-Toolbox's reference decoder, the u32 read
	// is *big-endian* (despite the magic being a plain LE tag — yes,
	// the format is internally inconsistent). The XOR-decoded size
	// should equal `blob.size` exactly for well-formed files.
	const reportedSize = (view.getUint32(4, false) ^ key) >>> 0;

	// Deobfuscate the body. We treat each 4-byte chunk as a BE u32,
	// XOR with the body key, and write it back as BE.
	const payloadLen = all.length - HEADER_SIZE;
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
		headerSizeOk: reportedSize === blob.size,
	};
}

/**
 * XOR each 4-byte LE word of `bytes` with {@link OBFUSCATION_KEY}.
 * The buffer length is rounded down to the nearest 4 bytes — any
 * trailing bytes (which don't occur in correctly-formed BFTTFs) are
 * left untouched.
 */
function xorInPlace(bytes: Uint8Array): void {
	const aligned = bytes.length - (bytes.length % 4);
	// Use Uint32Array if the underlying buffer is 4-byte aligned. We
	// allocated a fresh `Uint8Array(payloadLen)` above so its
	// `byteOffset` is 0 and ArrayBuffer is fresh — the alignment
	// check is just defensive.
	if ((bytes.byteOffset & 3) === 0) {
		const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, aligned >>> 2);
		for (let i = 0; i < u32.length; i++) {
			u32[i] = (u32[i] ^ OBFUSCATION_KEY) >>> 0;
		}
	} else {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let off = 0; off < aligned; off += 4) {
			const w = view.getUint32(off, true);
			view.setUint32(off, (w ^ OBFUSCATION_KEY) >>> 0, true);
		}
	}
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

/**
 * Sniff `'ttf' | 'otf' | 'ttc' | 'unknown'` from the first 4 bytes
 * of an sfnt-format font payload.
 */
function sniffSfntFormat(bytes: Uint8Array): 'ttf' | 'otf' | 'ttc' | 'unknown' {
	if (bytes.length < 4) return 'unknown';
	const tag =
		(bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
	if (tag === 0x00010000) return 'ttf';
	if (tag === 0x4f54544f /* "OTTO" */) return 'otf';
	if (tag === 0x74727565 /* "true" */) return 'ttf';
	if (tag === 0x74797031 /* "typ1" */) return 'ttf';
	if (tag === 0x74746366 /* "ttcf" */) return 'ttc';
	return 'unknown';
}
