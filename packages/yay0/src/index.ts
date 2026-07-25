/**
 * Yay0 decoder.
 *
 * Yay0 is an LZ-style compression scheme used by Nintendo on the
 * Nintendo 64 and GameCube (e.g. Super Mario 64's Japanese Shindou
 * revision, Ocarina of Time betas, various GC titles). It's the
 * split-stream sibling of Yaz0: the same back-reference encoding, but
 * with the control bits, back-reference records, and literal bytes
 * stored in three separate streams located by header offsets.
 *
 * Wire layout (all u32 fields big-endian, offsets relative to the
 * start of the Yay0 header):
 *
 *   bytes 0x00..0x03 = magic             ('Y','a','y','0')
 *   bytes 0x04..0x07 = decompressed size (u32 BE)
 *   bytes 0x08..0x0B = link table offset (u32 BE) → 2-byte back-reference records
 *   bytes 0x0C..0x0F = chunk offset      (u32 BE) → literal bytes AND
 *                      extended-length bytes
 *   bytes 0x10..     = control stream: consecutive u32 BE words,
 *                      32 flag bits per word, consumed MSB-first
 *
 * Decoding walks the control stream one bit at a time:
 *
 *   • bit = 1 → copy 1 literal byte from the chunk stream.
 *   • bit = 0 → read 2 bytes (b1, b2) from the link table:
 *               dist  = (((b1 & 0x0F) << 8) | b2) + 1  (1..4096)
 *               count = b1 >> 4
 *               if count == 0:
 *                   read 1 extra byte from the *chunk* stream
 *                   length = extra + 0x12               (0x12..0x111)
 *               else:
 *                   length = count + 2                  (3..17)
 *               Copy `length` bytes from `output[outPos - dist]`
 *               *byte by byte*. (Overlapping copies are intentional
 *               and produce run-length-encoded runs.)
 *
 * Decoding stops once the output reaches the declared decompressed
 * size. Any read past the end of the input, or a back-reference that
 * points before the start of the output, is an error.
 *
 * References:
 *   - http://wiki.tockdom.com/wiki/YAY0_(File_Format)
 *   - https://hack64.net/wiki/doku.php?id=yay0
 */

export const YAY0_MAGIC = 'Yay0';
const HEADER_SIZE = 16;

export interface Yay0Header {
	magic: 'Yay0';
	/** Decompressed size, read from header. */
	uncompressedSize: number;
	/** Offset (from the Yay0 header) of the 2-byte back-reference records. */
	linkOffset: number;
	/** Offset (from the Yay0 header) of the literal/extended-length bytes. */
	chunkOffset: number;
}

/** Cheap (4-byte) check for the Yay0 magic. */
export async function isYay0(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x59 /* Y */ &&
		head[1] === 0x61 /* a */ &&
		head[2] === 0x79 /* y */ &&
		head[3] === 0x30 /* 0 */
	);
}

/** Read just the Yay0 header (16 bytes) from a `Blob`. */
export async function readYay0Header(blob: Blob): Promise<Yay0Header> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a Yay0 file (${blob.size} bytes, need ${HEADER_SIZE})`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	return parseHeader(head, 0);
}

function parseHeader(bytes: Uint8Array, offset: number): Yay0Header {
	if (bytes.length - offset < HEADER_SIZE) {
		throw new Error(
			`Not enough bytes for a Yay0 header at offset ${offset}`,
		);
	}
	if (
		bytes[offset] !== 0x59 ||
		bytes[offset + 1] !== 0x61 ||
		bytes[offset + 2] !== 0x79 ||
		bytes[offset + 3] !== 0x30
	) {
		throw new Error('Bad Yay0 magic');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		magic: 'Yay0',
		uncompressedSize: view.getUint32(offset + 4, false),
		linkOffset: view.getUint32(offset + 8, false),
		chunkOffset: view.getUint32(offset + 12, false),
	};
}

/**
 * Decompress a Yay0 block found at `offset` within `bytes`.
 *
 * Yay0 blocks are frequently embedded in the middle of larger files
 * (N64 ROMs especially), so unlike the `Blob` API this synchronous
 * variant takes the containing byte array plus the offset of the
 * Yay0 header. All three streams are located relative to that offset,
 * per the header fields.
 */
export function decompressYay0Bytes(bytes: Uint8Array, offset = 0): Uint8Array {
	const header = parseHeader(bytes, offset);
	const out = new Uint8Array(header.uncompressedSize);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let ctrlPos = offset + HEADER_SIZE;
	let linkPos = offset + header.linkOffset;
	let chunkPos = offset + header.chunkOffset;

	const readByte = (pos: number, what: string): number => {
		if (pos >= bytes.length) {
			throw new Error(`Truncated Yay0 ${what} stream at input offset ${pos}`);
		}
		return bytes[pos];
	};

	let ctrlWord = 0;
	let bitsLeft = 0;
	let outPos = 0;
	while (outPos < out.length) {
		if (bitsLeft === 0) {
			if (ctrlPos + 4 > bytes.length) {
				throw new Error(
					`Truncated Yay0 control stream at input offset ${ctrlPos}`,
				);
			}
			ctrlWord = view.getUint32(ctrlPos, false);
			ctrlPos += 4;
			bitsLeft = 32;
		}
		const bit = (ctrlWord >>> 31) & 1;
		ctrlWord = (ctrlWord << 1) >>> 0;
		bitsLeft--;

		if (bit) {
			// Literal byte from the chunk stream.
			out[outPos++] = readByte(chunkPos++, 'chunk');
		} else {
			// 2-byte back-reference from the link table.
			const b1 = readByte(linkPos++, 'link');
			const b2 = readByte(linkPos++, 'link');
			const dist = (((b1 & 0x0f) << 8) | b2) + 1;
			const count = b1 >> 4;
			let length: number;
			if (count === 0) {
				// Extended length: 1 extra byte from the *chunk* stream.
				length = readByte(chunkPos++, 'chunk') + 0x12;
			} else {
				length = count + 2;
			}
			if (dist > outPos) {
				throw new Error(
					`Yay0 back-reference points before start of output (outPos=${outPos}, dist=${dist})`,
				);
			}
			const src = outPos - dist;
			// Byte-by-byte to allow overlapping (RLE-style) copies.
			const end = Math.min(outPos + length, out.length);
			for (let i = 0; outPos < end; i++) {
				out[outPos++] = out[src + i];
			}
		}
	}

	return out;
}

/**
 * Decompress a Yay0-compressed `Blob` into a fresh `Blob` of the
 * decompressed payload. The output `Blob` has no MIME type set —
 * callers should detect/set the content type themselves.
 *
 * Yay0's three streams are located by absolute header offsets, so the
 * whole input is materialized up front (blocks are small in practice).
 */
export async function decompressYay0(blob: Blob): Promise<Blob> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const out = decompressYay0Bytes(bytes, 0);
	// Cast: TS lib.dom.d.ts insists on `ArrayBufferView<ArrayBuffer>` for
	// `BlobPart`, but a freshly-allocated `Uint8Array` is always backed by
	// an `ArrayBuffer` (never `SharedArrayBuffer`).
	return new Blob([out as BlobPart]);
}
