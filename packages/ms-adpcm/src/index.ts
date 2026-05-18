/**
 * Microsoft ADPCM (MS-ADPCM) decoder.
 *
 * Reads a standard RIFF/WAVE container whose `fmt ` chunk
 * declares `wFormatTag = 0x0002` (WAVE_FORMAT_ADPCM), decodes
 * the block-encoded 4-bit ADPCM samples into interleaved
 * `Int16Array` PCM, and provides a helper to re-wrap the PCM
 * as a plain `WAVE_FORMAT_PCM` (1) WAV — which `<audio>` /
 * `AudioContext.decodeAudioData()` will happily play (Firefox,
 * Chrome, and Safari all support PCM WAV but none support the
 * ADPCM variant natively).
 *
 * # Format reference
 *
 *   * Microsoft "RIFF Waveform Audio File Format" — the
 *     ADPCM-specific extensions.
 *   * `MULTIMEDIA PROGRAMMER'S REFERENCE`, 1991 (chapter 6).
 *   * ffmpeg's `libavcodec/adpcm.c` decoder (CC-BY).
 *
 * # `fmt ` extension layout (for `wFormatTag = 2`)
 *
 *   0x00  wFormatTag           u16  = 0x0002
 *   0x02  nChannels            u16
 *   0x04  nSamplesPerSec       u32
 *   0x08  nAvgBytesPerSec      u32
 *   0x0c  nBlockAlign          u16  bytes per ADPCM block
 *   0x0e  wBitsPerSample       u16  = 4 (always for MS-ADPCM)
 *   0x10  cbSize               u16  extension size (= 32 typically)
 *   0x12  wSamplesPerBlock     u16  decoded samples per channel per block
 *   0x14  wNumCoef             u16  count of (i16,i16) coefficient pairs
 *   0x16  aCoef[wNumCoef]      pair  predictor coefficient pairs
 *
 * # Block layout
 *
 *   Per channel, a 7-byte block header:
 *     0x00  predictor  u8     index into the aCoef table (0..wNumCoef-1)
 *     0x01  delta      i16le  initial step size (adaptive)
 *     0x03  sample1    i16le  most-recent sample
 *     0x05  sample2    i16le  second-most-recent sample
 *
 *   Then nibbles (4 bits per sample), high nibble first within
 *   each byte. Stereo blocks interleave one nibble from channel 0
 *   followed by one nibble from channel 1, alternating.
 *
 * # Sample reconstruction (per nibble)
 *
 *   pred = (sample1 * coef1 + sample2 * coef2) / 256
 *   error = signed_nibble * delta
 *   new_sample = clamp_i16(pred + error)
 *   delta = max(16, (delta * adaptationTable[unsigned_nibble]) / 256)
 *   sample2 = sample1
 *   sample1 = new_sample
 */

/**
 * Adaptation table for `delta` step size. Indexed by the
 * UNSIGNED 4-bit nibble. From Microsoft's reference docs.
 */
const ADAPTATION_TABLE: readonly number[] = [
	230, 230, 230, 230, 307, 409, 512, 614,
	768, 614, 512, 409, 307, 230, 230, 230,
];

/**
 * The 7 standard predictor coefficient pairs. Almost every
 * MS-ADPCM file ships exactly these — `wNumCoef = 7` with the
 * same values — but the format allows custom tables, so the
 * parser always reads them from the `fmt ` chunk rather than
 * hard-coding.
 */
export const STANDARD_COEFS: ReadonlyArray<readonly [number, number]> = [
	[256, 0],
	[512, -256],
	[0, 0],
	[192, 64],
	[240, 0],
	[460, -208],
	[392, -232],
];

/** Parsed metadata from a RIFF/WAVE MS-ADPCM file. */
export interface ParsedMsAdpcmWav {
	/** Always 2 (`WAVE_FORMAT_ADPCM`). Exposed for sanity-check display. */
	formatTag: number;
	channels: number;
	sampleRate: number;
	/** Bytes per encoded block (header + nibbles, per all channels). */
	blockAlign: number;
	/** Total decoded samples per channel per block. */
	samplesPerBlock: number;
	/** Predictor coefficient pairs from the `fmt ` extension. */
	coefs: ReadonlyArray<readonly [number, number]>;
	/**
	 * Total number of decoded sample frames (one frame = N
	 * channels). Sourced from the `fact` chunk when present,
	 * otherwise computed from block count and `samplesPerBlock`.
	 */
	totalFrames: number;
	/** Offset of the `data` chunk's body within the source bytes. */
	dataOffset: number;
	/** Length of the `data` chunk's body in bytes. */
	dataSize: number;
}

