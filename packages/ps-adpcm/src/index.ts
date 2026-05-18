/**
 * Sony PS-ADPCM decoder.
 *
 * "PS-ADPCM" (a.k.a. SPU-ADPCM, VAG, or simply "ADPCM" in Sony's
 * SDK docs) is the 4-bit lossy audio codec used on every Sony
 * console from the PS1 through the Vita. It's the codec the PSX
 * SPU and PS2 SPU2 decoded in hardware; PS3/PSP/Vita carry it
 * over in software for backwards compatibility and small-RAM
 * sound-effect storage.
 *
 * # Frame layout
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ byte 0:  shift_factor (low nibble) │ coef_index (high nib) │
 *   ├────────────────────────────────────────────────────────────┤
 *   │ byte 1:  flags                                              │
 *   │            0x01 = loop end                                  │
 *   │            0x02 = loop region                               │
 *   │            0x04 = loop start                                │
 *   │            0x07 = silent frame (output forced to 0)         │
 *   ├────────────────────────────────────────────────────────────┤
 *   │ bytes 2..15: 28 samples packed as 4-bit nibbles             │
 *   │   nibble layout per byte:  low nibble first, then high      │
 *   └────────────────────────────────────────────────────────────┘
 *
 * So every 16-byte frame yields 28 mono PCM16 samples — roughly
 * 3.5x compression vs raw 16-bit PCM.
 *
 * # Decoding formula
 *
 *   shift = 20 - shift_factor
 *   for each nibble n in [-8, 7]:
 *     scaled = (n << shift)
 *     pred   = (coef1[ci] * hist1 + coef2[ci] * hist2) << 8
 *     out    = clamp16((scaled + pred) >> 8)
 *     hist2  = hist1; hist1 = out
 *
 * `coef_index` selects from a 5-entry table of (coef1, coef2)
 * integer pairs (×64). The standard table holds the canonical
 * 4 predictors plus an "all zero" identity at index 0. Some PS3
 * games use an extended 16-entry table; we follow vgmstream's
 * heuristic and treat indices ≥ 6 as 0 unless explicitly enabled.
 *
 * # References
 *   - https://github.com/vgmstream/vgmstream/blob/master/src/coding/psx_decoder.c
 *   - https://psx-spx.consoledev.net/soundprocessingunitspu/#spu-adpcm
 */

/** Number of bytes per encoded PS-ADPCM frame. */
export const PS_ADPCM_FRAME_SIZE = 16;
/** Number of decoded PCM samples per encoded PS-ADPCM frame. */
export const PS_ADPCM_SAMPLES_PER_FRAME = 28;

/**
 * Canonical 5-entry predictor table (coef1, coef2) × 64. Sourced
 * from the official Sony SDK docs. PS3 games occasionally use an
 * extended table; if {@link DecodePsAdpcmOptions.extended} is set,
 * we use the full 16-entry table from `psx_decoder.c`. Almost no
 * real-world content needs it.
 */
const PS_ADPCM_COEFS_STD: ReadonlyArray<readonly [number, number]> = [
	[0, 0],
	[60, 0],
	[115, -52],
	[98, -55],
	[122, -60],
];

/**
 * Extended 16-entry table, *64-scaled. Half-step coefs like 57.5
 * appear in vgmstream's float reference; the *64 representation
 * keeps them integer where possible. The non-integer halves (e.g.
 * `57.5 * 64 = 3680`) round to int multiplication exactly because
 * JS Number is double-precision; the final `| 0` after `* 4` still
 * matches vgmstream's `(int32_t)` truncation.
 */
const PS_ADPCM_COEFS_EXT: ReadonlyArray<readonly [number, number]> = [
	[0, 0],
	[60, 0],
	[115, -52],
	[98, -55],
	[122, -60],
	[30, 0],
	[57.5, -26],
	[49, -27.5],
	[61, -30],
	[15, 0],
	[28.75, -13],
	[24.5, -13.75],
	[30.5, -15],
	[32, -60],
	[15, -60],
	[7, -60],
];

export interface DecodePsAdpcmOptions {
	/**
	 * Treat the data as block-interleaved with the given stride. Each
	 * call decodes `bytesPerBlock` bytes for one channel, then skips
	 * `bytesPerBlock * (numChannels - 1)` bytes to the next block for
	 * the same channel.
	 *
	 * For typical mono streams (which the vast majority of PS-ADPCM
	 * content is — sound effects, voice lines) leave this undefined.
	 */
	blockInterleave?: {
		numChannels: number;
		bytesPerBlock: number;
		channel: number;
	};
	/**
	 * Use the extended 16-entry coefficient table. Enable for the
	 * handful of PS3 titles known to produce these (see vgmstream's
	 * `extended_mode` flag). Default: false.
	 */
	extended?: boolean;
	/**
	 * Ignore the per-frame "flags" byte. Some games (notably FF XI)
	 * store internal markers in the flags byte that the decoder
	 * should treat as 0. Without this, those frames decode to
	 * silence (flag 0x07 → forced 0).
	 *
	 * Defaults to false (honour flags) since standard content
	 * encodes flag 0x07 correctly as a "silent frame" marker.
	 */
	ignoreFlags?: boolean;
}

