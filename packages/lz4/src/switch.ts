/**
 * LZ4 "Switch firmware" wrapper decoder.
 *
 * This is the format Nintendo uses for `.lz4` files inside Switch
 * firmware NCAs (e.g. the WebKit / NetFront NRO blobs in the
 * `0x803` NetFront data title). It's the simplest possible LZ4
 * wrapper — no magic bytes, just a size prefix:
 *
 *   ┌────────────────────────┬─────────────────────────────────┐
 *   │ u32 LE uncompressed    │      raw LZ4 block format       │
 *   │     size (4 bytes)     │   (single block, no chunking,   │
 *   │                        │    no checksums)                │
 *   └────────────────────────┴─────────────────────────────────┘
 *
 * Because there's no magic, this format can ONLY be detected by
 * the `.lz4` extension (or by a successful trial-decode). The
 * 4-byte size prefix is itself ambiguous with the start of a
 * compressed LZ4 block, so we deliberately reject blobs whose
 * declared size doesn't make sense (≤ 0 or unreasonably large
 * relative to the compressed input).
 *
 * Verified against retail Firmware 16.0.3, NCA `04d1bca6…` (the
 * NetFront/WebKit data NCA) — all 10 embedded `.nro.lz4` files
 * decompress cleanly to valid NRO0-magic NRO executables.
 */

import { decodeBlock } from './block.js';

/**
 * Maximum allowed expansion ratio (uncompressed / compressed) used
 * as a sanity check before we trust the declared size. LZ4's
 * achievable ratio is ~250×; we use 1024× as an extremely loose
 * upper bound that still catches obviously-bogus values.
 */
const MAX_EXPANSION_RATIO = 1024;

/**
 * Cheap heuristic check: blob size ≥ 5 (4-byte header + ≥1 byte
 * payload), the declared size is positive, and the implied
 * expansion ratio is reasonable.
 *
 * This is NOT a magic-byte check — there's no magic. It's a
 * sanity filter to weed out files that obviously aren't this
 * format.
 */
export async function isLz4Switch(blob: Blob): Promise<boolean> {
	if (blob.size < 5) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const declaredSize =
		head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24);
	if (declaredSize <= 0) return false;
	const compressedSize = blob.size - 4;
	return declaredSize <= compressedSize * MAX_EXPANSION_RATIO;
}

/**
 * Decompress a Switch-firmware-style LZ4 blob (`u32 size + raw
 * block`) into a fresh `Blob` of the decompressed payload.
 */
export async function decompressLz4Switch(blob: Blob): Promise<Blob> {
	const bytes = await decompressLz4SwitchToBytes(blob);
	return new Blob([bytes as BlobPart]);
}

/** Same as {@link decompressLz4Switch} but returns raw bytes. */
export async function decompressLz4SwitchToBytes(
	blob: Blob,
): Promise<Uint8Array> {
	if (blob.size < 5) {
		throw new Error(
			`LZ4 switch-wrapper: blob too small (${blob.size} bytes, need at least 5)`,
		);
	}
	const all = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(all.buffer, all.byteOffset, all.byteLength);
	const declaredSize = view.getUint32(0, true);
	if (declaredSize <= 0) {
		throw new Error(
			`LZ4 switch-wrapper: invalid declared size ${declaredSize}`,
		);
	}
	const compressed = all.subarray(4);
	return decodeBlock(compressed, declaredSize);
}
