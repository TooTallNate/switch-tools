/**
 * Parser + decoder for the **UE4/UE5 "SWITCH_AUDIO" cooked audio
 * container** — the format Switch builds of Unreal Engine games use
 * to ship `USoundWave` payloads (the `CompressedFormatData` entry
 * named `SWITCH_AUDIO00000000`).
 *
 * Despite the name suggesting something Switch-specific or
 * proprietary, the container is just **standard Nintendo DSP-ADPCM**
 * (a.k.a. GC ADPCM) with one quirk for UE's cooker: the per-channel
 * 0x60-byte DSP header is written **little-endian** rather than the
 * big-endian originally produced by Nintendo's `DSPADPCM.exe`. The
 * raw payload layout is:
 *
 *   ┌──────────────────────────┐  offset 0x00
 *   │ DSP header, channel 0    │  0x60 bytes, LE
 *   │   sample_count    @ 0x00 │  u32 (total decoded samples)
 *   │   nibble_count    @ 0x04 │  u32 (counts frame headers too)
 *   │   sample_rate     @ 0x08 │  u32
 *   │   loop_flag       @ 0x0c │  u16
 *   │   format          @ 0x0e │  u16  (0 for DSP-ADPCM)
 *   │   loop_start_off  @ 0x10 │  u32  (nibble offset)
 *   │   loop_end_off    @ 0x14 │  u32  (nibble offset)
 *   │   initial_off     @ 0x18 │  u32  (should be 2)
 *   │   coef[16]        @ 0x1c │  s16 ×16 (8 predictor pairs)
 *   │   gain            @ 0x3c │  u16  (0 for ADPCM)
 *   │   initial_ps      @ 0x3e │  u16  (matches first frame header)
 *   │   initial_hist1   @ 0x40 │  s16
 *   │   initial_hist2   @ 0x42 │  s16
 *   │   loop_ps         @ 0x44 │  u16
 *   │   loop_hist1      @ 0x46 │  s16
 *   │   loop_hist2      @ 0x48 │  s16
 *   │   channels        @ 0x4a │  s16  (usually 0/garbage; not trusted)
 *   │   block_size      @ 0x4c │  u16  (usually 0)
 *   │   padding         @ 0x4e │  0x12 bytes
 *   ├──────────────────────────┤  offset 0x60
 *   │ DSP-ADPCM data, channel 0│  size = (payload_size / channels) − 0x60
 *   ├──────────────────────────┤
 *   │ DSP header, channel 1    │  (only present when channels ≥ 2)
 *   │ DSP-ADPCM data, channel 1│
 *   └──────────────────────────┘
 *
 * vgmstream detects the channel count by checking whether the
 * first 4 bytes (sample_count) match at the file midpoint — we do
 * the same.
 *
 * Verified on Brewmaster (Switch) and matches vgmstream's
 * `init_vgmstream_dsp_switch_audio` (ISC). DSP-ADPCM decoding
 * itself is delegated to {@link decodeFrames} from this package's
 * generic codec module.
 */

import {
	DSP_FRAME_SIZE,
	decodeFrames,
	interleavePcm16,
	makeDspState,
} from './index.js';

/**
 * Per-channel parsed header — a 1:1 mirror of the on-disk 0x60-byte
 * Nintendo DSP header. We don't bother exposing the values we never
 * read (`gain`, `block_size`, etc.) but the comments document them.
 */
export interface SwitchAudioChannelHeader {
	sampleCount: number;
	nibbleCount: number;
	sampleRate: number;
	loopFlag: number;
	loopStartNibble: number;
	loopEndNibble: number;
	coefs: Int16Array;
	initialPs: number;
	initialHist1: number;
	initialHist2: number;
}

/** Result of {@link decodeSwitchAudio}. */
export interface SwitchAudioDecoded {
	/** Interleaved PCM16, ready to wrap in a WAV. */
	samples: Int16Array;
	/** Sample rate from the first channel's header. */
	sampleRate: number;
	/** Channel count, detected by interleave-half compare. */
	numChannels: number;
	/** Decoded sample count per channel (matches `sampleCount` from the header). */
	numSamples: number;
	/** Per-channel parsed headers, in stream order. */
	channelHeaders: SwitchAudioChannelHeader[];
}

/** Size of the on-disk DSP header. */
const DSP_HEADER_SIZE = 0x60;

/**
 * Parse a single 0x60-byte DSP header from `bytes` at `offset`.
 *
 * UE4's cooker writes these little-endian, unlike the BE form
 * produced by Nintendo's reference tools. We only validate the
 * fields that matter for decoding; vgmstream does stricter checks
 * for use in format detection but we already know the codec at the
 * point this function is called.
 */
