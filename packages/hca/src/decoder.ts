/*
 * @tootallnate/hca — pure-TypeScript decoder for CRI Middleware's
 * High Compression Audio (HCA) codec.
 *
 * Ported from vgmstream's clHCA (ISC license, by nyaga / kode54 /
 * bnnm). See README + LICENSE.
 *
 * This file contains the frame decoder, the IMDCT synthesis stage,
 * and the inner stateful helpers (`unpack_scalefactors`,
 * `unpack_intensity`, `calculate_resolution`, `calculate_gain`,
 * `dequantize_coefficients`, `reconstruct_noise`,
 * `reconstruct_high_frequency`, `apply_intensity_stereo`,
 * `apply_ms_stereo`, `imdct_transform`). Each function mirrors the
 * clHCA C code 1:1 — same data layout, same loop ordering, same
 * floating-point operations in the same order.
 */

import { BitReader } from './bit-reader.js';
import { decryptBlock, checkSum } from './cipher.js';
import {
	DECODE5_LIST1_FLOAT,
	DECODE5_LIST2_FLOAT,
	DECODE5_LIST3_FLOAT,
} from './decode5-tables.js';
import {
	HcaHeader,
	HCA_SAMPLES_PER_SUBFRAME,
	HCA_SUBFRAMES,
	HCA_VERSION_V200,
} from './header.js';

// Sin/cos/window aliases — clHCA names → our existing table names.
const SIN_TABLES = DECODE5_LIST1_FLOAT; // sin_tables_hex
const COS_TABLES = DECODE5_LIST2_FLOAT; // cos_tables_hex
const IMDCT_WINDOW = DECODE5_LIST3_FLOAT; // hcaimdct_window_float

// =====================================================================
// Decoder lookup tables — bit-pattern verbatim from clHCA.
// =====================================================================

function u32ToFloat32(values: ArrayLike<number>): Float32Array {
	const buf = new ArrayBuffer(4);
	const dv = new DataView(buf);
	const out = new Float32Array(values.length);
	for (let i = 0; i < values.length; i++) {
		dv.setUint32(0, (values[i] as number) >>> 0, true);
		out[i] = dv.getFloat32(0, true);
	}
	return out;
}

/** clHCA `hcadecoder_invert_table[66]`. */
const INVERT_TABLE = new Uint8Array([
	14, 14, 14, 14, 14, 14, 13, 13, 13, 13, 13, 13, 12, 12, 12, 12, 12, 12, 11,
	11, 11, 11, 11, 11, 10, 10, 10, 10, 10, 10, 10, 9, 9, 9, 9, 9, 9, 8, 8, 8, 8,
	8, 8, 7, 6, 6, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]);

/** clHCA `hcadequantizer_scaling_table_float_hex[64]`. */
const SCALING_TABLE_FLOAT = u32ToFloat32([
	0x342a8d26, 0x34633f89, 0x3497657d, 0x34c9b9be, 0x35066491, 0x353311c4,
	0x356e9910, 0x359ef532, 0x35d3ccf1, 0x360d1adf, 0x363c034a, 0x367a83b3,
	0x36a6e595, 0x36de60f5, 0x371426ff, 0x3745672a, 0x37838359, 0x37af3b79,
	0x37e97c38, 0x381b8d3a, 0x384f4319, 0x388a14d5, 0x38b7fbf0, 0x38f5257d,
	0x3923520f, 0x39599d16, 0x3990fa4d, 0x39c12c4d, 0x3a00b1ed, 0x3a2b7a3a,
	0x3a647b6d, 0x3a9837f0, 0x3acad226, 0x3b071f62, 0x3b340aaf, 0x3b6fe4ba,
	0x3b9fd228, 0x3bd4f35b, 0x3c0ddf04, 0x3c3d08a4, 0x3c7bdfed, 0x3ca7cd94,
	0x3cdf9613, 0x3d14f4f0, 0x3d467991, 0x3d843a29, 0x3db02f0e, 0x3deac0c7,
	0x3e1c6573, 0x3e506334, 0x3e8ad4c6, 0x3eb8fbaf, 0x3ef67a41, 0x3f243516,
	0x3f5acb94, 0x3f91c3d3, 0x3fc238d2, 0x400164d2, 0x402c6897, 0x4065b907,
	0x40990b88, 0x40cbec15, 0x4107db35, 0x413504f3,
]);

