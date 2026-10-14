/**
 * GoldenEye 007 textures: the global image bank and Rare's texture codec.
 *
 * Display lists name textures by number (`G_SETTEX`, 0xC0); texture *n*
 * lives at `imagesSegment + (g_Textures[n] & 0xFFFFFF)`, where
 * `g_Textures` is a table of 8-byte entries in the main code segment
 * (hit types in the top byte, a running data offset in the low 24 bits,
 * then detail flags). The data's first byte is
 *
 *   bit 7  explicit LODs follow      bit 6  zlib (paletted)
 *   bits 0–5  LOD count
 *
 * **zlib** textures are always paletted (formats 9–12): `u8 format,
 * u8 colours−1, u16 palette[]`, then per image `u8 width, u8 height` and
 * a rarezip block (2-byte header + raw DEFLATE) of palette indices.
 *
 * **non-zlib** textures are a bitstring (MSB first): per image
 * `4 format, 8 width, 8 height, 4 method`, then one of
 *
 *   0/1  uncompressed pixels
 *   2    one Huffman tree over all channels      3  one tree per channel
 *   4    sliding-window RLE                        5  lookup table + packed indices
 *   6    lookup + Huffman indices                  7  lookup + RLE indices
 *   8/9  Huffman / RLE + a prediction filter (`texBlur`)
 *
 * Channel methods store each channel as its own plane (plus a 1-bit
 * alpha plane for RGBA16 / IA4). Only the first (largest) image is
 * decoded; the runtime's TMEM row swizzling is skipped, so output is
 * plain RGBA8, rows top-down.
 *
 * Ported from the n64decomp/007 decompilation: `src/game/image.c`
 * (`texLoad`, `texInflateZlib`, `texInflateNonZlib`, `texInflateHuffman`,
 * `texInflateRle`, `texBuildLookup`, `texChannelsToPixels`, `texBlur`)
 * and `image_bank.c` (`texReadBits`).
 */

import { inflateSync } from 'fflate';

export const enum TexFormat {
	RGBA32 = 0, RGBA16 = 1, RGB24 = 2, RGB15 = 3, IA16 = 4, IA8 = 5, IA4 = 6, I8 = 7, I4 = 8,
	RGBA16_CI8 = 9, RGBA16_CI4 = 10, IA16_CI8 = 11, IA16_CI4 = 12,
}