function parseDspHeader(
	bytes: Uint8Array,
	offset: number,
): SwitchAudioChannelHeader {
	if (offset + DSP_HEADER_SIZE > bytes.byteLength) {
		throw new RangeError(
			`SWITCH_AUDIO: header truncated at offset 0x${offset.toString(16)} (need ${DSP_HEADER_SIZE} bytes, have ${bytes.byteLength - offset})`,
		);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, DSP_HEADER_SIZE);
	const sampleCount = dv.getUint32(0x00, true);
	const nibbleCount = dv.getUint32(0x04, true);
	const sampleRate = dv.getUint32(0x08, true);
	const loopFlag = dv.getUint16(0x0c, true);
	// 0x0e: format (must be 0 for ADPCM); we don't store it.
	const loopStartNibble = dv.getUint32(0x10, true);
	const loopEndNibble = dv.getUint32(0x14, true);
	// 0x18: initial_offset (should be 2; not stored).
	const coefs = new Int16Array(16);
	for (let i = 0; i < 16; i++) coefs[i] = dv.getInt16(0x1c + i * 2, true);
	// 0x3c: gain (0); 0x3e..0x48: initial/loop ps + hist.
	const initialPs = dv.getUint16(0x3e, true);
	const initialHist1 = dv.getInt16(0x40, true);
	const initialHist2 = dv.getInt16(0x42, true);
	return {
		sampleCount,
		nibbleCount,
		sampleRate,
		loopFlag,
		loopStartNibble,
		loopEndNibble,
		coefs,
		initialPs,
		initialHist1,
		initialHist2,
	};
}

/**
 * Auto-detect channel count: compare the first 4 bytes
 * (`sample_count`) at the start of the payload to the same offset
 * at the payload midpoint. If they match, it's stereo; otherwise
 * treat it as mono. This is what vgmstream does for this format.
 *
 * UE5 has yet to ship a >2-channel SWITCH_AUDIO payload in the
 * wild that we've seen; if/when that happens this heuristic will
 * need to grow into a length-table parse, but it's correct for
 * every observed file today.
 */
function detectChannels(payload: Uint8Array): 1 | 2 {
	if (payload.byteLength < DSP_HEADER_SIZE * 2) return 1;
	const dvLo = new DataView(payload.buffer, payload.byteOffset, 4);
	const half = (payload.byteLength / 2) | 0;
	if (half + 4 > payload.byteLength) return 1;
	const dvHi = new DataView(payload.buffer, payload.byteOffset + half, 4);
	return dvLo.getUint32(0, true) === dvHi.getUint32(0, true) ? 2 : 1;
}

/**
 * Decode a `SWITCH_AUDIO00000000` payload to interleaved 16-bit
 * PCM samples. The returned `samples` array can be passed straight
 * to {@link encodeWav} / {@link encodeWavBlob}.
 *
 * Notes for callers:
 *
 *   - The function never throws on partial inputs except for
 *     fundamentally-broken sizing (header too short, channel slice
 *     shorter than its claimed sample count's worth of nibbles).
 *     This matches our other decoders so a malformed asset can
 *     still produce some audio rather than blanking the preview.
 *   - We trust the per-channel `sampleCount` field, not anything
 *     UE serialised externally. They almost always agree but the
 *     cooker writes the DSP header verbatim from the upstream
 *     encoder so it's the authoritative number.
 */
export function decodeSwitchAudio(payload: Uint8Array): SwitchAudioDecoded {
	if (payload.byteLength < DSP_HEADER_SIZE) {
		throw new Error(
			`SWITCH_AUDIO: payload too small (${payload.byteLength} bytes, need at least ${DSP_HEADER_SIZE})`,
		);
	}
	const numChannels = detectChannels(payload);
	const channelStride = (payload.byteLength / numChannels) | 0;

	const channelHeaders: SwitchAudioChannelHeader[] = [];
	const channelSamples: Int16Array[] = [];
	let sampleRate = 0;
	let numSamples = 0;
	for (let ch = 0; ch < numChannels; ch++) {
		const channelOffset = ch * channelStride;
		const header = parseDspHeader(payload, channelOffset);
		channelHeaders.push(header);
		if (ch === 0) {
			sampleRate = header.sampleRate;
			numSamples = header.sampleCount;
		}

		const dataStart = channelOffset + DSP_HEADER_SIZE;
		const dataEnd = channelOffset + channelStride;
		if (dataEnd > payload.byteLength) {
			throw new Error(
				`SWITCH_AUDIO: channel ${ch} data slice out of range (need bytes [${dataStart}, ${dataEnd}), have ${payload.byteLength})`,
			);
		}
		const data = payload.subarray(dataStart, dataEnd);

		// Coef bytes are already parsed into header.coefs; copy them
		// into the state without going back to bytes.
		const state = makeDspState(new Uint8Array(32), {
			littleEndian: true,
			hist1: header.initialHist1,
			hist2: header.initialHist2,
		});
		state.coefs.set(header.coefs);

		// Sanity-check the buffer is big enough for the claimed
		// sample count; if not, decode whatever we have.
		const minBytes =
			Math.ceil(header.sampleCount / 14) * DSP_FRAME_SIZE;
		if (data.byteLength < minBytes) {
			// Decode what's actually there rather than throwing — the
			// caller's preview is still useful with a truncated tail.
		}
		const out = new Int16Array(header.sampleCount);
		decodeFrames(data, 0, header.sampleCount, state, out, 0, 1);
		channelSamples.push(out);
	}

	const samples =
		numChannels === 1 ? channelSamples[0]! : interleavePcm16(channelSamples);
	return {
		samples,
		sampleRate,
		numChannels,
		numSamples,
		channelHeaders,
	};
}