/** clHCA `hcadequantizer_range_table_float_hex[16]`. */
const RANGE_TABLE_FLOAT = u32ToFloat32([
	0x3f800000, 0x3f2aaaab, 0x3ecccccd, 0x3e924925, 0x3e638e39, 0x3e3a2e8c,
	0x3e1d89d9, 0x3e088889, 0x3d842108, 0x3d020821, 0x3c810204, 0x3c008081,
	0x3b804020, 0x3b002008, 0x3a801002, 0x3a000801,
]);

/** clHCA `hcatbdecoder_max_bit_table[16]`. */
const MAX_BIT_TABLE = new Uint8Array([
	0, 2, 3, 3, 4, 4, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12,
]);

/** clHCA `hcatbdecoder_read_bit_table[128]`. */
const READ_BIT_TABLE = new Uint8Array([
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2,
	3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
	3, 3, 3, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3,
	3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
	4, 4, 4,
]);

/** clHCA `hcatbdecoder_read_val_table[128]` — signed quantised values. */
const READ_VAL_TABLE = new Float32Array([
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, -1, -1, 2, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 1, -1, 2, -2, 3, -3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, -1, -1, 2, 2,
	-2, -2, 3, 3, -3, -3, 4, -4, 0, 0, 1, 1, -1, -1, 2, 2, -2, -2, 3, -3, 4, -4,
	5, -5, 0, 0, 1, 1, -1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 0, 0, 1, -1,
	2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7,
]);

/** clHCA `hcadecoder_scale_conversion_table[128]`. */
const SCALE_CONVERSION_TABLE = u32ToFloat32([
	0x00000000, 0x32a0b051, 0x32d61b5e, 0x330ea43a, 0x333e0f68, 0x337d3e0c,
	0x33a8b6d5, 0x33e0ccdf, 0x3415c3ff, 0x34478d75, 0x3484f1f6, 0x34b123f6,
	0x34ec0719, 0x351d3eda, 0x355184df, 0x358b95c2, 0x35b9fcd2, 0x35f7d0df,
	0x36251958, 0x365bfbb8, 0x36928e72, 0x36c346cd, 0x370218af, 0x372d583f,
	0x3766f85b, 0x3799e046, 0x37cd078c, 0x3808980f, 0x38360094, 0x38728177,
	0x38a18faf, 0x38d744fd, 0x390f6a81, 0x393f179a, 0x397e9e11, 0x39a9a15b,
	0x39e2055b, 0x3a16942d, 0x3a48a2d8, 0x3a85aac3, 0x3ab21a32, 0x3aed4f30,
	0x3b1e196e, 0x3b52a81e, 0x3b8c57ca, 0x3bbaff5b, 0x3bf9295a, 0x3c25fed7,
	0x3c5d2d82, 0x3c935a2b, 0x3cc4563f, 0x3d02cd87, 0x3d2e4934, 0x3d68396a,
	0x3d9ab62b, 0x3dce248c, 0x3e0955ee, 0x3e36fd92, 0x3e73d290, 0x3ea27043,
	0x3ed87039, 0x3f1031dc, 0x3f40213b, 0x3f800000, 0x3faa8d26, 0x3fe33f89,
	0x4017657d, 0x4049b9be, 0x40866491, 0x40b311c4, 0x40ee9910, 0x411ef532,
	0x4153ccf1, 0x418d1adf, 0x41bc034a, 0x41fa83b3, 0x4226e595, 0x425e60f5,
	0x429426ff, 0x42c5672a, 0x43038359, 0x432f3b79, 0x43697c38, 0x439b8d3a,
	0x43cf4319, 0x440a14d5, 0x4437fbf0, 0x4475257d, 0x44a3520f, 0x44d99d16,
	0x4510fa4d, 0x45412c4d, 0x4580b1ed, 0x45ab7a3a, 0x45e47b6d, 0x461837f0,
	0x464ad226, 0x46871f62, 0x46b40aaf, 0x46efe4ba, 0x471fd228, 0x4754f35b,
	0x478ddf04, 0x47bd08a4, 0x47fbdfed, 0x4827cd94, 0x485f9613, 0x4894f4f0,
	0x48c67991, 0x49043a29, 0x49302f0e, 0x496ac0c7, 0x499c6573, 0x49d06334,
	0x4a0ad4c6, 0x4a38fbaf, 0x4a767a41, 0x4aa43516, 0x4adacb94, 0x4b11c3d3,
	0x4b4238d2, 0x4b8164d2, 0x4bac6897, 0x4be5b907, 0x4c190b88, 0x4c4bec15,
	0x00000000, 0x00000000,
]);

