/**
 * N64 RDP texture formats.
 *
 * A texture is identified by a (format, bit-size) pair taken from
 * `G_SETTIMG` / `G_SETTILE`. Dimensions come from `G_SETTILESIZE`
 * (or from a `G_LOADBLOCK` texel count), not from the image data
 * itself — there is no header.
 *
 * Colour-indexed (CI) formats index a TLUT ("texture look-up
 * table") loaded separately via `G_LOADTLUT`; entries are RGBA16.
 *
 * All output is tightly-packed top-down RGBA8, matching the app's
 * `DecodedTexture` convention.
 */

/** `G_IM_FMT_*` image formats. */
export const ImageFormat = {
	RGBA: 0,
	YUV: 1,
	CI: 2,
	IA: 3,
	I: 4,
} as const;

/** `G_IM_SIZ_*` bit sizes. */
export const ImageSize = {
	BITS_4: 0,
	BITS_8: 1,
	BITS_16: 2,
	BITS_32: 3,
} as const;

/** Human-readable `fmt`/`siz` combination, e.g. `"RGBA16"`. */
export function textureFormatName(format: number, size: number): string {
	const fmt =
		(['RGBA', 'YUV', 'CI', 'IA', 'I'] as const)[format] ?? `FMT${format}`;
	const bits = [4, 8, 16, 32][size] ?? size;
	return `${fmt}${bits}`;
}

/** Bits per texel for a (format, size) pair. */
export function bitsPerTexel(size: number): number {
	return [4, 8, 16, 32][size] ?? 0;
}

/** Expand a 5-bit channel to 8 bits by bit replication. */
function expand5(v: number): number {
	return (v << 3) | (v >> 2);
}

/** Expand a 3-bit channel to 8 bits. */
function expand3(v: number): number {
	return (v << 5) | (v << 2) | (v >> 1);
}

/** Expand a 4-bit channel to 8 bits. */
function expand4(v: number): number {
	return (v << 4) | v;
}

/** Decode one big-endian RGBA5551 texel into RGBA8. */
function rgba16ToRgba8(v: number, out: Uint8Array, o: number): void {
	out[o] = expand5((v >> 11) & 31);
	out[o + 1] = expand5((v >> 6) & 31);
	out[o + 2] = expand5((v >> 1) & 31);
	out[o + 3] = v & 1 ? 255 : 0;
}

export interface DecodeTextureOptions {
	/** Palette bytes for CI formats (RGBA16 entries, big-endian). */
	tlut?: Uint8Array;
}

/**
 * Decode an N64 texture to top-down RGBA8.
 *
 * Returns `null` when the (format, size) pair is unsupported (YUV,
 * which no retail model geometry uses) or the source data is too
 * short for the requested dimensions.
 */
export function decodeN64Texture(
	data: Uint8Array,
	offset: number,
	width: number,
	height: number,
	format: number,
	size: number,
	options: DecodeTextureOptions = {},
): Uint8Array | null {
	if (width <= 0 || height <= 0) return null;
	const texels = width * height;
	const bits = bitsPerTexel(size);
	if (bits === 0) return null;
	const needed = Math.ceil((texels * bits) / 8);
	if (offset < 0 || offset + needed > data.length) return null;

	const out = new Uint8Array(texels * 4);

	if (format === ImageFormat.RGBA && size === ImageSize.BITS_16) {
		for (let i = 0; i < texels; i++) {
			const o = offset + i * 2;
			rgba16ToRgba8((data[o] << 8) | data[o + 1], out, i * 4);
		}
		return out;
	}

	if (format === ImageFormat.RGBA && size === ImageSize.BITS_32) {
		for (let i = 0; i < texels; i++) {
			const o = offset + i * 4;
			out[i * 4] = data[o];
			out[i * 4 + 1] = data[o + 1];
			out[i * 4 + 2] = data[o + 2];
			out[i * 4 + 3] = data[o + 3];
		}
		return out;
	}

	if (format === ImageFormat.CI) {
		const tlut = options.tlut;
		for (let i = 0; i < texels; i++) {
			let index: number;
			if (size === ImageSize.BITS_4) {
				const b = data[offset + (i >> 1)];
				index = i & 1 ? b & 0xf : b >> 4;
			} else if (size === ImageSize.BITS_8) {
				index = data[offset + i];
			} else {
				return null;
			}
			if (tlut && index * 2 + 1 < tlut.length) {
				rgba16ToRgba8(
					(tlut[index * 2] << 8) | tlut[index * 2 + 1],
					out,
					i * 4,
				);
			} else {
				// No palette available — render the raw index as
				// greyscale so the geometry is still inspectable.
				const v = size === ImageSize.BITS_4 ? expand4(index) : index;
				out[i * 4] = v;
				out[i * 4 + 1] = v;
				out[i * 4 + 2] = v;
				out[i * 4 + 3] = 255;
			}
		}
		return out;
	}

	if (format === ImageFormat.IA) {
		for (let i = 0; i < texels; i++) {
			let intensity: number;
			let alpha: number;
			if (size === ImageSize.BITS_4) {
				const b = data[offset + (i >> 1)];
				const n = i & 1 ? b & 0xf : b >> 4;
				intensity = expand3((n >> 1) & 7);
				alpha = n & 1 ? 255 : 0;
			} else if (size === ImageSize.BITS_8) {
				const b = data[offset + i];
				intensity = expand4(b >> 4);
				alpha = expand4(b & 0xf);
			} else if (size === ImageSize.BITS_16) {
				intensity = data[offset + i * 2];
				alpha = data[offset + i * 2 + 1];
			} else {
				return null;
			}
			out[i * 4] = intensity;
			out[i * 4 + 1] = intensity;
			out[i * 4 + 2] = intensity;
			out[i * 4 + 3] = alpha;
		}
		return out;
	}

	if (format === ImageFormat.I) {
		for (let i = 0; i < texels; i++) {
			let v: number;
			if (size === ImageSize.BITS_4) {
				const b = data[offset + (i >> 1)];
				v = expand4(i & 1 ? b & 0xf : b >> 4);
			} else if (size === ImageSize.BITS_8) {
				v = data[offset + i];
			} else {
				return null;
			}
			out[i * 4] = v;
			out[i * 4 + 1] = v;
			out[i * 4 + 2] = v;
			// Intensity-only textures are opaque; the combiner
			// usually multiplies them against a primitive colour.
			out[i * 4 + 3] = 255;
		}
		return out;
	}

	// YUV and anything else: unsupported.
	return null;
}