const NUM_CHANNELS = [4, 3, 3, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1];
const HAS_1BIT_ALPHA = [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
const CHANNEL_SIZES = [0x100, 0x20, 0x100, 0x20, 0x100, 0x10, 8, 0x100, 0x10, 0x100, 0x10, 0x100, 0x10];
const BITS_PER_PIXEL = [0x20, 0x10, 0x18, 0xf, 0x10, 8, 4, 8, 4, 0x10, 0x10, 0x10, 0x10];

export interface GoldeneyeTexture {
	width: number;
	height: number;
	format: number;
	/** RGBA8, rows top-down. */
	rgba: Uint8Array;
}

class Bits {
	private pos: number;
	private acc = 0;
	private count = 0;
	constructor(private readonly b: Uint8Array, start: number) {
		this.pos = start;
	}
	/** Read `n` ≤ 24 bits, MSB first (texReadBits). */
	read(n: number): number {
		if (n === 0) return 0;
		while (this.count < n) {
			// Keep only the unread bits so the accumulator stays under 32 bits.
			this.acc = (((this.acc & ((1 << this.count) - 1)) << 8) | (this.b[this.pos++] ?? 0)) >>> 0;
			this.count += 8;
		}
		this.count -= n;
		return (this.acc >>> this.count) & ((1 << n) - 1);
	}
	get byteOffset(): number {
		return this.pos;
	}
}

function huffman(bits: Bits, n: number, chansize: number): Uint16Array {
	const freq = new Int32Array(2048);
	const nodes = new Int32Array(4096).fill(-1); // [i*2], [i*2+1]
	for (let i = 0; i < chansize; i++) freq[i] = bits.read(8);
	const isLeafless = (i: number) => nodes[i * 2]! < 0 && nodes[i * 2 + 1]! < 0;
	let min1 = 9999, min2 = 9999, i1 = 0, i2 = 0, root = 0;
	const findMins = (first: boolean) => {
		min1 = 9999;
		min2 = 9999;
		for (let i = 0; i < chansize; i++) {
			const f = freq[i]!;
			if (f < min1) {
				// The two scans differ subtly in the original; both are kept.
				if (first ? min2 < min1 : min1 > min2) {
					min1 = f;
					i1 = i;
				} else {
					min2 = f;
					i2 = i;
				}
			} else if (f < min2) {
				min2 = f;
				i2 = i;
			}
		}
	};
	findMins(true);
	for (let guard = 0; guard < 4096; guard++) {
		let sum = freq[i1]! + freq[i2]!;
		if (sum === 0) sum = 1;
		freq[i1] = 9999;
		freq[i2] = 9999;
		if (isLeafless(i1)) {
			nodes[i1 * 2] = i1 + 10000;
			root = i1;
			freq[i1] = sum;
			nodes[i1 * 2 + 1] = isLeafless(i2) ? i2 + 10000 : i2;
		} else if (isLeafless(i2)) {
			nodes[i2 * 2] = i2 + 10000;
			root = i2;
			freq[i2] = sum;
			nodes[i2 * 2 + 1] = isLeafless(i1) ? i1 + 10000 : i1;
		} else {
			let r = 0;
			while (r < 2047 && (nodes[r * 2]! >= 0 || nodes[r * 2 + 1]! >= 0 || freq[r]! < 9999)) r++;
			root = r;
			freq[r] = sum;
			nodes[r * 2] = i1;
			nodes[r * 2 + 1] = i2;
		}
		findMins(false);
		if (min1 === 9999 || min2 === 9999) break;
	}
	const out = new Uint16Array(n);
	for (let i = 0; i < n; i++) {
		let v = root;
		for (let g = 0; v < 10000 && g < 64; g++) v = nodes[v * 2 + bits.read(1)]!;
		out[i] = v - 10000;
	}
	return out;
}

function rle(bits: Bits, total: number): Uint16Array {
	const bt = bits.read(3), rl = bits.read(3), bs = bits.read(4);
	let cost = bt + rl + bs + 1, fudge = 0;
	while (cost > 0) {
		cost -= bs + 1;
		fudge++;
	}
	const out = new Uint16Array(total + 64);
	let done = 0;
	while (done < total) {
		if (bits.read(1) === 0) {
			out[done++] = bits.read(bs);
		} else {
			const start = done - bits.read(bt) - 1;
			const run = bits.read(rl) + fudge;
			for (let i = start; i < start + run && done < out.length; i++) out[done++] = i >= 0 ? out[i]! : 0;
			if (done < out.length) out[done++] = bits.read(bs);
		}
	}
	return out.subarray(0, total);
}

function blur(px: Uint16Array, width: number, height: number, method: number, chansize: number): void {
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			const cur = px[i]! + chansize * 2;
			const left = x > 0 ? px[i - 1]! : 0;
			const above = y > 0 ? px[i - width]! : 0;
			const al = x > 0 && y > 0 ? px[i - width - 1]! : 0;
			let v: number;
			switch (method) {
				case 0: v = cur + left; break;
				case 1: v = cur + above; break;
				case 2: v = cur + al; break;
				case 3: v = cur + (left + above - al); break;
				case 4: v = cur + (Math.trunc((above - al) / 2) + left); break;
				case 5: v = cur + (Math.trunc((left - al) / 2) + above); break;
				case 6: v = cur + Math.trunc((left + above) / 2); break;
				default: v = cur;
			}
			// The original stores into u8 pixels.
			px[i] = (v % chansize) & 0xff;
		}
	}
}

/** Native pixel value (format's own encoding) → RGBA8. */
function toRgba(format: number, v: number, out: Uint8Array, o: number): void {
	const c5 = (x: number) => (x << 3) | (x >> 2);
	switch (format) {
		case TexFormat.RGBA32:
			out[o] = v >>> 24; out[o + 1] = (v >>> 16) & 255; out[o + 2] = (v >>> 8) & 255; out[o + 3] = v & 255;
			return;
		case TexFormat.RGB24:
			out[o] = (v >>> 16) & 255; out[o + 1] = (v >>> 8) & 255; out[o + 2] = v & 255; out[o + 3] = 255;
			return;
		case TexFormat.RGB15:
			v = ((v << 1) | 1) & 0xffff;
		// falls through
		case TexFormat.RGBA16:
			out[o] = c5((v >> 11) & 31); out[o + 1] = c5((v >> 6) & 31); out[o + 2] = c5((v >> 1) & 31); out[o + 3] = v & 1 ? 255 : 0;
			return;
		case TexFormat.IA16:
			out[o] = out[o + 1] = out[o + 2] = (v >> 8) & 255; out[o + 3] = v & 255;
			return;
		case TexFormat.IA8:
			out[o] = out[o + 1] = out[o + 2] = ((v >> 4) & 15) * 17; out[o + 3] = (v & 15) * 17;
			return;
		case TexFormat.IA4:
			out[o] = out[o + 1] = out[o + 2] = Math.floor((((v >> 1) & 7) * 255) / 7); out[o + 3] = v & 1 ? 255 : 0;
			return;
		case TexFormat.I8:
			out[o] = out[o + 1] = out[o + 2] = out[o + 3] = v & 255;
			return;
		case TexFormat.I4:
			out[o] = out[o + 1] = out[o + 2] = out[o + 3] = (v & 15) * 17;
			return;
	}
}