/** clHCA `hcadecoder_intensity_ratio_table[16]`. */
const INTENSITY_RATIO_TABLE = u32ToFloat32([
	0x40000000, 0x3fedb6db, 0x3fdb6db7, 0x3fc92492, 0x3fb6db6e, 0x3fa49249,
	0x3f924925, 0x3f800000, 0x3f5b6db7, 0x3f36db6e, 0x3f124925, 0x3edb6db7,
	0x3e924925, 0x3e124925, 0x00000000, 0x00000000,
]);

// =====================================================================
// Channel types & state. Layout matches clHCA `stChannel`.
// =====================================================================

export const enum ChannelType {
	DISCRETE = 0,
	STEREO_PRIMARY = 1,
	STEREO_SECONDARY = 2,
}

/** Per-channel decoder state (allocated once via `initDecode`). */
export interface HcaChannelState {
	type: ChannelType;
	codedCount: number;

	intensity: Uint8Array; // HCA_SUBFRAMES
	scalefactors: Uint8Array; // 128
	resolution: Uint8Array; // 128
	noises: Uint8Array; // 128
	noiseCount: number;
	validCount: number;

	gain: Float32Array; // 128
	/** `spectra[subframe][bin]`, flat [HCA_SUBFRAMES * 128]. */
	spectra: Float32Array;

	temp: Float32Array; // 128
	imdctPrevious: Float32Array; // 128
	/** `wave[subframe][sample]`, flat [HCA_SUBFRAMES * 128]. Synonym with legacy `wave[i][j]`. */
	wave: Float32Array;
}

/** Aggregate state for a single HCA stream's decode. */
export interface HcaDecodeState {
	header: HcaHeader;
	ciphTable: Uint8Array;
	athTable: Uint8Array;
	channels: HcaChannelState[];
	random: number;
}

const HCA_DEFAULT_RANDOM = 1;

/**
 * Initialise per-channel state. Mirrors clHCA's
 * `clHCA_DecodeHeader` channel-type / coded-count setup.
 */
export function initDecode(
	header: HcaHeader,
	ciphTable: Uint8Array,
	athTable: Uint8Array,
): HcaDecodeState {
	const channels: HcaChannelState[] = [];
	const channelTypes = new Uint8Array(header.channelCount);

	const channelsPerTrack = Math.floor(header.channelCount / header.trackCount);
	if (header.stereoBandCount > 0 && channelsPerTrack > 1) {
		for (let t = 0; t < header.trackCount; t++) {
			const base = t * channelsPerTrack;
			switch (channelsPerTrack) {
				case 2:
					channelTypes[base] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 1] = ChannelType.STEREO_SECONDARY;
					break;
				case 3:
					channelTypes[base] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 1] = ChannelType.STEREO_SECONDARY;
					channelTypes[base + 2] = ChannelType.DISCRETE;
					break;
				case 4:
					channelTypes[base] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 1] = ChannelType.STEREO_SECONDARY;
					if (header.channelConfig === 0) {
						channelTypes[base + 2] = ChannelType.STEREO_PRIMARY;
						channelTypes[base + 3] = ChannelType.STEREO_SECONDARY;
					} else {
						channelTypes[base + 2] = ChannelType.DISCRETE;
						channelTypes[base + 3] = ChannelType.DISCRETE;
					}
					break;
				case 5:
					channelTypes[base] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 1] = ChannelType.STEREO_SECONDARY;
					channelTypes[base + 2] = ChannelType.DISCRETE;
					if (header.channelConfig <= 2) {
						channelTypes[base + 3] = ChannelType.STEREO_PRIMARY;
						channelTypes[base + 4] = ChannelType.STEREO_SECONDARY;
					} else {
						channelTypes[base + 3] = ChannelType.DISCRETE;
						channelTypes[base + 4] = ChannelType.DISCRETE;
					}
					break;
				case 6:
					channelTypes[base] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 1] = ChannelType.STEREO_SECONDARY;
					channelTypes[base + 2] = ChannelType.DISCRETE;
					channelTypes[base + 3] = ChannelType.DISCRETE;
					channelTypes[base + 4] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 5] = ChannelType.STEREO_SECONDARY;
					break;
				case 7:
					channelTypes[base] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 1] = ChannelType.STEREO_SECONDARY;
					channelTypes[base + 2] = ChannelType.DISCRETE;
					channelTypes[base + 3] = ChannelType.DISCRETE;
					channelTypes[base + 4] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 5] = ChannelType.STEREO_SECONDARY;
					channelTypes[base + 6] = ChannelType.DISCRETE;
					break;
				case 8:
					channelTypes[base] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 1] = ChannelType.STEREO_SECONDARY;
					channelTypes[base + 2] = ChannelType.DISCRETE;
					channelTypes[base + 3] = ChannelType.DISCRETE;
					channelTypes[base + 4] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 5] = ChannelType.STEREO_SECONDARY;
					channelTypes[base + 6] = ChannelType.STEREO_PRIMARY;
					channelTypes[base + 7] = ChannelType.STEREO_SECONDARY;
					break;
				default:
					break;
			}
		}
	}

	for (let i = 0; i < header.channelCount; i++) {
		const type = channelTypes[i] as ChannelType;
		const codedCount =
			type !== ChannelType.STEREO_SECONDARY
				? header.baseBandCount + header.stereoBandCount
				: header.baseBandCount;
		channels.push({
			type,
			codedCount,
			intensity: new Uint8Array(HCA_SUBFRAMES),
			scalefactors: new Uint8Array(HCA_SAMPLES_PER_SUBFRAME),
			resolution: new Uint8Array(HCA_SAMPLES_PER_SUBFRAME),
			noises: new Uint8Array(HCA_SAMPLES_PER_SUBFRAME),
			noiseCount: 0,
			validCount: 0,
			gain: new Float32Array(HCA_SAMPLES_PER_SUBFRAME),
			spectra: new Float32Array(HCA_SUBFRAMES * HCA_SAMPLES_PER_SUBFRAME),
			temp: new Float32Array(HCA_SAMPLES_PER_SUBFRAME),
			imdctPrevious: new Float32Array(HCA_SAMPLES_PER_SUBFRAME),
			wave: new Float32Array(HCA_SUBFRAMES * HCA_SAMPLES_PER_SUBFRAME),
		});
	}

	return {
		header,
		ciphTable,
		athTable,
		channels,
		random: HCA_DEFAULT_RANDOM,
	};
}

