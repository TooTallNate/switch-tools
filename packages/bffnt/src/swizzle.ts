/**
 * Tegra X1 GOB-block-linear swizzle math.
 *
 * Switch's NVN graphics API stores texture bytes in a tile-interleaved
 * layout for GPU cache locality, not as a normal width × height raster.
 * To use a texture in a normal pixel-grid sense (e.g. to draw it to a
 * canvas) we have to "deswizzle" it — undo the address mapping.
 *
 * The address calculation is documented in the Tegra X1 TRM and was
 * directly ported here from `aboood40091/BNTX-Extractor/swizzle.py`,
 * which is the canonical Python reference used by every Switch
 * texture tool.
 *
 * Inputs:
 *   width × height    pixel dimensions of the texture (in *pixels*,
 *                     not blocks)
 *   blkWidth, blkHeight  pixel dimensions of one compressed block —
 *                        4×4 for BC formats, 1×1 for uncompressed
 *   bpp               bytes per *block* (so a BC4 4×4 block is 8 bpp,
 *                     while RGBA8 is 4 bpp because each block IS a
 *                     pixel)
 *   blockHeightLog2   the texture's block-height exponent — derived
 *                     elsewhere via `getBlockHeight(blocksTall) >> 1`,
 *                     not stored in the BFFNT header. We hardcode it
 *                     to a safe Switch default and let the deswizzler
 *                     reject obviously-wrong inputs.
 *
 * Output:
 *   linear-pixel-grid bytes, in row-major (top-to-bottom, left-to-
 *   right) order, with `bpp` bytes per logical block.
 */

/** Round `n` up to the next multiple of `d`. */
function divRoundUp(n: number, d: number): number {
	return Math.floor((n + d - 1) / d);
}

/** Round `x` up to the next multiple of `y` (y must be a power of 2). */
function roundUp(x: number, y: number): number {
	return ((x - 1) | (y - 1)) + 1;
}

/**
 * Choose the appropriate `block_height` for the texture's pixel
 * height (in blocks, i.e. `divRoundUp(heightInPixels, blockHeight)`).
 * The TRM allows {1, 2, 4, 8, 16, 32}; we pick the largest power of
 * 2 ≤ heightInBlocks, capped at 16 (a safe default Nintendo uses).
 */
export function getBlockHeight(heightInBlocks: number): number {
	let bh = 16;
	while (bh > heightInBlocks && bh > 1) bh >>>= 1;
	return bh;
}

/**
 * Convert a (logical-block-grid) coordinate to a swizzled byte offset
 * inside the texture data. Direct port from `getAddrBlockLinear` in
 * the Python reference.
 */
function getAddrBlockLinear(
	x: number,
	y: number,
	imageWidth: number,
	bytesPerBlock: number,
	baseAddress: number,
	blockHeight: number,
): number {
	const imageWidthInGobs = divRoundUp(imageWidth * bytesPerBlock, 64);
	const gobAddress =
		baseAddress +
		Math.floor(y / (8 * blockHeight)) *
			512 *
			blockHeight *
			imageWidthInGobs +
		Math.floor((x * bytesPerBlock) / 64) * 512 * blockHeight +
		Math.floor((y % (8 * blockHeight)) / 8) * 512;

	const xb = x * bytesPerBlock;
	return (
		gobAddress +
		Math.floor((xb % 64) / 32) * 256 +
		Math.floor((y % 8) / 2) * 64 +
		Math.floor((xb % 32) / 16) * 32 +
		(y % 2) * 16 +
		(xb % 16)
	);
}

/**
 * Deswizzle a Tegra X1 block-linear texture into a normal row-major
 * byte layout. The input is treated as a grid of `widthInBlocks × heightInBlocks`
 * cells (each `bytesPerBlock` bytes); the output is the same grid in
 * left-to-right, top-to-bottom order.
 *
 * For uncompressed RGBA8: `blkWidth=blkHeight=1`, `bpp=4`. For BC4 /
 * BC5: `blkWidth=blkHeight=4`, `bpp=8` (BC4) or 16 (BC5). Caller
 * passes the *pixel* dimensions; the function divides them down by
 * the block size internally.
 */
export function deswizzle(opts: {
	width: number;
	height: number;
	blkWidth: number;
	blkHeight: number;
	bytesPerBlock: number;
	data: Uint8Array;
	/** Block-height exponent. Pass `getBlockHeight(divRoundUp(height, blkHeight)) >>> ?` — see below. */
	blockHeight?: number;
	/** Pad pitch to 32-byte rows (pitch-linear path). False on Switch. */
	pitchLinear?: boolean;
}): Uint8Array {
	const { width, height, blkWidth, blkHeight, bytesPerBlock, data } = opts;
	const widthInBlocks = divRoundUp(width, blkWidth);
	const heightInBlocks = divRoundUp(height, blkHeight);

	if (opts.pitchLinear) {
		// Linear (non-tiled) layout: just round pitch up to 32 bytes.
		const pitch = roundUp(widthInBlocks * bytesPerBlock, 32);
		const out = new Uint8Array(widthInBlocks * heightInBlocks * bytesPerBlock);
		for (let y = 0; y < heightInBlocks; y++) {
			for (let x = 0; x < widthInBlocks; x++) {
				const srcPos = y * pitch + x * bytesPerBlock;
				const dstPos = (y * widthInBlocks + x) * bytesPerBlock;
				if (srcPos + bytesPerBlock <= data.length) {
					for (let i = 0; i < bytesPerBlock; i++) {
						out[dstPos + i] = data[srcPos + i];
					}
				}
			}
		}
		return out;
	}

	const blockHeight = opts.blockHeight ?? getBlockHeight(heightInBlocks);
	const pitch = roundUp(widthInBlocks * bytesPerBlock, 64);
	const surfSize = pitch * roundUp(heightInBlocks, blockHeight * 8);
	const out = new Uint8Array(widthInBlocks * heightInBlocks * bytesPerBlock);

	for (let y = 0; y < heightInBlocks; y++) {
		for (let x = 0; x < widthInBlocks; x++) {
			const srcPos = getAddrBlockLinear(
				x,
				y,
				widthInBlocks,
				bytesPerBlock,
				0,
				blockHeight,
			);
			const dstPos = (y * widthInBlocks + x) * bytesPerBlock;
			if (
				srcPos + bytesPerBlock <= data.length &&
				srcPos + bytesPerBlock <= surfSize
			) {
				for (let i = 0; i < bytesPerBlock; i++) {
					out[dstPos + i] = data[srcPos + i];
				}
			}
		}
	}
	return out;
}
