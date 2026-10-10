/**
 * Sony's LZRC (LZ + range coder) decompressor, used for the disc
 * blocks of official PlayStation (PS1 Classics) EBOOTs.
 *
 * A line-by-line port of psxtract's `lz.cpp` (Hykem). Probabilities
 * live in a 0xA70-byte table; the reference passes pointers into it,
 * here they are offsets. All arithmetic is unsigned 32-bit, and
 * probabilities wrap as bytes.
 */

class RangeDecoder {
	range = 0xffffffff;
	code: number;
	pos = 0;
	constructor(
		readonly src: Uint8Array,
		readonly tmp: Uint8Array,
	) {
		this.code = ((src[1] << 24) | (src[2] << 16) | (src[3] << 8) | src[4]) >>> 0;
	}

	private normalize(): void {
		if (this.range >>> 24 === 0) {
			this.range = (this.range << 8) >>> 0;
			this.code = ((this.code << 8) + (this.src[this.pos + 5] ?? 0)) >>> 0;
			this.pos++;
		}
	}

	/** Decode one bit with the probability at `tmp[p]`. */
	bit(p: number): number {
		this.normalize();
		const c = this.tmp[p];
		const val = ((this.range >>> 8) * c) >>> 0;
		this.tmp[p] = (c - (c >> 3)) & 0xff;
		if (this.code < val) {
			this.range = val;
			this.tmp[p] = (this.tmp[p] + 31) & 0xff;
			return 1;
		}
		this.code = (this.code - val) >>> 0;
		this.range = (this.range - val) >>> 0;
		return 0;
	}

	/** Like `bit`, also shifting the bit into `acc` (the reference's index pointer). */
	bitInto(p: number, acc: { v: number }): number {
		const b = this.bit(p);
		acc.v = (acc.v << 1) | b;
		return b;
	}

	/** Raw bits for long lengths / offsets. */
	direct(acc: { v: number }, count: number): void {
		this.normalize();
		for (; count >= 5; count--) {
			acc.v <<= 1;
			this.range >>>= 1;
			if (this.code < this.range) acc.v++;
			else this.code = (this.code - this.range) >>> 0;
		}
	}
}

function decodeNumber(rc: RangeDecoder, ptr: number, index: number): { value: number; flag: number } {
	const acc = { v: 1 };
	if (index >= 3) {
		rc.bitInto(ptr + 0x18, acc);
		if (index >= 4) {
			rc.bitInto(ptr + 0x18, acc);
			if (index >= 5) rc.direct(acc, index);
		}
	}
	const flag = rc.bitInto(ptr, acc);
	if (index >= 1) {
		rc.bitInto(ptr + 0x8, acc);
		if (index >= 2) rc.bitInto(ptr + 0x10, acc);
	}
	return { value: acc.v, flag };
}

function decodeWord(rc: RangeDecoder, ptr: number, index: number): { value: number; flag: number } {
	const acc = { v: 1 };
	index = Math.trunc(index / 8);
	if (index >= 3) {
		rc.bitInto(ptr, acc);
		if (index >= 4) {
			rc.bitInto(ptr, acc);
			if (index >= 5) rc.direct(acc, index);
		}
	}
	const flag = rc.bitInto(ptr + 3, acc);
	if (index >= 1) {
		rc.bitInto(ptr + 2, acc);
		if (index >= 2) rc.bitInto(ptr + 1, acc);
	}
	return { value: acc.v, flag };
}

/** Decompress one LZRC stream into exactly `size` bytes (throws on corrupt data). */
export function decompressLzrc(input: Uint8Array, size: number): Uint8Array {
	const out = new Uint8Array(size);
	const tmp = new Uint8Array(0xa70);
	tmp.fill(0x80, 0, 0xa60);
	const rc = new RangeDecoder(input, tmp);
	const head = input[0];
	let pos = 0;
	let offset = 0;
	let prev = 0;
	for (;;) {
		let sect1 = offset + 0x920;
		if (!rc.bit(sect1)) {
			// Literal byte.
			if (offset > 0) offset--;
			if (pos === size) return out;
			const sect = ((((((pos & 7) << 8) + prev) >> head) & 7) * 0xff) - 1;
			const acc = { v: 1 };
			do {
				rc.bitInto(sect + acc.v, acc);
			} while (acc.v >> 8 === 0);
			out[pos++] = acc.v & 0xff;
		} else {
			// Match: length bits, then offset bits.
			let index = -1;
			let flag: number;
			do {
				sect1 += 8;
				flag = rc.bit(sect1);
				index += flag;
			} while (flag !== 0 && index < 6);
			let blockSize = 0x40;
			let sect2 = index + 0x7f1;
			let length: number;
			if (index >= 0 || flag !== 0) {
				const sect = (index << 5) | (((pos << index) & 3) << 3) | (offset & 7);
				const n = decodeNumber(rc, 0x960 + sect, index);
				length = n.value;
				flag = n.flag;
				if (length !== 3 && (index > 0 || flag !== 0)) {
					sect2 += 0x38;
					blockSize = 0x80;
				}
			} else {
				length = 1;
			}
			let diff = 0;
			const shift = { v: 1 };
			do {
				diff = (shift.v << 4) - blockSize;
				flag = rc.bitInto(sect2 + (shift.v << 3), shift);
			} while (diff < 0);
			let distance: number;
			if (diff > 0 || flag !== 0) {
				if (flag === 0) diff -= 8;
				distance = decodeWord(rc, 0x8a8 + diff, diff).value;
			} else {
				distance = 1;
			}
			const start = pos - distance;
			const end = pos + length + 1;
			// The stream ends with a match past the output once it's full
			// (psxtract's reference returns -1 there with the block complete).
			if (pos === size) return out;
			if (start < 0 || end > size) throw new Error('LZRC: corrupt stream');
			offset = ((end + 1) & 1) + 6;
			for (let s = start; pos < end; ) out[pos++] = out[s++];
		}
		prev = out[pos - 1];
	}
}