/**
 * Decode a stream of PS-ADPCM bytes into 16-bit PCM samples.
 *
 * The input must contain whole 16-byte frames; trailing partial
 * bytes are ignored. Mono output (one s16 sample per emitted
 * value); for stereo files, call this once per channel with the
 * appropriate `blockInterleave` config and interleave the results
 * outside.
 */
export function decodePsAdpcm(
	input: Uint8Array,
	options: DecodePsAdpcmOptions = {},
): Int16Array {
	const coefTable = options.extended ? PS_ADPCM_COEFS_EXT : PS_ADPCM_COEFS_STD;
	const maxCoefIndex = coefTable.length - 1;
	const ignoreFlags = options.ignoreFlags === true;

	// Build the iteration sequence as a list of frame offsets so the
	// block-interleave logic stays separate from the inner loop.
	const frameOffsets = collectFrameOffsets(input.byteLength, options);
	const out = new Int16Array(frameOffsets.length * PS_ADPCM_SAMPLES_PER_FRAME);
	let outIdx = 0;
	let hist1 = 0;
	let hist2 = 0;

	for (const frameOffset of frameOffsets) {
		const header = input[frameOffset];
		const flag = input[frameOffset + 1];
		let coefIndex = (header >> 4) & 0xf;
		let shiftFactor = header & 0xf;
		// vgmstream falls back to safe values when source data is
		// out-of-range; mimic that here so corrupted/edge frames
		// don't blow up the decoder.
		if (coefIndex > maxCoefIndex) coefIndex = 0;
		if (shiftFactor > 12) shiftFactor = 9;
		const shift = 20 - shiftFactor;
		const [c1, c2] = coefTable[coefIndex];

		const isSilent = !ignoreFlags && flag === 0x07;

		for (let i = 0; i < PS_ADPCM_SAMPLES_PER_FRAME; i++) {
			let rawSample = 0;
			if (!isSilent) {
				const byte = input[frameOffset + 2 + (i >> 1)];
				// PS-ADPCM packs LOW nibble first (sample i=even),
				// then HIGH nibble (i=odd). Sign-extend from 4 bits.
				const nibble =
					i & 1 ? ((byte >> 4) & 0xf) : (byte & 0xf);
				const signed = nibble > 7 ? nibble - 16 : nibble;
				// Match vgmstream's float-math reference:
				//
				//   sample = (nibble << shift)
				//          + int32((float_c1*hist1 + float_c2*hist2) * 256)
				//   sample >>= 8
				//
				// where float_c1 = int_c1 / 64. Our table holds the
				// 64-scaled integer coefs (60, 115, etc.), so
				//
				//   float_c1 * 256 = int_c1 * 4
				//
				// and the predictor contribution simplifies to
				// `(int_c1*hist1 + int_c2*hist2) * 4`. JS Number is
				// double-precision so there's no overflow risk for
				// the multiplications (max ~ 122*32768*4 ≈ 16M);
				// `| 0` truncates to int32 mirroring the C cast.
				//
				// CRITICAL: `rawSample` propagates as hist UN-clamped
				// — vgmstream stores int32 in `hist1` and only
				// clamps to s16 for the OUTPUT. Storing the clamped
				// value back into hist subtly biases the predictor
				// (loud transients get the running predictor pulled
				// back to ±32767 instead of overshooting briefly,
				// which is audible as crackle on percussive sounds).
				const scaled = signed * (1 << shift);
				const pred = ((c1 * hist1 + c2 * hist2) * 4) | 0;
				rawSample = (scaled + pred) >> 8;
			}
			out[outIdx++] = clamp16(rawSample);
			hist2 = hist1;
			hist1 = rawSample;
		}
	}

	return out;
}

/**
 * Convert a key value (8.24 fixed-point) read from a Square wave
 * bank header into a sample rate in Hz. Used by the `.wd` reader;
 * exported here because it's a Square-specific quirk that sits
 * naturally next to PS-ADPCM decoding.
 *
 * Per vgmstream's `square_key_to_sample_rate`:
 *
 *   rate = round(base * 2^(key / 0x1000000 / 12))
 *
 * The result is clamped to `base` (i.e. the key encodes a pitch
 * delta from the "natural" base rate). `base` is 48000 for PS2/
 * PSP/Vita (LE PS-ADPCM) and 32000 for GameCube (BE DSP-ADPCM).
 */
