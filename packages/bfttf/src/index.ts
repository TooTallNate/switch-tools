/**
 * BFTTF / BFOTF deobfuscation.
 *
 * Nintendo ships system fonts inside SystemData NCAs (title IDs
 * `0x0100000000000810`..`0x0100000000000815`) as files with the
 * extension `.bfttf` (TrueType) or `.bfotf` (OpenType-CFF). The
 * format is a thin obfuscation wrapper around a real TTF / OTF:
 *
 *   bytes 0..7  → 8-byte header (magic + size, both XOR-obfuscated)
 *   bytes 8..   → real TTF / OTF data, with each 4-byte little-
 *                 endian word XOR'd by {@link OBFUSCATION_KEY}.
 *
 * The obfuscation is purely cosmetic — there's no key derivation
 * involved — so this works on any retail dump without prod.keys.
 *
 * Header layout:
 *
 *   bytes 0..3  = MAGIC       ^ KEY  read as LE u32  (MAGIC = 0x18029a7f)
 *   bytes 4..7  = payloadSize ^ KEY  read as BE u32  (= blob.size - 8)
 *
 *   …yes, the magic is little-endian and the size is big-endian. We
 *   inherited that from Nintendo. ¯\\_(ツ)_/¯
 *
 * Reference: empirically verified against retail Switch firmware
 * (Firmware 16.0.3, FontStandard NCA `9a5a25bc…`). The decoded
 * payload is a standard TTF whose `head`/`OS/2`/`cmap`/`glyf`/etc.
 * tables parse cleanly.
 */

const HEADER_SIZE = 0x08;
export const OBFUSCATION_KEY = 0x06186249;

/** Fixed magic stored at the start of every BFTTF, after XOR. */
export const BFTTF_MAGIC = 0x18029a7f;

export interface ParsedBfttf {
	/** The full deobfuscated font as a `Blob` ready for `FontFace` / download. */
	font: Blob;
	/** TTF or OTF, sniffed from the deobfuscated sfnt magic. */
	format: 'ttf' | 'otf' | 'unknown';
	/** Number of bytes of the *output* font (= input size − 8). */
	size: number;
	/**
	 * Whether the reported size in the BFTTF header matches the
	 * actual payload length. Always true for well-formed files.
	 */
	headerSizeOk: boolean;
}

/**
 * Test whether a `Blob` looks like a BFTTF file by checking that
 * the first u32 of the header un-XOR's to the well-known
 * `BFTTF_MAGIC = 0x18029a7f`. Cheap (8 bytes read).
 */
export async function isBfttf(blob: Blob): Promise<boolean> {
	if (blob.size < HEADER_SIZE) return false;
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const magic = (view.getUint32(0, true) ^ OBFUSCATION_KEY) >>> 0;
	return magic === BFTTF_MAGIC;
}

/**
 * Deobfuscate a BFTTF / BFOTF blob into a real TTF / OTF. The
 * output is wrapped in a `Blob` whose `type` is set to the
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
	// The size at offset 4 is the original byte count, byte-reversed,
	// then XOR'd with the key, then stored as a little-endian u32.
	// Equivalently: read the bytes in big-endian order, then XOR.
	// (Yes, this is bizarre — Nintendo's choice. The magic at offset 0
	// is plain LE.)
	const reportedSize = bswap32((view.getUint32(4, true) ^ OBFUSCATION_KEY) >>> 0);

	// Deobfuscate using a Uint32Array view for speed. We allocate a
	// fresh, naturally-aligned buffer.
	const payloadLen = all.length - HEADER_SIZE;
	const out = new Uint8Array(payloadLen);
	out.set(all.subarray(HEADER_SIZE));
	xorInPlace(out);

	const format = sniffSfntFormat(out);
	const mime =
		format === 'otf' ? 'font/otf' : format === 'ttf' ? 'font/ttf' : 'application/octet-stream';
	return {
		font: new Blob([out], { type: mime }),
		format,
		size: payloadLen,
		headerSizeOk: reportedSize === payloadLen,
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
 * Sniff `'ttf' | 'otf' | 'unknown'` from the first 4 bytes of an
 * sfnt-format font payload (TTF: 0x00010000 or "true" / "typ1";
 * OTF: "OTTO").
 */
function sniffSfntFormat(bytes: Uint8Array): 'ttf' | 'otf' | 'unknown' {
	if (bytes.length < 4) return 'unknown';
	const tag =
		(bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
	if (tag === 0x00010000) return 'ttf';
	if (tag === 0x4f54544f /* "OTTO" */) return 'otf';
	if (tag === 0x74727565 /* "true" */) return 'ttf';
	if (tag === 0x74797031 /* "typ1" */) return 'ttf';
	return 'unknown';
}
