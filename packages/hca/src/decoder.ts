/**
 * HCA block decoder + IMDCT-like synthesis.
 *
 * `initDecode` pre-computes the per-channel state and channel-type
 * map; `decodeBlock` then walks each compressed block through the
 * 5-step pipeline:
 *
 *   1. decode1: read per-subband scale factors (the "envelope").
 *   2. decode2: read quantised spectral coefficients into `block`.
 *   3. decode3: rebuild the high-frequency mirror band from the
 *               low band (when the encoder used joint coding).
 *   4. decode4: cross-channel intensity stereo unmix.
 *   5. decode5: 7-stage butterfly + windowing into `wave[i]`,
 *               giving 0x80 PCM samples per channel per sub-block.
 *
 * Each block produces 8 sub-blocks × 0x80 samples per channel =
 * 1024 samples per block. Standard HCA always emits 1024.
 *
 * Ported from kohos/CriTools/src/hca.js (MIT).
 */

import { BitReader } from './bit-reader.js';
import { decryptBlock, checkSum } from './cipher.js';
import {
	DECODE1_SCALELIST,
	DECODE1_VALUE_FLOAT,
	DECODE1_SCALE_FLOAT,
	DECODE2_LIST1,
	DECODE2_LIST2,
	DECODE2_LIST3,
	DECODE3_LIST_FLOAT,
	DECODE4_LIST_FLOAT,
	DECODE5_LIST1_FLOAT,
	DECODE5_LIST2_FLOAT,
	DECODE5_LIST3_FLOAT,
} from './tables.js';
import type { HcaHeader } from './header.js';

/** Per-channel decoder state (allocated once via `initDecode`). */
export interface HcaChannelState {
	block: Float32Array;
	base: Float32Array;
	value: Uint8Array;
	scale: Uint8Array;
	value2: Uint8Array;
	value3: Uint8Array; // subarray view into `value`
	type: number; // 0, 1, or 2 — channel role in joint stereo
	count: number;
	wav1: Float32Array;
	wav2: Float32Array;
	wav3: Float32Array;
	wave: Float32Array[]; // 8 × Float32Array(0x80)
}

/** Aggregate state for a single HCA stream's decode. */
export interface HcaDecodeState {
	header: HcaHeader;
	ciphTable: Uint8Array;
	athTable: Uint8Array;
	channels: HcaChannelState[];
	comp: {
		r01: number;
		r02: number;
		r03: number;
		r04: number;
		r05: number;
		r06: number;
		r07: number;
		r08: number;
		r09: number;
	};
}

function ceil2(a: number, b: number): number {
	return b > 0 ? Math.floor(a / b) + (a % b ? 1 : 0) : 0;
}

/**
 * Allocate channel state + compute the joint-stereo type map. Pass
 * the parsed `HcaHeader` plus the cipher / ATH tables already built
 * via `initCiphTable` / `initAthTable`.
 */
