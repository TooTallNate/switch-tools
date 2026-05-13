/**
 * Block-compressed texture decoders (BC1 / BC2 / BC3 / BC4 / BC5).
 *
 * All decoders return canonical RGBA8 pixel buffers — one byte per
 * channel in `R, G, B, A` order, row-major, top-to-bottom, length
 * `width * height * 4`. This matches Canvas2D's `ImageData.data`
 * layout so the output drops straight into a `<canvas>` without
 * any further shuffling.
 *
 * **Block structure recap.** Every BCn format encodes the image as
 * a grid of 4×4-pixel blocks. The image dimensions are always
 * rounded up to the nearest multiple of 4; tail pixels in
 * non-multiple-of-4 textures are decoded but the caller is
 * responsible for cropping. For each block:
 *
 *   - **BC1** (8 bytes): 2 RGB565 colors + 16 × 2-bit index. Optional
 *     1-bit alpha when the color pair encodes "punch-through".
 *   - **BC2** (16 bytes): 64-bit 4-bit-per-pixel alpha + BC1-style RGB.
 *   - **BC3** (16 bytes): BC4-style alpha block + BC1-style RGB.
 *   - **BC4** (8 bytes): 2 endpoint bytes + 16 × 3-bit index → 1-channel.
 *   - **BC5** (16 bytes): two BC4 blocks back-to-back (RG normal maps).
 *
 * Refs:
 *   - Microsoft S3TC / BC docs:
 *     https://learn.microsoft.com/en-us/windows/win32/direct3d10/d3d10-graphics-programming-guide-resources-block-compression
 *   - Khronos S3TC extension spec:
 *     https://registry.khronos.org/OpenGL/extensions/EXT/EXT_texture_compression_s3tc.txt
 *   - PVRTexLib reference implementation (public C++), tested against
 *     our decoders' output.
 */

/** Decoded RGBA8 image: pixel buffer + dimensions. */
export interface DecodedImage {
	/** Width in pixels. Equal to `paddedWidth` when the original was a multiple of 4. */
	width: number;
	/** Height in pixels. */
	height: number;
	/** Pixel buffer, length `width * height * 4`. RGBA8 little-endian. */
	pixels: Uint8Array;
}

/** Cropping mode for non-multiple-of-4 textures. */
interface BlockDecodeOptions {
	/** When true, the output is cropped to `width × height` instead of the padded block size. Default: true. */
	crop?: boolean;
}

/**
 * Decode a BC1 (DXT1) compressed image.
 *
 * BC1 supports an "alpha cutoff" mode: when the second color endpoint
 * is `≤` the first (numerically), the block decodes one of its 4
 * colors as transparent black instead of an interpolated color. This
 * decoder always emits 8-bit alpha (0 or 255 for transparent / opaque
 * pixels respectively).
 *
 * @param data    BC1 byte stream, must be at least
 *                `ceil(width/4) * ceil(height/4) * 8` bytes.
 * @param width   image width in pixels
 * @param height  image height in pixels
 */
export function decodeBC1(
	data: Uint8Array,
	width: number,
	height: number,
	options: BlockDecodeOptions = {},
): DecodedImage {
	return decodeBlockGrid(data, width, height, 8, decodeBC1Block, options);
}

/**
 * Decode a BC2 (DXT3) compressed image.
 *
 * BC2 = explicit 4-bit-per-pixel alpha + BC1-style RGB (without the
 * BC1 alpha-cutoff trick — BC1 colors here always interpolate as
 * 4-color, never 3-color+alpha).
 */
export function decodeBC2(
	data: Uint8Array,
	width: number,
	height: number,
	options: BlockDecodeOptions = {},
): DecodedImage {
	return decodeBlockGrid(data, width, height, 16, decodeBC2Block, options);
}

/**
 * Decode a BC3 (DXT5) compressed image. Used heavily for diffuse +
 * alpha textures (the alpha block has smoother gradients than BC2).
 */
export function decodeBC3(
	data: Uint8Array,
	width: number,
	height: number,
	options: BlockDecodeOptions = {},
): DecodedImage {
	return decodeBlockGrid(data, width, height, 16, decodeBC3Block, options);
}

/**
 * Decode a BC4 (ATI1 / RGTC1) compressed image — single 8-bit channel.
 * The decoded value goes to R, G, and B simultaneously (greyscale)
 * and A = 255, since BC4 is typically used for roughness/AO masks
 * that look best previewed as greyscale.
 */
