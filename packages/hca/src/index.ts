/*
 * @tootallnate/hca — pure-TypeScript decoder for CRI Middleware's
 * High Compression Audio (HCA) codec.
 *
 * Ported from vgmstream's clHCA (ISC license, by nyaga / kode54 /
 * bnnm). See README + LICENSE.
 *
 * Use {@link decodeHca} for raw Float32 PCM, or
 * {@link decodeHcaToWavBlob} for a ready-to-play `audio/wav` blob.
 *
 * Encrypted files (`ciphType === 56`) need a 64-bit per-file key
 * plus an optional per-bank AWB subkey. We don't ship any keys —
 * pass them via {@link DecodeHcaOptions}.
 */

export {
	parseHcaHeader,
	HcaHeaderError,
	deriveSubkey,
	HCA_VERSION_V101,
	HCA_VERSION_V102,
	HCA_VERSION_V103,
	HCA_VERSION_V200,
	HCA_VERSION_V300,
	type HcaHeader,
} from './header.js';
export { initCiphTable, decryptBlock, checkSum } from './cipher.js';
export { initAthTable } from './tables.js';
export {
	initDecode,
	decodeBlock,
	type HcaChannelState,
	type HcaDecodeState,
} from './decoder.js';

import { parseHcaHeader, deriveSubkey, HCA_SAMPLES_PER_FRAME } from './header.js';
import { initCiphTable } from './cipher.js';
import { initAthTable } from './tables.js';
import { initDecode, decodeBlock } from './decoder.js';

export interface DecodeHcaOptions {
	/**
	 * 64-bit per-file decryption key. Required when `ciphType === 56`
	 * (key-derived cipher); ignored for ciph types 0 / 1. Accepts a
	 * `bigint` directly or any `number` ≤ 2⁵³−1 (callers with a
	 * larger key should construct a `bigint` themselves).
	 */
	key?: bigint | number;
	/**
	 * Per-bank AWB subkey. Mixed into the file key before the cipher
	 * table is built; defaults to 0 (no mixing). Read this from the
	 * containing AWB's `subkey` field when decoding bank-embedded HCAs.
	 */
	awbKey?: number;
	/**
	 * Output volume multiplier applied on top of the file's `rva ` gain.
	 * Defaults to 1.0 (passthrough).
	 */
	volume?: number;
}

/** Result of a successful HCA decode. */
export interface DecodedHca {
	/** Interleaved Float32 PCM in [-1, 1]. Layout: `[L0, R0, L1, R1, ...]`. */
	samples: Float32Array;
	/** Sample rate from the file's `fmt ` chunk. */
	sampleRate: number;
	/** Channel count from the file's `fmt ` chunk. */
	numChannels: number;
	/** Decoded sample count per channel. */
	numSamples: number;
}

/**
 * Decode an entire HCA stream to interleaved Float32 PCM.
 *
 * Each compressed block produces exactly 1024 samples per channel; we
 * loop through `header.blockCount` blocks and stop early if any block
 * fails its CRC.
 *
 * Throws `HcaHeaderError` for header-shape problems or `Error` for
 * config mismatches (unsupported comp ranges, missing key on a
 * type-56 stream, etc.).
 */
