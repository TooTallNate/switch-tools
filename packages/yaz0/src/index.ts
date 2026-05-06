/**
 * Yaz0 decoder.
 *
 * Yaz0 is a custom LZ-style compression scheme used by Nintendo across
 * many first-party titles (Wii / Wii U / Switch). It's most commonly
 * encountered as the wrapper around SARC archives in `.szs` files, but
 * is also used standalone for things like model and texture data.
 *
 * Wire layout (big-endian):
 *
 *   bytes 0..3   = magic            ('Y','a','z','0')
 *   bytes 4..7   = uncompressed_size (u32 BE)
 *   bytes 8..15  = reserved (zero on retail)
 *   bytes 16..   = compressed payload
 *
 * The payload is a sequence of *groups*. Each group starts with a
 * single byte of 8 flag bits, MSB-first. For each flag:
 *
 *   • bit = 1 → copy 1 literal byte from input to output.
 *   • bit = 0 → back-reference: read 2 bytes (b1, b2).
 *               offset = ((b1 & 0x0F) << 8) | b2     (0..0xFFF)
 *               length = (b1 >> 4)                   (0..15)
 *               if length == 0:
 *                   read a 3rd byte b3
 *                   length = b3 + 0x12               (0x12..0x111)
 *               else:
 *                   length += 2                      (3..17)
 *               Copy `length` bytes from `output[outPos - offset - 1]`
 *               to `output[outPos]` *byte by byte*. (Overlapping copies
 *               are intentional and produce run-length-encoded runs.)
 *
 * The decoder is single-pass over the input. We support both an
 * all-at-once `Blob` API and a streaming `ReadableStream` API; the
 * latter avoids materializing very large `.szs` files entirely in
 * memory before SARC parsing kicks in.
 *
 * References:
 *   - http://wiki.tockdom.com/wiki/Yaz0_(File_Format)
 *   - oead/src/yaz0.cpp (zeldamods)
 */

export const YAZ0_MAGIC = 'Yaz0';
const HEADER_SIZE = 16;

export interface Yaz0Header {
	magic: 'Yaz0';
	/** Decompressed size, read from header. */
	uncompressedSize: number;
}

/** Cheap (16-byte) check for the Yaz0 magic. */
export async function isYaz0(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x59 /* Y */ &&
		head[1] === 0x61 /* a */ &&
		head[2] === 0x7a /* z */ &&
		head[3] === 0x30 /* 0 */
	);
}

/** Read just the Yaz0 header (16 bytes) from a `Blob`. */
export async function readYaz0Header(blob: Blob): Promise<Yaz0Header> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a Yaz0 file (${blob.size} bytes, need ${HEADER_SIZE})`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	if (
		head[0] !== 0x59 ||
		head[1] !== 0x61 ||
		head[2] !== 0x7a ||
		head[3] !== 0x30
	) {
		throw new Error('Bad Yaz0 magic');
	}
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	return {
		magic: 'Yaz0',
		uncompressedSize: view.getUint32(4, false),
	};
}

/**
 * Decompress a Yaz0-compressed `Blob` into a fresh `Blob` of the
 * decompressed payload. The output `Blob` has no MIME type set —
 * callers should detect/set the content type themselves.
 *
 * Internally streams the input in chunks (so very large `.szs` files
 * don't need to be `arrayBuffer()`'d up front), but the decompressed
 * output is held in a single `Uint8Array` since Yaz0 back-references
 * can reach 4 KiB into already-emitted data.
 */
export async function decompressYaz0(blob: Blob): Promise<Blob> {
	const bytes = await decompressYaz0ToBytes(blob);
	// Cast: TS lib.dom.d.ts insists on `ArrayBufferView<ArrayBuffer>` for
	// `BlobPart`, but a freshly-allocated `Uint8Array` is always backed by
	// an `ArrayBuffer` (never `SharedArrayBuffer`).
	return new Blob([bytes as BlobPart]);
}

/** Same as {@link decompressYaz0} but returns the raw `Uint8Array`. */
export async function decompressYaz0ToBytes(blob: Blob): Promise<Uint8Array> {
	const header = await readYaz0Header(blob);
	const out = new Uint8Array(header.uncompressedSize);

	const reader = new ChunkReader(blob.slice(HEADER_SIZE).stream().getReader());

	let outPos = 0;
	while (outPos < out.length) {
		const flags = await reader.readByte();
		if (flags === -1) {
			throw new Error(
				`Truncated Yaz0 payload at output offset ${outPos} (need ${out.length})`,
			);
		}
		for (let bit = 7; bit >= 0 && outPos < out.length; bit--) {
			if ((flags >> bit) & 1) {
				// Literal byte.
				const b = await reader.readByte();
				if (b === -1) throw new Error('Truncated Yaz0 literal');
				out[outPos++] = b;
			} else {
				// Back-reference: 2 (or 3) bytes.
				const b1 = await reader.readByte();
				const b2 = await reader.readByte();
				if (b1 === -1 || b2 === -1) {
					throw new Error('Truncated Yaz0 back-reference');
				}
				const offset = (((b1 & 0x0f) << 8) | b2) + 1;
				let length = b1 >> 4;
				if (length === 0) {
					const b3 = await reader.readByte();
					if (b3 === -1) {
						throw new Error('Truncated Yaz0 long-length byte');
					}
					length = b3 + 0x12;
				} else {
					length += 2;
				}
				const src = outPos - offset;
				if (src < 0) {
					throw new Error(
						`Yaz0 back-reference points before start of output (outPos=${outPos}, offset=${offset})`,
					);
				}
				// Byte-by-byte to allow overlapping (RLE-style) copies.
				const end = Math.min(outPos + length, out.length);
				for (let i = 0; outPos < end; i++) {
					out[outPos++] = out[src + i];
				}
			}
		}
	}

	await reader.cancel();
	return out;
}

/**
 * Tiny helper: pulls `Uint8Array` chunks from a `ReadableStreamDefaultReader`
 * and exposes a `readByte()` that returns the next byte (or `-1` at EOF).
 *
 * Cheaper than wrapping with a `BYOB` reader, and good enough since the
 * Yaz0 inner loop reads 1–3 bytes at a time.
 */
class ChunkReader {
	private chunk: Uint8Array | null = null;
	private chunkPos = 0;
	private done = false;

	constructor(
		private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
	) {}

	async readByte(): Promise<number> {
		while (this.chunk === null || this.chunkPos >= this.chunk.length) {
			if (this.done) return -1;
			const { value, done } = await this.reader.read();
			if (done) {
				this.done = true;
				return -1;
			}
			this.chunk = value!;
			this.chunkPos = 0;
		}
		return this.chunk[this.chunkPos++];
	}

	async cancel(): Promise<void> {
		try {
			await this.reader.cancel();
		} catch {
			// ignore
		}
	}
}