// =====================================================================
// Per-block decode pipeline. Mirrors clHCA exactly:
//
//   1. test sync (0xFFFF)
//   2. verify CRC
//   3. decrypt
//   4. read packed_noise_level
//   5. per channel: unpack_scalefactors, unpack_intensity,
//      calculate_resolution, calculate_gain
//   6. per subframe / per channel: dequantize_coefficients
//   7. per subframe:
//        - reconstruct_noise (v3.0 added)
//        - reconstruct_high_frequency
//        - apply_intensity_stereo (joint stereo)
//        - apply_ms_stereo (v3.0 added)
//        - imdct_transform → fills wave[]
// =====================================================================

/** Decode one block; mutates `block`. Returns `true` on success. */
export function decodeBlock(state: HcaDecodeState, block: Uint8Array): boolean {
	if (block.length !== state.header.blockSize) return false;

	const br = new BitReader(block, state.header.blockSize);
	const sync = br.read(16);
	if (sync !== 0xffff) return false;
	if (checkSum(block, state.header.blockSize) !== 0) return false;
	decryptBlock(state.ciphTable, block);

	const frameAcceptableNoiseLevel = br.read(9);
	const frameEvaluationBoundary = br.read(7);
	const packedNoiseLevel =
		(frameAcceptableNoiseLevel << 8) - frameEvaluationBoundary;

	const header = state.header;
	for (let ch = 0; ch < header.channelCount; ch++) {
		if (
			!unpackScalefactors(
				state.channels[ch]!,
				br,
				header.hfrGroupCount,
				header.version,
			)
		)
			return false;
		if (
			!unpackIntensity(
				state.channels[ch]!,
				br,
				header.hfrGroupCount,
				header.version,
			)
		)
			return false;
		calculateResolution(
			state.channels[ch]!,
			packedNoiseLevel,
			state.athTable,
			header.minResolution,
			header.maxResolution,
		);
		calculateGain(state.channels[ch]!);
	}

	// Unpack spectra for all subframes (matches clHCA's
	// `clHCA_DecodeBlock_unpack` which decouples unpack from transform).
	for (let sf = 0; sf < HCA_SUBFRAMES; sf++) {
		for (let ch = 0; ch < header.channelCount; ch++) {
			dequantizeCoefficients(state.channels[ch]!, br, sf);
		}
	}

	// Transform pass — matches `clHCA_DecodeBlock_transform`.
	for (let sf = 0; sf < HCA_SUBFRAMES; sf++) {
		for (let ch = 0; ch < header.channelCount; ch++) {
			state.random = reconstructNoise(
				state.channels[ch]!,
				header.minResolution,
				header.msStereo,
				state.random,
				sf,
			);
			reconstructHighFrequency(
				state.channels[ch]!,
				header.hfrGroupCount,
				header.bandsPerHfrGroup,
				header.stereoBandCount,
				header.baseBandCount,
				header.totalBandCount,
				header.version,
				sf,
			);
		}

		if (header.stereoBandCount > 0) {
			for (let ch = 0; ch < header.channelCount - 1; ch++) {
				applyIntensityStereo(
					state.channels[ch]!,
					state.channels[ch + 1]!,
					sf,
					header.baseBandCount,
					header.totalBandCount,
				);
				applyMsStereo(
					state.channels[ch]!,
					state.channels[ch + 1]!,
					header.msStereo,
					header.baseBandCount,
					header.totalBandCount,
					sf,
				);
			}
		}

		for (let ch = 0; ch < header.channelCount; ch++) {
			imdctTransform(state.channels[ch]!, sf);
		}
	}

	return true;
}

