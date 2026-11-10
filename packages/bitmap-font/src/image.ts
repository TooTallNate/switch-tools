/**
 * The image codecs a BMFont needs, with no DOM: PNG decode / encode
 * and TGA decode (the AngelCode tool can write either for its pages).
 * They're synchronous so a Node CLI and a browser worker can share
 * them.
 *
 * PNG decoding covers every colour type and bit depth in the spec,
 * plus Adam7 interlacing; it ignores ancillary chunks (gamma, ICC),
 * which don't matter for glyph coverage. TGA covers the uncompressed
 * and RLE true-colour, grey and colour-mapped variants.
 *
 * Sources: PNG spec (W3C, 2nd ed.) and the Truevision TGA 2.0 spec.
 */

import { unzlibSync, zlibSync } from 'fflate';

/** An RGBA8 image, rows top-down. */
export interface RgbaImage {
	width: number;
	height: number;
	/** width × height × 4 bytes. */
	data: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
	return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Decode a PNG to RGBA8. */
export function decodePng(bytes: Uint8Array): RgbaImage {
	if (!isPng(bytes)) throw new Error('Not a PNG file');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette: Uint8Array | null = null;
	let trns: Uint8Array | null = null;
	const idat: Uint8Array[] = [];
	let pos = 8;
	while (pos + 8 <= bytes.length) {
		const len = view.getUint32(pos);
		const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		const body = bytes.subarray(pos + 8, pos + 8 + len);
		pos += 12 + len;
		if (type === 'IHDR') {
			width = view.getUint32(body.byteOffset - bytes.byteOffset);
			height = view.getUint32(body.byteOffset - bytes.byteOffset + 4);
			depth = body[8]!;
			colorType = body[9]!;
			interlace = body[12]!;
		} else if (type === 'PLTE') palette = body;
		else if (type === 'tRNS') trns = body;
		else if (type === 'IDAT') idat.push(body);
		else if (type === 'IEND') break;
	}
	if (!width || !height) throw new Error('PNG: missing IHDR');
	const total = idat.reduce((n, c) => n + c.length, 0);
	const compressed = new Uint8Array(total);
	let o = 0;
	for (const c of idat) {
		compressed.set(c, o);
		o += c.length;
	}
	const raw = unzlibSync(compressed);

	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
	if (!channels) throw new Error(`PNG: unsupported colour type ${colorType}`);
	const bpp = Math.max(1, (channels * depth) >> 3);
	const out = new Uint8Array(width * height * 4);

	// Adam7 passes: [x0, y0, dx, dy]; a non-interlaced image is one pass.
	const passes = interlace
		? [
				[0, 0, 8, 8],
				[4, 0, 8, 8],
				[0, 4, 4, 8],
				[2, 0, 4, 4],
				[0, 2, 2, 4],
				[1, 0, 2, 2],
				[0, 1, 1, 2],
			]
		: [[0, 0, 1, 1]];
	let rp = 0;
	for (const [x0, y0, dx, dy] of passes) {
		const pw = Math.ceil((width - x0!) / dx!);
		const ph = Math.ceil((height - y0!) / dy!);
		if (pw <= 0 || ph <= 0) continue;
		const stride = Math.ceil((pw * channels * depth) / 8);
		let prev = new Uint8Array(stride);
		for (let y = 0; y < ph; y++) {
			const filter = raw[rp++]!;
			const line = raw.slice(rp, rp + stride);
			rp += stride;
			unfilter(filter, line, prev, bpp);
			for (let x = 0; x < pw; x++) {
				const px = ((y0! + y * dy!) * width + x0! + x * dx!) * 4;
				writePixel(out, px, line, x, colorType, depth, channels, palette, trns);
			}
			prev = line;
		}
	}
	return { width, height, data: out };
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
	const n = line.length;
	switch (filter) {
		case 0:
			return;
		case 1:
			for (let i = bpp; i < n; i++) line[i] = (line[i]! + line[i - bpp]!) & 0xff;
			return;
		case 2:
			for (let i = 0; i < n; i++) line[i] = (line[i]! + prev[i]!) & 0xff;
			return;
		case 3:
			for (let i = 0; i < n; i++) {
				const left = i >= bpp ? line[i - bpp]! : 0;
				line[i] = (line[i]! + ((left + prev[i]!) >> 1)) & 0xff;
			}
			return;
		case 4:
			for (let i = 0; i < n; i++) {
				const a = i >= bpp ? line[i - bpp]! : 0;
				const b = prev[i]!;
				const c = i >= bpp ? prev[i - bpp]! : 0;
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
				line[i] = (line[i]! + pred) & 0xff;
			}
			return;
		default:
			throw new Error(`PNG: bad filter type ${filter}`);
	}
}

function writePixel(
	out: Uint8Array,
	px: number,
	line: Uint8Array,
	x: number,
	colorType: number,
	depth: number,
	channels: number,
	palette: Uint8Array | null,
	trns: Uint8Array | null,
): void {
	// Sample `c` of pixel `x`, scaled to 8 bits (palette indices unscaled).
	const sample = (c: number, scale: boolean): number => {
		if (depth === 8) return line[x * channels + c]!;
		if (depth === 16) return line[(x * channels + c) * 2]!;
		const bit = (x * channels + c) * depth;
		const v = (line[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
		return scale ? Math.round((v * 255) / ((1 << depth) - 1)) : v;
	};
	const raw16 = (c: number) =>
		depth === 16 ? (line[(x * channels + c) * 2]! << 8) | line[(x * channels + c) * 2 + 1]! : -1;
	let r: number;
	let g: number;
	let b: number;
	let a = 255;
	switch (colorType) {
		case 0: {
			r = g = b = sample(0, true);
			if (trns && trns.length >= 2) {
				const key = (trns[0]! << 8) | trns[1]!;
				const v = depth === 16 ? raw16(0) : depth === 8 ? line[x]! : sample(0, false);
				if (v === key) a = 0;
			}
			break;
		}
		case 2: {
			r = sample(0, true);
			g = sample(1, true);
			b = sample(2, true);
			if (trns && trns.length >= 6) {
				const key = [0, 1, 2].map((i) => (trns[i * 2]! << 8) | trns[i * 2 + 1]!);
				const v = depth === 16 ? [raw16(0), raw16(1), raw16(2)] : [r, g, b];
				if (v[0] === key[0] && v[1] === key[1] && v[2] === key[2]) a = 0;
			}
			break;
		}
		case 3: {
			const i = sample(0, false);
			r = palette?.[i * 3] ?? 0;
			g = palette?.[i * 3 + 1] ?? 0;
			b = palette?.[i * 3 + 2] ?? 0;
			a = trns && i < trns.length ? trns[i]! : 255;
			break;
		}
		case 4:
			r = g = b = sample(0, true);
			a = sample(1, true);
			break;
		default:
			r = sample(0, true);
			g = sample(1, true);
			b = sample(2, true);
			a = sample(3, true);
	}
	out[px] = r;
	out[px + 1] = g;
	out[px + 2] = b;
	out[px + 3] = a;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Encode RGBA8 pixels as a PNG (colour type 6, filter "up"). */
export function encodePng(image: RgbaImage): Uint8Array {
	const { width, height, data } = image;
	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const o = y * (stride + 1);
		raw[o] = 2;
		for (let i = 0; i < stride; i++) {
			const up = y ? data[(y - 1) * stride + i]! : 0;
			raw[o + 1 + i] = (data[y * stride + i]! - up) & 0xff;
		}
	}
	const ihdr = new Uint8Array(13);
	const hv = new DataView(ihdr.buffer);
	hv.setUint32(0, width);
	hv.setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const chunks = [chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
	const out = new Uint8Array(8 + chunks.reduce((n, c) => n + c.length, 0));
	out.set(PNG_SIGNATURE, 0);
	let o = 8;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + body.length);
	const v = new DataView(out.buffer);
	v.setUint32(0, body.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
	v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
	return out;
}

/** Decode a TGA (types 1, 2, 3 and their RLE forms 9, 10, 11) to RGBA8. */
export function decodeTga(bytes: Uint8Array): RgbaImage {
	if (bytes.length < 18) throw new Error('TGA: file too short');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const idLength = bytes[0]!;
	const mapType = bytes[1]!;
	const type = bytes[2]!;
	const mapFirst = view.getUint16(3, true);
	const mapLength = view.getUint16(5, true);
	const mapDepth = bytes[7]!;
	const width = view.getUint16(12, true);
	const height = view.getUint16(14, true);
	const depth = bytes[16]!;
	const descriptor = bytes[17]!;
	const base = type & ~8;
	if (base !== 1 && base !== 2 && base !== 3) throw new Error(`TGA: unsupported image type ${type}`);
	let pos = 18 + idLength;
	const mapBytes = Math.ceil(mapDepth / 8);
	let map: Uint8Array | null = null;
	if (mapType === 1) {
		map = new Uint8Array(mapLength * 4);
		for (let i = 0; i < mapLength; i++) readTgaColor(bytes, pos + i * mapBytes, mapDepth, map, i * 4);
		pos += mapLength * mapBytes;
	}
	const pxBytes = Math.ceil(depth / 8);
	const count = width * height;
	const linear = new Uint8Array(count * 4);
	const put = (src: number, i: number) => {
		if (base === 1) {
			const idx = (pxBytes === 2 ? view.getUint16(src, true) : bytes[src]!) - mapFirst;
			linear.set(map?.subarray(idx * 4, idx * 4 + 4) ?? [0, 0, 0, 255], i * 4);
		} else if (base === 3) {
			const v = bytes[src]!;
			linear.set([v, v, v, depth === 16 ? bytes[src + 1]! : 255], i * 4);
		} else readTgaColor(bytes, src, depth, linear, i * 4);
	};
	if (type & 8) {
		let i = 0;
		while (i < count && pos < bytes.length) {
			const header = bytes[pos++]!;
			const n = (header & 0x7f) + 1;
			if (header & 0x80) {
				for (let k = 0; k < n && i < count; k++) put(pos, i++);
				pos += pxBytes;
			} else {
				for (let k = 0; k < n && i < count; k++, pos += pxBytes) put(pos, i++);
			}
		}
	} else {
		for (let i = 0; i < count; i++) put(pos + i * pxBytes, i);
	}
	// Origin bits: bit 5 set = top-down rows, bit 4 set = right-to-left.
	const topDown = (descriptor & 0x20) !== 0;
	const rightToLeft = (descriptor & 0x10) !== 0;
	const data = new Uint8Array(count * 4);
	for (let y = 0; y < height; y++) {
		const sy = topDown ? y : height - 1 - y;
		for (let x = 0; x < width; x++) {
			const sx = rightToLeft ? width - 1 - x : x;
			data.set(linear.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
		}
	}
	return { width, height, data };
}

function readTgaColor(bytes: Uint8Array, at: number, depth: number, out: Uint8Array, o: number): void {
	if (depth === 15 || depth === 16) {
		const v = bytes[at]! | (bytes[at + 1]! << 8);
		out[o] = ((v >> 10) & 31) * 255 / 31;
		out[o + 1] = ((v >> 5) & 31) * 255 / 31;
		out[o + 2] = (v & 31) * 255 / 31;
		// The 16-bit attribute bit is ignored: many writers leave it
		// clear on opaque images, which would blank the page.
		out[o + 3] = 255;
		return;
	}
	out[o] = bytes[at + 2]!;
	out[o + 1] = bytes[at + 1]!;
	out[o + 2] = bytes[at]!;
	out[o + 3] = depth === 32 ? bytes[at + 3]! : 255;
}

/** Decode a PNG or TGA page image. */
export function decodeImage(bytes: Uint8Array): RgbaImage {
	if (isPng(bytes)) return decodePng(bytes);
	return decodeTga(bytes);
}
