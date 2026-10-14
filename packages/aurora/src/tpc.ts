/**
 * KotOR TPC texture (xoreos `src/graphics/images/tpc.cpp`).
 *
 * 128-byte header: u32 data size of mip 0 (0 = uncompressed), f32 (alpha
 * test), u16 width, u16 height, u8 encoding, u8 mip count, reserved. Then
 * pixel data (all mips, then cube faces), then a TXI text block.
 *
 * Encodings: 1 greyscale, 2 RGB (DXT1 when compressed), 4 RGBA (DXT5 when
 * compressed), 12 swizzled BGRA. Cube maps store six faces stacked
 * (height = 6 × width); we decode the first face.
 */
import { decodeBC1, decodeBC3 } from '@tootallnate/bcn';

export interface DecodedTpc {
	width: number;
	height: number;
	/** Top-down RGBA8 (first face / mip 0). */
	pixels: Uint8Array;
	hasAlpha: boolean;
	/** The TXI text after the pixel data (texture properties), if any. */
	txi: string;
}

export function isTpc(bytes: Uint8Array): boolean {
	if (bytes.length < 128) return false;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const w = dv.getUint16(8, true);
	const h = dv.getUint16(10, true);
	const enc = bytes[12]!;
	return w > 0 && h > 0 && w < 0x8000 && h < 0x8000 && [1, 2, 4, 12].includes(enc);
}

export function decodeTpc(bytes: Uint8Array): DecodedTpc {
	if (!isTpc(bytes)) throw new Error('Not a TPC texture');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dataSize = dv.getUint32(0, true);
	const width = dv.getUint16(8, true);
	let height = dv.getUint16(10, true);
	const enc = bytes[12]!;
	const mips = Math.max(1, bytes[13]!);
	const compressed = dataSize !== 0;
	// Cube maps: six square faces stacked vertically.
	let faces = 1;
	if (compressed && height === width * 6) {
		faces = 6;
		height = width;
	}
	const data = bytes.subarray(128);
	let pixels: Uint8Array;
	let hasAlpha = false;
	if (compressed) {
		const blocks = Math.ceil(width / 4) * Math.ceil(height / 4);
		const src = data.subarray(0, blocks * (enc === 4 ? 16 : 8));
		pixels = (enc === 4 ? decodeBC3(src, width, height) : decodeBC1(src, width, height)).pixels;
		hasAlpha = enc === 4;
	} else {
		const n = width * height;
		pixels = new Uint8Array(n * 4);
		for (let i = 0; i < n; i++) {
			if (enc === 1) {
				pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = data[i]!;
				pixels[i * 4 + 3] = 255;
			} else if (enc === 2) {
				pixels.set([data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!, 255], i * 4);
			} else if (enc === 4) {
				pixels.set(data.subarray(i * 4, i * 4 + 4), i * 4);
				hasAlpha = true;
			} else {
				pixels.set([data[i * 4 + 2]!, data[i * 4 + 1]!, data[i * 4]!, data[i * 4 + 3]!], i * 4);
				hasAlpha = true;
			}
		}
	}
	// TXI: after every mip of every face.
	let end = 128;
	let w = width;
	let h = height;
	for (let m = 0; m < mips; m++) {
		const size = compressed ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * (enc === 4 ? 16 : 8) : w * h * (enc === 1 ? 1 : enc === 2 ? 3 : 4);
		end += size * faces;
		w = Math.max(1, w >> 1);
		h = Math.max(1, h >> 1);
	}
	const txi = end < bytes.length ? new TextDecoder('latin1').decode(bytes.subarray(end)).replace(/\0+$/, '') : '';
	return { width, height, pixels, hasAlpha, txi };
}
