/**
 * PlayStation MDEC video frames (STR versions 2 and 3).
 *
 * A frame is 16-bit little-endian words read MSB-first: a header
 * (u16 run/level code count, u16 0x3800, u16 qscale, u16 version),
 * then one macroblock per 16×16 tile in column-major order. Each
 * macroblock is six 8×8 blocks: Cr, Cb, Y0, Y1, Y2, Y3. A block is a
 * DC coefficient then run/level AC codes in zigzag order. The codes
 * are MPEG-1's table B.14, except the escape is a 6-bit run and a
 * 10-bit level.
 *
 *  - v1 / v2: DC is a 10-bit signed value (v1, used by Final
 *    Fantasy VII, has the same bitstream as v2).
 *  - v3: DC is a differential coded with MPEG-1's DC size VLCs.
 *
 * Decoding follows FFmpeg's `mdec` decoder (libavcodec/mdec.c).
 */

// prettier-ignore
const MPEG1_VLC: [number, number][] = [
	[0x3, 2], [0x4, 4], [0x5, 5], [0x6, 7], [0x26, 8], [0x21, 8], [0xa, 10], [0x1d, 12],
	[0x18, 12], [0x13, 12], [0x10, 12], [0x1a, 13], [0x19, 13], [0x18, 13], [0x17, 13], [0x1f, 14],
	[0x1e, 14], [0x1d, 14], [0x1c, 14], [0x1b, 14], [0x1a, 14], [0x19, 14], [0x18, 14], [0x17, 14],
	[0x16, 14], [0x15, 14], [0x14, 14], [0x13, 14], [0x12, 14], [0x11, 14], [0x10, 14], [0x18, 15],
	[0x17, 15], [0x16, 15], [0x15, 15], [0x14, 15], [0x13, 15], [0x12, 15], [0x11, 15], [0x10, 15],
	[0x3, 3], [0x6, 6], [0x25, 8], [0xc, 10], [0x1b, 12], [0x16, 13], [0x15, 13], [0x1f, 15],
	[0x1e, 15], [0x1d, 15], [0x1c, 15], [0x1b, 15], [0x1a, 15], [0x19, 15], [0x13, 16], [0x12, 16],
	[0x11, 16], [0x10, 16], [0x5, 4], [0x4, 7], [0xb, 10], [0x14, 12], [0x14, 13], [0x7, 5],
	[0x24, 8], [0x1c, 12], [0x13, 13], [0x6, 5], [0xf, 10], [0x12, 12], [0x7, 6], [0x9, 10],
	[0x12, 13], [0x5, 6], [0x1e, 12], [0x14, 16], [0x4, 6], [0x15, 12], [0x7, 7], [0x11, 12],
	[0x5, 7], [0x11, 13], [0x27, 8], [0x10, 13], [0x23, 8], [0x1a, 16], [0x22, 8], [0x19, 16],
	[0x20, 8], [0x18, 16], [0xe, 10], [0x17, 16], [0xd, 10], [0x16, 16], [0x8, 10], [0x15, 16],
	[0x1f, 12], [0x1a, 12], [0x19, 12], [0x17, 12], [0x16, 12], [0x1f, 13], [0x1e, 13], [0x1d, 13],
	[0x1c, 13], [0x1b, 13], [0x1f, 16], [0x1e, 16], [0x1d, 16], [0x1c, 16], [0x1b, 16],
];
// prettier-ignore
const MPEG1_LEVEL = [
	1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
	25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2, 3, 4, 5, 6, 7, 8,
	9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 1, 2, 3, 4, 5, 1, 2, 3, 4, 1, 2, 3, 1, 2,
	3, 1, 2, 3, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];
// prettier-ignore
const MPEG1_RUN = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5,
	5, 6, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16,
	17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
];
// prettier-ignore
const INTRA_MATRIX = [
	8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37,
	19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40,
	22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58,
	26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
];
// prettier-ignore
const ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
	12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const DC_LUM: [number, number][] = [[0x4, 3], [0x0, 2], [0x1, 2], [0x5, 3], [0x6, 3], [0xe, 4], [0x1e, 5], [0x3e, 6], [0x7e, 7], [0xfe, 8], [0x1fe, 9], [0x1ff, 9]];
const DC_CHROMA: [number, number][] = [[0x0, 2], [0x1, 2], [0x2, 2], [0x6, 3], [0xe, 4], [0x1e, 5], [0x3e, 6], [0x7e, 7], [0xfe, 8], [0x1fe, 9], [0x3fe, 10], [0x3ff, 10]];

const KIND_CODE = 0;
const KIND_ESCAPE = 1;
const KIND_EOB = 2;

/**
 * 16-bit lookup: entry = len | kind << 5 | run << 8 | level << 16.
 * len 0 marks an invalid code.
 */
