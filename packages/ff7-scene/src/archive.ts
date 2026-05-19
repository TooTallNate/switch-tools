/**
 * scene.bin outer-container parser.
 *
 * scene.bin is a concatenation of fixed-size 8192-byte blocks.
 * Each block holds 1..16 gzip-compressed "scenes" addressed via
 * a 64-byte pointer table at the block's start:
 *
 *   block layout (0x2000 bytes):
 *     +-- 0x00 --+ pointer table: u32[16] LE
 *     |          | each pointer = (offset_within_block) >> 2
 *     |          | 0xFFFFFFFF = unused slot (and all subsequent
 *     |          | slots are 0xFFFFFFFF — convention, not law)
 *     +-- 0x40 --+
 *     |          | compressed scene #0 (gzip stream, RFC 1952)
 *     |          | trailing 0xFF bytes pad to 4-byte boundary
 *     +----------+
 *     |          | compressed scene #1
 *     +----------+
 *     |   ...    |
 *     +-- 0x2000-+ 0xFF padding to end of block
 *
 * There are always exactly 256 scenes total, but the number of
 * BLOCKS depends on compression ratios (typically ~30-35). The
 * outer parser scans blocks sequentially until EOF.
 *
 * Each compressed payload, after gzip-decompression and trailing
 * 0xFF stripping, is exactly 0x1E80 bytes (PC / PSX-EN). PSX-JP
 * uses 0x1C50 but FF7 PC and the Switch port both use 0x1E80.
 */

export const SCENE_BLOCK_SIZE = 0x2000 as const;
export const SCENE_DECOMPRESSED_SIZE = 0x1e80 as const;
export const POINTER_TABLE_SIZE = 0x40 as const;
export const POINTERS_PER_BLOCK = 16 as const;
export const SCENES_TOTAL = 256 as const;

export class SceneBinParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SceneBinParseError';
	}
}

/**
 * Walk `scene.bin` blocks and yield each scene's COMPRESSED bytes
 * (still gzip-wrapped) plus the scene's global index 0..255. The
 * caller is responsible for gunzipping each yielded payload.
 *
 * Yielding compressed bytes lets the caller stream-decompress in
 * the browser via `DecompressionStream("gzip")` without having to
 * ship a gzip implementation in the parser package.
 */
export function* iterateSceneBinBlocks(
	bytes: Uint8Array,
): Generator<{ sceneIndex: number; compressed: Uint8Array }> {
	if (bytes.length === 0) return;
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	let sceneIndex = 0;
	for (let blockOff = 0; blockOff + SCENE_BLOCK_SIZE <= bytes.length; blockOff += SCENE_BLOCK_SIZE) {
		// Read up to 16 pointers; stop at the first 0xFFFFFFFF sentinel.
		const ptrs: number[] = [];
		for (let i = 0; i < POINTERS_PER_BLOCK; i++) {
			const p = view.getUint32(blockOff + i * 4, true);
			if (p === 0xffffffff) break;
			ptrs.push(p << 2);
		}
		if (ptrs.length === 0) continue; // blank block (rare, but possible)

		for (let i = 0; i < ptrs.length; i++) {
			const start = blockOff + ptrs[i]!;
			// Next scene's start = next pointer's offset, or end of block.
			const nextStart =
				i + 1 < ptrs.length ? blockOff + ptrs[i + 1]! : blockOff + SCENE_BLOCK_SIZE;
			// Strip trailing 0xFF padding.
			let end = nextStart;
			while (end > start && bytes[end - 1] === 0xff) end--;
			if (end <= start) continue;
			yield {
				sceneIndex: sceneIndex++,
				compressed: bytes.subarray(start, end),
			};
		}
	}
}

/**
 * Decompress a single gzip-wrapped scene payload using the
 * browser/Node-shared `DecompressionStream` API. Throws if
 * decompression fails or if the result isn't the expected size.
 *
 * If `DecompressionStream` isn't available (very old Node), the
 * caller can use any gzip library (Node's `zlib.gunzipSync`,
 * pako, fflate, etc.) and call `validateSceneBytes` directly.
 */
export async function gunzipSceneBytes(compressed: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'undefined') {
		throw new SceneBinParseError(
			'DecompressionStream is not available; use a native gzip library and call validateSceneBytes directly',
		);
	}
	// Copy into a fresh ArrayBuffer to satisfy strict DOM types
	// (some buffer-backed views aren't acceptable to Response).
	const buf = new Uint8Array(compressed.length);
	buf.set(compressed);
	const stream = new Response(buf).body!.pipeThrough(
		new DecompressionStream('gzip'),
	);
	const out = new Uint8Array(await new Response(stream).arrayBuffer());
	validateSceneBytes(out);
	return out;
}

/**
 * Throw if `bytes` isn't the expected decompressed scene size.
 * PC / PSX-EN = 0x1E80; the (unsupported) PSX-JP variant is 0x1C50.
 */
export function validateSceneBytes(bytes: Uint8Array): void {
	if (bytes.length === SCENE_DECOMPRESSED_SIZE) return;
	if (bytes.length === 0x1c50) {
		throw new SceneBinParseError(
			'Detected PSX-JP scene format (0x1C50 bytes); only PC/PSX-EN (0x1E80) is supported',
		);
	}
	throw new SceneBinParseError(
		`Expected ${SCENE_DECOMPRESSED_SIZE} bytes after decompression, got ${bytes.length}`,
	);
}
