/**
 * N64 VADPCM audio decoder.
 *
 * VADPCM ("Vector ADPCM") is the compressed audio codec of the
 * Nintendo 64 SDK's audio library, and consequently of essentially
 * every N64 game that plays sampled sound: Super Mario 64, Ocarina
 * of Time, Majora's Mask, Mario Kart 64 and so on.
 *
 * It is a linear-predictive ADPCM. Rather than a fixed filter set
 * like the SNES BRR codec, each sample carries its own *codebook*
 * of predictor vectors computed at encode time, and every frame
 * selects one of them. That split means audio data alone is not
 * decodable — the codebook lives elsewhere (in a soundfont, or in
 * an AIFC container's `VADPCMCODES` chunk) and must be supplied.
 *
 * ## Codebook
 *
 *   order        s32be   predictor order, 0-8; always 2 in practice
 *   npredictors  s32be   number of predictor sets, 1-16
 *   vectors      s16be[] `order * npredictors * 8` coefficients,
 *                        Q11 fixed point
 *
 * ## Audio data
 *
 * Frames of 9 bytes, each holding 16 samples (4.5 bits per sample):
 *
 *   byte 0      high nibble = scaling factor (0-12)
 *               low nibble  = predictor index (0-15)
 *   bytes 1-8   16 residuals, one per nibble, high nibble first,
 *               each a signed 4-bit value
 *
 * ## Decoding
 *
 * A frame decodes as two independent vectors of 8 samples that share
 * the frame's scale and predictor. Per vector, with predictor order
 * K and an accumulator of 8 values:
 *
 *   1. Zero the accumulator.
 *   2. For each of the K predictor vectors, multiply it by the
 *      corresponding one of the last K output samples and add it in.
 *   3. For each output index i (0-7):
 *      a. The prediction is `accumulator[i] >> 11`.
 *      b. Scale residual i left by the frame's scaling factor.
 *      c. The output sample is prediction + scaled residual.
 *      d. Add the K-th predictor vector, shifted right by i+1
 *         elements, times the scaled residual, into the accumulator.
 *   4. The vector's output becomes the decoder state for the next.
 *
 * Step 3d is what makes the codec "vector": the residual's influence
 * on *later* samples in the same vector is folded into the
 * accumulator rather than recomputed from a sample history, so the
 * whole vector can be evaluated with SIMD.
 *
 * The accumulator is kept in JS numbers rather than coerced to
 * int32: coefficients and samples are both 16-bit, so eight
 * accumulated products can exceed 2^31, and `>>` would wrap. The
 * `>> 11` is therefore expressed as a floor-division by 2048, which
 * is identical for negative values and exact well past 2^31.
 *
 * References:
 *   - N64 SDK audio library (`ALADPCMBook`, `ALADPCMloop`)
 *   - https://github.com/depp/vadpcm — format documentation
 */

/** Bytes per encoded frame. */
export const VADPCM_FRAME_SIZE = 9;
/** Samples produced by one frame. */
export const VADPCM_SAMPLES_PER_FRAME = 16;
/** Samples per decode vector (a frame is two vectors). */
const VECTOR_SIZE = 8;
/** Coefficients per predictor vector. */
const VECTOR_COEFFS = 8;
/** Predictor coefficients are Q11 fixed point. */
const COEFF_SHIFT = 2048; // 1 << 11

/** A VADPCM codebook. */
export interface VadpcmBook {
	/** Predictor order (0-8; 2 in practice). */
	order: number;
	/** Number of predictor sets (1-16). */
	npredictors: number;
	/**
	 * Predictor vectors, flattened: `npredictors * order` vectors of
	 * 8 coefficients each. Vector `(p, k)` starts at
	 * `((p * order) + k) * 8`.
	 */
	vectors: Int16Array;
}

/** Byte length of a codebook with the given shape. */
export function bookByteLength(order: number, npredictors: number): number {
	return 8 + order * npredictors * VECTOR_COEFFS * 2;
}

export interface ParseBookOptions {
	/**
	 * Reject books whose shape is outside the format's limits
	 * (default true). Turn off only to inspect malformed data.
	 */
	strict?: boolean;
}