const AC_TABLE = (() => {
	const t = new Int32Array(1 << 16);
	const fill = (code: number, len: number, value: number) => {
		const start = code << (16 - len);
		const end = (code + 1) << (16 - len);
		for (let i = start; i < end; i++) t[i] = value;
	};
	MPEG1_VLC.forEach(([code, len], i) => fill(code, len, len | (KIND_CODE << 5) | ((MPEG1_RUN[i] + 1) << 8) | (MPEG1_LEVEL[i] << 16)));
	fill(0x1, 6, 6 | (KIND_ESCAPE << 5));
	fill(0x2, 2, 2 | (KIND_EOB << 5));
	return t;
})();

function dcTable(codes: [number, number][]): Int16Array {
	const t = new Int16Array(1 << 10).fill(-1);
	codes.forEach(([code, len], size) => {
		const start = code << (10 - len);
		const end = (code + 1) << (10 - len);
		for (let i = start; i < end; i++) t[i] = (len << 8) | size;
	});
	return t;
}
const DC_LUM_TABLE = dcTable(DC_LUM);
const DC_CHROMA_TABLE = dcTable(DC_CHROMA);

/** MSB-first reader over 16-bit little-endian words. */
class BitReader {
	private pos = 0; // bit position
	readonly bits: number;
	constructor(private readonly data: Uint8Array) {
		this.bits = (data.length >> 1) * 16;
	}
	private word(i: number): number {
		const o = i * 2;
		return o + 1 < this.data.length ? this.data[o] | (this.data[o + 1] << 8) : 0;
	}
	/** Peek up to 24 bits (three words give 48 exact bits in a double). */
	peek(n: number): number {
		const w = this.pos >> 4;
		const v = this.word(w) * 4294967296 + this.word(w + 1) * 65536 + this.word(w + 2);
		const shift = 48 - (this.pos & 15) - n;
		return Math.floor(v / 2 ** shift) % (1 << n);
	}
	skip(n: number): void {
		this.pos += n;
	}
	read(n: number): number {
		const v = this.peek(n);
		this.pos += n;
		return v;
	}
	readSigned(n: number): number {
		const v = this.read(n);
		return v & (1 << (n - 1)) ? v - (1 << n) : v;
	}
	get left(): number {
		return this.bits - this.pos;
	}
}

// IDCT basis: M[k][n] = c(k)/2 · cos((2n+1)kπ/16).
const IDCT = (() => {
	const m = new Float64Array(64);
	for (let k = 0; k < 8; k++) {
		for (let n = 0; n < 8; n++) {
			m[k * 8 + n] = (k === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
		}
	}
	return m;
})();

const tmp = new Float64Array(64);

/** 2D inverse DCT of `block` (raster order) into `dst` with clamping. */
function idctPut(block: Int32Array, dst: Uint8Array, offset: number, stride: number): void {
	// Rows: tmp[v][x] = Σu F[v][u] M[u][x]
	for (let v = 0; v < 8; v++) {
		const r = v * 8;
		let any = false;
		for (let u = 0; u < 8; u++) if (block[r + u]) { any = true; break; }
		for (let x = 0; x < 8; x++) {
			let s = 0;
			if (any) for (let u = 0; u < 8; u++) s += block[r + u] * IDCT[u * 8 + x];
			tmp[r + x] = s;
		}
	}
	// Columns: out[y][x] = Σv M[v][y] tmp[v][x]
	for (let x = 0; x < 8; x++) {
		for (let y = 0; y < 8; y++) {
			let s = 0;
			for (let v = 0; v < 8; v++) s += IDCT[v * 8 + y] * tmp[v * 8 + x];
			const p = Math.round(s);
			dst[offset + y * stride + x] = p < 0 ? 0 : p > 255 ? 255 : p;
		}
	}
}

export interface MdecFrame {
	width: number;
	height: number;
	/** Coded (macroblock-aligned) size of the planes. */
	codedWidth: number;
	codedHeight: number;
	y: Uint8Array;
	u: Uint8Array;
	v: Uint8Array;
	yStride: number;
	uStride: number;
	vStride: number;
}

export class MdecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MdecError';
	}
}

/**
 * Offset of the MDEC header in a demuxed frame: 0 normally, 40 for
 * Final Fantasy VII, which prefixes each frame with camera data.
 * Returns -1 when no `0x3800` magic is found.
 */
export function mdecHeaderOffset(frame: Uint8Array): number {
	for (let p = 0; p + 8 <= Math.min(frame.length, 72); p += 4) {
		if (frame[p + 2] === 0x00 && frame[p + 3] === 0x38) {
			const version = frame[p + 6] | (frame[p + 7] << 8);
			if (version >= 1 && version <= 3) return p;
		}
	}
	return -1;
}

/** Read the version of an MDEC frame header (-1 when there's none). */
export function mdecFrameVersion(frame: Uint8Array): number {
	const p = mdecHeaderOffset(frame);
	return p < 0 ? -1 : frame[p + 6] | (frame[p + 7] << 8);
}

