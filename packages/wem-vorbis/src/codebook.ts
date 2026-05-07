/**
 * Codebook unpacker / rebuilder.
 *
 * The "external codebook library" (`packed_codebooks_aoTuV_603.bin`)
 * is a flat concatenation of N compact Wwise codebooks plus an
 * offset table at the end:
 *
 *   ┌─────────────────┐
 *   │ codebook 0 data │
 *   │ codebook 1 data │  variable size
 *   │ ...             │
 *   │ codebook N-1    │
 *   ├─────────────────┤
 *   │ u32 offsets[N]  │  byte offsets into the data area, LE
 *   ├─────────────────┤
 *   │ u32 offset_off  │  start of the offset table itself
 *   └─────────────────┘
 *
 * `codebook_count = (file_size - offset_off) / 4`. Codebook `i` is
 * the bytes from `offsets[i]` to `offsets[i+1]` (the last entry is
 * a sentinel — `offsets[count-1]` marks the end of the actual data
 * area, so we have count-1 *real* codebooks).
 *
 * Each codebook's compact form differs from the standard Vorbis
 * codebook layout: the codeword-length field is 3-bit (variable),
 * the lookup-type field is 1-bit instead of 4, and the standard
 * 24-bit "BCV" identifier is omitted. {@link rebuildCodebook}
 * unpacks a compact codebook into a standard Vorbis codebook,
 * piping bits through the writer.
 */

import { BitReader, BitWriter, ilog, bookMaptype1Quantvals } from './bit-stream.js';

/** A loaded codebook library (offsets + payload). */
export class CodebookLibrary {
	/** Concatenated payloads (everything before the offset table). */
	private payload: Uint8Array;
	/** Byte offsets into `payload`. Length is `count + 1` (last entry is the data-area end sentinel). */
	private offsets: Uint32Array;

	constructor(file: Uint8Array) {
		if (file.length < 4) throw new Error('codebook library too small');
		const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
		const offsetTableStart = dv.getUint32(file.length - 4, true);
		if (offsetTableStart > file.length - 4) {
			throw new Error('codebook library: bad offset table start');
		}
		const tableEntries = (file.length - 4 - offsetTableStart) / 4;
		// ww2ogg's `codebook_count = (file_size - offset_offset) / 4` includes
		// the trailing offset-of-offsets word, so its codebook_count is
		// one larger than the number of *complete* entries. We keep the
		// raw offset array (size = tableEntries) and treat the last as
		// a sentinel — number of real codebooks is tableEntries - 1.
		this.offsets = new Uint32Array(tableEntries);
		for (let i = 0; i < tableEntries; i++) {
			this.offsets[i] = dv.getUint32(offsetTableStart + i * 4, true);
		}
		this.payload = file.subarray(0, offsetTableStart);
	}

	/** Number of codebooks in the library. */
	get count(): number {
		return this.offsets.length - 1;
	}

	/** Get the raw compact codebook bytes for index `i`. */
	getCodebook(i: number): Uint8Array {
		if (i < 0 || i >= this.count) {
			throw new Error(`codebook index ${i} out of range (have ${this.count})`);
		}
		const start = this.offsets[i];
		const end = this.offsets[i + 1];
		return this.payload.subarray(start, end);
	}

	/** Rebuild the standard Vorbis codebook for index `i` into `bw`. */
	rebuild(i: number, bw: BitWriter): void {
		const cb = this.getCodebook(i);
		const br = new BitReader(cb);
		rebuildCompactCodebook(br, cb.length, bw);
	}
}

/**
 * Unpack a compact Wwise codebook (as found in the external library)
 * into a full Vorbis codebook, piping bits to `bw`.
 *
 * The compact form differs from the spec form as follows:
 *   - No 24-bit "BCV" identifier (always emitted as 0x564342).
 *   - Dimensions: 4 bits compact → 16 bits spec.
 *   - Entry count: 14 bits compact → 24 bits spec.
 *   - Codeword length field: 3-bit length descriptor + per-entry n-bit lengths.
 *   - Lookup type: 1 bit compact → 4 bits spec.
 *
 * Pass `cbSize` so we can verify all input bytes were consumed.
 * If `cbSize === 0` the verification is skipped (used when the
 * compact codebook is read from an inline bitstream rather than a
 * standalone byte buffer — `--full-setup` mode, not used here).
 */