/**
 * Read a codebook from `bytes` at `offset`.
 *
 * Returns `null` rather than throwing when the header is not a
 * plausible codebook, so this can be used to probe candidate
 * offsets while scanning a soundfont.
 */
export function parseVadpcmBook(
	bytes: Uint8Array,
	offset = 0,
	options: ParseBookOptions = {},
): VadpcmBook | null {
	const strict = options.strict ?? true;
	if (offset < 0 || offset + 8 > bytes.length) return null;
	const readS32 = (o: number): number => {
		const v =
			((bytes[o] << 24) |
				(bytes[o + 1] << 16) |
				(bytes[o + 2] << 8) |
				bytes[o + 3]) >>>
			0;
		return v >= 0x80000000 ? v - 0x100000000 : v;
	};
	const order = readS32(offset);
	const npredictors = readS32(offset + 4);
	if (strict) {
		// The order is bounded by the decoder's 8-entry state array,
		// and the predictor index is a nibble.
		if (order < 1 || order > 8) return null;
		if (npredictors < 1 || npredictors > 16) return null;
	}
	const total = order * npredictors * VECTOR_COEFFS;
	const end = offset + 8 + total * 2;
	if (end > bytes.length) return null;
	const vectors = new Int16Array(total);
	for (let i = 0; i < total; i++) {
		const o = offset + 8 + i * 2;
		const v = (bytes[o] << 8) | bytes[o + 1];
		vectors[i] = v >= 0x8000 ? v - 0x10000 : v;
	}
	return { order, npredictors, vectors };
}

export interface DecodeVadpcmOptions {
	/**
	 * Stop after this many frames. Defaults to however many whole
	 * frames the input holds.
	 */
	frames?: number;
	/**
	 * Initial decoder state: the 8 samples preceding the stream.
	 * Defaults to silence. Supply a loop's saved state to resume
	 * mid-sample.
	 */
	state?: Int16Array;
}

export interface VadpcmDecodeResult {
	samples: Int16Array;
	/** Frames actually decoded. */
	frames: number;
	/** Decoder state after the final frame (8 samples). */
	state: Int16Array;
	/** Samples that hit the 16-bit clamp. */
	clamped: number;
}

function clamp16(v: number): number {
	if (v > 32767) return 32767;
	if (v < -32768) return -32768;
	return v;
}

/**
 * Decode a VADPCM stream to 16-bit PCM.
 *
 * Requires the codebook the data was encoded against; decoding with
 * the wrong codebook produces loud noise rather than an error, so
 * `clamped` is reported as a sanity signal — real audio decoded with
 * its own codebook barely clamps at all.
 */
