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
 *
 * **Version 5.** The format version is `(seed >> 14) & 0xF`: 4 for
 * almost every file, 5 for Pokkén DX's `font.drp` and system images.
 * Version 5 files insert a 0x20-byte stub after the header (a PNG
 * signature, a key word, a size and the stub's own seed slot), so
 * entries start at 0x80, and they add two layers:
 *
 * - Only the first 0x80 bytes take the xorshift stream. The rest is
 *   XORed with xoroshiro128+ (rotations 55 / 14 / 36), seeded through
 *   splitmix64 from the 64-bit key `BE32(0x60) << 32 | sext(BE32(0x68))`.
 *   Each 64-bit output covers two BE words: high half, then low half.
 * - Parts are deflated by a modified zlib that adjusts each *literal*:
 *   `out = lit - table[key]; key = (key + 1) & 0xFF`, with `key`
 *   starting at the decompressed size mod 255 (see `inflate.ts`). The
 *   256-byte table is game data, so it isn't shipped here: callers read
 *   it from the title's executable with {@link findLiteralTable}.
 *
 * Version 5 was reverse-engineered from Pokkén DX's `main` (the DRP
 * decryptor, and the `z_stream` extension its loader fills in), and
 * verified by every part's zlib Adler-32.
 */
import { Inflate, inflateSync } from 'fflate';
import { adler32, inflateLiterals } from './inflate.js';

export { adler32, inflateLiterals, type LiteralTransform } from './inflate.js';

/** Size of the file header and of each entry header. */
export const DRP_HEADER_SIZE = 0x60;

/** The DRP format version, from the seed (4, or 5 for the two-layer files). */
export function drpVersion(data: Uint8Array): number {
	if (data.byteLength < 0x20) return 0;
	return (new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0x1c, false) >>> 14) & 0xf;
}

/** Where the entries start: after the header, and the stub in version 5. */
function entriesStart(version: number): number {
	return version === 5 || version === 6 ? 0x80 : DRP_HEADER_SIZE;
}

/**
 * Decrypt a DRP file's bytes. Returns a new buffer. For version 4 the
 * same pass encrypts.
 */