export function decodeBC4(
	data: Uint8Array,
	width: number,
	height: number,
	options: BlockDecodeOptions = {},
): DecodedImage {
	return decodeBlockGrid(data, width, height, 8, decodeBC4Block, options);
}

/**
 * Decode a BC5 (ATI2 / RGTC2) compressed image. Two BC4 blocks per
 * 4×4 tile: one for R, one for G. B and A are set to 0 and 255
 * respectively, which yields the conventional unpacked-normal-map
 * preview (Z is computed at sample time on the GPU, not stored).
 */
export function decodeBC5(
	data: Uint8Array,
	width: number,
	height: number,
	options: BlockDecodeOptions = {},
): DecodedImage {
	return decodeBlockGrid(data, width, height, 16, decodeBC5Block, options);
}

// ---------------------------------------------------------------------------
// Block-grid driver
// ---------------------------------------------------------------------------

/**
 * Drive a per-block decoder over the full image.
 *
 * Output buffer is sized to the **block-padded** dimensions first;
 * if `crop` is requested (the default), we re-pack into a tight
 * buffer matching the requested `width × height`. The crop is just
 * a row-stride copy; it's cheap enough to not be worth a fast path.
 */
function decodeBlockGrid(
	data: Uint8Array,
	width: number,
	height: number,
	blockBytes: number,
	decodeBlock: (
		data: Uint8Array,
		blockOffset: number,
		dst: Uint8Array,
		dstStride: number,
		dstOffset: number,
	) => void,
	options: BlockDecodeOptions,
): DecodedImage {
	if (width <= 0 || height <= 0) {
		return { width, height, pixels: new Uint8Array(0) };
	}
	const blocksX = (width + 3) >> 2;
	const blocksY = (height + 3) >> 2;
	const requiredBytes = blocksX * blocksY * blockBytes;
	if (data.length < requiredBytes) {
		throw new Error(
			`BCn decode: expected ${requiredBytes} bytes for ${width}×${height} (${blocksX}×${blocksY} blocks × ${blockBytes}B), got ${data.length}.`,
		);
	}
	const paddedW = blocksX * 4;
	const paddedH = blocksY * 4;
	const padded = new Uint8Array(paddedW * paddedH * 4);
	const dstStride = paddedW * 4;
	for (let by = 0; by < blocksY; by++) {
		for (let bx = 0; bx < blocksX; bx++) {
			const blockOffset = (by * blocksX + bx) * blockBytes;
			const dstOffset = (by * 4) * dstStride + (bx * 4 * 4);
			decodeBlock(data, blockOffset, padded, dstStride, dstOffset);
		}
	}
	const crop = options.crop !== false;
	if (!crop || (paddedW === width && paddedH === height)) {
		return { width: paddedW, height: paddedH, pixels: padded };
	}
	const out = new Uint8Array(width * height * 4);
	const srcStride = paddedW * 4;
	const rowBytes = width * 4;
	for (let y = 0; y < height; y++) {
		out.set(padded.subarray(y * srcStride, y * srcStride + rowBytes), y * rowBytes);
	}
	return { width, height, pixels: out };
}

// ---------------------------------------------------------------------------
// BC1: 8-byte color block (RGB565 ×2 + 16 × 2-bit indices)
// ---------------------------------------------------------------------------

/**
 * Decode a single BC1 4×4 block into a 4-row strip of the destination
 * RGBA8 buffer. `dst[dstOffset..]` receives row 0, `dst[dstOffset+dstStride..]`
 * receives row 1, etc.
 */
function decodeBC1Block(
	data: Uint8Array,
	blockOffset: number,
	dst: Uint8Array,
	dstStride: number,
	dstOffset: number,
): void {
	const c0 = data[blockOffset]! | (data[blockOffset + 1]! << 8);
	const c1 = data[blockOffset + 2]! | (data[blockOffset + 3]! << 8);
	const indices =
		data[blockOffset + 4]! |
		(data[blockOffset + 5]! << 8) |
		(data[blockOffset + 6]! << 16) |
		(data[blockOffset + 7]! << 24);

	// Decode the 4-color palette.
	const palette = new Uint8Array(16);
	rgb565(c0, palette, 0);
	rgb565(c1, palette, 4);
	if (c0 > c1) {
		// 4-color block: linear interpolation at 1/3 and 2/3.
		for (let i = 0; i < 3; i++) {
			palette[8 + i] = ((2 * palette[i]!) + palette[4 + i]! + 1) / 3 | 0;
			palette[12 + i] = (palette[i]! + 2 * palette[4 + i]! + 1) / 3 | 0;
		}
		palette[11] = 255;
		palette[15] = 255;
	} else {
		// 3-color + transparent black block.
		for (let i = 0; i < 3; i++) {
			palette[8 + i] = (palette[i]! + palette[4 + i]!) >> 1;
			palette[12 + i] = 0;
		}
		palette[11] = 255;
		palette[15] = 0;
	}
	palette[3] = 255;
	palette[7] = 255;

	// 16 × 2-bit pixel indices, low bits = top-left, scanning rows
	// left-to-right then top-to-bottom (matches the DXT spec).
	let bits = indices >>> 0;
	for (let y = 0; y < 4; y++) {
		let p = dstOffset + y * dstStride;
		for (let x = 0; x < 4; x++) {
			const idx = (bits & 0x3) << 2;
			dst[p++] = palette[idx]!;
			dst[p++] = palette[idx + 1]!;
			dst[p++] = palette[idx + 2]!;
			dst[p++] = palette[idx + 3]!;
			bits = (bits >>> 2);
		}
	}
}

