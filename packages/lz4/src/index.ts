/**
 * LZ4 decompression — block format + three frame variants.
 *
 * This package supports three different "framings" of the same
 * underlying LZ4 block format:
 *
 * 1. **Standard frame format** ({@link decompressLz4Frame}) — the
 *    canonical self-describing format with magic `0x184D2204`. Used
 *    by the official `lz4` CLI and most third-party tooling.
 *
 * 2. **Legacy frame format** ({@link decompressLz4Legacy}) — the
 *    older 8-MiB-fixed-block format with magic `0x184C2102`. Used
 *    by the Linux kernel and some early Nintendo content.
 *
 * 3. **Switch firmware wrapper** ({@link decompressLz4Switch}) —
 *    Nintendo's bespoke `[u32 LE size][raw LZ4 block]` wrapper used
 *    for `.lz4` files inside firmware NCAs. NO magic bytes — this
 *    format must be detected by file extension or by trial decode.
 *
 * The high-level {@link decompressLz4} sniffs the magic and
 * dispatches to the right backend, falling back to the Switch
 * wrapper for files that don't match either standard magic.
 *
 * The block decoder ({@link decodeBlock}) is also exported for
 * callers who already know the size and have a raw block.
 */

export { decodeBlock, type DecodeBlockOptions } from './block.js';

export {
	LZ4_FRAME_MAGIC,
	isLz4Frame,
	decompressLz4Frame,
	decompressLz4FrameToBytes,
} from './frame.js';

export {
	LZ4_LEGACY_MAGIC,
	isLz4Legacy,
	decompressLz4Legacy,
	decompressLz4LegacyToBytes,
} from './legacy.js';

export {
	isLz4Switch,
	decompressLz4Switch,
	decompressLz4SwitchToBytes,
} from './switch.js';

import {
	LZ4_FRAME_MAGIC,
	decompressLz4Frame,
	decompressLz4FrameToBytes,
} from './frame.js';
import {
	LZ4_LEGACY_MAGIC,
	decompressLz4Legacy,
	decompressLz4LegacyToBytes,
} from './legacy.js';
import {
	decompressLz4Switch,
	decompressLz4SwitchToBytes,
} from './switch.js';

/** The detected framing variant — useful for logging / UI. */
export type Lz4Variant = 'frame' | 'legacy' | 'switch';

/** Result of detecting an LZ4 framing variant. */
export interface Lz4Detection {
	variant: Lz4Variant;
}

/**
 * Detect which LZ4 variant a blob is encoded with by reading the
 * first 4 bytes. Falls back to `'switch'` for blobs without a
 * recognized magic — note that this fallback is a *guess*; the
 * actual format must be verified by a successful decompression.
 */
export async function detectLz4(blob: Blob): Promise<Lz4Detection> {
	if (blob.size < 4) {
		throw new Error(
			`LZ4: blob too small to detect format (${blob.size} bytes)`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const sig =
		(head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)) >>> 0;
	if (sig === LZ4_FRAME_MAGIC) return { variant: 'frame' };
	if (sig === LZ4_LEGACY_MAGIC) return { variant: 'legacy' };
	return { variant: 'switch' };
}

/**
 * Auto-detect the LZ4 variant and decompress. Returns the
 * decompressed payload as a `Blob`, plus the detected variant for
 * informational purposes.
 */
export async function decompressLz4(
	blob: Blob,
): Promise<{ data: Blob; variant: Lz4Variant }> {
	const { variant } = await detectLz4(blob);
	const data =
		variant === 'frame'
			? await decompressLz4Frame(blob)
			: variant === 'legacy'
				? await decompressLz4Legacy(blob)
				: await decompressLz4Switch(blob);
	return { data, variant };
}

/** Same as {@link decompressLz4} but returns raw bytes. */
export async function decompressLz4ToBytes(
	blob: Blob,
): Promise<{ data: Uint8Array; variant: Lz4Variant }> {
	const { variant } = await detectLz4(blob);
	const data =
		variant === 'frame'
			? await decompressLz4FrameToBytes(blob)
			: variant === 'legacy'
				? await decompressLz4LegacyToBytes(blob)
				: await decompressLz4SwitchToBytes(blob);
	return { data, variant };
}