// =====================================================================
// Decode step 1 — scalefactors / intensity / resolution / gain.
// =====================================================================

function unpackScalefactors(
	ch: HcaChannelState,
	br: BitReader,
	hfrGroupCount: number,
	version: number,
): boolean {
	let csCount = ch.codedCount;
	let extraCount: number;
	const deltaBits = br.read(3);

	if (
		ch.type === ChannelType.STEREO_SECONDARY ||
		hfrGroupCount <= 0 ||
		version <= HCA_VERSION_V200
	) {
		extraCount = 0;
	} else {
		extraCount = hfrGroupCount;
		csCount = csCount + extraCount;
		if (csCount > HCA_SAMPLES_PER_SUBFRAME) return false;
	}

	if (deltaBits >= 6) {
		for (let i = 0; i < csCount; i++) {
			ch.scalefactors[i] = br.read(6);
		}
	} else if (deltaBits > 0) {
		const expectedDelta = ((1 << deltaBits) - 1) & 0xff;
		let value = br.read(6);
		ch.scalefactors[0] = value;
		for (let i = 1; i < csCount; i++) {
			const delta = br.read(deltaBits);
			if (delta === expectedDelta) {
				value = br.read(6);
			} else {
				const testV = value + (delta - (expectedDelta >>> 1));
				if (testV < 0 || testV >= 64) return false;
				value = (value - (expectedDelta >>> 1) + delta) & 0x3f;
			}
			ch.scalefactors[i] = value;
		}
	} else {
		for (let i = 0; i < HCA_SAMPLES_PER_SUBFRAME; i++) {
			ch.scalefactors[i] = 0;
		}
	}

	// v3.0 derived HFR scales
	for (let i = 0; i < extraCount; i++) {
		ch.scalefactors[HCA_SAMPLES_PER_SUBFRAME - 1 - i] =
			ch.scalefactors[csCount - i]!;
	}

	return true;
}

function unpackIntensity(
	ch: HcaChannelState,
	br: BitReader,
	hfrGroupCount: number,
	version: number,
): boolean {
	if (ch.type === ChannelType.STEREO_SECONDARY) {
		if (version <= HCA_VERSION_V200) {
			const value = br.peek(4);
			ch.intensity[0] = value;
			if (value < 15) {
				br.skip(4);
				for (let i = 1; i < HCA_SUBFRAMES; i++) {
					ch.intensity[i] = br.read(4);
				}
			}
		} else {
			const value0 = br.peek(4);
			if (value0 < 15) {
				br.skip(4);
				const deltaBits = br.read(2);
				let value = value0;
				ch.intensity[0] = value;
				if (deltaBits === 3) {
					for (let i = 1; i < HCA_SUBFRAMES; i++) {
						ch.intensity[i] = br.read(4);
					}
				} else {
					const bmax = (2 << deltaBits) - 1;
					const bits = deltaBits + 1;
					for (let i = 1; i < HCA_SUBFRAMES; i++) {
						const delta = br.read(bits);
						if (delta === bmax) {
							value = br.read(4);
						} else {
							value = value - (bmax >>> 1) + delta;
							if (value > 15) return false;
						}
						ch.intensity[i] = value;
					}
				}
			} else {
				br.skip(4);
				for (let i = 0; i < HCA_SUBFRAMES; i++) {
					ch.intensity[i] = 7;
				}
			}
		}
	} else {
		// non-secondary: read HFR scales (v2.0-only); v3.0 derives them above
		if (version <= HCA_VERSION_V200) {
			// v3.0 lib pointer position: scalefactors[128 - hfr_group_count]
			const offset = 128 - hfrGroupCount;
			for (let i = 0; i < hfrGroupCount; i++) {
				ch.scalefactors[offset + i] = br.read(6);
			}
		}
	}
	return true;
}

