/**
 * BC6H (BPTC float) block decoder → RGB half floats.
 *
 * Ported from Sergii "iOrange" Kudlai's bcdec.h v0.985 (`bcdec_bc6h_half`,
 * dual-licensed MIT / Unlicense): the per-mode endpoint bit layouts were
 * translated mechanically from its C source. Reference: Microsoft's
 * "BC6H Format" documentation.
 */

const ACTUAL_BITS: number[][] = [
	[10, 7, 11, 11, 11, 9, 8, 8, 8, 6, 10, 11, 12, 16], // W
	[5, 6, 5, 4, 4, 5, 6, 5, 5, 6, 10, 9, 8, 4], // dR
	[5, 6, 4, 5, 4, 5, 5, 6, 5, 6, 10, 9, 8, 4], // dG
	[5, 6, 4, 4, 5, 5, 5, 5, 6, 6, 10, 9, 8, 4], // dB
];

/** 32 two-region partitions (row-major 4×4); 0x80 marks a fix-up index. */
const PARTITIONS: number[][] = [
	[128, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 129],
	[128, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 129],
	[128, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 129],
	[128, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 129],
	[128, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 129],
	[128, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 129],
	[128, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 129],
	[128, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 129],
	[128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 129],
	[128, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 129],
	[128, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 129],
	[128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 129],
	[128, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 129],
	[128, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 129],
	[128, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 129],
	[128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 129],
	[128, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 129],
	[128, 1, 129, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
	[128, 0, 0, 0, 0, 0, 0, 0, 129, 0, 0, 0, 1, 1, 1, 0],
	[128, 1, 129, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0],
	[128, 0, 129, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
	[128, 0, 0, 0, 1, 0, 0, 0, 129, 1, 0, 0, 1, 1, 1, 0],
	[128, 0, 0, 0, 0, 0, 0, 0, 129, 0, 0, 0, 1, 1, 0, 0],
	[128, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 129],
	[128, 0, 129, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
	[128, 0, 0, 0, 1, 0, 0, 0, 129, 0, 0, 0, 1, 1, 0, 0],
	[128, 1, 129, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0],
	[128, 0, 129, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0],
	[128, 0, 0, 1, 0, 1, 1, 1, 129, 1, 1, 0, 1, 0, 0, 0],
	[128, 0, 0, 0, 1, 1, 1, 1, 129, 1, 1, 1, 0, 0, 0, 0],
	[128, 1, 129, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0],
	[128, 0, 129, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0],
];

const WEIGHT3 = [0, 9, 18, 27, 37, 46, 55, 64];
const WEIGHT4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

const extendSign = (v: number, n: number) => (v << (32 - n)) >> (32 - n);

function transformInverse(v: number, a0: number, n: number, signed: boolean): number {
	v = (v + a0) & ((1 << n) - 1);
	return signed ? extendSign(v, n) : v;
}

function unquantize(v: number, n: number, signed: boolean): number {
	if (!signed) {
		if (n >= 15) return v;
		if (!v) return 0;
		if (v === (1 << n) - 1) return 0xffff;
		return ((v << 16) + 0x8000) >> n;
	}
	if (n >= 16) return v;
	let s = false;
	if (v < 0) {
		s = true;
		v = -v;
	}
	let u: number;
	if (v === 0) u = 0;
	else if (v >= (1 << (n - 1)) - 1) u = 0x7fff;
	else u = ((v << 15) + 0x4000) >> (n - 1);
	return s ? -u : u;
}

const interpolate = (a: number, b: number, w: number[], i: number) => (a * (64 - w[i]!) + b * w[i]! + 32) >> 6;

function finishUnquantize(v: number, signed: boolean): number {
	if (!signed) return (v * 31) >> 6;
	v = v < 0 ? -((-v * 31) >> 5) : (v * 31) >> 5;
	return v < 0 ? 0x8000 | -v : v;
}

/**
 * Decode one 16-byte BC6H block at `src[off…]` into 16 RGB half-float
 * texels (`out`, 48 u16, row-major).
 */
export function decodeBC6HBlock(src: Uint8Array, off: number, signed: boolean, out: Uint16Array): void {
	let pos = 0;
	const bit = () => {
		const v = (src[off + (pos >> 3)]! >> (pos & 7)) & 1;
		pos++;
		return v;
	};
	const bits = (n: number) => {
		let v = 0;
		for (let i = 0; i < n; i++) v |= bit() << i;
		return v;
	};
	/** Bits read MSB-first (bcdec's "reversed" pull). */
	const bitsR = (n: number) => {
		let v = bits(n), r = 0;
		while (n--) {
			r = (r << 1) | (v & 1);
			v >>= 1;
		}
		return r;
	};
	const r = [0, 0, 0, 0], g = [0, 0, 0, 0], b = [0, 0, 0, 0];
	let mode = bits(2);
	if (mode > 1) mode |= bits(3) << 2;
	let partition = 0;
	switch (mode) {
		case 0b00: {
			g[2] |= bit() << 4;
			b[2] |= bit() << 4;
			b[3] |= bit() << 4;
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(5);
			g[3] |= bit() << 4;
			g[2] |= bits(4);
			g[1] |= bits(5);
			b[3] |= bit();
			g[3] |= bits(4);
			b[1] |= bits(5);
			b[3] |= bit() << 1;
			b[2] |= bits(4);
			r[2] |= bits(5);
			b[3] |= bit() << 2;
			r[3] |= bits(5);
			b[3] |= bit() << 3;
			partition = bits(5);
			mode = 0;
		break;
		}
		case 0b01: {
			g[2] |= bit() << 5;
			g[3] |= bit() << 4;
			g[3] |= bit() << 5;
			r[0] |= bits(7);
			b[3] |= bit();
			b[3] |= bit() << 1;
			b[2] |= bit() << 4;
			g[0] |= bits(7);
			b[2] |= bit() << 5;
			b[3] |= bit() << 2;
			g[2] |= bit() << 4;
			b[0] |= bits(7);
			b[3] |= bit() << 3;
			b[3] |= bit() << 5;
			b[3] |= bit() << 4;
			r[1] |= bits(6);
			g[2] |= bits(4);
			g[1] |= bits(6);
			g[3] |= bits(4);
			b[1] |= bits(6);
			b[2] |= bits(4);
			r[2] |= bits(6);
			r[3] |= bits(6);
			partition = bits(5);
			mode = 1;
		break;
		}
		case 0b00010: {
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(5);
			r[0] |= bit() << 10;
			g[2] |= bits(4);
			g[1] |= bits(4);
			g[0] |= bit() << 10;
			b[3] |= bit();
			g[3] |= bits(4);
			b[1] |= bits(4);
			b[0] |= bit() << 10;
			b[3] |= bit() << 1;
			b[2] |= bits(4);
			r[2] |= bits(5);
			b[3] |= bit() << 2;
			r[3] |= bits(5);
			b[3] |= bit() << 3;
			partition = bits(5);
			mode = 2;
		break;
		}
		case 0b00110: {
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(4);
			r[0] |= bit() << 10;
			g[3] |= bit() << 4;
			g[2] |= bits(4);
			g[1] |= bits(5);
			g[0] |= bit() << 10;
			g[3] |= bits(4);
			b[1] |= bits(4);
			b[0] |= bit() << 10;
			b[3] |= bit() << 1;
			b[2] |= bits(4);
			r[2] |= bits(4);
			b[3] |= bit();
			b[3] |= bit() << 2;
			r[3] |= bits(4);
			g[2] |= bit() << 4;
			b[3] |= bit() << 3;
			partition = bits(5);
			mode = 3;
		break;
		}
		case 0b01010: {
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(4);
			r[0] |= bit() << 10;
			b[2] |= bit() << 4;
			g[2] |= bits(4);
			g[1] |= bits(4);
			g[0] |= bit() << 10;
			b[3] |= bit();
			g[3] |= bits(4);
			b[1] |= bits(5);
			b[0] |= bit() << 10;
			b[2] |= bits(4);
			r[2] |= bits(4);
			b[3] |= bit() << 1;
			b[3] |= bit() << 2;
			r[3] |= bits(4);
			b[3] |= bit() << 4;
			b[3] |= bit() << 3;
			partition = bits(5);
			mode = 4;
		break;
		}
		case 0b01110: {
			r[0] |= bits(9);
			b[2] |= bit() << 4;
			g[0] |= bits(9);
			g[2] |= bit() << 4;
			b[0] |= bits(9);
			b[3] |= bit() << 4;
			r[1] |= bits(5);
			g[3] |= bit() << 4;
			g[2] |= bits(4);
			g[1] |= bits(5);
			b[3] |= bit();
			g[3] |= bits(4);
			b[1] |= bits(5);
			b[3] |= bit() << 1;
			b[2] |= bits(4);
			r[2] |= bits(5);
			b[3] |= bit() << 2;
			r[3] |= bits(5);
			b[3] |= bit() << 3;
			partition = bits(5);
			mode = 5;
		break;
		}
		case 0b10010: {
			r[0] |= bits(8);
			g[3] |= bit() << 4;
			b[2] |= bit() << 4;
			g[0] |= bits(8);
			b[3] |= bit() << 2;
			g[2] |= bit() << 4;
			b[0] |= bits(8);
			b[3] |= bit() << 3;
			b[3] |= bit() << 4;
			r[1] |= bits(6);
			g[2] |= bits(4);
			g[1] |= bits(5);
			b[3] |= bit();
			g[3] |= bits(4);
			b[1] |= bits(5);
			b[3] |= bit() << 1;
			b[2] |= bits(4);
			r[2] |= bits(6);
			r[3] |= bits(6);
			partition = bits(5);
			mode = 6;
		break;
		}
		case 0b10110: {
			r[0] |= bits(8);
			b[3] |= bit();
			b[2] |= bit() << 4;
			g[0] |= bits(8);
			g[2] |= bit() << 5;
			g[2] |= bit() << 4;
			b[0] |= bits(8);
			g[3] |= bit() << 5;
			b[3] |= bit() << 4;
			r[1] |= bits(5);
			g[3] |= bit() << 4;
			g[2] |= bits(4);
			g[1] |= bits(6);
			g[3] |= bits(4);
			b[1] |= bits(5);
			b[3] |= bit() << 1;
			b[2] |= bits(4);
			r[2] |= bits(5);
			b[3] |= bit() << 2;
			r[3] |= bits(5);
			b[3] |= bit() << 3;
			partition = bits(5);
			mode = 7;
		break;
		}
		case 0b11010: {
			r[0] |= bits(8);
			b[3] |= bit() << 1;
			b[2] |= bit() << 4;
			g[0] |= bits(8);
			b[2] |= bit() << 5;
			g[2] |= bit() << 4;
			b[0] |= bits(8);
			b[3] |= bit() << 5;
			b[3] |= bit() << 4;
			r[1] |= bits(5);
			g[3] |= bit() << 4;
			g[2] |= bits(4);
			g[1] |= bits(5);
			b[3] |= bit();
			g[3] |= bits(4);
			b[1] |= bits(6);
			b[2] |= bits(4);
			r[2] |= bits(5);
			b[3] |= bit() << 2;
			r[3] |= bits(5);
			b[3] |= bit() << 3;
			partition = bits(5);
			mode = 8;
		break;
		}
		case 0b11110: {
			r[0] |= bits(6);
			g[3] |= bit() << 4;
			b[3] |= bit();
			b[3] |= bit() << 1;
			b[2] |= bit() << 4;
			g[0] |= bits(6);
			g[2] |= bit() << 5;
			b[2] |= bit() << 5;
			b[3] |= bit() << 2;
			g[2] |= bit() << 4;
			b[0] |= bits(6);
			g[3] |= bit() << 5;
			b[3] |= bit() << 3;
			b[3] |= bit() << 5;
			b[3] |= bit() << 4;
			r[1] |= bits(6);
			g[2] |= bits(4);
			g[1] |= bits(6);
			g[3] |= bits(4);
			b[1] |= bits(6);
			b[2] |= bits(4);
			r[2] |= bits(6);
			r[3] |= bits(6);
			partition = bits(5);
			mode = 9;
		break;
		}
		case 0b00011: {
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(10);
			g[1] |= bits(10);
			b[1] |= bits(10);
			mode = 10;
		break;
		}
		case 0b00111: {
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(9);
			r[0] |= bit() << 10;
			g[1] |= bits(9);
			g[0] |= bit() << 10;
			b[1] |= bits(9);
			b[0] |= bit() << 10;
			mode = 11;
		break;
		}
		case 0b01011: {
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(8);
			r[0] |= bitsR(2) << 10;
			g[1] |= bits(8);
			g[0] |= bitsR(2) << 10;
			b[1] |= bits(8);
			b[0] |= bitsR(2) << 10;
			mode = 12;
		break;
		}
		case 0b01111: {
			r[0] |= bits(10);
			g[0] |= bits(10);
			b[0] |= bits(10);
			r[1] |= bits(4);
			r[0] |= bitsR(6) << 10;
			g[1] |= bits(4);
			g[0] |= bitsR(6) << 10;
			b[1] |= bits(4);
			b[0] |= bitsR(6) << 10;
			mode = 13;
		break;
		}
		default:
			out.fill(0);
			return;
	}

	const twoRegion = mode < 10;
	const regions = twoRegion ? 2 : 1;
	const w0 = ACTUAL_BITS[0]![mode]!;
	if (signed) {
		r[0] = extendSign(r[0]!, w0);
		g[0] = extendSign(g[0]!, w0);
		b[0] = extendSign(b[0]!, w0);
	}
	// Modes 10 and 11 (bcdec's 9 / 10) store endpoints without deltas.
	if ((mode !== 9 && mode !== 10) || signed) {
		for (let i = 1; i < regions * 2; i++) {
			r[i] = extendSign(r[i]!, ACTUAL_BITS[1]![mode]!);
			g[i] = extendSign(g[i]!, ACTUAL_BITS[2]![mode]!);
			b[i] = extendSign(b[i]!, ACTUAL_BITS[3]![mode]!);
		}
	}
	if (mode !== 9 && mode !== 10) {
		for (let i = 1; i < regions * 2; i++) {
			r[i] = transformInverse(r[i]!, r[0]!, w0, signed);
			g[i] = transformInverse(g[i]!, g[0]!, w0, signed);
			b[i] = transformInverse(b[i]!, b[0]!, w0, signed);
		}
	}
	for (let i = 0; i < regions * 2; i++) {
		r[i] = unquantize(r[i]!, w0, signed);
		g[i] = unquantize(g[i]!, w0, signed);
		b[i] = unquantize(b[i]!, w0, signed);
	}
	const weights = twoRegion ? WEIGHT3 : WEIGHT4;
	for (let t = 0; t < 16; t++) {
		let set = twoRegion ? PARTITIONS[partition]![t]! : t === 0 ? 0x80 : 0;
		let indexBits = twoRegion ? 3 : 4;
		// Fix-up indices are stored with one bit less.
		if (set & 0x80) indexBits--;
		set &= 1;
		const index = bits(indexBits);
		const e = set * 2;
		out[t * 3] = finishUnquantize(interpolate(r[e]!, r[e + 1]!, weights, index), signed);
		out[t * 3 + 1] = finishUnquantize(interpolate(g[e]!, g[e + 1]!, weights, index), signed);
		out[t * 3 + 2] = finishUnquantize(interpolate(b[e]!, b[e + 1]!, weights, index), signed);
	}
}

/** Half float (u16 bits) → number. */
export function halfToFloat(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * Decode a BC6H image to linear RGB floats (`w × h × 3`, row-major).
 */
export function decodeBC6H(src: Uint8Array, w: number, h: number, signed: boolean): Float32Array {
	const out = new Float32Array(w * h * 3);
	const block = new Uint16Array(48);
	const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++) {
			const off = (by * bw + bx) * 16;
			if (off + 16 > src.length) return out;
			decodeBC6HBlock(src, off, signed, block);
			for (let t = 0; t < 16; t++) {
				const x = bx * 4 + (t & 3), y = by * 4 + (t >> 2);
				if (x >= w || y >= h) continue;
				const o = (y * w + x) * 3;
				out[o] = halfToFloat(block[t * 3]!);
				out[o + 1] = halfToFloat(block[t * 3 + 1]!);
				out[o + 2] = halfToFloat(block[t * 3 + 2]!);
			}
		}
	}
	return out;
}