/** Expand a 16-bit RGB565 value into 3 RGB bytes at `out[off..off+3]`. */
function rgb565(v: number, out: Uint8Array, off: number): void {
	const r = (v >> 11) & 0x1f;
	const g = (v >> 5) & 0x3f;
	const b = v & 0x1f;
	// 5→8 and 6→8 bit expansion with the canonical "duplicate high
	// bits into the low" trick (produces values 0 and 255 exactly).
	out[off] = (r << 3) | (r >> 2);
	out[off + 1] = (g << 2) | (g >> 4);
	out[off + 2] = (b << 3) | (b >> 2);
}

// ---------------------------------------------------------------------------
// BC2 & BC3: 16-byte blocks (alpha + BC1-style color)
// ---------------------------------------------------------------------------

function decodeBC2Block(
	data: Uint8Array,
	blockOffset: number,
	dst: Uint8Array,
	dstStride: number,
	dstOffset: number,
): void {
	// First decode the color block at offset+8 (same as BC1 but the
	// "4-color" rule always applies; BC2 doesn't use the punch-through
	// alpha mode).
	decodeBC1Block(data, blockOffset + 8, dst, dstStride, dstOffset);
	// Then patch in the 64-bit explicit-alpha block (4 bits per pixel).
	let lo =
		data[blockOffset]! |
		(data[blockOffset + 1]! << 8) |
		(data[blockOffset + 2]! << 16) |
		(data[blockOffset + 3]! << 24);
	let hi =
		data[blockOffset + 4]! |
		(data[blockOffset + 5]! << 8) |
		(data[blockOffset + 6]! << 16) |
		(data[blockOffset + 7]! << 24);
	let bitsLo = lo >>> 0;
	let bitsHi = hi >>> 0;
	for (let y = 0; y < 4; y++) {
		let p = dstOffset + y * dstStride + 3; // alpha is at +3 of each RGBA8 pixel
		for (let x = 0; x < 4; x++) {
			let a4: number;
			if (y < 2) {
				a4 = bitsLo & 0xf;
				bitsLo = bitsLo >>> 4;
			} else {
				a4 = bitsHi & 0xf;
				bitsHi = bitsHi >>> 4;
			}
			dst[p] = (a4 << 4) | a4; // 4→8 bit expand
			p += 4;
		}
	}
}

function decodeBC3Block(
	data: Uint8Array,
	blockOffset: number,
	dst: Uint8Array,
	dstStride: number,
	dstOffset: number,
): void {
	// Color block first (same as BC1's 4-color path is forced by BC3).
	decodeBC1Block(data, blockOffset + 8, dst, dstStride, dstOffset);
	// Then overlay the BC4-style alpha (8-bit endpoints + 3-bit indices).
	patchBC4ChannelInPlace(data, blockOffset, dst, dstStride, dstOffset, 3);
}

// ---------------------------------------------------------------------------
// BC4 & BC5: single-channel and two-channel BC4 blocks
// ---------------------------------------------------------------------------

function decodeBC4Block(
	data: Uint8Array,
	blockOffset: number,
	dst: Uint8Array,
	dstStride: number,
	dstOffset: number,
): void {
	// BC4 decodes ONE channel; we splat it across R/G/B and set A=255
	// so the preview is naturally readable as greyscale.
	patchBC4ChannelInPlace(data, blockOffset, dst, dstStride, dstOffset, 0);
	// Mirror R into G and B, set A = 255.
	for (let y = 0; y < 4; y++) {
		let p = dstOffset + y * dstStride;
		for (let x = 0; x < 4; x++) {
			const r = dst[p]!;
			dst[p + 1] = r;
			dst[p + 2] = r;
			dst[p + 3] = 255;
			p += 4;
		}
	}
}