/** Decode one MDEC frame (STR v2 / v3) to YUV 4:2:0 planes (full range). */
export function decodeMdecFrame(frame: Uint8Array, width: number, height: number): MdecFrame {
	const headerAt = mdecHeaderOffset(frame);
	if (headerAt < 0) throw new MdecError('No MDEC frame header');
	frame = frame.subarray(headerAt);
	if (frame.length < 8) throw new MdecError('MDEC frame too short');
	const qscale = frame[4] | (frame[5] << 8);
	const version = frame[6] | (frame[7] << 8);
	if (version < 1 || version > 3) throw new MdecError(`Unsupported MDEC frame version ${version}`);
	const mbW = (width + 15) >> 4;
	const mbH = (height + 15) >> 4;
	const codedWidth = mbW * 16;
	const codedHeight = mbH * 16;
	const y = new Uint8Array(codedWidth * codedHeight);
	const u = new Uint8Array((codedWidth >> 1) * (codedHeight >> 1)).fill(128);
	const v = new Uint8Array((codedWidth >> 1) * (codedHeight >> 1)).fill(128);
	const br = new BitReader(frame);
	br.skip(64);
	const lastDc = [128, 128, 128];
	const blocks = Array.from({ length: 6 }, () => new Int32Array(64));
	// Decode order Cr, Cb, Y0..Y3 (FFmpeg's block_index).
	const order = [5, 4, 0, 1, 2, 3];
	const cw = codedWidth >> 1;
	try {
		for (let mx = 0; mx < mbW; mx++) {
			for (let my = 0; my < mbH; my++) {
				for (const n of order) {
					const block = blocks[n];
					block.fill(0);
					if (version !== 3) {
						block[0] = 2 * br.readSigned(10) + 1024;
					} else {
						const comp = n <= 3 ? 0 : n - 3;
						const t = comp === 0 ? DC_LUM_TABLE : DC_CHROMA_TABLE;
						const e = t[br.peek(10)];
						if (e < 0) throw new MdecError('bad DC code');
						br.skip(e >> 8);
						const size = e & 0xff;
						let diff = 0;
						if (size) {
							const bits = br.read(size);
							diff = bits & (1 << (size - 1)) ? bits : bits - (1 << size) + 1;
						}
						lastDc[comp] += diff;
						block[0] = lastDc[comp] * 8;
					}
					let i = 0;
					for (;;) {
						const e = AC_TABLE[br.peek(16)];
						const len = e & 31;
						if (!len) throw new MdecError('bad AC code');
						const kind = (e >> 5) & 7;
						br.skip(len);
						if (kind === KIND_EOB) break;
						let level: number;
						let j: number;
						if (kind === KIND_CODE) {
							i += (e >> 8) & 0xff;
							if (i > 63) throw new MdecError('AC run past the block');
							j = ZIGZAG[i];
							level = ((e >> 16) * qscale * INTRA_MATRIX[j]) >> 3;
							if (br.read(1)) level = -level;
						} else {
							i += br.read(6) + 1;
							level = br.readSigned(10);
							if (i > 63) throw new MdecError('AC run past the block');
							j = ZIGZAG[i];
							if (level < 0) {
								level = -((((-level * qscale * INTRA_MATRIX[j]) >> 3) - 1) | 1);
							} else {
								level = (((level * qscale * INTRA_MATRIX[j]) >> 3) - 1) | 1;
							}
						}
						block[j] = level;
					}
					if (br.left < 0) throw new MdecError('frame data ran out');
				}
				const yo = my * 16 * codedWidth + mx * 16;
				idctPut(blocks[0], y, yo, codedWidth);
				idctPut(blocks[1], y, yo + 8, codedWidth);
				idctPut(blocks[2], y, yo + 8 * codedWidth, codedWidth);
				idctPut(blocks[3], y, yo + 8 * codedWidth + 8, codedWidth);
				const co = my * 8 * cw + mx * 8;
				idctPut(blocks[4], u, co, cw);
				idctPut(blocks[5], v, co, cw);
			}
		}
	} catch (err) {
		// Keep what decoded so far; a damaged tail shouldn't lose the frame.
		if (!(err instanceof MdecError)) throw err;
	}
	return { width, height, codedWidth, codedHeight, y, u, v, yStride: codedWidth, uStride: cw, vStride: cw };
}

/** Convert a decoded frame to RGBA8 (BT.601, full range), cropped to its display size. */
export function mdecFrameToRgba(f: MdecFrame): Uint8Array {
	const out = new Uint8Array(f.width * f.height * 4);
	for (let yy = 0; yy < f.height; yy++) {
		for (let xx = 0; xx < f.width; xx++) {
			const Y = f.y[yy * f.yStride + xx];
			const ci = (yy >> 1) * f.uStride + (xx >> 1);
			const U = f.u[ci] - 128;
			const V = f.v[ci] - 128;
			const o = (yy * f.width + xx) * 4;
			out[o] = clamp(Y + 1.402 * V);
			out[o + 1] = clamp(Y - 0.344136 * U - 0.714136 * V);
			out[o + 2] = clamp(Y + 1.772 * U);
			out[o + 3] = 255;
		}
	}
	return out;
}

function clamp(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
