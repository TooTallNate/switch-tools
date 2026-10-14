/**
 * Truevision TGA decoder: colour-mapped (types 1 / 9), true-colour
 * (2 / 10) and greyscale (3 / 11), raw or run-length encoded, at 8, 15,
 * 16, 24 or 32 bits per pixel. Output is top-down RGBA8.
 *
 * Header (18 bytes, little-endian): id length, colour-map type, image
 * type, colour-map first entry / length / entry bits, x / y origin,
 * width, height, bits per pixel, descriptor (bits 0–3: alpha bits;
 * bit 4: right-to-left; bit 5: top-to-bottom). Then the image id, the
 * colour map, and the pixels (BGR(A) order; 16-bit is ARGB1555).
 * From the Truevision TGA 2.0 specification.
 */

export interface DecodedTga {
	width: number;
	height: number;
	/** Top-down RGBA8. */
	pixels: Uint8Array;
	/** True when the file carries meaningful alpha. */
	hasAlpha: boolean;
}

export function isTga(bytes: Uint8Array): boolean {
	if (bytes.length < 18) return false;
	const type = bytes[2]!;
	const bpp = bytes[16]!;
	const w = bytes[12]! | (bytes[13]! << 8);
	const h = bytes[14]! | (bytes[15]! << 8);
	return [1, 2, 3, 9, 10, 11].includes(type) && [8, 15, 16, 24, 32].includes(bpp) && w > 0 && h > 0 && bytes[1]! <= 1;
}

export function decodeTga(bytes: Uint8Array): DecodedTga {
	if (!isTga(bytes)) throw new Error('Not a TGA image');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const idLen = bytes[0]!;
	const cmapType = bytes[1]!;
	const type = bytes[2]!;
	const cmapFirst = dv.getUint16(3, true);
	const cmapLen = dv.getUint16(5, true);
	const cmapBits = bytes[7]!;
	const width = dv.getUint16(12, true);
	const height = dv.getUint16(14, true);
	const bpp = bytes[16]!;
	const desc = bytes[17]!;
	const alphaBits = desc & 0x0f;
	const rightToLeft = (desc & 0x10) !== 0;
	const topDown = (desc & 0x20) !== 0;
	let pos = 18 + idLen;

	// Colour map → RGBA entries.
	const toRgba = (o: number, bits: number, out: Uint8Array, d: number) => {
		if (bits === 32) {
			out[d] = bytes[o + 2]!;
			out[d + 1] = bytes[o + 1]!;
			out[d + 2] = bytes[o]!;
			out[d + 3] = bytes[o + 3]!;
		} else if (bits === 24) {
			out[d] = bytes[o + 2]!;
			out[d + 1] = bytes[o + 1]!;
			out[d + 2] = bytes[o]!;
			out[d + 3] = 255;
		} else if (bits === 15 || bits === 16) {
			const v = bytes[o]! | (bytes[o + 1]! << 8);
			out[d] = (((v >> 10) & 31) * 255) / 31;
			out[d + 1] = (((v >> 5) & 31) * 255) / 31;
			out[d + 2] = ((v & 31) * 255) / 31;
			out[d + 3] = bits === 16 && alphaBits > 0 ? (v & 0x8000 ? 255 : 0) : 255;
		} else {
			const g = bytes[o]!;
			out[d] = out[d + 1] = out[d + 2] = g;
			out[d + 3] = 255;
		}
	};
	let palette: Uint8Array | null = null;
	if (cmapType === 1) {
		const eb = Math.ceil(cmapBits / 8);
		palette = new Uint8Array((cmapFirst + cmapLen) * 4);
		for (let i = 0; i < cmapLen; i++) toRgba(pos + i * eb, cmapBits, palette, (cmapFirst + i) * 4);
		pos += cmapLen * eb;
	}

	const pb = Math.ceil(bpp / 8);
	const n = width * height;
	const linear = new Uint8Array(n * 4);
	const writePixel = (src: number, i: number) => {
		if (type === 1 || type === 9) {
			const idx = pb === 2 ? bytes[src]! | (bytes[src + 1]! << 8) : bytes[src]!;
			if (palette) linear.set(palette.subarray(idx * 4, idx * 4 + 4), i * 4);
		} else if (type === 3 || type === 11) {
			const g = bytes[src]!;
			linear[i * 4] = linear[i * 4 + 1] = linear[i * 4 + 2] = g;
			linear[i * 4 + 3] = pb === 2 ? bytes[src + 1]! : 255;
		} else {
			toRgba(src, bpp, linear, i * 4);
		}
	};
	if (type >= 9) {
		let i = 0;
		while (i < n && pos < bytes.length) {
			const hdr = bytes[pos++]!;
			const count = (hdr & 0x7f) + 1;
			if (hdr & 0x80) {
				for (let k = 0; k < count && i < n; k++) writePixel(pos, i++);
				pos += pb;
			} else {
				for (let k = 0; k < count && i < n; k++) {
					writePixel(pos, i++);
					pos += pb;
				}
			}
		}
	} else {
		for (let i = 0; i < n && pos + pb <= bytes.length; i++, pos += pb) writePixel(pos, i);
	}

	// Reorder to top-down, left-to-right.
	const pixels = new Uint8Array(n * 4);
	let hasAlpha = false;
	for (let y = 0; y < height; y++) {
		const sy = topDown ? y : height - 1 - y;
		for (let x = 0; x < width; x++) {
			const sx = rightToLeft ? width - 1 - x : x;
			const s = (sy * width + sx) * 4;
			const d = (y * width + x) * 4;
			pixels[d] = linear[s]!;
			pixels[d + 1] = linear[s + 1]!;
			pixels[d + 2] = linear[s + 2]!;
			pixels[d + 3] = linear[s + 3]!;
			if (linear[s + 3] !== 255) hasAlpha = true;
		}
	}
	// 32-bit files with no alpha bits declared and all-zero alpha: treat as opaque.
	if (bpp === 32 && alphaBits === 0 && hasAlpha) {
		let allZero = true;
		for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) {
			allZero = false;
			break;
		}
		if (allZero) {
			for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
			hasAlpha = false;
		}
	}
	return { width, height, pixels, hasAlpha };
}