export function initDecode(
	header: HcaHeader,
	ciphTable: Uint8Array,
	athTable: Uint8Array,
): HcaDecodeState {
	const comp = {
		r01: header.r01,
		r02: header.r02,
		r03: header.r03 || 1,
		r04: header.r04,
		r05: header.r05,
		r06: header.r06,
		r07: header.r07,
		r08: header.r08,
		r09: 0,
	};
	// Resolution range validation. HCA v1.x/v2.x is strict: only the
	// canonical r01=1, r02=15 pair is allowed. v3.0+ relaxes this to
	// `0 <= r01 <= r02 <= 15`, which is what real Switch-era HCAs use
	// (e.g. r01=0, r02=15 in CRIWARE's modern encoder output). See
	// vgmstream's clHCA `hca_parse_header`, the `HCA_VERSION_V200`
	// branch.
	if (header.version <= 0x0200) {
		if (!(comp.r01 === 1 && comp.r02 === 15)) {
			throw new Error(
				`HCA: unsupported v${header.version.toString(16)} comp ranges r01=${comp.r01} r02=${comp.r02} (expected 1, 15)`,
			);
		}
	} else {
		if (!(comp.r01 <= comp.r02 && comp.r02 <= 15)) {
			throw new Error(
				`HCA: invalid comp ranges r01=${comp.r01} r02=${comp.r02} (need r01 <= r02 <= 15)`,
			);
		}
	}
	comp.r09 = ceil2(comp.r05 - (comp.r06 + comp.r07), comp.r08);

	const r = new Uint8Array(0x10);
	const b = Math.floor(header.channelCount / comp.r03);
	if (comp.r07 && b > 1) {
		let c = 0;
		for (let i = 0; i < comp.r03; i++) {
			switch (b) {
				case 2:
					r[c] = 1;
					r[c + 1] = 2;
					break;
				case 3:
					r[c] = 1;
					r[c + 1] = 2;
					break;
				case 4:
					r[c] = 1;
					r[c + 1] = 2;
					if (comp.r04 === 0) {
						r[c + 2] = 1;
						r[c + 3] = 2;
					}
					break;
				case 5:
					r[c] = 1;
					r[c + 1] = 2;
					if (comp.r04 <= 2) {
						r[c + 3] = 1;
						r[c + 4] = 2;
					}
					break;
				case 6:
					r[c] = 1;
					r[c + 1] = 2;
					r[c + 4] = 1;
					r[c + 5] = 2;
					break;
				case 7:
					r[c] = 1;
					r[c + 1] = 2;
					r[c + 4] = 1;
					r[c + 5] = 2;
					break;
				case 8:
					r[c] = 1;
					r[c + 1] = 2;
					r[c + 4] = 1;
					r[c + 5] = 2;
					r[c + 6] = 1;
					r[c + 7] = 2;
					break;
				default:
					break;
			}
			c += b;
		}
	}

	const channels: HcaChannelState[] = [];
	for (let i = 0; i < header.channelCount; i++) {
		const value = new Uint8Array(0x80);
		// `value3` is a subarray VIEW from value[r06+r07 .. r06+r07+a].
		// The original code stores `channel.value.slice(...)` which in
		// Node Buffer/`Uint8Array.slice` returns a shared-buffer view
		// (despite the name). We use `subarray` to match that semantics.
		const value3 = value.subarray(comp.r06 + comp.r07);
		const channel: HcaChannelState = {
			block: new Float32Array(0x80),
			base: new Float32Array(0x80),
			value,
			scale: new Uint8Array(0x80),
			value2: new Uint8Array(8),
			value3,
			type: r[i]!,
			count: comp.r06 + (r[i] !== 2 ? comp.r07 : 0),
			wav1: new Float32Array(0x80),
			wav2: new Float32Array(0x80),
			wav3: new Float32Array(0x80),
			wave: [
				new Float32Array(0x80),
				new Float32Array(0x80),
				new Float32Array(0x80),
				new Float32Array(0x80),
				new Float32Array(0x80),
				new Float32Array(0x80),
				new Float32Array(0x80),
				new Float32Array(0x80),
			],
		};
		channels.push(channel);
	}
	return { header, ciphTable, athTable, channels, comp };
}

// =====================================================================
// decode1..decode5 — pure ports of the kohos algorithm. The hot path
// inside decode2 is tight; we pulled the tables into module-scoped
// typed arrays so V8 can monomorphise the indexing.
// =====================================================================

