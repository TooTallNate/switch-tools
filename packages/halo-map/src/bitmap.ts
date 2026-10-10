import { decodeBC1, decodeBC2, decodeBC3 } from '@tootallnate/bcn';
import { readReflexive, type HaloMap, type HaloTag } from './index.js';

/** `BitmapDataType`. */
export const BITMAP_TYPES = ['2d', '3d', 'cube', 'white'] as const;

/** `BitmapDataFormat` names, indexed by value. */
export const BITMAP_FORMATS = [
	'a8',
	'y8',
	'ay8',
	'a8y8',
	'unused1',
	'unused2',
	'r5g6b5',
	'unused3',
	'a1r5g5b5',
	'a4r4g4b4',
	'x8r8g8b8',
	'a8r8g8b8',
	'unused4',
	'unused5',
	'dxt1',
	'dxt3',
	'dxt5',
	'p8',
] as const;

const FLAG_SWIZZLED = 1 << 3;
const FLAG_EXTERNAL = 1 << 8;

/** One entry of a `bitm` tag's `bitmap data` block. */
export interface HaloBitmap {
	/** Index within the tag. */
	index: number;
	width: number;
	height: number;
	depth: number;
	type: (typeof BITMAP_TYPES)[number] | 'unknown';
	format: string;
	formatId: number;
	flags: number;
	mipmapCount: number;
	/** File offset of the pixel data (all faces / mips). */
	pixelOffset: number;
	pixelSize: number;
	swizzled: boolean;
	/** True when the pixels live in a separate resource map (PC). */
	external: boolean;
}

/** List the bitmaps of a `bitm` tag. */
export function parseBitmapTag(map: HaloMap, tag: HaloTag): HaloBitmap[] {
	if (tag.tagClass !== 'bitm' || tag.dataOffset < 0) return [];
	const data = readReflexive(map, tag.dataOffset + 0x60);
	const out: HaloBitmap[] = [];
	const v = map.view;
	for (let i = 0; i < data.count; i++) {
		const o = data.offset + i * 0x30;
		if (o + 0x30 > map.bytes.length) break;
		const formatId = v.getUint16(o + 0x0c, true);
		const flags = v.getUint16(o + 0x0e, true);
		const typeId = v.getUint16(o + 0x0a, true);
		out.push({
			index: i,
			width: v.getUint16(o + 4, true),
			height: v.getUint16(o + 6, true),
			depth: v.getUint16(o + 8, true),
			type: BITMAP_TYPES[typeId] ?? 'unknown',
			format: BITMAP_FORMATS[formatId] ?? `format ${formatId}`,
			formatId,
			flags,
			mipmapCount: v.getUint16(o + 0x14, true),
			pixelOffset: v.getUint32(o + 0x18, true),
			pixelSize: v.getUint32(o + 0x1c, true),
			swizzled: (flags & FLAG_SWIZZLED) !== 0,
			external: (flags & FLAG_EXTERNAL) !== 0,
		});
	}
	return out;
}

/** Bits per pixel of a bitmap format (0 when unknown). */
export function bitsPerPixel(formatId: number): number {
	switch (formatId) {
		case 0:
		case 1:
		case 2:
		case 17:
			return 8;
		case 3:
		case 6:
		case 8:
		case 9:
			return 16;
		case 10:
		case 11:
			return 32;
		case 14:
			return 4;
		case 15:
		case 16:
			return 8;
		default:
			return 0;
	}
}

/** Byte size of mip level 0 of one face / slice. */
export function mip0Size(b: HaloBitmap): number {
	const bpp = bitsPerPixel(b.formatId);
	if (b.formatId >= 14 && b.formatId <= 16) {
		const bw = Math.max(1, Math.ceil(b.width / 4));
		const bh = Math.max(1, Math.ceil(b.height / 4));
		return bw * bh * (b.formatId === 14 ? 8 : 16);
	}
	return (b.width * b.height * bpp) / 8;
}

/**
 * Xbox (NV2A) swizzle: texel (x, y) lives at the Morton index made by
 * interleaving the bits of x and y, x first, for as long as each
 * coordinate still has bits.
 */