export function rebuildCompactCodebook(
	br: BitReader,
	cbSize: number,
	bw: BitWriter,
): void {
	// IN: 4-bit dimensions, 14-bit entry count.
	const dimensions = br.readUint(4);
	const entries = br.readUint(14);

	// OUT: 24-bit identifier (0x564342 = "BCV"), 16-bit dimensions, 24-bit entries.
	bw.writeUint(0x564342, 24);
	bw.writeUint(dimensions, 16);
	bw.writeUint(entries, 24);

	// Codeword lengths: 1-bit ordered flag.
	const ordered = br.readBit();
	bw.writeBit(ordered);
	if (ordered) {
		// 5-bit initial length.
		const initialLength = br.readUint(5);
		bw.writeUint(initialLength, 5);
		let currentEntry = 0;
		while (currentEntry < entries) {
			const number = br.readUint(ilog(entries - currentEntry));
			bw.writeUint(number, ilog(entries - currentEntry));
			currentEntry += number;
		}
		if (currentEntry > entries) throw new Error('codebook: ordered current_entry overflow');
	} else {
		// IN: 3-bit codeword-length-length, 1-bit sparse flag.
		const codewordLengthLength = br.readUint(3);
		const sparse = br.readBit();
		if (codewordLengthLength === 0 || codewordLengthLength > 5) {
			throw new Error(`codebook: nonsense codeword length ${codewordLengthLength}`);
		}
		// OUT: 1-bit sparse.
		bw.writeBit(sparse);
		for (let i = 0; i < entries; i++) {
			let presentBool = true;
			if (sparse) {
				const present = br.readBit();
				bw.writeBit(present);
				presentBool = present !== 0;
			}
			if (presentBool) {
				// IN: n-bit codeword-length-1, OUT: 5-bit codeword-length-1.
				const codewordLength = br.readUint(codewordLengthLength);
				bw.writeUint(codewordLength, 5);
			}
		}
	}

	// Lookup table: 1-bit type → 4-bit type.
	const lookupType = br.readUint(1);
	bw.writeUint(lookupType, 4);
	if (lookupType === 0) {
		// no lookup table
	} else if (lookupType === 1) {
		// 32-bit min, 32-bit max, 4-bit value-length-1, 1-bit sequence.
		const min = br.readUint(32);
		const max = br.readUint(32);
		const valueLength = br.readUint(4);
		const sequenceFlag = br.readBit();
		bw.writeUint(min, 32);
		bw.writeUint(max, 32);
		bw.writeUint(valueLength, 4);
		bw.writeBit(sequenceFlag);
		const quantvals = bookMaptype1Quantvals(entries, dimensions);
		for (let i = 0; i < quantvals; i++) {
			const val = br.readUint(valueLength + 1);
			bw.writeUint(val, valueLength + 1);
		}
	} else {
		throw new Error(`codebook: invalid lookup type ${lookupType}`);
	}

	// Sanity: when called with a known cb size, verify all bytes consumed.
	// ww2ogg's check: bits_read/8 + 1 == cb_size.
	if (cbSize !== 0) {
		const bitsConsumed = br.totalBitsRead;
		const expected = cbSize;
		const actual = Math.floor(bitsConsumed / 8) + 1;
		if (actual !== expected) {
			throw new Error(
				`codebook: size mismatch (used ${actual}, expected ${expected})`,
			);
		}
	}
}

/**
 * Inline codebook copier (used when the codebook itself is embedded
 * in the WEM's setup packet, with the 24-bit "BCV" identifier already
 * present). Copies the codebook bits verbatim from `br` to `bw`,
 * stopping at the natural end of the codebook structure.
 *
 * Provided for completeness — Switch-era V62 always uses *external*
 * codebooks (a 10-bit codebook id pointing into the library), so
 * this isn't called on the Switch path. We include it for parity
 * with ww2ogg's `codebook_library::copy()` in case future games
 * use the inline-codebooks variant.
 */
export function copyInlineCodebook(br: BitReader, bw: BitWriter): void {
	// IN: 24-bit BCV id, 16-bit dimensions, 24-bit entries.
	const id = br.readUint(24);
	if (id !== 0x564342) throw new Error('codebook: invalid inline identifier');
	const dimensions = br.readUint(16);
	const entries = br.readUint(24);
	bw.writeUint(id, 24);
	bw.writeUint(dimensions, 16);
	bw.writeUint(entries, 24);

	const ordered = br.readBit();
	bw.writeBit(ordered);
	if (ordered) {
		const initialLength = br.readUint(5);
		bw.writeUint(initialLength, 5);
		let currentEntry = 0;
		while (currentEntry < entries) {
			const n = br.readUint(ilog(entries - currentEntry));
			bw.writeUint(n, ilog(entries - currentEntry));
			currentEntry += n;
		}
		if (currentEntry > entries) throw new Error('codebook: ordered overflow');
	} else {
		const sparse = br.readBit();
		bw.writeBit(sparse);
		for (let i = 0; i < entries; i++) {
			let presentBool = true;
			if (sparse) {
				const present = br.readBit();
				bw.writeBit(present);
				presentBool = present !== 0;
			}
			if (presentBool) {
				const cwl = br.readUint(5);
				bw.writeUint(cwl, 5);
			}
		}
	}
	const lookupType = br.readUint(4);
	bw.writeUint(lookupType, 4);
	if (lookupType === 0) {
		// no table
	} else if (lookupType === 1) {
		const min = br.readUint(32);
		const max = br.readUint(32);
		const valueLength = br.readUint(4);
		const sequenceFlag = br.readBit();
		bw.writeUint(min, 32);
		bw.writeUint(max, 32);
		bw.writeUint(valueLength, 4);
		bw.writeBit(sequenceFlag);
		const quantvals = bookMaptype1Quantvals(entries, dimensions);
		for (let i = 0; i < quantvals; i++) {
			const val = br.readUint(valueLength + 1);
			bw.writeUint(val, valueLength + 1);
		}
	} else {
		throw new Error(`codebook: invalid lookup type ${lookupType}`);
	}
}