export function decodeVadpcm(
	data: Uint8Array,
	book: VadpcmBook,
	options: DecodeVadpcmOptions = {},
): VadpcmDecodeResult {
	const { order, npredictors, vectors } = book;
	const available = Math.floor(data.length / VADPCM_FRAME_SIZE);
	const frames = Math.max(
		0,
		Math.min(options.frames ?? available, available),
	);

	const out = new Int16Array(frames * VADPCM_SAMPLES_PER_FRAME);
	// Decoder state is the previous vector's 8 output samples.
	const state = new Int16Array(VECTOR_SIZE);
	if (options.state) state.set(options.state.subarray(0, VECTOR_SIZE));

	const accumulator = new Float64Array(VECTOR_SIZE);
	const residual = new Int8Array(VECTOR_SIZE);
	let clamped = 0;
	let outPos = 0;

	for (let frame = 0; frame < frames; frame++) {
		const base = frame * VADPCM_FRAME_SIZE;
		const header = data[base];
		const scale = header >> 4;
		// Clamp the predictor index into the codebook: a corrupt or
		// mismatched frame must not read outside the vectors array.
		const predictor = Math.min(header & 0x0f, npredictors - 1);
		const predictorBase = predictor * order * VECTOR_COEFFS;

		for (let half = 0; half < 2; half++) {
			// Unpack this vector's 8 residual nibbles.
			for (let i = 0; i < VECTOR_SIZE; i++) {
				const nibbleIndex = half * VECTOR_SIZE + i;
				const byte = data[base + 1 + (nibbleIndex >> 1)];
				const raw = nibbleIndex & 1 ? byte & 0x0f : byte >> 4;
				residual[i] = raw >= 8 ? raw - 16 : raw;
			}

			// Step 1-2: seed the accumulator from the last `order`
			// output samples.
			accumulator.fill(0);
			for (let k = 0; k < order; k++) {
				const previous = state[VECTOR_SIZE - order + k];
				if (previous === 0) continue;
				const vec = predictorBase + k * VECTOR_COEFFS;
				for (let j = 0; j < VECTOR_COEFFS; j++) {
					accumulator[j] += vectors[vec + j] * previous;
				}
			}

			// Step 3: emit samples, folding each residual's influence
			// on later samples back into the accumulator.
			const lastVec = predictorBase + (order - 1) * VECTOR_COEFFS;
			for (let i = 0; i < VECTOR_SIZE; i++) {
				const scaled = residual[i] << scale;
				// Arithmetic >> 11 without int32 coercion.
				const predicted = Math.floor(accumulator[i] / COEFF_SHIFT);
				const sample = predicted + scaled;
				const limited = clamp16(sample);
				if (limited !== sample) clamped++;
				state[i] = limited;
				out[outPos++] = limited;
				if (scaled !== 0) {
					for (let j = 0; j < VECTOR_SIZE - 1 - i; j++) {
						accumulator[i + 1 + j] += vectors[lastVec + j] * scaled;
					}
				}
			}
		}
	}

	return {
		samples: outPos === out.length ? out : out.subarray(0, outPos),
		frames,
		state,
		clamped,
	};
}

// ---------------------------------------------------------------
// AIFC container
// ---------------------------------------------------------------

/**
 * A parsed AIFC file.
 *
 * AIFC (compressed AIFF) is what the N64 SDK's audio tools emit, and
 * it is the one place VADPCM travels together with its codebook: the
 * non-standard `VADPCMCODES` application chunk carries the book,
 * while `SSND` carries the frames.
 */
export interface AifcFile {
	channels: number;
	sampleRate: number;
	/** Frame count from the `COMM` chunk (in sample frames). */
	sampleFrames: number;
	/** Compression type, e.g. `VAPC` for VADPCM. */
	compressionType: string;
	/** Codebook from `VADPCMCODES`, when present. */
	book: VadpcmBook | null;
	/** Raw `SSND` payload (the encoded frames). */
	audioData: Uint8Array<ArrayBufferLike>;
	/** Loop info from `VADPCMLOOPS`, when present. */
	loop: AifcLoop | null;
}

/** A VADPCM loop, from the `VADPCMLOOPS` chunk. */
export interface AifcLoop {
	start: number;
	end: number;
	count: number;
	/** 16 saved samples used to prime the decoder at the loop point. */
	state: Int16Array;
}

/** Is this an AIFF-C file? */
export function isAifc(bytes: Uint8Array): boolean {
	if (bytes.length < 12) return false;
	const tag = (o: number) =>
		String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
	return tag(0) === 'FORM' && (tag(8) === 'AIFC' || tag(8) === 'AIFF');
}

/**
 * Read an 80-bit IEEE 754 extended float, as AIFF stores sample
 * rates. Only the range and precision needed for audio rates is
 * handled; subnormals and NaN are not.
 */
function readExtendedFloat(bytes: Uint8Array, offset: number): number {
	const exponent = ((bytes[offset] & 0x7f) << 8) | bytes[offset + 1];
	const sign = bytes[offset] & 0x80 ? -1 : 1;
	let mantissa = 0;
	for (let i = 0; i < 8; i++) {
		mantissa = mantissa * 256 + bytes[offset + 2 + i];
	}
	if (exponent === 0 && mantissa === 0) return 0;
	return sign * mantissa * Math.pow(2, exponent - 16383 - 63);
}

/**
 * Parse an AIFC file, extracting the VADPCM codebook and audio.
 *
 * Throws when the container is malformed. Unknown chunks are
 * skipped, so files carrying extra metadata parse fine.
 */
