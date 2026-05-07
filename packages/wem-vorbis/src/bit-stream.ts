/**
 * Vorbis bitpacking primitives.
 *
 * Vorbis (and Wwise's variants) store multi-bit values **LSB-first**
 * within each byte: the first bit read becomes bit 0 of the value,
 * the second becomes bit 1, etc. Bytes are consumed in order. This
 * matches both libvorbis and ww2ogg's `Bit_stream` / `Bit_oggstream`.
 *
 * The reader and writer here mirror ww2ogg's API:
 *
 *   reader.readBit()         → boolean
 *   reader.readUint(n)       → number   (n ≤ 32)
 *   writer.writeBit(b)       → void
 *   writer.writeUint(v, n)   → void
 *
 * The writer is structured around a bag of accumulated bits that get
 * flushed to a `Uint8Array` payload buffer on byte boundaries. Ogg
 * pages always end on a byte boundary too, so we expose `flushByte()`
 * for the framing layer to call before serialising a page.
 */

export class BitReader {
	private bytes: Uint8Array;
	private byteOffset: number;
	private bitBuffer = 0;
	private bitsLeft = 0;
	private _totalBitsRead = 0;

	constructor(bytes: Uint8Array, byteOffset = 0) {
		this.bytes = bytes;
		this.byteOffset = byteOffset;
	}

	/** Total number of bits consumed since construction. */
	get totalBitsRead(): number {
		return this._totalBitsRead;
	}

	/** Read a single bit, LSB-first within each byte. */
	readBit(): 0 | 1 {
		if (this.bitsLeft === 0) {
			if (this.byteOffset >= this.bytes.length) {
				throw new Error('BitReader: out of bits');
			}
			this.bitBuffer = this.bytes[this.byteOffset++];
			this.bitsLeft = 8;
		}
		// First bit of a byte is the LSB. ww2ogg achieves this with
		// `(buf & (0x80 >> bits_left))` after decrementing bits_left,
		// which is equivalent to bit (7 - bits_left) where bits_left
		// counts down 7,6,5,4,3,2,1,0 — i.e. bit positions 0..7. So
		// the simpler formulation: just shift right by (8 - bitsLeft).
		const bit = (this.bitBuffer >> (8 - this.bitsLeft)) & 1;
		this.bitsLeft--;
		this._totalBitsRead++;
		return bit as 0 | 1;
	}

	/**
	 * Read an unsigned integer of `n` bits (1 ≤ n ≤ 32). The first
	 * bit read becomes bit 0 of the result (LSB).
	 */
	readUint(n: number): number {
		if (n < 0 || n > 32) throw new Error(`BitReader: bad bit count ${n}`);
		let v = 0;
		for (let i = 0; i < n; i++) {
			if (this.readBit()) v |= 1 << i;
		}
		// Force unsigned for bit counts that hit the sign bit.
		return v >>> 0;
	}

	/** Convenience: bytes already consumed (rounded down). */
	get bytesRead(): number {
		return this.byteOffset - (this.bitsLeft > 0 ? 1 : 0);
	}
}

/**
 * LSB-first bit writer that builds up a `Uint8Array` payload.
 * Used both for the in-memory rebuild buffer (passed to the Ogg
 * page builder) and indirectly for the on-the-wire framing.
 */
export class BitWriter {
	/** Internal buffer; grows by doubling when full. */
	private buf: Uint8Array;
	private byteCount = 0;
	private bitBuffer = 0;
	private bitsStored = 0;

	constructor(initialCapacity = 1024) {
		this.buf = new Uint8Array(initialCapacity);
	}

	/** Number of full bytes written so far. */
	get byteLength(): number {
		return this.byteCount;
	}

	/** Number of bits currently buffered (0..7). */
	get bitsBuffered(): number {
		return this.bitsStored;
	}

	/** Write a single bit (LSB-first within each byte). */
	writeBit(bit: 0 | 1 | boolean): void {
		if (bit) this.bitBuffer |= 1 << this.bitsStored;
		this.bitsStored++;
		if (this.bitsStored === 8) this._emitByte();
	}

	/**
	 * Write an unsigned integer of `n` bits. Bit 0 of the value goes
	 * out first (i.e. into the lowest-numbered output bit position).
	 */
	writeUint(value: number, n: number): void {
		if (n < 0 || n > 32) throw new Error(`BitWriter: bad bit count ${n}`);
		// Defensive: trim to n bits. Caller bugs that pass over-wide
		// values otherwise corrupt later reads.
		const mask = n === 32 ? 0xffffffff : (1 << n) - 1;
		const v = (value >>> 0) & mask;
		for (let i = 0; i < n; i++) {
			this.writeBit(((v >>> i) & 1) as 0 | 1);
		}
	}

	/**
	 * If we're mid-byte, pad the current byte with zero bits and
	 * flush it. Used to align the writer to a byte boundary at the
	 * end of an Ogg packet (Ogg packets are byte-aligned even though
	 * Vorbis bitpacking is not).
	 */
	flushByte(): void {
		if (this.bitsStored > 0) this._emitByte();
	}

	/** Snapshot the written bytes as a Uint8Array. Doesn't flush; caller must flushByte first if needed. */
	toUint8Array(): Uint8Array {
		return this.buf.subarray(0, this.byteCount);
	}

	private _emitByte() {
		if (this.byteCount === this.buf.length) {
			const grown = new Uint8Array(this.buf.length * 2);
			grown.set(this.buf);
			this.buf = grown;
		}
		this.buf[this.byteCount++] = this.bitBuffer;
		this.bitBuffer = 0;
		this.bitsStored = 0;
	}
}

/** Number of bits required to represent values [0, v]. (`ilog` in ww2ogg / Tremor.) */
export function ilog(v: number): number {
	let r = 0;
	while (v > 0) {
		r++;
		v >>>= 1;
	}
	return r;
}

/**
 * libvorbis's `_book_maptype1_quantvals(entries, dimensions)` — solves
 * for the largest n such that n^dimensions ≤ entries < (n+1)^dimensions.
 * Used by codebook lookup-type 1 to determine how many quantisation
 * values are encoded.
 */
export function bookMaptype1Quantvals(entries: number, dimensions: number): number {
	const bits = ilog(entries);
	let vals = entries >>> Math.floor(((bits - 1) * (dimensions - 1)) / dimensions);
	while (true) {
		let acc = 1;
		let acc1 = 1;
		for (let i = 0; i < dimensions; i++) {
			acc = (acc * vals) >>> 0;
			acc1 = (acc1 * (vals + 1)) >>> 0;
		}
		if (acc <= entries && acc1 > entries) return vals;
		if (acc > entries) vals--;
		else vals++;
	}
}