function decodeBC5Block(
	data: Uint8Array,
	blockOffset: number,
	dst: Uint8Array,
	dstStride: number,
	dstOffset: number,
): void {
	// First BC4 block → R channel.
	patchBC4ChannelInPlace(data, blockOffset, dst, dstStride, dstOffset, 0);
	// Second BC4 block → G channel.
	patchBC4ChannelInPlace(data, blockOffset + 8, dst, dstStride, dstOffset, 1);
	// B = 0 (Z is GPU-side reconstruction), A = 255.
	for (let y = 0; y < 4; y++) {
		let p = dstOffset + y * dstStride;
		for (let x = 0; x < 4; x++) {
			dst[p + 2] = 0;
			dst[p + 3] = 255;
			p += 4;
		}
	}
}

/**
 * Decode an 8-byte BC4 block (2 endpoints + 48 bits of 3-bit indices)
 * into a single channel of the destination RGBA8 buffer.
 *
 * @param channel which RGBA8 byte (0=R, 1=G, 2=B, 3=A) to write into.
 */
function patchBC4ChannelInPlace(
	data: Uint8Array,
	blockOffset: number,
	dst: Uint8Array,
	dstStride: number,
	dstOffset: number,
	channel: number,
): void {
	const a0 = data[blockOffset]!;
	const a1 = data[blockOffset + 1]!;
	// Build the 8-value palette.
	const palette = new Uint8Array(8);
	palette[0] = a0;
	palette[1] = a1;
	if (a0 > a1) {
		// 8-step interpolation between a0 and a1.
		palette[2] = (6 * a0 + 1 * a1) / 7 | 0;
		palette[3] = (5 * a0 + 2 * a1) / 7 | 0;
		palette[4] = (4 * a0 + 3 * a1) / 7 | 0;
		palette[5] = (3 * a0 + 4 * a1) / 7 | 0;
		palette[6] = (2 * a0 + 5 * a1) / 7 | 0;
		palette[7] = (1 * a0 + 6 * a1) / 7 | 0;
	} else {
		// 6-step interpolation + 0 and 255 endpoints.
		palette[2] = (4 * a0 + 1 * a1) / 5 | 0;
		palette[3] = (3 * a0 + 2 * a1) / 5 | 0;
		palette[4] = (2 * a0 + 3 * a1) / 5 | 0;
		palette[5] = (1 * a0 + 4 * a1) / 5 | 0;
		palette[6] = 0;
		palette[7] = 255;
	}
	// 16 × 3-bit indices packed into the 6 trailing bytes — read them
	// as a single 48-bit value (lo 32 + hi 16) using JS-safe bigint to
	// avoid u32 sign-extension surprises with shifts of >24.
	const lo =
		data[blockOffset + 2]! |
		(data[blockOffset + 3]! << 8) |
		(data[blockOffset + 4]! << 16) |
		(data[blockOffset + 5]! << 24);
	const hi = data[blockOffset + 6]! | (data[blockOffset + 7]! << 8);
	const indexBits = BigInt(lo >>> 0) | (BigInt(hi) << 32n);
	let bits = indexBits;
	for (let y = 0; y < 4; y++) {
		let p = dstOffset + y * dstStride + channel;
		for (let x = 0; x < 4; x++) {
			const idx = Number(bits & 0x7n);
			dst[p] = palette[idx]!;
			bits = bits >> 3n;
			p += 4;
		}
	}
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

/** All BCn formats this package decodes. */
export type BcnFormat = 'BC1' | 'BC2' | 'BC3' | 'BC4' | 'BC5';

/**
 * Dispatch a decode call by format name. Throws on unsupported formats
 * (BC6H and BC7 are out of scope for this package).
 */
export function decodeBcn(
	format: BcnFormat,
	data: Uint8Array,
	width: number,
	height: number,
	options: BlockDecodeOptions = {},
): DecodedImage {
	switch (format) {
		case 'BC1':
			return decodeBC1(data, width, height, options);
		case 'BC2':
			return decodeBC2(data, width, height, options);
		case 'BC3':
			return decodeBC3(data, width, height, options);
		case 'BC4':
			return decodeBC4(data, width, height, options);
		case 'BC5':
			return decodeBC5(data, width, height, options);
		default: {
			const _exhaustive: never = format;
			throw new Error(`Unsupported BCn format: ${_exhaustive as string}`);
		}
	}
}