/** Planar channels → native values (texChannelsToPixels). */
function fromChannels(format: number, ch: Uint16Array, alpha: Uint8Array | null, n: number, i: number): number {
	const p = (k: number) => ch[i + n * k]!;
	switch (format) {
		case TexFormat.RGBA32: return ((p(0) << 24) | (p(1) << 16) | (p(2) << 8) | p(3)) >>> 0;
		case TexFormat.RGB24: return (p(0) << 16) | (p(1) << 8) | p(2);
		case TexFormat.RGBA16: return (p(0) << 11) | (p(1) << 6) | (p(2) << 1) | (alpha ? alpha[i]! : 1);
		case TexFormat.RGB15: return (p(0) << 10) | (p(1) << 5) | p(2);
		case TexFormat.IA16: return (p(0) << 8) | p(1);
		case TexFormat.IA8: return (p(0) << 4) | p(1);
		case TexFormat.IA4: return (p(0) << 1) | (alpha ? alpha[i]! : 1);
		default: return p(0);
	}
}

function readLookup(bits: Bits, bpp: number): number[] {
	const n = bits.read(11);
	const out: number[] = new Array(n);
	for (let i = 0; i < n; i++) out[i] = bpp > 24 ? ((bits.read(24) << 8) | bits.read(bpp - 24)) >>> 0 : bits.read(bpp);
	return out;
}

const bitSize = (n: number) => {
	let c = 0;
	for (n--; n > 0; n >>= 1) c++;
	return c;
};

function decodeNonZlib(data: Uint8Array, start: number): GoldeneyeTexture | null {
	const bits = new Bits(data, start);
	const format = bits.read(4), width = bits.read(8), height = bits.read(8), method = bits.read(4);
	if (format > 8 || width === 0 || height === 0 || width * height > 0x2000) return null;
	const n = width * height;
	const values = new Uint32Array(n);
	const nc = NUM_CHANNELS[format]!, cs = CHANNEL_SIZES[format]!;
	const readAlpha = () => {
		if (!HAS_1BIT_ALPHA[format]) return null;
		const a = new Uint8Array(n);
		for (let i = 0; i < n; i++) a[i] = bits.read(1);
		return a;
	};
	const planar = (ch: Uint16Array, alpha: Uint8Array | null) => {
		for (let i = 0; i < n; i++) values[i] = fromChannels(format, ch, alpha, n, i);
	};
	switch (method) {
		case 0:
		case 1: {
			const bpp = BITS_PER_PIXEL[format]!;
			for (let i = 0; i < n; i++) values[i] = bpp > 24 ? ((bits.read(16) << 16) | bits.read(16)) >>> 0 : bits.read(bpp);
			break;
		}
		case 2: {
			const ch = huffman(bits, nc * n, cs);
			planar(ch, readAlpha());
			break;
		}
		case 3: {
			const ch = new Uint16Array(nc * n);
			for (let j = 0; j < nc; j++) ch.set(huffman(bits, n, cs), j * n);
			planar(ch, readAlpha());
			break;
		}
		case 4: {
			const ch = rle(bits, nc * n);
			planar(ch, readAlpha());
			break;
		}
		case 5: {
			const lut = readLookup(bits, BITS_PER_PIXEL[format]!);
			const b = bitSize(lut.length);
			for (let i = 0; i < n; i++) values[i] = lut[bits.read(b)] ?? 0;
			break;
		}
		case 6:
		case 7: {
			const lut = readLookup(bits, BITS_PER_PIXEL[format]!);
			const idx = method === 6 ? huffman(bits, n, lut.length) : rle(bits, n);
			for (let i = 0; i < n; i++) values[i] = lut[idx[i]!] ?? 0;
			break;
		}
		case 8:
		case 9: {
			const filter = bits.read(3);
			const ch = method === 8 ? huffman(bits, nc * n, cs) : rle(bits, nc * n);
			blur(ch, width, nc * height, filter, cs);
			planar(ch, readAlpha());
			break;
		}
		default:
			return null;
	}
	const rgba = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) toRgba(format, values[i]!, rgba, i * 4);
	return { width, height, format, rgba };
}

