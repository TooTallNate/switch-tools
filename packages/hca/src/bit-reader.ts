/*
 * @tootallnate/hca — pure-TypeScript decoder for CRI Middleware's
 * High Compression Audio (HCA) codec.
 *
 * Ported from vgmstream's clHCA (ISC license, by nyaga / kode54 /
 * bnnm). See README + LICENSE.
 */

/**
 * Big-endian bit-level reader over a fixed-size byte block.
 *
 * Mirrors clHCA's `clData` / `bitreader_*` helpers. Unlike the older
 * kohos-style 3-byte window we used previously, this one peeks up to
 * 32 bits at a time which is what the CRIWARE bitstream format
 * occasionally needs (e.g. `bitreader_peek(br, 25..32)` during the
 * scalefactor and intensity unpack paths).
 */
export class BitReader {
	readonly data: Uint8Array;
	/** Addressable bit count (`buffer.length * 8`). */
	readonly size: number;
	/** Current cursor in bits. */
	bit: number;

	constructor(buffer: Uint8Array, byteSize: number = buffer.length) {
		this.data = buffer;
		this.size = byteSize * 8;
		this.bit = 0;
	}

	/** Peek `bits` bits at the current cursor without advancing. */
	peek(bits: number): number {
		const bitPos = this.bit;
		const bitRem = bitPos & 7;
		const bitSize = this.size;
		if (bits === 0) return 0;
		if (bitPos + bits > bitSize) return 0;

		const bitOffset = bits + bitRem;
		const bitsLeft = bitSize - bitPos;
		const data = this.data;
		const i = bitPos >>> 3;
		let v: number;
		let shift: number;
		let mask: number;
		if (bitsLeft >= 32 && bitOffset >= 25) {
			// 4-byte window (use unsigned 32-bit arithmetic throughout)
			v = data[i]!;
			v = (v << 8) | data[i + 1]!;
			v = (v << 8) | data[i + 2]!;
			v = ((v << 8) | data[i + 3]!) >>> 0;
			// >>> 0 with bitRem=0 yields the same value; with bitRem 1..7 it
			// chops off the top bits as required.
			v = (v & ((0xffffffff >>> bitRem) | 0)) >>> 0;
			shift = 32 - bitRem - bits;
			return v >>> shift;
		} else if (bitsLeft >= 24 && bitOffset >= 17) {
			// 3-byte window
			v = data[i]!;
			v = (v << 8) | data[i + 1]!;
			v = (v << 8) | data[i + 2]!;
			mask = 0xffffff >>> bitRem;
			v &= mask;
			shift = 24 - bitRem - bits;
			return v >>> shift;
		} else if (bitsLeft >= 16 && bitOffset >= 9) {
			// 2-byte window
			v = data[i]!;
			v = (v << 8) | data[i + 1]!;
			mask = 0xffff >>> bitRem;
			v &= mask;
			shift = 16 - bitRem - bits;
			return v >>> shift;
		} else {
			// 1-byte window
			v = data[i]!;
			mask = 0xff >>> bitRem;
			v &= mask;
			shift = 8 - bitRem - bits;
			return v >>> shift;
		}
	}

	/** Read `bits` bits and advance. */
	read(bits: number): number {
		const v = this.peek(bits);
		this.bit += bits;
		return v;
	}

	/** Advance by `bits` bits (may be negative to rewind). */
	skip(bits: number): void {
		this.bit += bits;
	}
}
