/**
 * Big-endian bit-level reader over a fixed-size byte block. HCA's
 * inner per-block bitstream is BE — every `decode1`..`decode5` step
 * reads a handful of N-bit fields out of the 0x100-ish-byte payload
 * (block size minus the 2-byte CRC).
 *
 * Two operations:
 *   - {@link checkBit}: peek N bits (1..16) at the current cursor.
 *   - {@link getBit}:   peek + advance.
 *   - {@link addBit}:   advance only (used to skip rare cases where
 *                       a smaller table read replaces a larger one).
 *
 * The 3-byte window in `checkBit` is enough for any 16-bit read; HCA
 * never needs more than that in a single call.
 *
 * Ported from kohos/CriTools/src/hca.js (MIT) — same algorithm,
 * rewritten as a TypeScript class operating on `Uint8Array` rather
 * than Node `Buffer`.
 */

const MASK = [
	0xffffff, 0x7fffff, 0x3fffff, 0x1fffff, 0x0fffff, 0x07ffff, 0x03ffff, 0x01ffff,
];

export class BitReader {
	private readonly data: Uint8Array;
	private readonly size: number;
	bit: number;

	constructor(buffer: Uint8Array) {
		this.data = buffer;
		// `size` is the addressable bit count; the trailing 2 bytes
		// (CRC) are intentionally excluded — they're not part of the
		// bitstream.
		this.size = buffer.length * 8 - 16;
		this.bit = 0;
	}

	checkBit(bitSize: number): number {
		let v = 0;
		if (this.bit + bitSize <= this.size) {
			const pos = this.bit >>> 3;
			v = this.data[pos]!;
			v = (v << 8) | this.data[pos + 1]!;
			v = (v << 8) | this.data[pos + 2]!;
			v &= MASK[this.bit & 7]!;
			v >>>= 24 - (this.bit & 7) - bitSize;
		}
		return v;
	}

	getBit(bitSize: number): number {
		const v = this.checkBit(bitSize);
		this.bit += bitSize;
		return v;
	}

	addBit(bitSize: number): void {
		this.bit += bitSize;
	}
}
