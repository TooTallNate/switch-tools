/**
 * BC1..BC5 block-compressed texture decoders. Each format packs a
 * 4×4 pixel block into 8 or 16 bytes; we decode each block to
 * RGBA8 in place, writing into the output buffer at the block's
 * correct (px, py) coordinate.
 *
 * BC6 and BC7 (the HDR / high-quality variants) live in
 * `decode-bc7.ts` because BC7 alone is ~600 LOC and BC6 needs a
 * different (16-bit float) output path.
 *
 * Reference: Microsoft DXT/BC documentation + Nvidia Texture Tools
 * source.
 */

/** Expand 5-bit channel to 8-bit via `(n << 3) | (n >> 2)` rounding. */
const expand5 = (n: number) => (n << 3) | (n >> 2);
/** Expand 6-bit channel to 8-bit. */
const expand6 = (n: number) => (n << 2) | (n >> 4);

/**
 * Decode the 16-bit RGB565 endpoints + 32-bit index table that
 * BC1, BC2, and BC3 all share for their colour data.
 *
 * Writes 16 RGB triplets into `outRgb` (48 bytes per block) and
 * the four-colour palette into `palette` (12 bytes per block).
 *
 * For BC1: returns whether the alternate (3-colour + transparent)
 * mode is in use, so the caller can write A=0 for index 3.
 */
function decodeBc1ColourBlock(
	src: Uint8Array,
	off: number,
	outRgb: Uint8Array,
	outRgbOff: number,
): { bc1Alpha: boolean } {
	const c0 = src[off] | (src[off + 1] << 8);
	const c1 = src[off + 2] | (src[off + 3] << 8);
	const r0 = expand5((c0 >> 11) & 0x1f);
	const g0 = expand6((c0 >> 5) & 0x3f);
	const b0 = expand5(c0 & 0x1f);
	const r1 = expand5((c1 >> 11) & 0x1f);
	const g1 = expand6((c1 >> 5) & 0x3f);
	const b1 = expand5(c1 & 0x1f);
	const palette = new Uint8Array(12);
	palette[0] = r0;
	palette[1] = g0;
	palette[2] = b0;
	palette[3] = r1;
	palette[4] = g1;
	palette[5] = b1;
	const bc1Alpha = c0 <= c1;
	if (!bc1Alpha) {
		palette[6] = (2 * r0 + r1) / 3;
		palette[7] = (2 * g0 + g1) / 3;
		palette[8] = (2 * b0 + b1) / 3;
		palette[9] = (r0 + 2 * r1) / 3;
		palette[10] = (g0 + 2 * g1) / 3;
		palette[11] = (b0 + 2 * b1) / 3;
	} else {
		palette[6] = (r0 + r1) / 2;
		palette[7] = (g0 + g1) / 2;
		palette[8] = (b0 + b1) / 2;
		// Index 3 is "transparent black" in BC1's alternate mode.
		palette[9] = 0;
		palette[10] = 0;
		palette[11] = 0;
	}
	const indices =
		src[off + 4] |
		(src[off + 5] << 8) |
		(src[off + 6] << 16) |
		(src[off + 7] << 24);
	for (let i = 0; i < 16; i++) {
		const idx = (indices >>> (i * 2)) & 0x03;
		outRgb[outRgbOff + i * 3 + 0] = palette[idx * 3 + 0];
		outRgb[outRgbOff + i * 3 + 1] = palette[idx * 3 + 1];
		outRgb[outRgbOff + i * 3 + 2] = palette[idx * 3 + 2];
	}
	return { bc1Alpha };
}

/** BC1 (DXT1) — 8 bytes per block, RGB + 1-bit alpha. */
export function decodeBC1(src: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	const blocksWide = Math.ceil(w / 4);
	const blocksTall = Math.ceil(h / 4);
	const tmp = new Uint8Array(48);
	for (let by = 0; by < blocksTall; by++) {
		for (let bx = 0; bx < blocksWide; bx++) {
			const off = (by * blocksWide + bx) * 8;
			if (off + 8 > src.length) continue;
			const { bc1Alpha } = decodeBc1ColourBlock(src, off, tmp, 0);
			// Re-read indices for alpha decisions when in alternate mode.
			const indices =
				src[off + 4] |
				(src[off + 5] << 8) |
				(src[off + 6] << 16) |
				(src[off + 7] << 24);
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px;
					const y = by * 4 + py;
					if (x >= w || y >= h) continue;
					const i = py * 4 + px;
					const idx = (indices >>> (i * 2)) & 0x03;
					const dst = (y * w + x) * 4;
					out[dst + 0] = tmp[i * 3 + 0];
					out[dst + 1] = tmp[i * 3 + 1];
					out[dst + 2] = tmp[i * 3 + 2];
					out[dst + 3] = bc1Alpha && idx === 3 ? 0 : 255;
				}
			}
		}
	}
	return out;
}

