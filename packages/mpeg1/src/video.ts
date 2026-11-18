/**
 * MPEG-1 video (ISO/IEC 11172-2) decoder, ported from pl_mpeg's
 * `plm_video` (MIT, https://github.com/phoboslab/pl_mpeg, itself
 * inspired by Zoltan Korandi's Java MPEG-1 decoder).
 *
 * Input is an elementary stream: a sequence header (`00 00 01 B3`)
 * followed by groups of pictures, each picture made of slices of
 * macroblocks. I pictures stand alone, P pictures predict from the last
 * reference, B pictures from the references either side of them, which
 * is why the stream stores pictures out of display order: a reference
 * is held back until the next one arrives ({@link Mpeg1VideoDecoder.decode}
 * returns frames in display order).
 *
 * One extension beyond pl_mpeg: TMPGEnc writes MPEG-1 with MPEG-2's
 * intra DC precision, announced in sequence user data as
 * `TMPGEXS … IDCPREC <len><value> … TMPGEXE` (FFmpeg's `tmpgexs` flag in
 * `mpeg12dec.c`). CRI's Sofdec2 "MPEG" streams are made that way (Sonic
 * Frontiers' movies use precision 3, 11-bit DC), and decode as noise
 * without it.
 *
 * Frames are YCbCr 4:2:0 planes padded to whole macroblocks. They are
 * the decoder's own buffers and change on the next `decode()`: copy what
 * you keep.
 */

import {
	CODE_BLOCK_PATTERN,
	DCT_COEFF,
	DCT_SIZE,
	MACROBLOCK_ADDRESS_INCREMENT,
	MACROBLOCK_TYPE,
	MOTION,
} from './tables.js';

const PICTURE_TYPE_INTRA = 1;
const PICTURE_TYPE_PREDICTIVE = 2;
const PICTURE_TYPE_B = 3;

const START_SEQUENCE = 0xb3;
const START_PICTURE = 0x00;
const START_EXTENSION = 0xb5;
const START_USER_DATA = 0xb2;
const isSlice = (c: number) => c >= 0x01 && c <= 0xaf;

const PICTURE_RATE = [0, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 0, 0, 0, 0, 0, 0, 0];