function decode1(
	ch: HcaChannelState,
	r: BitReader,
	a: number,
	b: number,
	athTable: Uint8Array,
): void {
	let v = r.getBit(3);
	if (v >= 6) {
		for (let i = 0; i < ch.count; i++) ch.value[i] = r.getBit(6);
	} else if (v) {
		let v1 = r.getBit(6);
		const v2 = (1 << v) - 1;
		const v3 = v2 >>> 1;
		ch.value[0] = v1;
		for (let i = 1; i < ch.count; i++) {
			const v4 = r.getBit(v);
			if (v4 !== v2) {
				v1 += v4 - v3;
			} else {
				v1 = r.getBit(6);
			}
			ch.value[i] = v1;
		}
	} else {
		ch.value.fill(0);
	}
	if (ch.type === 2) {
		v = r.checkBit(4);
		ch.value2[0] = v;
		if (v < 15) {
			for (let i = 0; i < 8; i++) ch.value2[i] = r.getBit(4);
		}
	} else {
		for (let i = 0; i < a; i++) {
			ch.value3[i] = r.getBit(6);
		}
	}
	for (let i = 0; i < ch.count; i++) {
		let sv = ch.value[i]!;
		if (sv) {
			sv = athTable[i]! + ((b + i) >>> 8) - Math.floor((sv * 5) / 2) + 1;
			if (sv < 0) sv = 15;
			else if (sv >= 0x39) sv = 1;
			else sv = DECODE1_SCALELIST[sv]!;
		}
		ch.scale[i] = sv;
	}
	ch.scale.fill(0, ch.count, 0x80);
	for (let i = 0; i < ch.count; i++) {
		ch.base[i] =
			DECODE1_VALUE_FLOAT[ch.value[i]!]! * DECODE1_SCALE_FLOAT[ch.scale[i]!]!;
	}
}

function decode2(ch: HcaChannelState, r: BitReader): void {
	for (let i = 0; i < ch.count; i++) {
		let f: number;
		const s = ch.scale[i]!;
		const bitSize = DECODE2_LIST1[s]!;
		let v = r.getBit(bitSize);
		if (s < 8) {
			v += s << 4;
			r.addBit(DECODE2_LIST2[v]! - bitSize);
			f = DECODE2_LIST3[v]!;
		} else {
			v = (1 - ((v & 1) << 1)) * Math.floor(v / 2);
			if (!v) r.addBit(-1);
			f = v;
		}
		ch.block[i] = ch.base[i]! * f;
	}
	ch.block.fill(0, ch.count, 0x80);
}

function decode3(
	ch: HcaChannelState,
	a: number,
	b: number,
	c: number,
	d: number,
): void {
	if (ch.type !== 2 && b > 0) {
		for (let i = 0; i < a; i++) {
			for (let j = 0, k = c, l = c - 1; j < b && k < d; j++, l--) {
				ch.block[k++] =
					DECODE3_LIST_FLOAT[0x40 + ch.value3[i]! - ch.value[l]!]! *
					ch.block[l]!;
			}
		}
		ch.block[0x80 - 1] = 0;
	}
}

function decode4(
	ch: HcaChannelState,
	next: HcaChannelState,
	index: number,
	a: number,
	b: number,
	c: number,
): void {
	if (ch.type === 1 && c) {
		const f1 = DECODE4_LIST_FLOAT[next.value2[index]!]!;
		const f2 = f1 - 2.0;
		for (let i = 0; i < a; i++) {
			next.block[b + i] = ch.block[b + i]! * f2;
			ch.block[b + i] = ch.block[b + i]! * f1;
		}
	}
}