function calculateResolution(
	ch: HcaChannelState,
	packedNoiseLevel: number,
	athCurve: Uint8Array,
	minResolution: number,
	maxResolution: number,
): void {
	const crCount = ch.codedCount;
	let noiseCount = 0;
	let validCount = 0;

	for (let i = 0; i < crCount; i++) {
		let newResolution = 0;
		const scalefactor = ch.scalefactors[i]!;
		if (scalefactor > 0) {
			const noiseLevel = athCurve[i]! + ((packedNoiseLevel + i) >> 8);
			const curvePosition = noiseLevel + 1 - ((5 * scalefactor) >> 1);
			if (curvePosition < 0) {
				newResolution = 15;
			} else if (curvePosition <= 65) {
				newResolution = INVERT_TABLE[curvePosition]!;
			} else {
				newResolution = 0;
			}

			if (newResolution > maxResolution) newResolution = maxResolution;
			else if (newResolution < minResolution) newResolution = minResolution;

			if (newResolution < 1) {
				ch.noises[noiseCount++] = i;
			} else {
				ch.noises[HCA_SAMPLES_PER_SUBFRAME - 1 - validCount] = i;
				validCount++;
			}
		}
		ch.resolution[i] = newResolution;
	}

	ch.noiseCount = noiseCount;
	ch.validCount = validCount;
	for (let i = crCount; i < HCA_SAMPLES_PER_SUBFRAME; i++) ch.resolution[i] = 0;
}

function calculateGain(ch: HcaChannelState): void {
	const cgCount = ch.codedCount;
	for (let i = 0; i < cgCount; i++) {
		const sfScale = SCALING_TABLE_FLOAT[ch.scalefactors[i]!]!;
		const resScale = RANGE_TABLE_FLOAT[ch.resolution[i]!]!;
		ch.gain[i] = sfScale * resScale;
	}
}

// =====================================================================
// Decode step 2 — dequantise spectral coefficients.
// =====================================================================

function dequantizeCoefficients(
	ch: HcaChannelState,
	br: BitReader,
	subframe: number,
): void {
	const ccCount = ch.codedCount;
	const base = subframe * HCA_SAMPLES_PER_SUBFRAME;
	const spectra = ch.spectra;

	for (let i = 0; i < ccCount; i++) {
		let qc: number;
		const resolution = ch.resolution[i]!;
		const bits = MAX_BIT_TABLE[resolution]!;
		const code = br.read(bits);

		if (resolution > 7) {
			// sign-magnitude form
			const signedCode = (1 - ((code & 1) << 1)) * (code >> 1);
			if (signedCode === 0) br.skip(-1);
			qc = signedCode;
		} else {
			const index = (resolution << 4) + code;
			const skip = READ_BIT_TABLE[index]! - bits;
			br.skip(skip);
			qc = READ_VAL_TABLE[index]!;
		}

		spectra[base + i] = ch.gain[i]! * qc;
	}

	// zero rest
	for (let i = ccCount; i < HCA_SAMPLES_PER_SUBFRAME; i++) {
		spectra[base + i] = 0;
	}
}

// =====================================================================
// Decode step 3 — noise reconstruction + HFR.
// =====================================================================

