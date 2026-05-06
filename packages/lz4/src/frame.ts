/**
 * LZ4 frame-format decoder.
 *
 * The frame format is the standard self-describing wrapper around
 * one or more LZ4 blocks. Layout:
 *
 *   ┌─────────┬──────────────┬───────────────┬──────────┬──────────┐
 *   │ Magic   │ FrameDescr.  │ DataBlock×N   │ EndMark  │ Checksum │
 *   │ 0x18..  │ 3–15 bytes   │               │ 4 bytes  │ 0–4 byte │
 *   │ 4 bytes │              │               │ (0)      │          │
 *   └─────────┴──────────────┴───────────────┴──────────┴──────────┘
 *
 * Frame descriptor:
 *   FLG byte:  bits 7-6 = version (must be 01)
 *              bit 5    = block independence
 *              bit 4    = block checksum present
 *              bit 3    = content size present
 *              bit 2    = content checksum present
 *              bit 1    = reserved
 *              bit 0    = dictionary id present
 *   BD byte:   bits 6-4 = block max size enum (4=64K, 5=256K, 6=1M, 7=4M)
 *   [optional 8-byte LE content size, if FLG bit 3]
 *   [optional 4-byte dict id, if FLG bit 0]
 *   HC byte:   header checksum = (xxhash32(FLG..before_HC) >> 8) & 0xFF
 *
 * Each block is then:
 *   u32 LE blockSize
 *     - high bit set ⇒ uncompressed block, low 31 bits = byte length
 *     - high bit clear ⇒ compressed (LZ4 block format), low 31 bits = byte length
 *     - exactly 0x00000000 ⇒ EndMark (no more blocks)
 *   blockSize bytes of (compressed or uncompressed) data
 *   [optional 4-byte block checksum, if FLG bit 4]
 *
 * We don't validate the optional checksums — they're for corruption
 * detection, and tools downstream can re-verify if they care. We do
 * sanity-check structural fields (version, max-size enum range,
 * truncation, EOM presence).
 *
 * Reference: https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md
 */

import { decodeBlock } from './block.js';

/** Magic number for the standard (current) LZ4 frame format. */
export const LZ4_FRAME_MAGIC = 0x184d2204;

/** Magic number for LZ4 skippable frames (0x184D2A50..0x184D2A5F). */
const LZ4_SKIPPABLE_MAGIC_BASE = 0x184d2a50;
const LZ4_SKIPPABLE_MAGIC_MASK = 0xfffffff0;

/** Block max size enum → bytes lookup (only values 4–7 are valid). */
const BLOCK_MAX_SIZES: Record<number, number> = {
	4: 64 * 1024,
	5: 256 * 1024,
	6: 1 * 1024 * 1024,
	7: 4 * 1024 * 1024,
};

/** Cheap (4-byte) check for the LZ4 frame magic. */
export async function isLz4Frame(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const sig =
		head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24);
	return (sig >>> 0) === LZ4_FRAME_MAGIC;
}

/**
 * Decompress a standard-frame-format LZ4 blob. Returns the
 * concatenated uncompressed payload from all blocks within the
 * frame. Skippable frames preceding the data frame are tolerated
 * (and skipped). Concatenated post-EndMark frames are NOT decoded
 * — the spec leaves multi-frame handling to the caller, and so do
 * we; doing so avoids ambiguity around content-size validation.
 */
export async function decompressLz4Frame(blob: Blob): Promise<Blob> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const out = decodeFrameBytes(bytes);
	return new Blob([out as BlobPart]);
}

/** Same as {@link decompressLz4Frame} but returns raw bytes. */
export async function decompressLz4FrameToBytes(
	blob: Blob,
): Promise<Uint8Array> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return decodeFrameBytes(bytes);
}

