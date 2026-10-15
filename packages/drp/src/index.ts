/**
 * Bandai Namco `.drp` archives, as used by Pokkén Tournament (Wii U,
 * arcade) and Pokkén Tournament DX (Switch).
 *
 * **Encryption.** A DRP file is XORed, one big-endian u32 word at a
 * time, with an xorshift128 keystream. The seed is the BE s32 at 0x1C,
 * which is stored in the clear. An LCG (`x * 0x41C64E6D + 0x3039`, the
 * glibc `rand` constants) seeds the four xorshift words, and each word
 * of output is:
 *
 *     r     = xorshift() & 0x7FFFFFFF
 *     plain = cipher ^ r ^ carry
 *     carry = (r << 13) & 0x80000000
 *
 * XOR is its own inverse, so the same pass encrypts. All arithmetic is
 * signed 32-bit, with arithmetic right shifts.
 *
 * **Container, all big-endian.** A 0x60-byte file header: CRC (u32),
 * then at 0x14 an unknown s16 and the entry count (s16), and the seed
 * at 0x1C. Entries follow back to back from 0x60, each with a 0x60-byte
 * header:
 *
 *     +0x00  char[0x40]  name
 *     +0x40  s16, s16    file type A / B
 *     +0x44  s32         entry size (header + data): next entry offset
 *     +0x48  s16         1 = zlib parts, 0 = stored (but stage
 *                        models are zlib with 0: check each payload)
 *     +0x4A  s16         part count (up to 4)
 *     +0x50  s32[4]      part end offsets, relative to the end of
 *                        the entry header (running totals; unused
 *                        slots repeat the last). Each part is a BE u32
 *                        decompressed size, then the payload, padded
 *                        to 0x10.
 *
 * Sources: Sammi-Husky/Pokken-Tools (`DRPDecrypter`, `DRPExtractor`;
 * cipher reverse-engineered by Dantarion), the wood5578 fork's fixes
 * (compression flag, `EntrySize` walking), and Smash Forge `DRP.cs`.
 * Verified against Pokkén Tournament DX, where multi-part entries
 * (stage models, UI layouts) show the part sizes are running totals.
 * Header version 5 files (`NX/resource/*.drp`, the PNG system images)
 * carry a second, unknown layer over their payload and don't parse.
 */
import { Inflate, inflateSync } from 'fflate';

/** Size of the file header and of each entry header. */
export const DRP_HEADER_SIZE = 0x60;

/** Decrypt (or encrypt) a DRP file's bytes. Returns a new buffer. */
export function decryptDrp(data: Uint8Array): Uint8Array {
	if (data.byteLength < 0x20) throw new Error('DRP: file too small');
	const src = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const seed = src.getInt32(0x1c, false);
	let s0 = (Math.imul(seed, 0x41c64e6d) + 0x3039) | 0;
	let s1 = (Math.imul(s0, 0x41c64e6d) + 0x3039) | 0;
	let s2 = (Math.imul(s1, 0x41c64e6d) + 0x3039) | 0;
	let s3 = (Math.imul(s2, 0x41c64e6d) + 0x3039) | 0;
	const out = new Uint8Array(data.byteLength);
	const dst = new DataView(out.buffer);
	const words = data.byteLength >>> 2;
	let carry = 0;
	for (let w = 0; w < words; w++) {
		const t = s3 ^ (s3 << 11);
		const x = s0 ^ (s0 >> 19) ^ t ^ (t >> 8);
		s3 = s2;
		s2 = s1;
		s1 = s0;
		s0 = x;
		const r = x & 0x7fffffff;
		dst.setUint32(w * 4, (src.getUint32(w * 4, false) ^ r ^ carry) >>> 0, false);
		carry = (r << 13) & 0x80000000;
	}
	// The seed word isn't part of the keystream.
	out.set(data.subarray(0x1c, 0x20), 0x1c);
	// Trailing bytes past the last whole word (never seen in real files).
	out.set(data.subarray(words * 4), words * 4);
	return out;
}

export interface DrpPart {
	/** Absolute offset of the payload (after the size word) in the decrypted file. */
	offset: number;
	/** Payload length in the file. */
	length: number;
	/** True when the payload is a zlib stream (whatever the entry's flag says). */
	zlib: boolean;
	/** Size of the part's bytes: the size word (zlib parts, or stored ones where it fits), else `length`. */
	size: number;
}

export interface DrpEntry {
	name: string;
	typeA: number;
	typeB: number;
	/** The entry's compression flag (see {@link DrpPart.zlib}). */
	compressed: boolean;
	parts: DrpPart[];
}

export interface DrpArchive {
	crc: number;
	seed: number;
	entries: DrpEntry[];
}

/**
 * True if `decrypted` looks like a decrypted DRP: zero padding in the
 * header and a sane entry count. Used to tell DRPs from other `.drp`
 * files before trusting the parse.
 */
export function isDrp(decrypted: Uint8Array): boolean {
	if (decrypted.byteLength < DRP_HEADER_SIZE * 2) return false;
	for (let i = 4; i < 0x14; i++) if (decrypted[i] !== 0) return false;
	const dv = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
	const count = dv.getInt16(0x16, false);
	return count > 0 && count * DRP_HEADER_SIZE < decrypted.byteLength;
}

