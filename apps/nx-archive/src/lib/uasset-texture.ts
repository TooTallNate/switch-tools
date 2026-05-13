/**
 * Decode a UE Texture2D / TextureCube mip to RGBA8 pixels.
 *
 * This is the bridge between {@link parseTexturePlatformData}
 * (binary layout decoder) and the lower-level pixel-format
 * decoders (`@tootallnate/bcn`, `@tootallnate/astc-wasm`, plus
 * a couple of raw passthroughs). Returns an `ImageData`-shaped
 * object the caller can paint directly into a canvas.
 *
 * Format coverage in this PAK's sample of ~1000 textures:
 *   PF_ASTC_6x6   ~40%  ✓
 *   PF_BC4         ~34% ✓
 *   PF_B8G8R8A8    ~17% ✓
 *   PF_BC5          ~8% ✓ (with Z reconstruction for the normal-map preview)
 *   PF_FloatRGBA   <1%  ✓
 *   PF_G8          <1%  ✓
 *   PF_BC7         <1%  ✗ (deferred; complex per-block decoder)
 *   PF_BC1/3       0%    ✓ anyway, easy
 *
 * The PixelFormat → block-size mapping lives here so the texture
 * preview component doesn't have to know per-format ASTC block
 * dimensions etc.
 */

import { decodeBcn, type BcnFormat } from '@tootallnate/bcn';
import { decodeAstc } from './astc.js';

export interface DecodedMip {
	width: number;
	height: number;
	/** RGBA8 bytes, length = width * height * 4. */
	pixels: Uint8Array;
	/** True if the decoder applied normal-map Z reconstruction (BC5 + similar). */
	normalReconstructed?: boolean;
}

/**
 * Decode a single mip given its UE PixelFormat name + compressed bytes.
 *
 * Throws on unsupported formats so the preview can surface a clear
 * error message ("PixelFormat PF_X not supported yet") instead of
 * silently rendering garbage.
 */
export async function decodeUeMip(
	pixelFormat: string,
	width: number,
	height: number,
	bytes: Uint8Array,
): Promise<DecodedMip> {
	// ASTC: block dimensions are encoded in the format name.
	const astcMatch = /^PF_ASTC_(\d+)x(\d+)$/.exec(pixelFormat);
	if (astcMatch) {
		const blockW = Number(astcMatch[1]);
		const blockH = Number(astcMatch[2]);
		const pixels = await decodeAstc(width, height, blockW, blockH, bytes);
		return { width, height, pixels };
	}

	// BC family.
	const bcnFormat = mapBcnFormat(pixelFormat);
	if (bcnFormat) {
		const img = decodeBcn(bcnFormat, bytes, width, height);
		// BC5 is conventionally a normal map: reconstruct Z so the preview
		// looks like the canonical purple-blue tangent-space normal map
		// rather than the half-decoded olive that BC5's stored R/G alone
		// produce.
		if (bcnFormat === 'BC5') {
			return {
				...img,
				pixels: reconstructNormalMapZ(img.pixels),
				normalReconstructed: true,
			};
		}
		return img;
	}

	// Raw formats: cheap CPU passthrough.
	switch (pixelFormat) {
		case 'PF_B8G8R8A8': {
			// UE stores BGRA on disk; convert to RGBA in-place into a fresh buffer.
			const expectedSize = width * height * 4;
			if (bytes.length < expectedSize) {
				throw new Error(
					`PF_B8G8R8A8: expected ${expectedSize} bytes for ${width}x${height}, got ${bytes.length}.`,
				);
			}
			const out = new Uint8Array(expectedSize);
			for (let i = 0; i < expectedSize; i += 4) {
				out[i] = bytes[i + 2]!;     // R ← B
				out[i + 1] = bytes[i + 1]!; // G
				out[i + 2] = bytes[i]!;     // B ← R
				out[i + 3] = bytes[i + 3]!; // A
			}
			return { width, height, pixels: out };
		}
		case 'PF_R8G8B8A8':
		case 'PF_R8G8B8A8_UINT': {
			const expectedSize = width * height * 4;
			if (bytes.length < expectedSize) {
				throw new Error(
					`${pixelFormat}: expected ${expectedSize} bytes for ${width}x${height}, got ${bytes.length}.`,
				);
			}
			return { width, height, pixels: bytes.slice(0, expectedSize) };
		}
		case 'PF_G8':
		case 'PF_A8': {
			const expectedSize = width * height;
			if (bytes.length < expectedSize) {
				throw new Error(
					`${pixelFormat}: expected ${expectedSize} bytes for ${width}x${height}, got ${bytes.length}.`,
				);
			}
			const out = new Uint8Array(width * height * 4);
			for (let i = 0; i < expectedSize; i++) {
				const v = bytes[i]!;
				out[i * 4] = v;
				out[i * 4 + 1] = v;
				out[i * 4 + 2] = v;
				out[i * 4 + 3] = 255;
			}
			return { width, height, pixels: out };
		}
		case 'PF_FloatRGBA': {
			// Half-float (16-bit) ×4 channels.
			const expectedSize = width * height * 8;
			if (bytes.length < expectedSize) {
				throw new Error(
					`PF_FloatRGBA: expected ${expectedSize} bytes for ${width}x${height}, got ${bytes.length}.`,
				);
			}
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const out = new Uint8Array(width * height * 4);
			for (let i = 0; i < width * height; i++) {
				// We use a quick Reinhard tonemap to bring HDR values into
				// LDR range — otherwise highly-bright HDR pixels would
				// just clip to white and you'd lose the structure.
				const r = halfToFloat(view.getUint16(i * 8, true));
				const g = halfToFloat(view.getUint16(i * 8 + 2, true));
				const b = halfToFloat(view.getUint16(i * 8 + 4, true));
				const a = halfToFloat(view.getUint16(i * 8 + 6, true));
				out[i * 4] = tonemap(r);
				out[i * 4 + 1] = tonemap(g);
				out[i * 4 + 2] = tonemap(b);
				out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
			}
			return { width, height, pixels: out };
		}
	}

	throw new UnsupportedPixelFormatError(pixelFormat);
}