/** BC2 (DXT3) — 16 bytes/block: 8 bytes of explicit 4-bit alpha, then BC1 colour block. */
export function decodeBC2(src: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	const blocksWide = Math.ceil(w / 4);
	const blocksTall = Math.ceil(h / 4);
	const tmp = new Uint8Array(48);
	for (let by = 0; by < blocksTall; by++) {
		for (let bx = 0; bx < blocksWide; bx++) {
			const off = (by * blocksWide + bx) * 16;
			if (off + 16 > src.length) continue;
			// Colour: bytes 8..15 like BC1.
			decodeBc1ColourBlock(src, off + 8, tmp, 0);
			// Alpha: bytes 0..7, two nibbles per pixel (LE).
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px;
					const y = by * 4 + py;
					if (x >= w || y >= h) continue;
					const i = py * 4 + px;
					const aByte = src[off + (i >> 1)];
					const aNibble = i & 1 ? (aByte >> 4) : aByte & 0x0f;
					const dst = (y * w + x) * 4;
					out[dst + 0] = tmp[i * 3 + 0];
					out[dst + 1] = tmp[i * 3 + 1];
					out[dst + 2] = tmp[i * 3 + 2];
					out[dst + 3] = aNibble * 17; // 4-bit → 8-bit
				}
			}
		}
	}
	return out;
}

/**
 * Decode a BC3 / BC4 / BC5 8-byte alpha block into 16 8-bit
 * values. Shared between BC3 (alpha channel of RGBA), BC4 (single
 * channel) and BC5 (two channels).
 */
function decodeAlphaBlock(
	src: Uint8Array,
	off: number,
	out: Uint8Array,
	outOff: number,
	signed: boolean,
): void {
	const a0Raw = src[off];
	const a1Raw = src[off + 1];
	const palette = new Uint8Array(8);
	let a0: number;
	let a1: number;
	if (signed) {
		a0 = a0Raw < 128 ? a0Raw + 128 : a0Raw - 128;
		a1 = a1Raw < 128 ? a1Raw + 128 : a1Raw - 128;
	} else {
		a0 = a0Raw;
		a1 = a1Raw;
	}
	palette[0] = a0;
	palette[1] = a1;
	if (a0 > a1) {
		palette[2] = Math.round((6 * a0 + 1 * a1) / 7);
		palette[3] = Math.round((5 * a0 + 2 * a1) / 7);
		palette[4] = Math.round((4 * a0 + 3 * a1) / 7);
		palette[5] = Math.round((3 * a0 + 4 * a1) / 7);
		palette[6] = Math.round((2 * a0 + 5 * a1) / 7);
		palette[7] = Math.round((1 * a0 + 6 * a1) / 7);
	} else {
		palette[2] = Math.round((4 * a0 + 1 * a1) / 5);
		palette[3] = Math.round((3 * a0 + 2 * a1) / 5);
		palette[4] = Math.round((2 * a0 + 3 * a1) / 5);
		palette[5] = Math.round((1 * a0 + 4 * a1) / 5);
		palette[6] = 0;
		palette[7] = 255;
	}
	const lo24 =
		src[off + 2] | (src[off + 3] << 8) | (src[off + 4] << 16);
	const hi24 =
		src[off + 5] | (src[off + 6] << 8) | (src[off + 7] << 16);
	for (let i = 0; i < 16; i++) {
		const bit = i * 3;
		const v = bit < 24 ? (lo24 >> bit) & 0x07 : (hi24 >> (bit - 24)) & 0x07;
		out[outOff + i] = palette[v];
	}
}

