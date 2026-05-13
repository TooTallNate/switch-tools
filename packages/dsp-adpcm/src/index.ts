/**
 * Nintendo DSP-ADPCM (a.k.a. GC ADPCM) decoder.
 *
 * Used by every Nintendo first-party audio format from the
 * GameCube onward: BRSTM/BCSTM/BFSTM, BRWAV/BCWAV/BFWAV, BFSTP,
 * BARS-embedded FWAVs, BWAV, etc. The codec packs **14 4-bit
 * samples** into each **8-byte frame**:
 *
 *   ┌────────────────┬─────────────────────────────────────────────┐
 *   │ byte 0: header │ scale (low nibble) │ predictor (high nibble) │
 *   ├────────────────┴─────────────────────────────────────────────┤
 *   │ bytes 1..7: 14 samples, each as a signed 4-bit nibble         │
 *   │ (high nibble of each byte is sample N, low nibble is N+1)     │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Each channel has a fixed 16-entry coefficient table (8 predictor
 * pairs × s16). The header byte's high nibble selects which pair to
 * use for the frame; the low nibble gives a per-frame shift exponent
 * `k`, and `2^k` becomes the per-frame "scale" multiplier.
 *
 * The decoded sample is computed (per vgmstream's
 * `ngc_dsp_decoder.c`) as:
 *
 *   sample = clamp16(
 *     ((nibble * scale) << 11 + 1024 + coef1*hist1 + coef2*hist2) >> 11
 *   )
 *
 * with `hist1`/`hist2` carried frame-to-frame (and across block
 * boundaries when this decoder is fed block-interleaved input).
 *
 * References (read line-by-line):
 *   - https://github.com/vgmstream/vgmstream/blob/master/src/coding/ngc_dsp_decoder.c
 *   - https://github.com/Thealexbarney/VGAudio/blob/master/src/VGAudio/Codecs/GcAdpcm/GcAdpcmDecoder.cs
 */

/** Number of bytes per encoded ADPCM frame. */
export const DSP_FRAME_SIZE = 8;
/** Number of decoded PCM samples per encoded ADPCM frame. */
export const DSP_SAMPLES_PER_FRAME = 14;

/**
 * Per-channel decoder state. Carry this across calls to
 * {@link decodeFrames} so history continues seamlessly across the
 * interleave gaps in block-interleaved formats like BFSTM.
 */
export interface DspChannelState {
	/**
	 * 16 × s16 coefficient table for this channel. The header byte's
	 * high nibble (0..7) selects a `(coef1, coef2)` pair from this
	 * table.
	 */
	coefs: Int16Array;
	/** Previous decoded sample (yn-1). Initialised to 0 at stream start. */
	hist1: number;
	/** Sample two before (yn-2). Initialised to 0 at stream start. */
	hist2: number;
}

/**
 * Build a {@link DspChannelState} from a 32-byte (16 × s16) coefficient
 * blob and optional initial hist values. The byte order follows the
 * source format's BOM — Switch BFWAV/BFSTM is little-endian, Wii U
 * is big-endian.
 */
export function makeDspState(
	coefBytes: Uint8Array,
	options: {
		littleEndian: boolean;
		hist1?: number;
		hist2?: number;
	},
): DspChannelState {
	if (coefBytes.byteLength < 32) {
		throw new Error(
			`DSP-ADPCM coef blob too small: got ${coefBytes.byteLength} bytes, need 32`,
		);
	}
	const view = new DataView(
		coefBytes.buffer,
		coefBytes.byteOffset,
		coefBytes.byteLength,
	);
	const coefs = new Int16Array(16);
	for (let i = 0; i < 16; i++) {
		coefs[i] = view.getInt16(i * 2, options.littleEndian);
	}
	return {
		coefs,
		hist1: options.hist1 ?? 0,
		hist2: options.hist2 ?? 0,
	};
}

/**
 * Decode a contiguous range of DSP-ADPCM nibbles into PCM samples.
 *
 * Reads up to `numSamples` samples starting from `firstSample`
 * within the encoded byte stream `frames` (which must contain whole
 * 8-byte frames). Writes them to `out` at indices
 * `[outOffset, outOffset + numSamples)` with the given stride
 * (use stride > 1 to interleave directly into a multi-channel
 * output buffer; stride === 1 just writes consecutive samples).
 *
 * Updates `state.hist1` / `state.hist2` in-place so the caller can
 * resume decoding the same channel from the next byte slice (this
 * is what makes block-interleaved BFSTM work).
 *
 * Decoding stops cleanly if the input runs out — callers should
 * always size `frames` to cover at least
 * `ceil((firstSample + numSamples) / 14) * 8` bytes.
 */