export function decodeHca(
	bytes: Uint8Array,
	options: DecodeHcaOptions = {},
): DecodedHca {
	const header = parseHcaHeader(bytes);
	let key1 = 0;
	let key2 = 0;
	if (header.ciphType === 56) {
		if (options.key === undefined || options.key === null) {
			throw new Error(
				`HCA: ciphType=56 requires a decryption key. Pass options.key with the game-specific 64-bit value.`,
			);
		}
		const derived = deriveSubkey(options.key, options.awbKey ?? 0);
		key1 = derived.key1;
		key2 = derived.key2;
	} else if (options.key !== undefined && options.key !== null) {
		const derived = deriveSubkey(options.key, options.awbKey ?? 0);
		key1 = derived.key1;
		key2 = derived.key2;
	}
	const ciphTable = initCiphTable(header.ciphType, key1, key2);
	const athTable = initAthTable(header.athType, header.samplingRate);
	const state = initDecode(header, ciphTable, athTable);

	const volume = (options.volume ?? 1.0) * header.rvaVolume;
	const numSamples = header.blockCount * HCA_SAMPLES_PER_FRAME;
	const interleaved = new Float32Array(numSamples * header.channelCount);
	const channels = state.channels;
	const channelCount = header.channelCount;

	let address = header.headerSize;
	let writeIdx = 0;
	for (let m = 0; m < header.blockCount; m++) {
		if (address + header.blockSize > bytes.length) break;
		// Decrypt-in-place mutates the input; slice into a fresh buffer
		// so the caller can hand us shared memory.
		const block = bytes.subarray(address, address + header.blockSize).slice();
		const ok = decodeBlock(state, block);
		if (!ok) break;
		// Emit interleaved samples [L0 R0 L1 R1 ...] for the block.
		for (let sf = 0; sf < 8; sf++) {
			for (let j = 0; j < 128; j++) {
				const off = sf * 128 + j;
				for (let k = 0; k < channelCount; k++) {
					interleaved[writeIdx++] = channels[k]!.wave[off]! * volume;
				}
			}
		}
		address += header.blockSize;
	}

	return {
		samples: interleaved,
		sampleRate: header.samplingRate,
		numChannels: header.channelCount,
		numSamples,
	};
}

/**
 * Wrap interleaved Float32 PCM into a RIFF WAVE buffer at the
 * requested bit depth. `mode = 0` writes 32-bit float WAV (which HCA
 * samples natively are); 16-bit PCM is the most browser-compatible
 * choice.
 */
export function encodeWav(
	samples: Float32Array,
	sampleRate: number,
	numChannels: number,
	mode: 8 | 16 | 24 | 32 | 0 = 16,
): Uint8Array {
	if (numChannels < 1) throw new Error('numChannels must be ≥ 1');
	if (sampleRate < 1) throw new Error('sampleRate must be ≥ 1');
	const bitsPerSample = mode === 0 ? 32 : mode;
	const isFloat = mode === 0;
	const bytesPerSample = bitsPerSample >>> 3;
	const dataSize = samples.length * bytesPerSample;
	const out = new Uint8Array(44 + dataSize);
	const dv = new DataView(out.buffer);
	const enc = new TextEncoder();
	out.set(enc.encode('RIFF'), 0);
	dv.setUint32(4, 36 + dataSize, true);
	out.set(enc.encode('WAVE'), 8);
	out.set(enc.encode('fmt '), 12);
	dv.setUint32(16, 16, true);
	dv.setUint16(20, isFloat ? 3 : 1, true);
	dv.setUint16(22, numChannels, true);
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
	dv.setUint16(32, numChannels * bytesPerSample, true);
	dv.setUint16(34, bitsPerSample, true);
	out.set(enc.encode('data'), 36);
	dv.setUint32(40, dataSize, true);

	let p = 44;
	for (let i = 0; i < samples.length; i++) {
		let f = samples[i]!;
		if (f > 1) f = 1;
		else if (f < -1) f = -1;
		switch (mode) {
			case 0:
				dv.setFloat32(p, f, true);
				p += 4;
				break;
			case 8:
				out[p++] = Math.floor(f * 0x7f) + 0x80;
				break;
			case 16:
				dv.setInt16(p, Math.floor(f * 0x7fff), true);
				p += 2;
				break;
			case 24: {
				const v = Math.floor(f * 0x7fffff) | 0;
				out[p++] = v & 0xff;
				out[p++] = (v >> 8) & 0xff;
				out[p++] = (v >> 16) & 0xff;
				break;
			}
			case 32:
				dv.setInt32(p, Math.floor(f * 0x7fffffff), true);
				p += 4;
				break;
		}
	}
	return out;
}

/**
 * Convenience: decode HCA bytes and wrap the result in an
 * `audio/wav` {@link Blob} ready to hand to `URL.createObjectURL`
 * for `<audio>` playback.
 */
export function decodeHcaToWavBlob(
	bytes: Uint8Array,
	options: DecodeHcaOptions = {},
): { blob: Blob; decoded: DecodedHca } {
	const decoded = decodeHca(bytes, options);
	const wav = encodeWav(decoded.samples, decoded.sampleRate, decoded.numChannels, 16);
	return {
		blob: new Blob([wav as BlobPart], { type: 'audio/wav' }),
		decoded,
	};
}