/** BC3 (DXT5) — 16 bytes/block: BC4-style alpha + BC1 colour. */
export function decodeBC3(src: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	const blocksWide = Math.ceil(w / 4);
	const blocksTall = Math.ceil(h / 4);
	const tmpRgb = new Uint8Array(48);
	const tmpA = new Uint8Array(16);
	for (let by = 0; by < blocksTall; by++) {
		for (let bx = 0; bx < blocksWide; bx++) {
			const off = (by * blocksWide + bx) * 16;
			if (off + 16 > src.length) continue;
			decodeAlphaBlock(src, off + 0, tmpA, 0, false);
			decodeBc1ColourBlock(src, off + 8, tmpRgb, 0);
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px;
					const y = by * 4 + py;
					if (x >= w || y >= h) continue;
					const i = py * 4 + px;
					const dst = (y * w + x) * 4;
					out[dst + 0] = tmpRgb[i * 3 + 0];
					out[dst + 1] = tmpRgb[i * 3 + 1];
					out[dst + 2] = tmpRgb[i * 3 + 2];
					out[dst + 3] = tmpA[i];
				}
			}
		}
	}
	return out;
}

/**
 * BC4 — 8 bytes/block: a single alpha block treated as a single
 * channel. Output: white RGB with the channel in alpha (mode='alpha')
 * or grayscale RGB with full alpha (mode='rgb').
 */
export function decodeBC4(
	src: Uint8Array,
	w: number,
	h: number,
	options: { signed?: boolean; mode?: 'alpha' | 'rgb' } = {},
): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	const blocksWide = Math.ceil(w / 4);
	const blocksTall = Math.ceil(h / 4);
	const tmp = new Uint8Array(16);
	const mode = options.mode ?? 'rgb';
	for (let by = 0; by < blocksTall; by++) {
		for (let bx = 0; bx < blocksWide; bx++) {
			const off = (by * blocksWide + bx) * 8;
			if (off + 8 > src.length) continue;
			decodeAlphaBlock(src, off, tmp, 0, options.signed === true);
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px;
					const y = by * 4 + py;
					if (x >= w || y >= h) continue;
					const v = tmp[py * 4 + px];
					const dst = (y * w + x) * 4;
					if (mode === 'alpha') {
						out[dst + 0] = 255;
						out[dst + 1] = 255;
						out[dst + 2] = 255;
						out[dst + 3] = v;
					} else {
						out[dst + 0] = v;
						out[dst + 1] = v;
						out[dst + 2] = v;
						out[dst + 3] = 255;
					}
				}
			}
		}
	}
	return out;
}

/**
 * BC5 — 16 bytes/block: two BC4-style alpha blocks. Typically used
 * for tangent-space normal maps: channel 0 → R, channel 1 → G,
 * derived B = sqrt(1 - R² - G²).
 *
 * Output format options:
 *   - `'rg'`: just R and G as decoded (B=0, A=255). What the bytes
 *     actually represent.
 *   - `'normal'`: reconstruct the third channel as if this were a
 *     normalised tangent-space normal — what the user expects when
 *     they preview a `*_nrm.bntx`. Default.
 */
export function decodeBC5(
	src: Uint8Array,
	w: number,
	h: number,
	options: { signed?: boolean; mode?: 'rg' | 'normal' } = {},
): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	const blocksWide = Math.ceil(w / 4);
	const blocksTall = Math.ceil(h / 4);
	const tmpR = new Uint8Array(16);
	const tmpG = new Uint8Array(16);
	const mode = options.mode ?? 'normal';
	for (let by = 0; by < blocksTall; by++) {
		for (let bx = 0; bx < blocksWide; bx++) {
			const off = (by * blocksWide + bx) * 16;
			if (off + 16 > src.length) continue;
			decodeAlphaBlock(src, off + 0, tmpR, 0, options.signed === true);
			decodeAlphaBlock(src, off + 8, tmpG, 0, options.signed === true);
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px;
					const y = by * 4 + py;
					if (x >= w || y >= h) continue;
					const r = tmpR[py * 4 + px];
					const g = tmpG[py * 4 + px];
					const dst = (y * w + x) * 4;
					out[dst + 0] = r;
					out[dst + 1] = g;
					if (mode === 'normal') {
						// Reconstruct the third axis in normal-map fashion:
						//   nx = r/127.5 - 1, ny = g/127.5 - 1
						//   nz = sqrt(max(0, 1 - nx² - ny²))
						//   B = (nz + 1) * 127.5
						const nx = r / 127.5 - 1;
						const ny = g / 127.5 - 1;
						const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
						out[dst + 2] = Math.round((nz + 1) * 127.5);
					} else {
						out[dst + 2] = 0;
					}
					out[dst + 3] = 255;
				}
			}
		}
	}
	return out;
}