function reconstructNoise(
	ch: HcaChannelState,
	minResolution: number,
	msStereo: number,
	random: number,
	subframe: number,
): number {
	if (minResolution > 0) return random;
	if (ch.validCount <= 0 || ch.noiseCount <= 0) return random;
	if (!(msStereo === 0 || ch.type === ChannelType.STEREO_PRIMARY)) return random;

	const base = subframe * HCA_SAMPLES_PER_SUBFRAME;
	for (let i = 0; i < ch.noiseCount; i++) {
		// 32-bit unsigned rand step. JS `*` overflows int32 around 2^31,
		// so we manually keep this in 32-bit unsigned space.
		random = mulAdd32(random, 0x343fd, 0x269ec3);

		const randomIndex =
			HCA_SAMPLES_PER_SUBFRAME -
			ch.validCount +
			(((random & 0x7fff) * ch.validCount) >>> 15);

		const noiseIndex = ch.noises[i]!;
		const validIndex = ch.noises[randomIndex]!;

		const sfNoise = ch.scalefactors[noiseIndex]!;
		const sfValid = ch.scalefactors[validIndex]!;
		let scIndex = sfNoise - sfValid + 62;
		// Clamp to 0 (clHCA uses `& ~(x >> 31)`, the C sign-extension trick).
		if (scIndex < 0) scIndex = 0;

		ch.spectra[base + noiseIndex] =
			SCALE_CONVERSION_TABLE[scIndex]! * ch.spectra[base + validIndex]!;
	}
	return random;
}