export function squareKeyToSampleRate(key: number, baseRate: number): number {
	// `key` is signed 32-bit fixed-point 8.24; positive = lower
	// pitch (slower rate), so the exponent stays ≤ 0 and the
	// clamp at baseRate just guards against tiny floating-point
	// overshoot.
	const exponent = key / 0x1000000 / 12;
	const rate = Math.round(baseRate * Math.pow(2, exponent));
	return rate >= baseRate ? baseRate : rate;
}

/** Saturating clip to s16 range. */
function clamp16(n: number): number {
	if (n > 32767) return 32767;
	if (n < -32768) return -32768;
	return n;
}

/**
 * Compute the list of frame-start byte offsets to visit, honouring
 * `blockInterleave` if set. For a flat mono stream this is just
 * `[0, 16, 32, ...]`. For interleaved stereo it picks one channel's
 * blocks and walks them in order.
 */
function collectFrameOffsets(
	totalBytes: number,
	options: DecodePsAdpcmOptions,
): number[] {
	const out: number[] = [];
	if (!options.blockInterleave) {
		for (let off = 0; off + PS_ADPCM_FRAME_SIZE <= totalBytes; off += PS_ADPCM_FRAME_SIZE) {
			out.push(off);
		}
		return out;
	}
	const { numChannels, bytesPerBlock, channel } = options.blockInterleave;
	if (numChannels < 1) {
		throw new Error('blockInterleave.numChannels must be ≥ 1');
	}
	if (channel < 0 || channel >= numChannels) {
		throw new Error(
			`blockInterleave.channel out of range: ${channel} (numChannels=${numChannels})`,
		);
	}
	if (bytesPerBlock % PS_ADPCM_FRAME_SIZE !== 0) {
		throw new Error(
			`blockInterleave.bytesPerBlock (${bytesPerBlock}) is not a multiple of the frame size (${PS_ADPCM_FRAME_SIZE})`,
		);
	}
	const stride = bytesPerBlock * numChannels;
	for (let block = 0; block * stride < totalBytes; block++) {
		const blockStart = block * stride + channel * bytesPerBlock;
		const blockEnd = Math.min(blockStart + bytesPerBlock, totalBytes);
		for (
			let off = blockStart;
			off + PS_ADPCM_FRAME_SIZE <= blockEnd;
			off += PS_ADPCM_FRAME_SIZE
		) {
			out.push(off);
		}
	}
	return out;
}

/**
 * Compute the number of PCM samples a PS-ADPCM payload of the
 * given byte length decodes to. Helper for memory sizing.
 */
export function psAdpcmBytesToSamples(
	byteLength: number,
	numChannels: number = 1,
): number {
	const totalFrames = Math.floor(byteLength / PS_ADPCM_FRAME_SIZE);
	return Math.floor(totalFrames / numChannels) * PS_ADPCM_SAMPLES_PER_FRAME;
}

/**
 * Build a RIFF/WAVE-format byte buffer from the given PCM16
 * samples. Tiny utility colocated here so this package can
 * stand alone — see also `@tootallnate/dsp-adpcm`'s `encodeWav`,
 * which is functionally identical.
 */
export function encodeWav(
	samples: Int16Array,
	sampleRate: number,
	numChannels: number,
): Uint8Array {
	if (numChannels < 1) throw new Error('numChannels must be ≥ 1');
	if (sampleRate < 1) throw new Error('sampleRate must be ≥ 1');
	if (samples.length % numChannels !== 0) {
		throw new Error(
			`samples.length (${samples.length}) is not a multiple of numChannels (${numChannels})`,
		);
	}
	const bytesPerSample = 2;
	const byteRate = sampleRate * numChannels * bytesPerSample;
	const blockAlign = numChannels * bytesPerSample;
	const dataSize = samples.length * bytesPerSample;
	const out = new Uint8Array(44 + dataSize);
	const v = new DataView(out.buffer);
	const enc = new TextEncoder();
	out.set(enc.encode('RIFF'), 0);
	v.setUint32(4, 36 + dataSize, true);
	out.set(enc.encode('WAVE'), 8);
	out.set(enc.encode('fmt '), 12);
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, numChannels, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, byteRate, true);
	v.setUint16(32, blockAlign, true);
	v.setUint16(34, 16, true);
	out.set(enc.encode('data'), 36);
	v.setUint32(40, dataSize, true);
	const sampleView = new DataView(out.buffer, 44, dataSize);
	for (let i = 0; i < samples.length; i++) {
		sampleView.setInt16(i * 2, samples[i], true);
	}
	return out;
}