function decode5(ch: HcaChannelState, index: number): void {
	// Stage 1: 7 butterfly passes turning the 128-coef `block` into
	// `wav1` (which then ping-pongs).
	let s = ch.block;
	let d = ch.wav1;
	{
		let count1 = 1;
		let count2 = 0x40;
		for (let i = 0; i < 7; i++) {
			let x = 0;
			let d1 = 0;
			let d2 = count2;
			for (let j = 0; j < count1; j++) {
				for (let k = 0; k < count2; k++) {
					const a = s[x++]!;
					const b = s[x++]!;
					d[d1++] = b + a;
					d[d2++] = a - b;
				}
				d1 += count2;
				d2 += count2;
			}
			const tmp = s;
			s = d;
			d = tmp;
			count1 <<= 1;
			count2 >>>= 1;
		}
	}

	// Stage 2: 7 IMDCT-like passes mixing with `list1Float[i]` /
	// `list2Float[i]`. The result builds into `block` then back to
	// `wav1`, etc.
	s = ch.wav1;
	d = ch.block;
	{
		let count1 = 0x40;
		let count2 = 1;
		for (let i = 0; i < 7; i++) {
			const list1Float = DECODE5_LIST1_FLOAT[i]!;
			const list2Float = DECODE5_LIST2_FLOAT[i]!;
			let x = 0;
			let y = 0;
			let s1 = 0;
			let s2 = count2;
			let d1 = 0;
			let d2 = count2 * 2 - 1;
			for (let j = 0; j < count1; j++) {
				for (let k = 0; k < count2; k++) {
					const a = s[s1++]!;
					const b = s[s2++]!;
					const c = list1Float[x++]!;
					const e = list2Float[y++]!;
					d[d1++] = a * c - b * e;
					d[d2--] = a * e + b * c;
				}
				s1 += count2;
				s2 += count2;
				d1 += count2;
				d2 += count2 * 3;
			}
			const tmp = s;
			s = d;
			d = tmp;
			count1 >>>= 1;
			count2 <<= 1;
		}
	}

	// Copy current pingpong source into wav2, then apply the
	// windowing table to produce wave[index].
	d = ch.wav2;
	for (let i = 0; i < 0x80; i++) d[i] = s[i]!;
	const win = DECODE5_LIST3_FLOAT;
	const wave = ch.wave[index]!;
	const s1 = ch.wav2;
	const s2 = ch.wav3;
	for (let i = 0; i < 0x40; i++) wave[i] = s1[0x40 + i]! * win[i]! + s2[i]!;
	for (let i = 0; i < 0x40; i++)
		wave[0x40 + i] = win[0x40 + i]! * s1[0x7f - i]! - s2[0x40 + i]!;
	for (let i = 0; i < 0x40; i++) s2[i] = s1[0x3f - i]! * win[0x7f - i]!;
	for (let i = 0; i < 0x40; i++) s2[0x40 + i] = win[0x3f - i]! * s1[i]!;
}

/**
 * Decode one compressed block into the per-channel `wave[]`
 * buffers. The caller is responsible for advancing the input
 * cursor by `header.blockSize` bytes between calls.
 *
 * Returns `true` when the block decoded cleanly, `false` when the
 * CRC mismatched or the bitstream wasn't an HCA payload block.
 * A `false` result leaves the per-channel state unchanged so the
 * caller can stop or emit silence.
 */
export function decodeBlock(state: HcaDecodeState, block: Uint8Array): boolean {
	if (block.length !== state.header.blockSize) return false;
	if (checkSum(block, block.length) !== 0) return false;
	if (state.header.ciphType) {
		// Block bytes are XOR-substituted; the cipher is a 1:1
		// permutation, applied in place.
		decryptBlock(state.ciphTable, block);
	}
	const r = new BitReader(block);
	const magic = r.getBit(16);
	if (magic !== 0xffff) return false;
	const a = (r.getBit(9) << 8) - r.getBit(7);
	const comp = state.comp;
	for (let i = 0; i < state.header.channelCount; i++) {
		decode1(state.channels[i]!, r, comp.r09, a, state.athTable);
	}
	for (let i = 0; i < 8; i++) {
		for (let j = 0; j < state.header.channelCount; j++) {
			decode2(state.channels[j]!, r);
		}
		for (let j = 0; j < state.header.channelCount; j++) {
			decode3(state.channels[j]!, comp.r09, comp.r08, comp.r07 + comp.r06, comp.r05);
		}
		for (let j = 0; j < state.header.channelCount - 1; j++) {
			decode4(
				state.channels[j]!,
				state.channels[j + 1]!,
				i,
				comp.r05 - comp.r06,
				comp.r06,
				comp.r07,
			);
		}
		for (let j = 0; j < state.header.channelCount; j++) {
			decode5(state.channels[j]!, i);
		}
	}
	return true;
}