function decodeFrameBytes(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 7) {
		throw new Error(
			`LZ4: blob too small to be a frame (${bytes.length} bytes, need at least 7)`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);

	let pos = 0;
	// Skip any leading skippable frames. The spec discourages starting
	// a frame stream with one but says decoders should tolerate them.
	while (pos < bytes.length) {
		if (pos + 4 > bytes.length) {
			throw new Error('LZ4: truncated magic');
		}
		const magic = view.getUint32(pos, true);
		if ((magic & LZ4_SKIPPABLE_MAGIC_MASK) === LZ4_SKIPPABLE_MAGIC_BASE) {
			// Skippable frame: 4 bytes magic + 4 bytes user-data length
			// + N bytes of user data. Skip it entirely.
			if (pos + 8 > bytes.length) {
				throw new Error('LZ4: truncated skippable frame header');
			}
			const userLen = view.getUint32(pos + 4, true);
			pos += 8 + userLen;
			if (pos > bytes.length) {
				throw new Error(
					'LZ4: skippable frame user-data length exceeds blob size',
				);
			}
			continue;
		}
		if (magic !== LZ4_FRAME_MAGIC) {
			throw new Error(
				`LZ4: bad frame magic 0x${magic.toString(16)} at offset ${pos}`,
			);
		}
		break;
	}
	pos += 4;

	// --- Frame descriptor ---
	if (pos + 2 > bytes.length) {
		throw new Error('LZ4: truncated frame descriptor');
	}
	const flg = bytes[pos++];
	const bd = bytes[pos++];
	const version = (flg >> 6) & 0x03;
	if (version !== 0x01) {
		throw new Error(`LZ4: unsupported frame version ${version}`);
	}
	const blockChecksumFlag = (flg >> 4) & 1;
	const contentSizeFlag = (flg >> 3) & 1;
	// const contentChecksumFlag = (flg >> 2) & 1;  // ignored
	const dictIdFlag = flg & 1;

	const blockMaxSizeEnum = (bd >> 4) & 0x07;
	const blockMaxSize = BLOCK_MAX_SIZES[blockMaxSizeEnum];
	if (!blockMaxSize) {
		throw new Error(
			`LZ4: invalid block max size enum ${blockMaxSizeEnum}`,
		);
	}

	let declaredContentSize: number | null = null;
	if (contentSizeFlag) {
		if (pos + 8 > bytes.length) {
			throw new Error('LZ4: truncated content size field');
		}
		const lo = view.getUint32(pos, true);
		const hi = view.getUint32(pos + 4, true);
		if (hi > 0x001fffff) {
			throw new Error(
				'LZ4: content size exceeds Number.MAX_SAFE_INTEGER',
			);
		}
		declaredContentSize = hi * 0x100000000 + lo;
		pos += 8;
	}
	if (dictIdFlag) {
		if (pos + 4 > bytes.length) {
			throw new Error('LZ4: truncated dict id field');
		}
		// We don't support dictionaries; skip the id.
		pos += 4;
	}
	// Header checksum byte — ignored for decode purposes.
	if (pos + 1 > bytes.length) {
		throw new Error('LZ4: truncated frame descriptor checksum byte');
	}
	pos += 1;

	// --- Data blocks ---
	const chunks: Uint8Array[] = [];
	let totalSize = 0;
	for (;;) {
		if (pos + 4 > bytes.length) {
			throw new Error('LZ4: truncated block size field');
		}
		const rawSize = view.getUint32(pos, true);
		pos += 4;
		if (rawSize === 0) break; // EndMark
		const isUncompressed = (rawSize & 0x80000000) !== 0;
		const blockSize = rawSize & 0x7fffffff;
		if (blockSize > blockMaxSize) {
			throw new Error(
				`LZ4: block size ${blockSize} exceeds declared max ${blockMaxSize}`,
			);
		}
		if (pos + blockSize > bytes.length) {
			throw new Error(
				`LZ4: block size ${blockSize} extends past blob bounds`,
			);
		}
		const blockData = bytes.subarray(pos, pos + blockSize);
		pos += blockSize;
		if (blockChecksumFlag) {
			if (pos + 4 > bytes.length) {
				throw new Error('LZ4: truncated block checksum');
			}
			pos += 4; // skipped (not validated)
		}
		if (isUncompressed) {
			chunks.push(blockData);
			totalSize += blockSize;
		} else {
			// We don't know the exact decompressed size of an
			// individual block up front; the spec only guarantees
			// it's ≤ blockMaxSize. Pass that as an upper bound and
			// let `decodeBlock` shrink the output to the actual
			// decoded length. (Real-world final blocks are almost
			// always shorter than blockMaxSize.)
			const decoded = decodeBlock(blockData, blockMaxSize, {
				allowShorter: true,
			});
			chunks.push(decoded);
			totalSize += decoded.length;
		}
	}

	// Validate declared content size (if any).
	if (declaredContentSize !== null && totalSize !== declaredContentSize) {
		throw new Error(
			`LZ4: declared content size ${declaredContentSize} disagrees with decoded size ${totalSize}`,
		);
	}

	// Concatenate.
	const out = new Uint8Array(totalSize);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}
