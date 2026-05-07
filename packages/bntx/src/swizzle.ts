/**
 * Tegra X1 GOB block-linear deswizzling.
 *
 * Switch's NVN graphics API stores texture bytes in a tile-
 * interleaved layout for GPU cache locality, not as a normal
 * width × height raster. To use a texture as a normal pixel grid
 * (e.g. to draw it to a `<canvas>` or feed it to a BCn decoder)
 * we have to "deswizzle" it — undo the address mapping.
 *
 * The address calculation is documented in the Tegra X1 TRM and
 * is directly ported here from `aboood40091/BNTX-Extractor/swizzle.py`,
 * which is the canonical Python reference used by every Switch
 * texture tool.
 */

/** Round `n` up to the next multiple of `d` (any positive `d`). */
function divRoundUp(n: number, d: number): number {
	return Math.floor((n + d - 1) / d);
}

/** Round `x` up to the next multiple of `y`. `y` must be a power of 2. */
function roundUpPow2(x: number, y: number): number {
	return ((x - 1) | (y - 1)) + 1;
}

/**
 * Tegra texture-layout block height. Reads bits 0-2 of the BNTX
 * BRTI's `textureLayout` field, which is the exponent of the block
 * height (block_height = 1 << blockHeightLog2). Capped to 16 since
 * that's the maximum the hardware supports.
 */
export function blockHeightFromLog2(blockHeightLog2: number): number {
	return Math.min(16, 1 << (blockHeightLog2 & 0x07));
}

/**
 * Pick a block_height for `heightInBlocks` when no explicit
 * exponent is available. Returns the largest power of 2 ≤ height,
 * capped at 16. Used as a fallback for textures without a stored
 * `textureLayout` field.
 */
export function pickBlockHeight(heightInBlocks: number): number {
	let bh = 16;
	while (bh > heightInBlocks && bh > 1) bh >>>= 1;
	return bh;
}

/**
 * Compute the byte address of a (block-grid) coordinate inside a
 * Tegra block-linear texture. Direct port of `getAddrBlockLinear`
 * from the Python reference.
 */
function getAddrBlockLinear(
	x: number,
	y: number,
	imageWidthInBlocks: number,
	bytesPerBlock: number,
	baseAddress: number,
	blockHeight: number,
): number {
	const imageWidthInGobs = divRoundUp(imageWidthInBlocks * bytesPerBlock, 64);
	const gobAddress =
		baseAddress +
		Math.floor(y / (8 * blockHeight)) * 512 * blockHeight * imageWidthInGobs +
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

export interface DeswizzleOptions {
	/** Texture pixel width (NOT block width). */
	width: number;
	/** Texture pixel height. */
	height: number;
	/** Pixel width of a compressed block (4 for BCn, 1 for uncompressed, etc.). */
	blkWidth: number;
	/** Pixel height of a compressed block. */
	blkHeight: number;
	/** Bytes per block. */
	bytesPerBlock: number;
	/** Source bytes (one layer's swizzled mip-0 data). */
	data: Uint8Array;
	/**
	 * Tegra block-height exponent (from BRTI's `textureLayout & 7`).
	 * If omitted, defaults to {@link pickBlockHeight} for the
	 * computed block height.
	 */
	blockHeight?: number;
	/**
	 * If true, treat `data` as already linear (pitch-padded to
	 * 32-byte rows) and just rearrange. If false (the default),
	 * deswizzle the GOB block-linear layout. Switch BNTX is always
	 * block-linear, so this flag is rarely set.
	 */
	pitchLinear?: boolean;
}

/**
 * Deswizzle a Tegra X1 block-linear texture into a normal row-
 * major byte layout. The output is a `widthInBlocks ×
 * heightInBlocks` grid of `bytesPerBlock`-sized cells in left-to-
 * right, top-to-bottom order — exactly what BCn / uncompressed
 * decoders expect.
 */
export function deswizzle(opts: DeswizzleOptions): Uint8Array {
	const { width, height, blkWidth, blkHeight, bytesPerBlock, data } = opts;
	const widthInBlocks = divRoundUp(width, blkWidth);
	const heightInBlocks = divRoundUp(height, blkHeight);
	const totalOutBytes = widthInBlocks * heightInBlocks * bytesPerBlock;

	if (opts.pitchLinear) {
		const pitch = roundUpPow2(widthInBlocks * bytesPerBlock, 32);
		const out = new Uint8Array(totalOutBytes);
		for (let y = 0; y < heightInBlocks; y++) {
			for (let x = 0; x < widthInBlocks; x++) {
				const srcPos = y * pitch + x * bytesPerBlock;
				const dstPos = (y * widthInBlocks + x) * bytesPerBlock;
				if (srcPos + bytesPerBlock <= data.length) {
					for (let i = 0; i < bytesPerBlock; i++) out[dstPos + i] = data[srcPos + i];
				}
			}
		}
		return out;
	}

	const blockHeight = opts.blockHeight ?? pickBlockHeight(heightInBlocks);
	const pitch = roundUpPow2(widthInBlocks * bytesPerBlock, 64);
	const surfSize = pitch * roundUpPow2(heightInBlocks, blockHeight * 8);
	const out = new Uint8Array(totalOutBytes);
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
				for (let i = 0; i < bytesPerBlock; i++) out[dstPos + i] = data[srcPos + i];
			}
		}
	}
	return out;
}