export function decryptDrp(data: Uint8Array): Uint8Array {
	if (data.byteLength < 0x20) throw new Error('DRP: file too small');
	const src = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const seed = src.getInt32(0x1c, false);
	const version = (seed >>> 14) & 0xf;
	const layered = version === 5 || version === 6;
	let s0 = (Math.imul(seed, 0x41c64e6d) + 0x3039) | 0;
	let s1 = (Math.imul(s0, 0x41c64e6d) + 0x3039) | 0;
	let s2 = (Math.imul(s1, 0x41c64e6d) + 0x3039) | 0;
	let s3 = (Math.imul(s2, 0x41c64e6d) + 0x3039) | 0;
	const out = new Uint8Array(data.byteLength);
	const dst = new DataView(out.buffer);
	const words = data.byteLength >>> 2;
	const xorWords = layered ? Math.min(words, 32) : words;
	let carry = 0;
	for (let w = 0; w < xorWords; w++) {
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
	if (layered && data.byteLength >= 132) xoroshiroLayer(data, out, words, out);
	// Trailing bytes past the last whole word (never seen in real files).
	out.set(data.subarray(words * 4), words * 4);
	return out;
}

/**
 * Encrypt a plaintext DRP (the inverse of {@link decryptDrp}). Version 4
 * is symmetric; version 5's second layer is keyed from the plaintext
 * stub, so it has to run first.
 */
export function encryptDrp(plain: Uint8Array): Uint8Array {
	const version = drpVersion(plain);
	if (version !== 5 && version !== 6) return decryptDrp(plain);
	const words = plain.byteLength >>> 2;
	const mid = plain.slice();
	if (plain.byteLength >= 132) xoroshiroLayer(plain, mid, words, plain);
	// The xorshift layer only touches the first 0x80 bytes in version 5.
	const head = decryptDrp(mid.slice(0, 0x80));
	mid.set(head, 0);
	return mid;
}

const M64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

function splitmix64(x: bigint): bigint {
	let z = (x + GOLDEN) & M64;
	z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
	z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
	return z ^ (z >> 31n);
}

/**
 * Version 5's second layer: xoroshiro128+ over everything after 0x80,
 * keyed from the plaintext stub in `keySource`.
 */
function xoroshiroLayer(src: Uint8Array, out: Uint8Array, words: number, keySource: Uint8Array): void {
	const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
	const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
	const kv = new DataView(keySource.buffer, keySource.byteOffset, keySource.byteLength);
	const key = ((BigInt(kv.getUint32(0x60, false)) << 32n) | BigInt.asUintN(64, BigInt(kv.getInt32(0x68, false)))) & M64;
	// Run the generator on 32-bit halves: BigInt per word would be slow.
	let a = splitmix64(key);
	let b = splitmix64((key + GOLDEN) & M64);
	let s0h = Number(a >> 32n) >>> 0, s0l = Number(a & 0xffffffffn) >>> 0;
	let s1h = Number(b >> 32n) >>> 0, s1l = Number(b & 0xffffffffn) >>> 0;
	let hi = 0;
	let lo = 0;
	for (let w = 32, i = 0; w < words; w++, i++) {
		if ((i & 1) === 0) {
			// result = s0 + s1
			lo = (s0l + s1l) >>> 0;
			hi = (s0h + s1h + (lo < s0l ? 1 : 0)) >>> 0;
			// t = s1 ^ s0
			const th = (s1h ^ s0h) >>> 0, tl = (s1l ^ s0l) >>> 0;
			// s0 = rotl(s0, 55) ^ t ^ (t << 14)
			const rh = ((s0h >>> 9) | (s0l << 23)) >>> 0, rl = ((s0l >>> 9) | (s0h << 23)) >>> 0;
			const shh = ((th << 14) | (tl >>> 18)) >>> 0, shl = (tl << 14) >>> 0;
			s0h = (rh ^ th ^ shh) >>> 0;
			s0l = (rl ^ tl ^ shl) >>> 0;
			// s1 = rotl(t, 36) = rotr(t, 28)
			s1h = ((tl << 4) | (th >>> 28)) >>> 0;
			s1l = ((th << 4) | (tl >>> 28)) >>> 0;
		}
		const half = (i & 1) === 0 ? hi : lo;
		dv.setUint32(w * 4, (sv.getUint32(w * 4, false) ^ half) >>> 0, false);
	}
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
	/**
	 * Version 5: inflating needs the literal table (see
	 * {@link findLiteralTable}); `readDrpPart` throws without one.
	 */
	literal?: boolean;
}

/** Options for reading version 5 parts. */
export interface DrpReadOptions {
	/** The title's 256-byte literal table, from {@link findLiteralTable}. */
	literalTable?: Uint8Array | null;
}

/** Thrown when a version 5 part is read without the literal table. */
export class DrpLiteralTableError extends Error {
	constructor() {
		super("This DRP uses the version 5 layout, whose compression needs a table from the game's executable (exefs main), which wasn't found.");
		this.name = 'DrpLiteralTableError';
	}
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
	/** Format version (see the module comment). */
	version: number;
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
	return count > 0 && entriesStart(drpVersion(decrypted)) + count * DRP_HEADER_SIZE <= decrypted.byteLength;
}

/** Parse a decrypted DRP file's entry table. */
export function parseDrp(decrypted: Uint8Array): DrpArchive {
	if (!isDrp(decrypted)) throw new Error('DRP: bad header (wrong file, or not decrypted)');
	const dv = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
	const count = dv.getInt16(0x16, false);
	const entries: DrpEntry[] = [];
	const version = drpVersion(decrypted);
	let o = entriesStart(version);
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
			const part: DrpPart = { offset: q + 4, length, zlib, size: zlib || word <= length ? word : length };
			if (zlib && (version === 5 || version === 6)) part.literal = true;
			parts.push(part);
			q += partSize;
		}
		entries.push({ name, typeA, typeB, compressed, parts });
		if (entrySize <= 0) break;
		o += entrySize;
	}
	return { crc: dv.getUint32(0, false), seed: dv.getUint32(0x1c, false), version, entries };
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
	options: { unwrapNested?: boolean } & DrpReadOptions = {},
): Uint8Array {
	const raw = decrypted.subarray(part.offset, part.offset + part.length);
	let out: Uint8Array;
	if (part.literal) {
		if (!options.literalTable) throw new DrpLiteralTableError();
		if (!isZlibHeader(raw)) throw new Error(`DRP: entry "${entry.name}" isn't zlib`);
		return inflateLiterals(raw.subarray(2), part.size, { table: options.literalTable, key: part.size % 255 }, { verify: true });
	}
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
export function peekDrpPart(decrypted: Uint8Array, entry: DrpEntry, part: DrpPart, n = 16, options: DrpReadOptions = {}): Uint8Array {
	const raw = decrypted.subarray(part.offset, part.offset + part.length);
	let head: Uint8Array;
	if (part.literal) {
		if (!options.literalTable || !isZlibHeader(raw)) return new Uint8Array(0);
		try {
			return inflateLiterals(raw.subarray(2), Math.min(n, part.size), { table: options.literalTable, key: part.size % 255 });
		} catch {
			return new Uint8Array(0);
		}
	}
	if (!part.zlib) return raw.subarray(0, n);
	if (!isZlibHeader(raw)) return new Uint8Array(0);
	head = inflateHead(raw.subarray(2), Math.max(n, 1024));
	if (isZlibHeader(head)) {
		const inner = inflateHead(head.subarray(2), n);
		if (inner.byteLength > 0) return inner;
	}
	return head.subarray(0, n);
}

/**
 * Find the version 5 literal table in a title's executable.
 *
 * `image` is the `main` module flattened to its load layout (text at 0,
 * then rodata and data at their memory offsets, relocations applied or
 * not: the pointer's addend is also stored in place). The modified
 * inflater emits a literal as
 *
 *     ldr   xT, [xP, #off]        ; xP from an adrp: the table pointer
 *     ldrb  wK, [xS, #0x70]       ; z_stream key byte
 *     ...
 *     ldrb  wV, [xT, xK]          ; table[key]
 *
 * so this scans for `ldrb w, [x, #0x70]` followed within a few
 * instructions by a register-offset `ldrb` whose base was loaded from an
 * adrp page, and returns the 256 bytes the pointer refers to.
 */
export function findLiteralTable(image: Uint8Array): Uint8Array | null {
	const words = image.byteLength >>> 2;
	const dv = new DataView(image.buffer, image.byteOffset, words * 4);
	const at = (i: number) => dv.getUint32(i * 4, true);
	for (let i = 4; i < words - 4; i++) {
		const x = at(i);
		// LDRB Wt, [Xn, #0x70] (unsigned offset).
		if (((x & 0xffc00000) >>> 0) !== 0x39400000 || ((x >>> 10) & 0xfff) !== 0x70) continue;
		const keyReg = x & 31;
		for (let j = i + 1; j <= i + 3; j++) {
			const y = at(j);
			// LDRB Wt, [Xn, Xm] (register offset, LSL #0 / UXTX).
			if (((y & 0xffe0fc00) >>> 0) !== 0x38606800 || ((y >>> 16) & 31) !== keyReg) continue;
			const base = (y >>> 5) & 31;
			// Find `ldr xBase, [xBase, #off]` and its adrp just before.
			for (let k = i - 1; k >= i - 6; k--) {
				const l = at(k);
				if (((l & 0xffc00000) >>> 0) !== 0xf9400000 || (l & 31) !== base || ((l >>> 5) & 31) !== base) continue;
				const off = ((l >>> 10) & 0xfff) * 8;
				for (let a = k - 1; a >= k - 6; a--) {
					const p = at(a);
					if (((p & 0x9f000000) >>> 0) !== 0x90000000 || (p & 31) !== base) continue;
					let imm = (((p >>> 5) & 0x7ffff) << 2) | ((p >>> 29) & 3);
					if (imm & 0x100000) imm -= 0x200000;
					const slot = (a * 4 - ((a * 4) % 4096)) + imm * 4096 + off;
					if (slot < 0 || slot + 8 > image.byteLength) continue;
					const ptr = Number(new DataView(image.buffer, image.byteOffset).getBigUint64(slot, true));
					if (ptr <= 0 || ptr + 256 > image.byteLength) continue;
					const table = image.slice(ptr, ptr + 256);
					// Sanity: the table isn't all zero.
					if (table.some((b) => b !== 0)) return table;
				}
			}
		}
	}
	return null;
}