function decodeZlib(data: Uint8Array, start: number): GoldeneyeTexture | null {
	let o = start;
	const format = data[o++]!;
	const colours = data[o++]! + 1;
	if (format < 9 || format > 12) return null;
	const palette: number[] = [];
	for (let i = 0; i < colours; i++, o += 2) palette.push((data[o]! << 8) | data[o + 1]!);
	const width = data[o++]!, height = data[o++]!;
	if (!width || !height || width * height > 4096) return null;
	// rarezip: a 2-byte header, then raw DEFLATE.
	const idx = inflateSync(data.subarray(o + 2));
	const ci4 = format === TexFormat.RGBA16_CI4 || format === TexFormat.IA16_CI4;
	const rowBytes = ci4 ? Math.ceil(width / 2) : width;
	const ia = format === TexFormat.IA16_CI8 || format === TexFormat.IA16_CI4;
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const b = idx[y * rowBytes + (ci4 ? x >> 1 : x)] ?? 0;
			const i = ci4 ? (x & 1 ? b & 15 : b >> 4) : b;
			toRgba(ia ? TexFormat.IA16 : TexFormat.RGBA16, palette[i] ?? 0, rgba, (y * width + x) * 4);
		}
	}
	return { width, height, format, rgba };
}

/** Decode the first image of a texture whose data starts at `data[start]`. */
export function decodeGoldeneyeTexture(data: Uint8Array, start = 0): GoldeneyeTexture | null {
	if (start >= data.length) return null;
	const flags = data[start]!;
	try {
		return flags & 0x40 ? decodeZlib(data, start + 1) : decodeNonZlib(data, start + 1);
	} catch {
		return null;
	}
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/**
 * Texture data offsets from `g_Textures` in the main code segment. In
 * the ROM each entry's low 24 bits hold the texture's *size* (the boot
 * code turns them into running offsets), so this finds the longest run
 * of 8-byte entries with plausible sizes and returns their prefix sums
 * (`offsets[n]` = start of texture n, plus a final end offset).
 */
export function findGoldeneyeTextureOffsets(code: Uint8Array): number[] | null {
	let best: { at: number; n: number } | null = null;
	for (let t = 0; t + 8 <= code.length; t += 4) {
		let n = 0;
		while (t + n * 8 + 8 <= code.length) {
			const size = u32(code, t + n * 8) & 0xffffff;
			if (size === 0 || size > 0x4000) break;
			n++;
		}
		if (n > 500 && (!best || n > best.n)) best = { at: t, n };
		if (n > 1) t += n * 8 - 4;
	}
	if (!best) return null;
	const offsets = [0];
	for (let i = 0; i < best.n; i++) offsets.push(offsets[i]! + (u32(code, best.at + i * 8) & 0xffffff));
	return offsets;
}

export interface GoldeneyeTextureBank {
	/** ROM offset of the images segment. */
	romStart: number;
	offsets: number[];
}

/**
 * Locate the images segment: the ROM position (8-aligned, within
 * `searchFrom … +0x10000`) where the first textures decode.
 */
export function findGoldeneyeTextureBank(rom: Uint8Array, offsets: number[], searchFrom: number): GoldeneyeTextureBank | null {
	const probe = [0, 1, 2, 3, 4, 5].filter((i) => i < offsets.length);
	for (let s = searchFrom & ~7; s < Math.min(rom.length, searchFrom + 0x10000); s += 8) {
		if (probe.every((i) => decodeGoldeneyeTexture(rom, s + offsets[i]!) !== null)) return { romStart: s, offsets };
	}
	return null;
}

/** Decode texture `n` from the bank. */
export function readGoldeneyeTexture(rom: Uint8Array, bank: GoldeneyeTextureBank, n: number): GoldeneyeTexture | null {
	const off = bank.offsets[n];
	if (off === undefined) return null;
	return decodeGoldeneyeTexture(rom, bank.romStart + off);
}