export class MsAdpcmParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MsAdpcmParseError';
	}
}

/**
 * Check whether a buffer looks like a RIFF/WAVE file with the
 * MS-ADPCM codec. Reads at most the first 22 bytes — cheap
 * enough for magic-sniffing on every `.wav` encountered.
 *
 * Returns `false` (rather than throwing) for non-WAV inputs and
 * for WAVs with a different codec (PCM, IEEE float, etc.).
 */
export function isMsAdpcmWav(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 22) return false;
	if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
		return false; // not "RIFF"
	}
	if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) {
		return false; // not "WAVE"
	}
	if (bytes[12] !== 0x66 || bytes[13] !== 0x6d || bytes[14] !== 0x74 || bytes[15] !== 0x20) {
		return false; // not "fmt "
	}
	const v = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const tag = v.getUint16(20, true);
	return tag === 0x0002;
}

/**
 * Parse a RIFF/WAVE MS-ADPCM file's metadata + locate the data
 * chunk. Validates the magic, codec tag, and coefficient
 * table count. Does NOT decode samples — call
 * {@link decodeMsAdpcm} for that.
 *
 * Throws {@link MsAdpcmParseError} if the file isn't a RIFF
 * MS-ADPCM WAV, or if a required chunk is missing.
 */
export function parseMsAdpcmWav(bytes: Uint8Array): ParsedMsAdpcmWav {
	if (bytes.byteLength < 44) {
		throw new MsAdpcmParseError(
			`Buffer too small (${bytes.byteLength} bytes) to contain a WAV header`,
		);
	}
	const v = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const decoder = new TextDecoder('ascii');
	const magic = decoder.decode(bytes.subarray(0, 4));
	if (magic !== 'RIFF') {
		throw new MsAdpcmParseError(`Bad RIFF magic: ${JSON.stringify(magic)}`);
	}
	const waveTag = decoder.decode(bytes.subarray(8, 12));
	if (waveTag !== 'WAVE') {
		throw new MsAdpcmParseError(`Bad WAVE tag: ${JSON.stringify(waveTag)}`);
	}

	// Walk the chunk list starting at byte 12. Each chunk is a 4-
	// byte FourCC + u32 size, then `size` bytes of payload, then
	// padding to the next even offset.
	let cursor = 12;
	let fmt: { ofs: number; size: number } | null = null;
	let data: { ofs: number; size: number } | null = null;
	let fact: { ofs: number; size: number } | null = null;
	while (cursor + 8 <= bytes.byteLength) {
		const id = decoder.decode(bytes.subarray(cursor, cursor + 4));
		const size = v.getUint32(cursor + 4, true);
		const payload = cursor + 8;
		if (id === 'fmt ') fmt = { ofs: payload, size };
		else if (id === 'data') data = { ofs: payload, size };
		else if (id === 'fact') fact = { ofs: payload, size };
		// Chunks pad to a 16-bit boundary.
		cursor = payload + size + (size & 1);
	}

	if (!fmt) throw new MsAdpcmParseError('Missing `fmt ` chunk');
	if (!data) throw new MsAdpcmParseError('Missing `data` chunk');
	if (fmt.size < 18) {
		throw new MsAdpcmParseError(
			`fmt chunk too small (${fmt.size}) for an ADPCM extension`,
		);
	}

	const formatTag = v.getUint16(fmt.ofs + 0, true);
	if (formatTag !== 0x0002) {
		throw new MsAdpcmParseError(
			`Expected WAVE_FORMAT_ADPCM (0x0002), got 0x${formatTag.toString(16).padStart(4, '0')}`,
		);
	}
	const channels = v.getUint16(fmt.ofs + 2, true);
	const sampleRate = v.getUint32(fmt.ofs + 4, true);
	const blockAlign = v.getUint16(fmt.ofs + 12, true);
	const bitsPerSample = v.getUint16(fmt.ofs + 14, true);
	if (bitsPerSample !== 4) {
		throw new MsAdpcmParseError(
			`MS-ADPCM should declare wBitsPerSample = 4; got ${bitsPerSample}`,
		);
	}
	const samplesPerBlock = v.getUint16(fmt.ofs + 18, true);
	const numCoef = v.getUint16(fmt.ofs + 20, true);
	if (numCoef < 1 || numCoef > 64) {
		throw new MsAdpcmParseError(
			`Unreasonable wNumCoef = ${numCoef}; expected 1..64`,
		);
	}
	const coefs: Array<readonly [number, number]> = [];
	for (let i = 0; i < numCoef; i++) {
		const a = v.getInt16(fmt.ofs + 22 + i * 4, true);
		const b = v.getInt16(fmt.ofs + 24 + i * 4, true);
		coefs.push([a, b]);
	}

	// Compute total frames. Prefer `fact` (the encoder's own
	// count) — some MS-ADPCM files have a final partial block
	// that's still a full blockAlign on disk but contains fewer
	// than `samplesPerBlock` decoded samples, which only `fact`
	// knows the exact size of.
	let totalFrames: number;
	if (fact && fact.size >= 4) {
		totalFrames = v.getUint32(fact.ofs, true);
	} else {
		const blockCount = Math.floor(data.size / blockAlign);
		totalFrames = blockCount * samplesPerBlock;
	}

	return {
		formatTag,
		channels,
		sampleRate,
		blockAlign,
		samplesPerBlock,
		coefs,
		totalFrames,
		dataOffset: data.ofs,
		dataSize: data.size,
	};
}

