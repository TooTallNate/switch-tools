/**
 * LZ4 *legacy* frame-format decoder.
 *
 * The legacy format predates the modern LZ4 frame format and is
 * still found in some older content (notably the Linux kernel's
 * embedded LZ4 streams and some early Nintendo first-party content).
 *
 * Wire layout:
 *
 *   ┌──────────┬───────────┬───────────┬───────────┬───────────┬─────────┐
 *   │  Magic   │ B.CSize   │   CData   │ B.CSize   │   CData   │ EndMark │
 *   │ 0x184C..  │ 4 bytes   │  CSize B  │ 4 bytes   │  CSize B  │ EOF /   │
 *   │ 4 bytes  │           │           │           │           │ next    │
 *   └──────────┴───────────┴───────────┴───────────┴───────────┴─────────┘
 *
 * - All blocks are LZ4-compressed (no per-block uncompressed flag).
 * - All blocks except the last are exactly 8 MiB uncompressed.
 * - The last block is shorter than 8 MiB.
 * - There's no explicit end marker — termination is signaled by EOF
 *   or by the appearance of a recognized "next frame" magic. Since
 *   we always operate on a complete `Blob`, EOF works fine.
 * - No checksums anywhere.
 *
 * Reference: https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md
 *            (section "Legacy frame")
 */

import { decodeBlock } from './block.js';

/** Magic number for the legacy LZ4 frame format. */
export const LZ4_LEGACY_MAGIC = 0x184c2102;

/** Fixed uncompressed block size for legacy-format blocks: 8 MiB. */
const LEGACY_BLOCK_SIZE = 8 * 1024 * 1024;

/** Cheap (4-byte) check for the legacy LZ4 frame magic. */
export async function isLz4Legacy(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const sig =
		head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24);
	return (sig >>> 0) === LZ4_LEGACY_MAGIC;
}

/**
 * Decompress a legacy-frame-format LZ4 blob into a fresh `Blob` of
 * the decompressed payload.
 */
export async function decompressLz4Legacy(blob: Blob): Promise<Blob> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const out = decodeLegacyBytes(bytes);
	return new Blob([out as BlobPart]);
}

/** Same as {@link decompressLz4Legacy} but returns raw bytes. */
export async function decompressLz4LegacyToBytes(
	blob: Blob,
): Promise<Uint8Array> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return decodeLegacyBytes(bytes);
}

function decodeLegacyBytes(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 8) {
		throw new Error(
			`LZ4 legacy: blob too small (${bytes.length} bytes, need at least 8)`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	if (view.getUint32(0, true) !== LZ4_LEGACY_MAGIC) {
		throw new Error('LZ4 legacy: bad magic');
	}

	const chunks: Uint8Array[] = [];
	let totalSize = 0;
	let pos = 4;
	while (pos < bytes.length) {
		if (pos + 4 > bytes.length) {
			throw new Error('LZ4 legacy: truncated block size at EOF');
		}
		const blockSize = view.getUint32(pos, true);
		pos += 4;
		// A "valid magic" appearing where a block size should be
		// indicates a concatenated frame. We don't decode further.
		if (blockSize === LZ4_LEGACY_MAGIC) {
			pos -= 4;
			break;
		}
		if (pos + blockSize > bytes.length) {
			throw new Error(
				`LZ4 legacy: block size ${blockSize} extends past blob bounds at offset ${pos}`,
			);
		}
		const blockBytes = bytes.subarray(pos, pos + blockSize);
		pos += blockSize;

		// Each block decompresses to ≤ 8 MiB. Use `allowShorter`
		// because the *last* block is typically shorter than the
		// fixed block size.
		const decoded = decodeBlock(blockBytes, LEGACY_BLOCK_SIZE, {
			allowShorter: true,
		});
		chunks.push(decoded);
		totalSize += decoded.length;
	}

	const out = new Uint8Array(totalSize);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}