export function parseAifc(bytes: Uint8Array): AifcFile {
	if (!isAifc(bytes)) throw new Error('AIFC: bad FORM/AIFC signature');
	const readU32 = (o: number): number =>
		(((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>>
		0);
	const readU16 = (o: number): number => (bytes[o] << 8) | bytes[o + 1];
	const tag = (o: number) =>
		String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);

	let channels = 1;
	let sampleRate = 32000;
	let sampleFrames = 0;
	let compressionType = '';
	let book: VadpcmBook | null = null;
	let loop: AifcLoop | null = null;
	// Typed as ArrayBufferLike-backed because `subarray` of the input
	// inherits the caller's buffer type.
	let audioData: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

	let position = 12;
	while (position + 8 <= bytes.length) {
		const chunkId = tag(position);
		const chunkSize = readU32(position + 4);
		const body = position + 8;
		if (body + chunkSize > bytes.length + 1) break;

		if (chunkId === 'COMM' && chunkSize >= 22) {
			channels = readU16(body);
			sampleFrames = readU32(body + 2);
			sampleRate = Math.round(readExtendedFloat(bytes, body + 8));
			compressionType = tag(body + 18);
		} else if (chunkId === 'SSND' && chunkSize >= 8) {
			// offset + blockSize, then the frames.
			const dataOffset = readU32(body);
			const start = body + 8 + dataOffset;
			const end = Math.min(bytes.length, body + chunkSize);
			if (start < end) audioData = bytes.subarray(start, end);
		} else if (chunkId === 'APPL' && chunkSize > 4) {
			// Application chunks are `APPL` + a 4-char signature; the
			// SDK uses a Pascal-style counted name after it.
			const signature = tag(body);
			if (signature === 'stoc' && chunkSize > 5) {
				const nameLength = bytes[body + 4];
				const nameStart = body + 5;
				const name = String.fromCharCode(
					...bytes.subarray(nameStart, nameStart + nameLength),
				);
				// Payload is padded to an even offset.
				let payload = nameStart + nameLength;
				if (payload & 1) payload++;
				if (name === 'VADPCMCODES') {
					// version:u16, then the book (order/npredictors as
					// u16 here rather than the s32 pair used in RAM).
					const order = readU16(payload + 2);
					const npredictors = readU16(payload + 4);
					const total = order * npredictors * VECTOR_COEFFS;
					if (
						order >= 1 && order <= 8 &&
						npredictors >= 1 && npredictors <= 16 &&
						payload + 6 + total * 2 <= bytes.length
					) {
						const vectors = new Int16Array(total);
						for (let i = 0; i < total; i++) {
							const o = payload + 6 + i * 2;
							const v = (bytes[o] << 8) | bytes[o + 1];
							vectors[i] = v >= 0x8000 ? v - 0x10000 : v;
						}
						book = { order, npredictors, vectors };
					}
				} else if (name === 'VADPCMLOOPS') {
					const start = readU32(payload + 2);
					const end = readU32(payload + 6);
					const count = readU32(payload + 10);
					const state = new Int16Array(16);
					for (let i = 0; i < 16; i++) {
						const o = payload + 14 + i * 2;
						if (o + 1 >= bytes.length) break;
						const v = (bytes[o] << 8) | bytes[o + 1];
						state[i] = v >= 0x8000 ? v - 0x10000 : v;
					}
					loop = { start, end, count, state };
				}
			}
		}

		// Chunks are padded to even lengths.
		position = body + chunkSize + (chunkSize & 1);
	}

	return {
		channels,
		sampleRate,
		sampleFrames,
		compressionType,
		book,
		audioData,
		loop,
	};
}

/**
 * Decode an AIFC file's VADPCM payload.
 *
 * Throws when the file carries no codebook, since VADPCM cannot be
 * decoded without one.
 */
export function decodeAifc(file: AifcFile): VadpcmDecodeResult {
	if (!file.book) {
		throw new Error(
			'AIFC: no VADPCMCODES chunk — VADPCM cannot be decoded without its codebook',
		);
	}
	return decodeVadpcm(file.audioData, file.book);
}