export class UnsupportedPixelFormatError extends Error {
	pixelFormat: string;
	constructor(pixelFormat: string) {
		super(`PixelFormat "${pixelFormat}" not supported yet.`);
		this.name = 'UnsupportedPixelFormatError';
		this.pixelFormat = pixelFormat;
	}
}

/**
 * Return a human-readable description of what a PixelFormat encodes,
 * for UI annotation. Falls back to the raw format name when unknown.
 */
export function describePixelFormat(pixelFormat: string): string {
	switch (pixelFormat) {
		case 'PF_B8G8R8A8':
			return 'BGRA8 (raw, 32-bit color)';
		case 'PF_R8G8B8A8':
			return 'RGBA8 (raw, 32-bit color)';
		case 'PF_G8':
			return 'Grayscale (8-bit single channel)';
		case 'PF_A8':
			return 'Alpha-only (8-bit)';
		case 'PF_BC1':
			return 'BC1 / DXT1 (RGB + 1-bit alpha)';
		case 'PF_BC2':
			return 'BC2 / DXT3 (RGB + explicit 4-bit alpha)';
		case 'PF_BC3':
			return 'BC3 / DXT5 (RGB + interpolated alpha)';
		case 'PF_BC4':
			return 'BC4 (single channel — mask / AO)';
		case 'PF_BC5':
			return 'BC5 (two channels — normal map)';
		case 'PF_BC6H':
			return 'BC6H (HDR RGB)';
		case 'PF_BC7':
			return 'BC7 (high-quality RGBA)';
		case 'PF_FloatRGBA':
			return 'RGBA half-float (HDR)';
		default:
			if (pixelFormat.startsWith('PF_ASTC_')) {
				return `ASTC ${pixelFormat.slice('PF_ASTC_'.length)} (mobile / Switch)`;
			}
			return pixelFormat;
	}
}

function mapBcnFormat(pixelFormat: string): BcnFormat | null {
	switch (pixelFormat) {
		case 'PF_DXT1':
		case 'PF_BC1':
			return 'BC1';
		case 'PF_DXT3':
		case 'PF_BC2':
			return 'BC2';
		case 'PF_DXT5':
		case 'PF_BC3':
			return 'BC3';
		case 'PF_BC4':
			return 'BC4';
		case 'PF_BC5':
			return 'BC5';
		default:
			return null;
	}
}

/**
 * In place over a BC5-decoded RGBA buffer (R = Nx, G = Ny, B = 0,
 * A = 255), reconstruct the Z channel and pack it into B. Returns a
 * fresh `Uint8Array` so the caller can hand it to ImageData without
 * worrying about reuse.
 *
 *   Nx = R/255 * 2 - 1
 *   Ny = G/255 * 2 - 1
 *   Nz = sqrt(max(0, 1 - Nx² - Ny²))
 *   B  = (Nz + 1) / 2 * 255
 */
function reconstructNormalMapZ(rgba: Uint8Array): Uint8Array {
	const out = new Uint8Array(rgba.length);
	for (let i = 0; i < rgba.length; i += 4) {
		const r = rgba[i]!;
		const g = rgba[i + 1]!;
		const nx = (r / 255) * 2 - 1;
		const ny = (g / 255) * 2 - 1;
		const nz2 = 1 - nx * nx - ny * ny;
		const nz = nz2 > 0 ? Math.sqrt(nz2) : 0;
		out[i] = r;
		out[i + 1] = g;
		out[i + 2] = Math.round(((nz + 1) / 2) * 255);
		out[i + 3] = 255;
	}
	return out;
}

/**
 * Convert one IEEE 754 binary16 (half-float) value to a regular
 * JS number. We use the classic bit-twiddle algorithm; close enough
 * for tone-mapping LDR previews of HDR data.
 */
function halfToFloat(h: number): number {
	const s = (h & 0x8000) >> 15;
	const e = (h & 0x7c00) >> 10;
	const f = h & 0x03ff;
	if (e === 0) {
		// Subnormal: zero or denormalised.
		return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
	}
	if (e === 0x1f) {
		// Inf or NaN — flatten to 0 for tonemapping safety.
		return f === 0 ? (s ? -Infinity : Infinity) : NaN;
	}
	return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Reinhard tonemap: clamps any positive HDR value into 0..1 with a
 * monotonic curve that preserves contrast in mid-tones. Output is
 * an 8-bit value.
 */
function tonemap(v: number): number {
	if (!Number.isFinite(v) || v <= 0) return 0;
	const ldr = v / (1 + v);
	return Math.max(0, Math.min(255, Math.round(ldr * 255)));
}
