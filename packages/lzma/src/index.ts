/**
 * LZMA (LZMA1) decoder — a direct port of the reference decoder in
 * Igor Pavlov's public-domain LZMA SDK (`LzmaSpec.cpp`).
 *
 * Used for Unity asset bundles whose blocks are LZMA-compressed: each
 * block is a 5-byte properties header (`lc/lp/pb` byte + u32 dictionary
 * size) followed by the raw stream, with the uncompressed size known
 * from the bundle's block table. {@link decodeLzmaAlone} handles the
 * classic `.lzma` container (properties + u64 size + stream).
 */

const NUM_STATES = 12;
const LEN_LOW_BITS = 3;
const LEN_MID_BITS = 3;
const LEN_HIGH_BITS = 8;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >>> 1);
const NUM_ALIGN_BITS = 4;
const PROB_INIT = 1024;

class RangeDecoder {
	private range = 0xffffffff;
	private code = 0;
	pos: number;
	constructor(
		private readonly buf: Uint8Array,
		start: number,
	) {
		this.pos = start;
		if (buf[this.pos++] !== 0) throw new Error('LZMA: corrupt stream (bad range coder init)');
		for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.next()) >>> 0;
		if (this.code === this.range) throw new Error('LZMA: corrupt stream');
	}

	private next(): number {
		// Reading past the end yields zeros; well-formed streams never need it.
		return this.pos < this.buf.length ? this.buf[this.pos++]! : (this.pos++, 0);
	}

	private normalize(): void {
		if (this.range < 0x1000000) {
			this.range = (this.range << 8) >>> 0;
			this.code = ((this.code << 8) | this.next()) >>> 0;
		}
	}

	bit(probs: Uint16Array, i: number): number {
		const p = probs[i]!;
		const bound = (this.range >>> 11) * p;
		let b: number;
		if (this.code < bound) {
			this.range = bound >>> 0;
			probs[i] = p + ((2048 - p) >>> 5);
			b = 0;
		} else {
			this.range = (this.range - bound) >>> 0;
			this.code = (this.code - bound) >>> 0;
			probs[i] = p - (p >>> 5);
			b = 1;
		}
		this.normalize();
		return b;
	}

	direct(numBits: number): number {
		let res = 0;
		for (; numBits > 0; numBits--) {
			this.range >>>= 1;
			let b = 0;
			if (this.code >= this.range) {
				this.code = (this.code - this.range) >>> 0;
				b = 1;
			}
			res = ((res << 1) | b) >>> 0;
			this.normalize();
		}
		return res;
	}

	tree(probs: Uint16Array, offset: number, numBits: number): number {
		let m = 1;
		for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(probs, offset + m);
		return m - (1 << numBits);
	}

	reverseTree(probs: Uint16Array, offset: number, numBits: number): number {
		let m = 1;
		let sym = 0;
		for (let i = 0; i < numBits; i++) {
			const b = this.bit(probs, offset + m);
			m = (m << 1) + b;
			sym |= b << i;
		}
		return sym;
	}
}

class LenDecoder {
	private readonly choice = new Uint16Array(2).fill(PROB_INIT);
	private readonly low = new Uint16Array(16 << LEN_LOW_BITS).fill(PROB_INIT);
	private readonly mid = new Uint16Array(16 << LEN_MID_BITS).fill(PROB_INIT);
	private readonly high = new Uint16Array(1 << LEN_HIGH_BITS).fill(PROB_INIT);

	decode(rc: RangeDecoder, posState: number): number {
		if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << LEN_LOW_BITS, LEN_LOW_BITS);
		if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << LEN_MID_BITS, LEN_MID_BITS);
		return 16 + rc.tree(this.high, 0, LEN_HIGH_BITS);
	}
}

export interface LzmaProperties {
	lc: number;
	lp: number;
	pb: number;
	dictSize: number;
}

/** Parse the 5-byte LZMA properties header. */
export function parseLzmaProperties(bytes: Uint8Array, offset = 0): LzmaProperties {
	if (bytes.length < offset + 5) throw new Error('LZMA: truncated properties');
	let d = bytes[offset]!;
	if (d >= 9 * 5 * 5) throw new Error('LZMA: bad properties byte');
	const lc = d % 9;
	d = (d / 9) | 0;
	const lp = d % 5;
	const pb = (d / 5) | 0;
	const dictSize =
		(bytes[offset + 1]! | (bytes[offset + 2]! << 8) | (bytes[offset + 3]! << 16) | (bytes[offset + 4]! << 24)) >>> 0;
	return { lc, lp, pb, dictSize };
}

/**
 * Decode a raw LZMA stream whose 5-byte properties header starts at
 * `offset`, producing `outSize` bytes — or fewer when the stream ends
 * with an end marker first.
 */