/**
 * Decode the entire MS-ADPCM stream into interleaved s16 PCM.
 *
 * For stereo input the output is `[L0, R0, L1, R1, ...]` of
 * length `totalFrames * channels`. Mono input is a flat sample
 * array (one channel).
 *
 * The implementation walks blocks sequentially. Per block:
 *
 *   1. Read the per-channel headers (predictor, delta, sample1,
 *      sample2). The first two emitted samples per block are
 *      `sample2` then `sample1` — the headers double as the
 *      seed values, NOT as discardable warm-up state.
 *   2. Decode nibbles until either `samplesPerBlock` samples
 *      have been emitted or the block ends.
 *
 * Stereo nibble order within a byte: high nibble = channel 0,
 * low nibble = channel 1, alternating bytes. The spec calls
 * this "interleaved per nibble"; some references describe it
 * as "byte 0 = (L, R)" — same thing.
 */
export function decodeMsAdpcm(
	bytes: Uint8Array,
	parsed: ParsedMsAdpcmWav,
): Int16Array {
	const { channels, blockAlign, samplesPerBlock, coefs, totalFrames } = parsed;
	const v = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const out = new Int16Array(totalFrames * channels);
	let outIdx = 0;
	const blockCount = Math.floor(parsed.dataSize / blockAlign);

	const sample1 = new Int32Array(channels);
	const sample2 = new Int32Array(channels);
	const delta = new Int32Array(channels);
	const c1 = new Int32Array(channels);
	const c2 = new Int32Array(channels);

	for (let b = 0; b < blockCount; b++) {
		const blockOffset = parsed.dataOffset + b * blockAlign;

		// Per-channel header. The spec packs them sequentially:
		// all predictors first, then all deltas, then all sample1s,
		// then all sample2s. So for stereo:
		//   [pred_L, pred_R, delta_L, delta_R,
		//    sample1_L, sample1_R, sample2_L, sample2_R]
		let headerCursor = blockOffset;
		for (let c = 0; c < channels; c++) {
			let predIdx = bytes[headerCursor++];
			// Defensive: clamp to a valid coef index.
			if (predIdx >= coefs.length) predIdx = coefs.length - 1;
			const pair = coefs[predIdx]!;
			c1[c] = pair[0];
			c2[c] = pair[1];
		}
		for (let c = 0; c < channels; c++) {
			delta[c] = v.getInt16(headerCursor, true);
			headerCursor += 2;
		}
		for (let c = 0; c < channels; c++) {
			sample1[c] = v.getInt16(headerCursor, true);
			headerCursor += 2;
		}
		for (let c = 0; c < channels; c++) {
			sample2[c] = v.getInt16(headerCursor, true);
			headerCursor += 2;
		}

		// The two header seed samples count toward `samplesPerBlock`
		// and ARE the first two emitted samples (in order: sample2,
		// sample1).
		let framesLeftInBlock = samplesPerBlock;
		if (outIdx < out.length) {
			// First frame: each channel's sample2 (the older of the
			// two seed samples).
			for (let c = 0; c < channels && outIdx + c < out.length; c++) {
				out[outIdx + c] = sample2[c]!;
			}
			outIdx += channels;
			framesLeftInBlock--;
		}
		if (framesLeftInBlock > 0 && outIdx < out.length) {
			// Second frame: each channel's sample1.
			for (let c = 0; c < channels && outIdx + c < out.length; c++) {
				out[outIdx + c] = sample1[c]!;
			}
			outIdx += channels;
			framesLeftInBlock--;
		}

		// Remaining samples come from the nibble stream after the
		// header. We need `framesLeftInBlock * channels` nibbles —
		// at 2 nibbles per byte that's `framesLeftInBlock *
		// channels / 2` bytes, ceil-rounded for safety.
		const nibbleBase = blockOffset + channels * 7;
		let nibbleIdx = 0;

		// Decode one frame at a time. For stereo, channel 0's
		// nibble comes from the high nibble of the current byte;
		// channel 1's from the low nibble of the same byte. Then
		// advance to the next byte for the next frame. For mono,
		// alternate high/low nibbles within each byte (so each
		// byte produces 2 mono samples).
		while (framesLeftInBlock > 0 && outIdx < out.length) {
			for (let c = 0; c < channels; c++) {
				if (outIdx >= out.length) break;
				const byteOff = nibbleBase + (nibbleIdx >> 1);
				if (byteOff >= bytes.byteLength) break;
				const byte = bytes[byteOff]!;
				const nibble =
					(nibbleIdx & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
				nibbleIdx++;

				// Sign-extend the 4-bit nibble.
				const signed = nibble >= 8 ? nibble - 16 : nibble;

				// Prediction from history. CRITICAL: use integer
				// truncation toward zero (matching C `/ 256`), NOT
				// arithmetic right shift (`>> 8`, which floors).
				// Negative numerators differ by 1 between the two,
				// and the reference (ffmpeg, libsndfile) uses C
				// integer division — `Math.trunc` matches it.
				const num = sample1[c]! * c1[c]! + sample2[c]! * c2[c]!;
				const predicted = Math.trunc(num / 256);
				let next = predicted + signed * delta[c]!;
				if (next > 32767) next = 32767;
				else if (next < -32768) next = -32768;

				out[outIdx + c] = next;

				// Advance the predictor state.
				sample2[c] = sample1[c]!;
				sample1[c] = next;

				// Adapt delta.
				let nextDelta = (delta[c]! * ADAPTATION_TABLE[nibble]!) >> 8;
				if (nextDelta < 16) nextDelta = 16;
				delta[c] = nextDelta;
			}
			outIdx += channels;
			framesLeftInBlock--;
		}
	}

	return out;
}

/**
 * Build a standard PCM WAV (`WAVE_FORMAT_PCM`, 16-bit) byte
 * buffer from interleaved `Int16Array` samples. Suitable for
 * `<audio src=URL.createObjectURL(blob)>` playback in every
 * browser.
 *
 * Mirrors `@tootallnate/dsp-adpcm`'s `encodeWav` so the API
 * is consistent across formats; duplicated here so the
 * package has no runtime deps.
 */
export function encodeWav(
	samples: Int16Array,
	sampleRate: number,
	channels: number,
): Uint8Array {
	if (channels < 1) throw new Error('channels must be ≥ 1');
	if (sampleRate < 1) throw new Error('sampleRate must be ≥ 1');
	if (samples.length % channels !== 0) {
		throw new Error(
			`samples.length (${samples.length}) is not a multiple of channels (${channels})`,
		);
	}
	const bytesPerSample = 2;
	const byteRate = sampleRate * channels * bytesPerSample;
	const blockAlign = channels * bytesPerSample;
	const dataSize = samples.length * bytesPerSample;
	const out = new Uint8Array(44 + dataSize);
	const v = new DataView(out.buffer);
	const enc = new TextEncoder();
	out.set(enc.encode('RIFF'), 0);
	v.setUint32(4, 36 + dataSize, true);
	out.set(enc.encode('WAVE'), 8);
	out.set(enc.encode('fmt '), 12);
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, channels, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, byteRate, true);
	v.setUint16(32, blockAlign, true);
	v.setUint16(34, 16, true);
	out.set(enc.encode('data'), 36);
	v.setUint32(40, dataSize, true);
	const sampleView = new DataView(out.buffer, 44, dataSize);
	for (let i = 0; i < samples.length; i++) {
		sampleView.setInt16(i * 2, samples[i]!, true);
	}
	return out;
}

/**
 * One-shot: take a MS-ADPCM WAV byte buffer and return a PCM-WAV
 * `Blob` MIME-tagged as `audio/wav`, ready to feed `<audio>`.
 *
 * Throws {@link MsAdpcmParseError} for non-MS-ADPCM input.
 */
export function transcodeMsAdpcmToPcmWav(bytes: Uint8Array): Blob {
	const parsed = parseMsAdpcmWav(bytes);
	const samples = decodeMsAdpcm(bytes, parsed);
	const pcm = encodeWav(samples, parsed.sampleRate, parsed.channels);
	return new Blob([pcm.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
}