/** 32-bit unsigned `random * mul + add`, with JS-safe multiplication. */
function mulAdd32(random: number, mul: number, add: number): number {
	// random is 32-bit unsigned; mul=0x343FD (18 bits); product fits in 50 bits.
	// We split random into hi/lo 16-bit halves to keep intermediate <2^53.
	const lo = random & 0xffff;
	const hi = random >>> 16;
	const low = lo * mul + add;
	const high = hi * mul + (low >>> 16);
	return (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
}

function reconstructHighFrequency(
	ch: HcaChannelState,
	hfrGroupCount: number,
	bandsPerHfrGroup: number,
	stereoBandCount: number,
	baseBandCount: number,
	totalBandCount: number,
	version: number,
	subframe: number,
): void {
	if (bandsPerHfrGroup === 0) return;
	if (ch.type === ChannelType.STEREO_SECONDARY) return;

	const base = subframe * HCA_SAMPLES_PER_SUBFRAME;
	const startBand = stereoBandCount + baseBandCount;
	let highband = startBand;
	let lowband = startBand - 1;

	const hfrScalesOffset = 128 - hfrGroupCount;
	let groupLimit: number;
	if (version <= HCA_VERSION_V200) {
		groupLimit = hfrGroupCount;
	} else {
		// `(hfr_group_count >= 0) ? hfr_group_count : hfr_group_count + 1` →
		// hfrGroupCount is always ≥0 (uint), so just hfrGroupCount.
		groupLimit = hfrGroupCount >> 1;
	}

	for (let group = 0; group < hfrGroupCount; group++) {
		const lowbandSub = group < groupLimit ? 1 : 0;
		for (let i = 0; i < bandsPerHfrGroup; i++) {
			if (highband >= totalBandCount || lowband < 0) break;
			let scIndex = ch.scalefactors[hfrScalesOffset + group]! -
				ch.scalefactors[lowband]! + 63;
			if (scIndex < 0) scIndex = 0;
			ch.spectra[base + highband] =
				SCALE_CONVERSION_TABLE[scIndex]! * ch.spectra[base + lowband]!;
			highband += 1;
			lowband -= lowbandSub;
		}
	}
	// last spectrum coefficient is 0
	ch.spectra[base + highband - 1] = 0;
}

// =====================================================================
// Decode step 4 — intensity / mid-side stereo unmix.
// =====================================================================

function applyIntensityStereo(
	chL: HcaChannelState,
	chR: HcaChannelState,
	subframe: number,
	baseBandCount: number,
	totalBandCount: number,
): void {
	if (chL.type !== ChannelType.STEREO_PRIMARY) return;
	const ratioL = INTENSITY_RATIO_TABLE[chR.intensity[subframe]!]!;
	const ratioR = 2.0 - ratioL;
	const baseL = subframe * HCA_SAMPLES_PER_SUBFRAME;
	const baseR = subframe * HCA_SAMPLES_PER_SUBFRAME;
	const spL = chL.spectra;
	const spR = chR.spectra;
	for (let band = baseBandCount; band < totalBandCount; band++) {
		const v = spL[baseL + band]!;
		spL[baseL + band] = v * ratioL;
		spR[baseR + band] = v * ratioR;
	}
}

function applyMsStereo(
	chL: HcaChannelState,
	chR: HcaChannelState,
	msStereo: number,
	baseBandCount: number,
	totalBandCount: number,
	subframe: number,
): void {
	if (!msStereo) return;
	if (chL.type !== ChannelType.STEREO_PRIMARY) return;
	const ratio = 0.70710676908493;
	const base = subframe * HCA_SAMPLES_PER_SUBFRAME;
	const spL = chL.spectra;
	const spR = chR.spectra;
	for (let band = baseBandCount; band < totalBandCount; band++) {
		const a = spL[base + band]!;
		const b = spR[base + band]!;
		spL[base + band] = (a + b) * ratio;
		spR[base + band] = (a - b) * ratio;
	}
}

// =====================================================================
// Decode step 5 — IMDCT synthesis. Mirrors clHCA `imdct_transform`.
// =====================================================================

const HCA_MDCT_BITS = 7; // log2(128)

function imdctTransform(ch: HcaChannelState, subframe: number): void {
	const size = HCA_SAMPLES_PER_SUBFRAME;
	const half = size / 2;
	const spectraBase = subframe * HCA_SAMPLES_PER_SUBFRAME;

	// We need two scratch buffers of size 128. clHCA uses the spectra
	// and temp arrays as ping-pong buffers. We do the same.
	let src = ch.spectra;
	let srcBase = spectraBase;
	let dst = ch.temp;
	let dstBase = 0;

	// Stage A: pre-rotation. 7 passes that produce a butterfly.
	{
		let count1 = 1;
		let count2 = half;
		for (let i = 0; i < HCA_MDCT_BITS; i++) {
			let s = srcBase;
			let d1 = dstBase;
			let d2 = dstBase + count2;
			for (let j = 0; j < count1; j++) {
				for (let k = 0; k < count2; k++) {
					const a = src[s++]!;
					const b = src[s++]!;
					dst[d1++] = a + b;
					dst[d2++] = a - b;
				}
				d1 += count2;
				d2 += count2;
			}
			// swap src and dst (we move "spectra" out of the loop after
			// the first pass — afterwards we ping-pong between temp arrays).
			const ts = src;
			const tsb = srcBase;
			src = dst;
			srcBase = dstBase;
			// For the next iteration the previous src becomes the new dst.
			// But spectra base is whatever it was; we need a writable buffer
			// of the same size. We use spectra (subframe slice) as the
			// alternate buffer, which matches clHCA's behaviour (it reuses
			// spectra and temp as ping-pong).
			dst = ts;
			dstBase = tsb;

			count1 <<= 1;
			count2 >>>= 1;
		}
	}

	// Stage B: 7 passes that apply sin/cos tables.
	{
		let count1 = half;
		let count2 = 1;
		for (let i = 0; i < HCA_MDCT_BITS; i++) {
			const sinTable = SIN_TABLES[i]!;
			const cosTable = COS_TABLES[i]!;
			let stIdx = 0;
			let s1 = srcBase;
			let s2 = srcBase + count2;
			let d1 = dstBase;
			let d2 = dstBase + count2 * 2 - 1;
			for (let j = 0; j < count1; j++) {
				for (let k = 0; k < count2; k++) {
					const a = src[s1++]!;
					const b = src[s2++]!;
					const sn = sinTable[stIdx]!;
					const cs = cosTable[stIdx]!;
					stIdx++;
					dst[d1++] = a * sn - b * cs;
					dst[d2--] = a * cs + b * sn;
				}
				s1 += count2;
				s2 += count2;
				d1 += count2;
				d2 += count2 * 3;
			}
			const ts = src;
			const tsb = srcBase;
			src = dst;
			srcBase = dstBase;
			dst = ts;
			dstBase = tsb;

			count1 >>>= 1;
			count2 <<= 1;
		}
	}

	// Windowing + overlap-add. After the pingpong above, `src` holds the
	// final DCT result. Following clHCA we treat `src[srcBase..]` as `dct`.
	const wave = ch.wave;
	const waveBase = subframe * HCA_SAMPLES_PER_SUBFRAME;
	const prev = ch.imdctPrevious;
	const win = IMDCT_WINDOW;
	for (let i = 0; i < half; i++) {
		wave[waveBase + i] = win[i]! * src[srcBase + i + half]! + prev[i]!;
		wave[waveBase + i + half] =
			win[i + half]! * src[srcBase + size - 1 - i]! - prev[i + half]!;
		prev[i] = win[size - 1 - i]! * src[srcBase + half - i - 1]!;
		prev[i + half] = win[half - i - 1]! * src[srcBase + i]!;
	}
}