export function unswizzle(
	src: Uint8Array,
	width: number,
	height: number,
	bytesPerPixel: number,
): Uint8Array {
	const out = new Uint8Array(width * height * bytesPerPixel);
	// Precompute per-axis bit spreads.
	const xs = new Uint32Array(width);
	const ys = new Uint32Array(height);
	let bit = 1;
	let wBit = 1;
	let hBit = 1;
	while (wBit < width || hBit < height) {
		if (wBit < width) {
			for (let x = 0; x < width; x++) if (x & wBit) xs[x] |= bit;
			bit <<= 1;
			wBit <<= 1;
		}
		if (hBit < height) {
			for (let y = 0; y < height; y++) if (y & hBit) ys[y] |= bit;
			bit <<= 1;
			hBit <<= 1;
		}
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = (xs[x] | ys[y]) * bytesPerPixel;
			const d = (y * width + x) * bytesPerPixel;
			for (let k = 0; k < bytesPerPixel; k++) out[d + k] = src[s + k];
		}
	}
	return out;
}

export interface DecodedBitmap {
	width: number;
	height: number;
	/** RGBA8 pixels, `width * height * 4` bytes. */
	pixels: Uint8Array;
}

/**
 * Decode mip 0 of the first face / slice of a bitmap to RGBA8.
 * Throws for external pixel data and unsupported formats.
 */
export function decodeBitmap(map: HaloMap, b: HaloBitmap): DecodedBitmap {
	if (b.external) {
		throw new Error('Bitmap pixels are stored in bitmaps.map');
	}
	const { width, height } = b;
	if (!width || !height) throw new Error('Empty bitmap');
	const size = mip0Size(b);
	if (!size) throw new Error(`Unsupported bitmap format ${b.format}`);
	if (b.pixelOffset + size > map.bytes.length) {
		throw new Error('Bitmap pixels are outside the map');
	}
	let src = map.bytes.subarray(b.pixelOffset, b.pixelOffset + size);

	if (b.formatId === 14) return decodeBC1(src, width, height);
	if (b.formatId === 15) return decodeBC2(src, width, height);
	if (b.formatId === 16) return decodeBC3(src, width, height);

	const bpp = bitsPerPixel(b.formatId) / 8;
	if (b.swizzled) src = unswizzle(src, width, height, bpp);
	const px = new Uint8Array(width * height * 4);
	const n = width * height;
	for (let i = 0; i < n; i++) {
		const d = i * 4;
		let r = 255;
		let g = 255;
		let bl = 255;
		let a = 255;
		switch (b.formatId) {
			case 0: // a8
				a = src[i];
				break;
			case 1: // y8
			case 17: // p8 bump: palette index, shown as intensity
				r = g = bl = src[i];
				break;
			case 2: // ay8: one byte drives intensity and alpha
				r = g = bl = a = src[i];
				break;
			case 3: // a8y8
				r = g = bl = src[i * 2];
				a = src[i * 2 + 1];
				break;
			case 6: {
				const v = src[i * 2] | (src[i * 2 + 1] << 8);
				r = ((v >> 11) & 0x1f) * 255 / 31;
				g = ((v >> 5) & 0x3f) * 255 / 63;
				bl = (v & 0x1f) * 255 / 31;
				break;
			}
			case 8: {
				const v = src[i * 2] | (src[i * 2 + 1] << 8);
				a = v & 0x8000 ? 255 : 0;
				r = ((v >> 10) & 0x1f) * 255 / 31;
				g = ((v >> 5) & 0x1f) * 255 / 31;
				bl = (v & 0x1f) * 255 / 31;
				break;
			}
			case 9: {
				const v = src[i * 2] | (src[i * 2 + 1] << 8);
				a = ((v >> 12) & 0xf) * 17;
				r = ((v >> 8) & 0xf) * 17;
				g = ((v >> 4) & 0xf) * 17;
				bl = (v & 0xf) * 17;
				break;
			}
			case 10:
			case 11:
				bl = src[i * 4];
				g = src[i * 4 + 1];
				r = src[i * 4 + 2];
				a = b.formatId === 11 ? src[i * 4 + 3] : 255;
				break;
		}
		px[d] = r;
		px[d + 1] = g;
		px[d + 2] = bl;
		px[d + 3] = a;
	}
	return { width, height, pixels: px };
}