/** Parse a decrypted DRP file's entry table. */
export function parseDrp(decrypted: Uint8Array): DrpArchive {
	if (!isDrp(decrypted)) throw new Error('DRP: bad header (wrong file, or not decrypted)');
	const dv = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
	const count = dv.getInt16(0x16, false);
	const entries: DrpEntry[] = [];
	let o = DRP_HEADER_SIZE;
	for (let i = 0; i < count; i++) {
		if (o + DRP_HEADER_SIZE > decrypted.byteLength) throw new Error(`DRP: entry ${i} is out of bounds`);
		let end = o;
		while (end < o + 0x40 && decrypted[end] !== 0) end++;
		const name = new TextDecoder('latin1').decode(decrypted.subarray(o, end));
		const typeA = dv.getInt16(o + 0x40, false);
		const typeB = dv.getInt16(o + 0x42, false);
		const entrySize = dv.getInt32(o + 0x44, false);
		const compressed = dv.getInt16(o + 0x48, false) === 1;
		const partCount = Math.min(4, Math.max(0, dv.getInt16(o + 0x4a, false)));
		const parts: DrpPart[] = [];
		let q = o + DRP_HEADER_SIZE;
		let prevEnd = 0;
		for (let k = 0; k < partCount; k++) {
			// Running totals: part k spans [ends[k-1], ends[k]).
			const partEnd = dv.getInt32(o + 0x50 + k * 4, false);
			const partSize = partEnd - prevEnd;
			prevEnd = partEnd;
			if (partSize < 4 || q + partSize > decrypted.byteLength) {
				throw new Error(`DRP: entry "${name}" part ${k} is out of bounds`);
			}
			// The entry's compression flag isn't reliable (stage models are
			// zlib with flag 0), so trust the payload's own header.
			const zlib = compressed || isZlibHeader(decrypted.subarray(q + 4, q + 6));
			// Stored parts are padded to 0x10; their size word is the real
			// length when it fits (some hold other values there).
			const word = dv.getUint32(q, false);
			const length = partSize - 4;
			parts.push({ offset: q + 4, length, zlib, size: zlib || word <= length ? word : length });
			q += partSize;
		}
		entries.push({ name, typeA, typeB, compressed, parts });
		if (entrySize <= 0) break;
		o += entrySize;
	}
	return { crc: dv.getUint32(0, false), seed: dv.getUint32(0x1c, false), entries };
}

/** True for a plausible zlib header (deflate method, valid FCHECK, no dictionary). */
function isZlibHeader(b: Uint8Array): boolean {
	return b.byteLength >= 2 && (b[0]! & 0x0f) === 8 && (b[0]! >> 4) <= 7 && (b[1]! & 0x20) === 0 && ((b[0]! << 8) | b[1]!) % 31 === 0;
}

/**
 * The bytes of one part, inflated if the entry is compressed.
 *
 * Some parts (stage models, UI layouts) are zlib streams *inside* the
 * zlib part. With `unwrapNested` (the default) such a payload is
 * inflated once more; the inner size isn't recorded anywhere.
 */
export function readDrpPart(
	decrypted: Uint8Array,
	entry: DrpEntry,
	part: DrpPart,
	options: { unwrapNested?: boolean } = {},
): Uint8Array {
	const raw = decrypted.subarray(part.offset, part.offset + part.length);
	let out: Uint8Array;
	if (!part.zlib) {
		out = raw.subarray(0, part.size);
	} else {
		// zlib: skip the 2-byte header and raw-inflate, which stops at the
		// final block and so ignores the adler32 and the 0x10 padding.
		if (!isZlibHeader(raw)) throw new Error(`DRP: entry "${entry.name}" isn't zlib`);
		out = inflateSync(raw.subarray(2), { out: new Uint8Array(part.size) });
	}
	if (options.unwrapNested !== false && isZlibHeader(out)) {
		try {
			return inflateSync(out.subarray(2));
		} catch {
			// Not actually zlib; the payload just happens to start like it.
		}
	}
	return out;
}

/** Inflate just enough of a raw-deflate stream to get its first `n` bytes. */
function inflateHead(deflated: Uint8Array, n: number): Uint8Array {
	const chunks: Uint8Array[] = [];
	let have = 0;
	const inf = new Inflate((chunk) => {
		chunks.push(chunk);
		have += chunk.byteLength;
	});
	try {
		for (let o = 0; o < deflated.byteLength && have < n; o += 256) {
			inf.push(deflated.subarray(o, Math.min(deflated.byteLength, o + 256)), false);
		}
	} catch {
		// Truncated or padded input: keep what came out.
	}
	const out = new Uint8Array(Math.min(n, have));
	let o = 0;
	for (const c of chunks) {
		if (o >= out.byteLength) break;
		out.set(c.subarray(0, out.byteLength - o), o);
		o += c.byteLength;
	}
	return out;
}

/**
 * The first `n` bytes of a part (after nested-zlib unwrapping), without
 * inflating the whole thing. Used to identify parts by magic cheaply.
 */
export function peekDrpPart(decrypted: Uint8Array, entry: DrpEntry, part: DrpPart, n = 16): Uint8Array {
	const raw = decrypted.subarray(part.offset, part.offset + part.length);
	let head: Uint8Array;
	if (!part.zlib) return raw.subarray(0, n);
	if (!isZlibHeader(raw)) return new Uint8Array(0);
	head = inflateHead(raw.subarray(2), Math.max(n, 1024));
	if (isZlibHeader(head)) {
		const inner = inflateHead(head.subarray(2), n);
		if (inner.byteLength > 0) return inner;
	}
	return head.subarray(0, n);
}
