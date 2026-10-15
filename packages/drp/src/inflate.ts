/**
 * A small RFC 1951 (raw DEFLATE) inflater with a hook on literal bytes.
 *
 * Version 5 DRPs (Pokkén Tournament DX's `font.drp` and system images)
 * are compressed with a modified zlib: every *literal* byte the inflater
 * emits is adjusted as
 *
 *     out = (literal - table[key]) & 0xFF;  key = (key + 1) & 0xFF
 *
 * while back-references copy already-adjusted output untouched. A stock
 * inflater can't reproduce that (it can't tell literals from copies), so
 * this one decodes the stream itself. Stored blocks are copied as-is,
 * as the modified zlib does (its stored-block path is a plain memcpy).
 *
 * Huffman decoding follows the canonical-code construction in RFC 1951
 * §3.2.2 (count / first-code / symbol tables, bit-at-a-time decode as in
 * zlib's `contrib/puff`).
 */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
	count: Uint16Array;
	symbol: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
	const count = new Uint16Array(16);
	for (let i = 0; i < n; i++) count[lengths[i]!]!++;
	count[0] = 0;
	const offs = new Uint16Array(16);
	for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + count[i - 1]!;
	const symbol = new Uint16Array(n);
	for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]!]!++] = i;
	return { count, symbol };
}

export interface LiteralTransform {
	table: Uint8Array;
	/** Initial key (the decompressed size mod 255 for Pokkén DX). */
	key: number;
	/** Key increment per literal (1). */
	step?: number;
}

export interface InflateLiteralsOptions {
	/**
	 * Check the zlib Adler-32 trailer that follows the DEFLATE stream
	 * (throws on mismatch). Only meaningful when inflating the whole part.
	 */
	verify?: boolean;
}

/**
 * Inflate a raw DEFLATE stream into (at most) `size` bytes, adjusting
 * literals with `transform`. Stops once `size` bytes are out, so a small
 * `size` peeks at the head. Throws on malformed input.
 */
export function inflateLiterals(
	input: Uint8Array,
	size: number,
	transform: LiteralTransform,
	options: InflateLiteralsOptions = {},
): Uint8Array {
	const out = new Uint8Array(size);
	const table = transform.table;
	let key = transform.key & 0xff;
	const step = transform.step ?? 1;
	let pos = 0; // input byte
	let bitBuf = 0;
	let bitCount = 0;
	let o = 0;

	const bits = (n: number): number => {
		while (bitCount < n) {
			if (pos >= input.byteLength) throw new Error('inflate: input ended early');
			bitBuf |= input[pos++]! << bitCount;
			bitCount += 8;
		}
		const v = bitBuf & ((1 << n) - 1);
		bitBuf >>>= n;
		bitCount -= n;
		return v;
	};
	const decode = (h: Huffman): number => {
		let code = 0;
		let first = 0;
		let index = 0;
		for (let len = 1; len < 16; len++) {
			code |= bits(1);
			const c = h.count[len]!;
			if (code - c < first) return h.symbol[index + (code - first)]!;
			index += c;
			first += c;
			first <<= 1;
			code <<= 1;
		}
		throw new Error('inflate: bad Huffman code');
	};

	let fixedLit: Huffman | null = null;
	let fixedDist: Huffman | null = null;
	let final = 0;
	while (!final && o < size) {
		final = bits(1);
		const type = bits(2);
		if (type === 0) {
			bitBuf = 0;
			bitCount = 0;
			if (pos + 4 > input.byteLength) throw new Error('inflate: truncated stored block');
			const len = input[pos]! | (input[pos + 1]! << 8);
			pos += 4;
			if (pos + len > input.byteLength) throw new Error('inflate: stored block out of range');
			const n = Math.min(len, size - o);
			out.set(input.subarray(pos, pos + n), o);
			pos += len;
			o += n;
			continue;
		}
		let lit: Huffman;
		let dist: Huffman;
		if (type === 1) {
			if (!fixedLit) {
				const l = new Uint8Array(288);
				l.fill(8, 0, 144);
				l.fill(9, 144, 256);
				l.fill(7, 256, 280);
				l.fill(8, 280, 288);
				fixedLit = buildHuffman(l, 288);
				fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30);
			}
			lit = fixedLit;
			dist = fixedDist!;
		} else if (type === 2) {
			const nlen = bits(5) + 257;
			const ndist = bits(5) + 1;
			const ncode = bits(4) + 4;
			const lengths = new Uint8Array(320);
			for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]!] = bits(3);
			const cl = buildHuffman(lengths, 19);
			lengths.fill(0);
			for (let i = 0; i < nlen + ndist; ) {
				const sym = decode(cl);
				if (sym < 16) lengths[i++] = sym;
				else {
					let len = 0;
					let rep: number;
					if (sym === 16) {
						if (i === 0) throw new Error('inflate: repeat with no previous length');
						len = lengths[i - 1]!;
						rep = 3 + bits(2);
					} else if (sym === 17) rep = 3 + bits(3);
					else rep = 11 + bits(7);
					if (i + rep > nlen + ndist) throw new Error('inflate: too many code lengths');
					while (rep--) lengths[i++] = len;
				}
			}
			lit = buildHuffman(lengths, nlen);
			dist = buildHuffman(lengths.subarray(nlen), ndist);
		} else {
			throw new Error('inflate: invalid block type');
		}
		for (;;) {
			const sym = decode(lit);
			if (sym < 256) {
				// Peeking: stop once the requested bytes are out. (When
				// verifying, decode to the end so the trailer is reached.)
				if (o >= size) {
					if (!options.verify) return out;
					throw new Error('inflate: output overflow');
				}
				out[o++] = (sym - table[key]!) & 0xff;
				key = (key + step) & 0xff;
			} else if (sym === 256) {
				break;
			} else {
				const li = sym - 257;
				if (li >= 29) throw new Error('inflate: bad length code');
				const len = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
				const di = decode(dist);
				if (di >= 30) throw new Error('inflate: bad distance code');
				const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
				if (d > o) throw new Error('inflate: distance before start');
				if (o + len > size && options.verify) throw new Error('inflate: output overflow');
				const n = Math.min(len, size - o);
				for (let k = 0; k < n; k++, o++) out[o] = out[o - d]!;
				if (o >= size && !options.verify) return out;
			}
		}
	}
	if (options.verify) {
		// The trailer starts at the next whole byte after the final block.
		if (pos + 4 > input.byteLength) throw new Error('inflate: missing Adler-32 trailer');
		const want = ((input[pos]! << 24) | (input[pos + 1]! << 16) | (input[pos + 2]! << 8) | input[pos + 3]!) >>> 0;
		if (adler32(out.subarray(0, o)) !== want) throw new Error('inflate: Adler-32 mismatch (wrong literal table?)');
	}
	return o === size ? out : out.subarray(0, o);
}

/** zlib's Adler-32 (to check a version 5 part against its stream trailer). */
export function adler32(data: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (let i = 0; i < data.byteLength; ) {
		const end = Math.min(data.byteLength, i + 3800);
		for (; i < end; i++) {
			a += data[i]!;
			b += a;
		}
		a %= 65521;
		b %= 65521;
	}
	return ((b << 16) | a) >>> 0;
}