export function decodeFrames(
	frames: Uint8Array,
	firstSample: number,
	numSamples: number,
	state: DspChannelState,
	out: Int16Array,
	outOffset: number,
	stride: number = 1,
): void {
	if (numSamples <= 0) return;
	let { hist1, hist2 } = state;
	const coefs = state.coefs;
	const totalSamples = firstSample + numSamples;

	let frameIndex = (firstSample / DSP_SAMPLES_PER_FRAME) | 0;
	let sampleInFrame = firstSample - frameIndex * DSP_SAMPLES_PER_FRAME;
	let writeIdx = outOffset;
	let samplesLeft = numSamples;

	while (samplesLeft > 0) {
		const frameStart = frameIndex * DSP_FRAME_SIZE;
		if (frameStart + 1 > frames.byteLength) {
			// Out of input — caller asked for more samples than the
			// nibble stream contains. Bail rather than reading garbage.
			break;
		}
		const header = frames[frameStart];
		// Low nibble: shift exponent k → scale = 2^k.
		const scale = 1 << (header & 0x0f);
		// High nibble: predictor pair index (0..7 normally, up to 0xF
		// in malformed files; the DSP hardware only uses 0..7).
		const coefIndex = (header >> 4) & 0x0f;
		const coef1 = coefs[(coefIndex * 2) & 0xf];
		const coef2 = coefs[(coefIndex * 2 + 1) & 0xf];

		// Walk the 14 nibbles of this frame — high nibble of each byte
		// first, then low nibble.
		const stopInFrame = Math.min(
			DSP_SAMPLES_PER_FRAME,
			sampleInFrame + samplesLeft,
		);
		for (let i = sampleInFrame; i < stopInFrame; i++) {
			const byteOff = frameStart + 1 + (i >> 1);
			if (byteOff >= frames.byteLength) {
				samplesLeft = 0;
				break;
			}
			const byte = frames[byteOff];
			// Sign-extend the chosen 4-bit nibble to [-8, 7].
			let nibble: number;
			if ((i & 1) === 0) nibble = ((byte >> 4) & 0x0f) - ((byte >> 3) & 0x10);
			else nibble = (byte & 0x0f) - ((byte & 0x08) << 1);

			// Predictor + delta in Q11 fixed point. The +1024 (== 0x400)
			// is a rounding term: equivalent to +0.5 after the >>11.
			let predicted = (nibble * scale) << 11;
			predicted += 1024 + coef1 * hist1 + coef2 * hist2;
			let sample = predicted >> 11;
			if (sample > 32767) sample = 32767;
			else if (sample < -32768) sample = -32768;

			out[writeIdx] = sample;
			writeIdx += stride;
			hist2 = hist1;
			hist1 = sample;
			samplesLeft--;
			if (samplesLeft <= 0) break;
		}
		frameIndex++;
		sampleInFrame = 0;
		// Bookkeeping sanity: if firstSample+numSamples < frame end,
		// loop falls through. Otherwise loop continues into the next frame.
		if (firstSample + numSamples - samplesLeft >= totalSamples) break;
	}

	state.hist1 = hist1;
	state.hist2 = hist2;
}

/**
 * Decode a complete per-channel DSP-ADPCM byte stream of
 * `numSamples` samples into a fresh Int16Array. Convenience wrapper
 * around {@link decodeFrames} for non-interleaved input (e.g. one
 * channel of a BFWAV).
 */
export function decodeChannel(
	frames: Uint8Array,
	numSamples: number,
	state: DspChannelState,
): Int16Array {
	const out = new Int16Array(numSamples);
	decodeFrames(frames, 0, numSamples, state, out, 0, 1);
	return out;
}

/**
 * Number of bytes a DSP-ADPCM stream of `numSamples` samples
 * occupies, rounded up to whole 8-byte frames. Useful for sizing
 * the per-channel byte slice you read from a BFWAV's DATA block.
 */
export function dspBytesForSamples(numSamples: number): number {
	if (numSamples <= 0) return 0;
	const frames = Math.ceil(numSamples / DSP_SAMPLES_PER_FRAME);
	return frames * DSP_FRAME_SIZE;
}

/**
 * Interleave `numChannels` separate PCM16 sample streams into a
 * single output buffer suitable for {@link encodeWav}. All input
 * channels must have the same length.
 */
export function interleavePcm16(channels: Int16Array[]): Int16Array {
	const numChannels = channels.length;
	if (numChannels === 0) return new Int16Array(0);
	const numFrames = channels[0].length;
	for (let i = 1; i < numChannels; i++) {
		if (channels[i].length !== numFrames) {
			throw new Error(
				`Channel ${i} has ${channels[i].length} samples but channel 0 has ${numFrames}`,
			);
		}
	}
	if (numChannels === 1) return channels[0];
	const out = new Int16Array(numFrames * numChannels);
	for (let f = 0; f < numFrames; f++) {
		for (let c = 0; c < numChannels; c++) {
			out[f * numChannels + c] = channels[c][f];
		}
	}
	return out;
}

export { encodeWav, encodeWavBlob } from './wav.js';
export {
	decodeSwitchAudio,
	type SwitchAudioChannelHeader,
	type SwitchAudioDecoded,
} from './switch-audio.js';