const ZIG_ZAG = Uint8Array.from([
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const INTRA_QUANT_MATRIX = Uint8Array.from([
	8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40,
	22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
]);

const PREMULTIPLIER_MATRIX = Uint8Array.from([
	32, 44, 42, 38, 32, 25, 17, 9, 44, 62, 58, 52, 44, 35, 24, 12, 42, 58, 55, 49, 42, 33, 23, 12, 38, 52, 49, 44, 38, 30, 20, 10,
	32, 44, 42, 38, 32, 25, 17, 9, 25, 35, 33, 30, 25, 20, 14, 7, 17, 24, 23, 20, 17, 14, 9, 5, 9, 12, 12, 10, 9, 7, 5, 2,
]);

/** Big-endian bit reader over the whole stream. */
class BitReader {
	index = 0; // in bits
	constructor(readonly bytes: Uint8Array) {}

	has(count: number): boolean {
		return this.index + count <= this.bytes.length * 8;
	}

	read(count: number): number {
		if (!this.has(count)) {
			this.index = this.bytes.length * 8;
			return 0;
		}
		let value = 0;
		while (count) {
			const byte = this.bytes[this.index >> 3]!;
			const remaining = 8 - (this.index & 7);
			const read = remaining < count ? remaining : count;
			const shift = remaining - read;
			const mask = 0xff >> (8 - read);
			value = (value << read) | ((byte & (mask << shift)) >> shift);
			this.index += read;
			count -= read;
		}
		return value;
	}

	skip(count: number): void {
		if (this.has(count)) this.index += count;
	}

	peekNonZero(count: number): boolean {
		if (!this.has(count)) return false;
		const v = this.read(count);
		this.index -= count;
		return v !== 0;
	}

	/** Next start code's byte (the reader then sits after it), or -1. */
	nextStartCode(): number {
		this.index = ((this.index + 7) >> 3) << 3;
		const b = this.bytes;
		for (let i = this.index >> 3; i + 4 <= b.length; i++) {
			if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
				this.index = (i + 4) << 3;
				return b[i + 3]!;
			}
		}
		this.index = b.length * 8;
		return -1;
	}

	findStartCode(code: number): number {
		for (;;) {
			const c = this.nextStartCode();
			if (c === code || c === -1) return c;
		}
	}

	/** Walk a {@link tables} VLC table one bit at a time. */
	readVlc(table: Int32Array): number {
		let index = 0, value = 0;
		do {
			const e = (index + this.read(1)) * 2;
			index = table[e]!;
			value = table[e + 1]!;
		} while (index > 0 && this.has(1));
		return value;
	}
}

interface Plane {
	data: Uint8Array;
	width: number;
}

interface Picture {
	y: Plane;
	cr: Plane;
	cb: Plane;
}

interface Motion {
	fullPx: boolean;
	isSet: boolean;
	rSize: number;
	h: number;
	v: number;
}

export interface Mpeg1Frame {
	/** Display size. */
	width: number;
	height: number;
	/** Luma plane, `yStride` wide (whole macroblocks). */
	y: Uint8Array;
	yStride: number;
	/** Chroma planes, `cStride` wide, half the luma size each way. */
	cb: Uint8Array;
	cr: Uint8Array;
	cStride: number;
	/** Seconds since the first frame. */
	time: number;
}

export interface Mpeg1Info {
	width: number;
	height: number;
	/** Frames per second (`picture_rate`). */
	frameRate: number;
}

/**
 * TMPGEnc's intra DC precision from the user data near the start of the
 * stream (0 when absent). FFmpeg assumes 3 whenever `TMPGEXS` is there.
 */
export function tmpgencDcPrecision(bytes: Uint8Array): number {
	const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
	if (!head.includes('TMPGEXS\0')) return 0;
	const m = /IDCPREC\0(\d{8})(\d{8})/.exec(head);
	const v = m ? Number(m[2]) : 3;
	return v >= 0 && v <= 3 ? v : 3;
}

const clamp = (n: number) => (n > 255 ? 255 : n < 0 ? 0 : n);

export class Mpeg1VideoDecoder {
	private bits: BitReader;
	private startCode = -1;
	private hasSequenceHeader = false;
	private hasReferenceFrame = false;
	private framesDecoded = 0;

	width = 0;
	height = 0;
	frameRate = 30;
	private mbWidth = 0;
	private mbHeight = 0;
	private mbSize = 0;
	private lumaWidth = 0;
	private chromaWidth = 0;

	private pictureType = 0;
	private forward: Motion = { fullPx: false, isSet: false, rSize: 0, h: 0, v: 0 };
	private backward: Motion = { fullPx: false, isSet: false, rSize: 0, h: 0, v: 0 };
	private quantizerScale = 0;
	private sliceBegin = false;
	private macroblockAddress = 0;
	private mbRow = 0;
	private mbCol = 0;
	private macroblockType = 0;
	private macroblockIntra = false;
	private dcPredictor = [128, 128, 128];
	/** Intra DC precision (0-3): DC is 8 + n bits, scaled by 8 >> n. */
	private dcPrecision = 0;
	private dcReset = 128;

	private current!: Picture;
	private forwardFrame!: Picture;
	private backwardFrame!: Picture;

	private blockData = new Int32Array(64);
	private intraQuant = new Uint8Array(64);
	private nonIntraQuant = new Uint8Array(64);

	/**
	 * @param options.dcPrecision Intra DC precision (0-3) when a container
	 *   states it (Sofdec2's `mpeg_dcprec` minus 8); otherwise read from
	 *   TMPGEnc user data.
	 */
	constructor(bytes: Uint8Array, options: { dcPrecision?: number } = {}) {
		this.bits = new BitReader(bytes);
		if (this.bits.findStartCode(START_SEQUENCE) !== -1) this.decodeSequenceHeader();
		const p = options.dcPrecision;
		this.dcPrecision = p !== undefined && p >= 0 && p <= 3 ? p : tmpgencDcPrecision(bytes);
		this.dcReset = 128 << this.dcPrecision;
	}

	/** Stream parameters, or null before a sequence header. */
	get info(): Mpeg1Info | null {
		return this.hasSequenceHeader ? { width: this.width, height: this.height, frameRate: this.frameRate } : null;
	}

	/** The next frame in display order, or null at the end of the stream. */
	decode(): Mpeg1Frame | null {
		if (!this.hasSequenceHeader) return null;
		let frame: Picture | null = null;
		do {
			if (this.startCode !== START_PICTURE) {
				this.startCode = this.bits.findStartCode(START_PICTURE);
				if (this.startCode === -1) {
					// The last reference picture is still held back for display,
					// whether or not B pictures followed it in the stream.
					if (this.hasReferenceFrame) {
						this.hasReferenceFrame = false;
						frame = this.backwardFrame;
						break;
					}
					return null;
				}
			}
			this.decodePicture();
			if (this.pictureType === PICTURE_TYPE_B) frame = this.current;
			else if (this.hasReferenceFrame) frame = this.forwardFrame;
			else this.hasReferenceFrame = true;
		} while (!frame);
		const time = this.framesDecoded / this.frameRate;
		this.framesDecoded++;
		return {
			width: this.width,
			height: this.height,
			y: frame.y.data,
			yStride: this.lumaWidth,
			cb: frame.cb.data,
			cr: frame.cr.data,
			cStride: this.chromaWidth,
			time,
		};
	}

	private decodeSequenceHeader(): boolean {
		const b = this.bits;
		const width = b.read(12), height = b.read(12);
		if (width <= 0 || height <= 0) return false;
		b.skip(4); // pixel aspect ratio
		this.frameRate = PICTURE_RATE[b.read(4)] || 30;
		b.skip(18 + 1 + 10 + 1); // bit_rate, marker, vbv buffer size, constrained
		if (b.read(1)) for (let i = 0; i < 64; i++) this.intraQuant[ZIG_ZAG[i]!] = b.read(8);
		else this.intraQuant.set(INTRA_QUANT_MATRIX);
		if (b.read(1)) for (let i = 0; i < 64; i++) this.nonIntraQuant[ZIG_ZAG[i]!] = b.read(8);
		else this.nonIntraQuant.fill(16);

		this.width = width;
		this.height = height;
		this.mbWidth = (width + 15) >> 4;
		this.mbHeight = (height + 15) >> 4;
		this.mbSize = this.mbWidth * this.mbHeight;
		this.lumaWidth = this.mbWidth << 4;
		this.chromaWidth = this.mbWidth << 3;
		const lumaSize = this.lumaWidth * (this.mbHeight << 4);
		const chromaSize = this.chromaWidth * (this.mbHeight << 3);
		const picture = (): Picture => ({
			y: { data: new Uint8Array(lumaSize), width: this.lumaWidth },
			cr: { data: new Uint8Array(chromaSize), width: this.chromaWidth },
			cb: { data: new Uint8Array(chromaSize), width: this.chromaWidth },
		});
		this.current = picture();
		this.forwardFrame = picture();
		this.backwardFrame = picture();
		this.hasSequenceHeader = true;
		return true;
	}

	private decodePicture(): void {
		const b = this.bits;
		b.skip(10); // temporal reference
		this.pictureType = b.read(3);
		b.skip(16); // vbv delay
		// D pictures or unknown coding types.
		if (this.pictureType <= 0 || this.pictureType > PICTURE_TYPE_B) {
			this.startCode = -1;
			return;
		}
		if (this.pictureType === PICTURE_TYPE_PREDICTIVE || this.pictureType === PICTURE_TYPE_B) {
			this.forward.fullPx = b.read(1) === 1;
			const fCode = b.read(3);
			if (fCode === 0) {
				this.startCode = -1;
				return;
			}
			this.forward.rSize = fCode - 1;
		}
		if (this.pictureType === PICTURE_TYPE_B) {
			this.backward.fullPx = b.read(1) === 1;
			const fCode = b.read(3);
			if (fCode === 0) {
				this.startCode = -1;
				return;
			}
			this.backward.rSize = fCode - 1;
		}

		const temp = this.forwardFrame;
		const reference = this.pictureType === PICTURE_TYPE_INTRA || this.pictureType === PICTURE_TYPE_PREDICTIVE;
		if (reference) this.forwardFrame = this.backwardFrame;

		// First slice, past any extension and user data.
		do this.startCode = b.nextStartCode();
		while (this.startCode === START_EXTENSION || this.startCode === START_USER_DATA);

		while (isSlice(this.startCode)) {
			this.decodeSlice(this.startCode & 0xff);
			if (this.macroblockAddress >= this.mbSize - 1) break;
			this.startCode = b.nextStartCode();
		}
		// The slice loop may stop on the next picture's start code already.
		if (this.startCode !== START_PICTURE) this.startCode = -1;

		// A reference picture becomes the backward reference.
		if (reference) {
			this.backwardFrame = this.current;
			this.current = temp;
		}
	}

	private decodeSlice(slice: number): void {
		const b = this.bits;
		this.sliceBegin = true;
		this.macroblockAddress = (slice - 1) * this.mbWidth - 1;
		this.forward.h = this.forward.v = this.backward.h = this.backward.v = 0;
		this.dcPredictor[0] = this.dcPredictor[1] = this.dcPredictor[2] = this.dcReset;
		this.quantizerScale = b.read(5);
		while (b.read(1)) b.skip(8); // extra information
		do this.decodeMacroblock();
		while (this.macroblockAddress < this.mbSize - 1 && b.peekNonZero(23));
	}

	private decodeMacroblock(): void {
		const b = this.bits;
		let increment = 0;
		let t = b.readVlc(MACROBLOCK_ADDRESS_INCREMENT);
		while (t === 34) t = b.readVlc(MACROBLOCK_ADDRESS_INCREMENT); // stuffing
		while (t === 35) {
			// escape
			increment += 33;
			t = b.readVlc(MACROBLOCK_ADDRESS_INCREMENT);
		}
		increment += t;

		if (this.sliceBegin) {
			// The first increment of a slice counts from the row start.
			this.sliceBegin = false;
			this.macroblockAddress += increment;
		} else {
			if (this.macroblockAddress + increment >= this.mbSize) return;
			if (increment > 1) {
				// Skipped macroblocks reset DC predictors, and motion in P pictures.
				this.dcPredictor[0] = this.dcPredictor[1] = this.dcPredictor[2] = this.dcReset;
				if (this.pictureType === PICTURE_TYPE_PREDICTIVE) this.forward.h = this.forward.v = 0;
			}
			while (increment > 1) {
				this.macroblockAddress++;
				this.mbRow = Math.floor(this.macroblockAddress / this.mbWidth);
				this.mbCol = this.macroblockAddress % this.mbWidth;
				this.predictMacroblock();
				increment--;
			}
			this.macroblockAddress++;
		}
		this.mbRow = Math.floor(this.macroblockAddress / this.mbWidth);
		this.mbCol = this.macroblockAddress % this.mbWidth;
		if (this.mbCol >= this.mbWidth || this.mbRow >= this.mbHeight) return;

		this.macroblockType = b.readVlc(MACROBLOCK_TYPE[this.pictureType]!);
		this.macroblockIntra = (this.macroblockType & 0x01) !== 0;
		this.forward.isSet = (this.macroblockType & 0x08) !== 0;
		this.backward.isSet = (this.macroblockType & 0x04) !== 0;
		if (this.macroblockType & 0x10) this.quantizerScale = b.read(5);

		if (this.macroblockIntra) {
			this.forward.h = this.forward.v = this.backward.h = this.backward.v = 0;
		} else {
			this.dcPredictor[0] = this.dcPredictor[1] = this.dcPredictor[2] = this.dcReset;
			this.decodeMotionVectors();
			this.predictMacroblock();
		}

		const cbp = this.macroblockType & 0x02 ? b.readVlc(CODE_BLOCK_PATTERN) : this.macroblockIntra ? 0x3f : 0;
		for (let block = 0, mask = 0x20; block < 6; block++, mask >>= 1) if (cbp & mask) this.decodeBlock(block);
	}

	private decodeMotionVectors(): void {
		const f = this.forward, k = this.backward;
		if (f.isSet) {
			f.h = this.decodeMotionVector(f.rSize, f.h);
			f.v = this.decodeMotionVector(f.rSize, f.v);
		} else if (this.pictureType === PICTURE_TYPE_PREDICTIVE) {
			f.h = f.v = 0;
		}
		if (k.isSet) {
			k.h = this.decodeMotionVector(k.rSize, k.h);
			k.v = this.decodeMotionVector(k.rSize, k.v);
		}
	}

	private decodeMotionVector(rSize: number, motion: number): number {
		const fscale = 1 << rSize;
		const mCode = this.bits.readVlc(MOTION);
		let d: number;
		if (mCode !== 0 && fscale !== 1) {
			const r = this.bits.read(rSize);
			d = ((Math.abs(mCode) - 1) << rSize) + r + 1;
			if (mCode < 0) d = -d;
		} else {
			d = mCode;
		}
		motion += d;
		if (motion > (fscale << 4) - 1) motion -= fscale << 5;
		else if (motion < -(fscale << 4)) motion += fscale << 5;
		return motion;
	}

	private predictMacroblock(): void {
		let fh = this.forward.h, fv = this.forward.v;
		if (this.forward.fullPx) {
			fh <<= 1;
			fv <<= 1;
		}
		if (this.pictureType === PICTURE_TYPE_B) {
			let bh = this.backward.h, bv = this.backward.v;
			if (this.backward.fullPx) {
				bh <<= 1;
				bv <<= 1;
			}
			if (this.forward.isSet) {
				this.copyMacroblock(this.forwardFrame, fh, fv, false);
				if (this.backward.isSet) this.copyMacroblock(this.backwardFrame, bh, bv, true);
			} else {
				this.copyMacroblock(this.backwardFrame, bh, bv, false);
			}
		} else {
			this.copyMacroblock(this.forwardFrame, fh, fv, false);
		}
	}

	private copyMacroblock(s: Picture, mh: number, mv: number, interpolate: boolean): void {
		const d = this.current;
		// C's integer division truncates toward zero.
		const ch = Math.trunc(mh / 2), cv = Math.trunc(mv / 2);
		this.processMacroblock(s.y.data, d.y.data, mh, mv, 16, interpolate);
		this.processMacroblock(s.cr.data, d.cr.data, ch, cv, 8, interpolate);
		this.processMacroblock(s.cb.data, d.cb.data, ch, cv, 8, interpolate);
	}

	private processMacroblock(s: Uint8Array, d: Uint8Array, mh: number, mv: number, bs: number, interpolate: boolean): void {
		const dw = this.mbWidth * bs;
		const hp = mh >> 1, vp = mv >> 1;
		const oddH = (mh & 1) === 1, oddV = (mv & 1) === 1;
		let si = (this.mbRow * bs + vp) * dw + this.mbCol * bs + hp;
		let di = (this.mbRow * dw + this.mbCol) * bs;
		const maxAddress = dw * (this.mbHeight * bs - bs + 1) - bs;
		if (si < 0 || si > maxAddress || di > maxAddress) return; // corrupt
		const scan = dw - bs;
		for (let y = 0; y < bs; y++, si += scan, di += scan) {
			for (let x = 0; x < bs; x++, si++, di++) {
				let v: number;
				if (oddH && oddV) v = (s[si]! + s[si + 1]! + s[si + dw]! + s[si + dw + 1]! + 2) >> 2;
				else if (oddH) v = (s[si]! + s[si + 1]! + 1) >> 1;
				else if (oddV) v = (s[si]! + s[si + dw]! + 1) >> 1;
				else v = s[si]!;
				d[di] = interpolate ? (d[di]! + v + 1) >> 1 : v;
			}
		}
	}

	private decodeBlock(block: number): void {
		const b = this.bits;
		const s = this.blockData;
		let n = 0;
		let quant: Uint8Array;

		if (this.macroblockIntra) {
			// DC coefficient, predicted from the previous block of its plane.
			const plane = block > 3 ? block - 3 : 0;
			const predictor = this.dcPredictor[plane]!;
			const dctSize = b.readVlc(DCT_SIZE[plane]!);
			if (dctSize > 0) {
				const diff = b.read(dctSize);
				s[0] = diff & (1 << (dctSize - 1)) ? predictor + diff : predictor + (-(1 << dctSize) | (diff + 1));
			} else {
				s[0] = predictor;
			}
			this.dcPredictor[plane] = s[0]!;
			s[0] = s[0]! << (3 - this.dcPrecision + 5); // dequantize + premultiply
			quant = this.intraQuant;
			n = 1;
		} else {
			quant = this.nonIntraQuant;
		}

		// AC coefficients (and DC for non-intra blocks).
		for (;;) {
			let run: number, level: number;
			const coeff = b.readVlc(DCT_COEFF) & 0xffff;
			if (coeff === 0x0001 && n > 0 && b.read(1) === 0) break; // end of block
			if (!b.has(1)) break;
			if (coeff === 0xffff) {
				// escape
				run = b.read(6);
				level = b.read(8);
				if (level === 0) level = b.read(8);
				else if (level === 128) level = b.read(8) - 256;
				else if (level > 128) level -= 256;
			} else {
				run = coeff >> 8;
				level = coeff & 0xff;
				if (b.read(1)) level = -level;
			}
			n += run;
			if (n < 0 || n >= 64) return; // invalid
			const z = ZIG_ZAG[n]!;
			n++;
			// Dequantize, oddify, clip.
			level <<= 1;
			if (!this.macroblockIntra) level += level < 0 ? -1 : 1;
			level = (level * this.quantizerScale * quant[z]!) >> 4;
			if ((level & 1) === 0) level -= level > 0 ? 1 : -1;
			if (level > 2047) level = 2047;
			else if (level < -2048) level = -2048;
			s[z] = level * PREMULTIPLIER_MATRIX[z]!;
		}

		// Where the block goes.
		let d: Uint8Array, dw: number, di: number;
		if (block < 4) {
			d = this.current.y.data;
			dw = this.lumaWidth;
			di = (this.mbRow * this.lumaWidth + this.mbCol) << 4;
			if (block & 1) di += 8;
			if (block & 2) di += this.lumaWidth << 3;
		} else {
			d = block === 4 ? this.current.cb.data : this.current.cr.data;
			dw = this.chromaWidth;
			di = ((this.mbRow * this.lumaWidth) << 2) + (this.mbCol << 3);
		}
		const scan = dw - 8;
		if (n === 1) {
			// DC only: one value for the whole block.
			const value = (s[0]! + 128) >> 8;
			for (let y = 0; y < 8; y++, di += scan) for (let x = 0; x < 8; x++, di++) d[di] = clamp(this.macroblockIntra ? value : d[di]! + value);
			s[0] = 0;
		} else {
			idct(s);
			let si = 0;
			for (let y = 0; y < 8; y++, di += scan) for (let x = 0; x < 8; x++, di++, si++) d[di] = clamp(this.macroblockIntra ? s[si]! : d[di]! + s[si]!);
			s.fill(0);
		}
	}
}

function idct(block: Int32Array): void {
	let b1, b3, b4, b6, b7, tmp1, tmp2, m0, x0, x1, x2, x3, x4, y3, y4, y5, y6, y7;
	for (let i = 0; i < 8; ++i) {
		b1 = block[4 * 8 + i]!;
		b3 = block[2 * 8 + i]! + block[6 * 8 + i]!;
		b4 = block[5 * 8 + i]! - block[3 * 8 + i]!;
		tmp1 = block[1 * 8 + i]! + block[7 * 8 + i]!;
		tmp2 = block[3 * 8 + i]! + block[5 * 8 + i]!;
		b6 = block[1 * 8 + i]! - block[7 * 8 + i]!;
		b7 = tmp1 + tmp2;
		m0 = block[0 * 8 + i]!;
		x4 = ((b6 * 473 - b4 * 196 + 128) >> 8) - b7;
		x0 = x4 - (((tmp1 - tmp2) * 362 + 128) >> 8);
		x1 = m0 - b1;
		x2 = (((block[2 * 8 + i]! - block[6 * 8 + i]!) * 362 + 128) >> 8) - b3;
		x3 = m0 + b1;
		y3 = x1 + x2;
		y4 = x3 + b3;
		y5 = x1 - x2;
		y6 = x3 - b3;
		y7 = -x0 - ((b4 * 473 + b6 * 196 + 128) >> 8);
		block[0 * 8 + i] = b7 + y4;
		block[1 * 8 + i] = x4 + y3;
		block[2 * 8 + i] = y5 - x0;
		block[3 * 8 + i] = y6 - y7;
		block[4 * 8 + i] = y6 + y7;
		block[5 * 8 + i] = x0 + y5;
		block[6 * 8 + i] = y3 - x4;
		block[7 * 8 + i] = y4 - b7;
	}
	for (let i = 0; i < 64; i += 8) {
		b1 = block[4 + i]!;
		b3 = block[2 + i]! + block[6 + i]!;
		b4 = block[5 + i]! - block[3 + i]!;
		tmp1 = block[1 + i]! + block[7 + i]!;
		tmp2 = block[3 + i]! + block[5 + i]!;
		b6 = block[1 + i]! - block[7 + i]!;
		b7 = tmp1 + tmp2;
		m0 = block[0 + i]!;
		x4 = ((b6 * 473 - b4 * 196 + 128) >> 8) - b7;
		x0 = x4 - (((tmp1 - tmp2) * 362 + 128) >> 8);
		x1 = m0 - b1;
		x2 = (((block[2 + i]! - block[6 + i]!) * 362 + 128) >> 8) - b3;
		x3 = m0 + b1;
		y3 = x1 + x2;
		y4 = x3 + b3;
		y5 = x1 - x2;
		y6 = x3 - b3;
		y7 = -x0 - ((b4 * 473 + b6 * 196 + 128) >> 8);
		block[0 + i] = (b7 + y4 + 128) >> 8;
		block[1 + i] = (x4 + y3 + 128) >> 8;
		block[2 + i] = (y5 - x0 + 128) >> 8;
		block[3 + i] = (y6 - y7 + 128) >> 8;
		block[4 + i] = (y6 + y7 + 128) >> 8;
		block[5 + i] = (x0 + y5 + 128) >> 8;
		block[6 + i] = (y3 - x4 + 128) >> 8;
		block[7 + i] = (y4 - b7 + 128) >> 8;
	}
}
