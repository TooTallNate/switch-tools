/**
 * MIO0 decoder.
 *
 * MIO0 is an LZ-style compression scheme used by Nintendo in many
 * libultra-era first-party Nintendo 64 titles (Super Mario 64, Mario
 * Kart 64, …). Unlike Yaz0's single interleaved stream, MIO0 splits
 * the compressed data into three separate streams whose offsets are
 * declared in the header.
 *
 * Wire layout (all u32 fields big-endian, offsets relative to the
 * start of the MIO0 header):
 *
 *   bytes 0x00..0x03 = magic               ('M','I','O','0')
 *   bytes 0x04..0x07 = decompressed size   (u32 BE)
 *   bytes 0x08..0x0B = compressed offset   (u32 BE) → 2-byte back-reference records
 *   bytes 0x0C..0x0F = raw offset          (u32 BE) → literal bytes
 *   bytes 0x10..     = control bit stream  (byte after byte, MSB-first)
 *
 * Decoding walks the control bit stream one bit at a time:
 *
 *   • bit = 1 → copy 1 literal byte from the raw (uncompressed)
 *               stream and advance it.
 *   • bit = 0 → read 2 bytes (b1, b2) from the compressed stream:
 *               length = (b1 >> 4) + 3                 (3..18)
 *               dist   = (((b1 & 0x0F) << 8) | b2) + 1 (1..4096)
 *               Copy `length` bytes from `output[outPos - dist]`
 *               *byte by byte*. (Overlapping copies are intentional
 *               and produce run-length-encoded runs.)
 *
 * Decoding stops once the output reaches the declared decompressed
 * size. Any read past the end of the input, or a back-reference that
 * points before the start of the output, is an error.
 *
 * References:
 *   - https://hack64.net/wiki/doku.php?id=super_mario_64:mio0
 *   - https://n64squid.com/homebrew/n64-sdk/textures/image-formats/mio0/
 */

export const MIO0_MAGIC = 'MIO0';
const HEADER_SIZE = 16;

export interface Mio0Header {
	magic: 'MIO0';
	/** Decompressed size, read from header. */
	uncompressedSize: number;
	/** Offset (from the MIO0 header) of the 2-byte back-reference records. */
	compressedOffset: number;
	/** Offset (from the MIO0 header) of the raw literal bytes. */
	rawOffset: number;
}

/** Cheap (4-byte) check for the MIO0 magic. */
export async function isMio0(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x4d /* M */ &&
		head[1] === 0x49 /* I */ &&
		head[2] === 0x4f /* O */ &&
		head[3] === 0x30 /* 0 */
	);
}

/** Read just the MIO0 header (16 bytes) from a `Blob`. */
export async function readMio0Header(blob: Blob): Promise<Mio0Header> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a MIO0 file (${blob.size} bytes, need ${HEADER_SIZE})`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	return parseHeader(head, 0);
}

function parseHeader(bytes: Uint8Array, offset: number): Mio0Header {
	if (bytes.length - offset < HEADER_SIZE) {
		throw new Error(
			`Not enough bytes for a MIO0 header at offset ${offset}`,
		);
	}
	if (
		bytes[offset] !== 0x4d ||
		bytes[offset + 1] !== 0x49 ||
		bytes[offset + 2] !== 0x4f ||
		bytes[offset + 3] !== 0x30
	) {
		throw new Error('Bad MIO0 magic');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		magic: 'MIO0',
		uncompressedSize: view.getUint32(offset + 4, false),
		compressedOffset: view.getUint32(offset + 8, false),
		rawOffset: view.getUint32(offset + 12, false),
	};
}

/**
 * Decompress a MIO0 block found at `offset` within `bytes`.
 *
 * MIO0 blocks are frequently embedded in the middle of larger files
 * (N64 ROMs especially), so unlike the `Blob` API this synchronous
 * variant takes the containing byte array plus the offset of the
 * MIO0 header. All three streams are located relative to that offset,
 * per the header fields.
 */
export function decompressMio0Bytes(bytes: Uint8Array, offset = 0): Uint8Array {
	const header = parseHeader(bytes, offset);
	const out = new Uint8Array(header.uncompressedSize);

	let ctrlPos = offset + HEADER_SIZE;
	let compPos = offset + header.compressedOffset;
	let rawPos = offset + header.rawOffset;

	const readByte = (pos: number, what: string): number => {
		if (pos >= bytes.length) {
			throw new Error(`Truncated MIO0 ${what} stream at input offset ${pos}`);
		}
		return bytes[pos];
	};

	let outPos = 0;
	while (outPos < out.length) {
		const flags = readByte(ctrlPos++, 'control');
		for (let bit = 7; bit >= 0 && outPos < out.length; bit--) {
			if ((flags >> bit) & 1) {
				// Literal byte from the raw stream.
				out[outPos++] = readByte(rawPos++, 'raw');
			} else {
				// 2-byte back-reference from the compressed stream.
				const b1 = readByte(compPos++, 'compressed');
				const b2 = readByte(compPos++, 'compressed');
				const length = (b1 >> 4) + 3;
				const dist = (((b1 & 0x0f) << 8) | b2) + 1;
				if (dist > outPos) {
					throw new Error(
						`MIO0 back-reference points before start of output (outPos=${outPos}, dist=${dist})`,
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
	}

	return out;
}

/**
 * Decompress a MIO0-compressed `Blob` into a fresh `Blob` of the
 * decompressed payload. The output `Blob` has no MIME type set —
 * callers should detect/set the content type themselves.
 *
 * MIO0's three streams are located by absolute header offsets, so the
 * whole input is materialized up front (blocks are small — texture
 * and display-list sized — in practice).
 */
export async function decompressMio0(blob: Blob): Promise<Blob> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const out = decompressMio0Bytes(bytes, 0);
	// Cast: TS lib.dom.d.ts insists on `ArrayBufferView<ArrayBuffer>` for
	// `BlobPart`, but a freshly-allocated `Uint8Array` is always backed by
	// an `ArrayBuffer` (never `SharedArrayBuffer`).
	return new Blob([out as BlobPart]);
}