export function decodeLzma(input: Uint8Array, outSize: number, offset = 0): Uint8Array {
	const { lc, lp, pb } = parseLzmaProperties(input, offset);
	const out = new Uint8Array(outSize);
	if (outSize === 0) return out;
	const rc = new RangeDecoder(input, offset + 5);

	const literals = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
	const posSlot = new Uint16Array(4 << 6).fill(PROB_INIT);
	const posDecoders = new Uint16Array(1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX).fill(PROB_INIT);
	const align = new Uint16Array(1 << NUM_ALIGN_BITS).fill(PROB_INIT);
	const isMatch = new Uint16Array(NUM_STATES << 4).fill(PROB_INIT);
	const isRep = new Uint16Array(NUM_STATES).fill(PROB_INIT);
	const isRepG0 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
	const isRepG1 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
	const isRepG2 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
	const isRep0Long = new Uint16Array(NUM_STATES << 4).fill(PROB_INIT);
	const lenDecoder = new LenDecoder();
	const repLenDecoder = new LenDecoder();

	const pbMask = (1 << pb) - 1;
	const lpMask = (1 << lp) - 1;
	let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
	let state = 0;
	let pos = 0;

	while (pos < outSize) {
		const posState = pos & pbMask;
		if (rc.bit(isMatch, (state << 4) + posState) === 0) {
			// Literal.
			const prev = pos > 0 ? out[pos - 1]! : 0;
			const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
			let sym = 1;
			if (state >= 7) {
				let matchByte = out[pos - rep0 - 1]!;
				do {
					const matchBit = (matchByte >>> 7) & 1;
					matchByte <<= 1;
					const b = rc.bit(literals, base + ((1 + matchBit) << 8) + sym);
					sym = (sym << 1) | b;
					if (matchBit !== b) break;
				} while (sym < 0x100);
			}
			while (sym < 0x100) sym = (sym << 1) | rc.bit(literals, base + sym);
			out[pos++] = sym & 0xff;
			state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
			continue;
		}

		let len: number;
		if (rc.bit(isRep, state) !== 0) {
			if (pos === 0) throw new Error('LZMA: corrupt stream (rep match at start)');
			if (rc.bit(isRepG0, state) === 0) {
				if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
					// Short rep: one byte from rep0.
					state = state < 7 ? 9 : 11;
					out[pos] = out[pos - rep0 - 1]!;
					pos++;
					continue;
				}
			} else {
				let dist: number;
				if (rc.bit(isRepG1, state) === 0) {
					dist = rep1;
				} else {
					if (rc.bit(isRepG2, state) === 0) {
						dist = rep2;
					} else {
						dist = rep3;
						rep3 = rep2;
					}
					rep2 = rep1;
				}
				rep1 = rep0;
				rep0 = dist;
			}
			len = repLenDecoder.decode(rc, posState);
			state = state < 7 ? 8 : 11;
		} else {
			rep3 = rep2;
			rep2 = rep1;
			rep1 = rep0;
			len = lenDecoder.decode(rc, posState);
			state = state < 7 ? 7 : 10;
			// Distance.
			const lenState = len < 3 ? len : 3;
			const slot = rc.tree(posSlot, lenState << 6, 6);
			let dist: number;
			if (slot < 4) {
				dist = slot;
			} else {
				const numDirect = (slot >>> 1) - 1;
				dist = ((2 | (slot & 1)) << numDirect) >>> 0;
				if (slot < END_POS_MODEL_INDEX) {
					dist += rc.reverseTree(posDecoders, dist - slot, numDirect);
				} else {
					dist += rc.direct(numDirect - NUM_ALIGN_BITS) * (1 << NUM_ALIGN_BITS);
					dist += rc.reverseTree(align, 0, NUM_ALIGN_BITS);
				}
				dist >>>= 0;
			}
			if (dist === 0xffffffff) return out.subarray(0, pos); // end marker
			rep0 = dist;
			if (rep0 >= pos) throw new Error('LZMA: corrupt stream (distance beyond output)');
		}
		len += 2;
		const from = pos - rep0 - 1;
		const n = Math.min(len, outSize - pos);
		for (let i = 0; i < n; i++) out[pos + i] = out[from + i]!;
		pos += n;
	}
	return out;
}

/**
 * Decode a classic `.lzma` ("LZMA alone") file: properties, a u64
 * uncompressed size (all 0xFF = unknown, requires an end marker and
 * `maxSize`), then the stream.
 */
export function decodeLzmaAlone(input: Uint8Array, maxSize?: number): Uint8Array {
	if (input.length < 13) throw new Error('LZMA: truncated header');
	const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const lo = dv.getUint32(5, true);
	const hi = dv.getUint32(9, true);
	const unknown = lo === 0xffffffff && hi === 0xffffffff;
	const size = unknown ? (maxSize ?? 0) : hi * 2 ** 32 + lo;
	if (unknown && !maxSize) throw new Error('LZMA: unknown size requires maxSize');
	// Shift so the properties sit right before the stream.
	const stream = new Uint8Array(input.length - 8);
	stream.set(input.subarray(0, 5), 0);
	stream.set(input.subarray(13), 5);
	return decodeLzma(stream, size);
}
