/**
 * Zelda 64 audio extraction.
 *
 * Ocarina of Time and Majora's Mask split their sampled audio across
 * two files in the dmadata filesystem:
 *
 *   Audiobank   soundfonts — instrument/drum tables, envelopes, and
 *               per-sample headers carrying a VADPCM codebook and a
 *               loop descriptor
 *   Audiotable  a flat blob of raw VADPCM frames that the sample
 *               headers point into
 *
 * (A third file, Audioseq, holds the music sequences; those are a
 * separate format and are not handled here.)
 *
 * A sample header is 16 bytes:
 *
 *   +0x00  u32  flags and codec in the high byte(s), size in the
 *               low 24 bits (the *compressed* byte count)
 *   +0x04  u32  offset of the frames within Audiotable
 *   +0x08  u32  offset of the loop descriptor within Audiobank
 *   +0x0C  u32  offset of the codebook within Audiobank
 *
 * The three offsets are stored as file-relative values and relocated
 * into pointers when the bank is loaded, which is what makes static
 * extraction possible.
 *
 * The loop descriptor is:
 *
 *   +0x00  u32  loop start (in samples)
 *   +0x04  u32  loop end (in samples)
 *   +0x08  u32  loop count; 0 means the sample is a one-shot
 *   +0x0C  u32  padding
 *   +0x10  s16[16]  decoder state to prime the loop point,
 *                   present only when the count is non-zero
 *
 * Audiobank concatenates many soundfonts, and this module does not
 * walk the bank's own index — it scans for sample headers directly.
 * That is deliberate: the structure is highly self-validating (the
 * codebook offset must land on a plausible VADPCM codebook, both
 * in-bank offsets must be in range, and the sample must fit inside
 * Audiotable), and scanning works uniformly across game versions
 * whose index layouts differ.
 */

import {
	VADPCM_FRAME_SIZE,
	VADPCM_SAMPLES_PER_FRAME,
	decodeVadpcm,
	parseVadpcmBook,
	type VadpcmBook,
	type VadpcmDecodeResult,
} from '@tootallnate/vadpcm';

/** Bytes per sample header. */
export const SAMPLE_HEADER_SIZE = 0x10;

/**
 * Nominal playback rate.
 *
 * The RSP mixes at 32 kHz, but an individual sample is resampled at
 * runtime to whatever pitch the instrument asks for — the rate a
 * sample was recorded at lives in the instrument tables, not in the
 * sample header. 32 kHz is therefore a convention for previewing,
 * not ground truth, and a sample may sound transposed.
 */
export const Z64_NOMINAL_SAMPLE_RATE = 32000;

/** `codec` values used by the Zelda 64 audio driver. */
export const Codec = {
	/** VADPCM — the overwhelming majority of samples. */
	ADPCM: 0,
	S8: 1,
	S16_INMEMORY: 2,
	SMALL_ADPCM: 3,
	REVERB: 4,
	S16: 5,
} as const;

/** A loop descriptor. */
export interface Z64Loop {
	start: number;
	end: number;
	/** 0 for a one-shot sample. */
	count: number;
	/** Decoder state for the loop point, when the sample loops. */
	state: Int16Array | null;
}

/** A sample located in Audiobank, with its data in Audiotable. */
export interface Z64Sample {
	/** Offset of the 16-byte header within Audiobank. */
	headerOffset: number;
	/** Offset of the VADPCM frames within Audiotable. */
	dataOffset: number;
	/** Compressed size in bytes. */
	size: number;
	/** Codec id; see {@link Codec}. */
	codec: number;
	book: VadpcmBook;
	bookOffset: number;
	loop: Z64Loop | null;
	loopOffset: number;
	/** Decoded sample count implied by `size`. */
	sampleCount: number;
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] << 24) |
			(bytes[offset + 1] << 16) |
			(bytes[offset + 2] << 8) |
			bytes[offset + 3]) >>>
		0
	);
}

/** Read a loop descriptor, or `null` if it is out of range. */
export function parseZ64Loop(
	audiobank: Uint8Array,
	offset: number,
): Z64Loop | null {
	if (offset < 0 || offset + 16 > audiobank.length) return null;
	const start = readU32(audiobank, offset);
	const end = readU32(audiobank, offset + 4);
	const count = readU32(audiobank, offset + 8);
	let state: Int16Array | null = null;
	if (count !== 0 && offset + 16 + 32 <= audiobank.length) {
		state = new Int16Array(16);
		for (let i = 0; i < 16; i++) {
			const o = offset + 16 + i * 2;
			const v = (audiobank[o] << 8) | audiobank[o + 1];
			state[i] = v >= 0x8000 ? v - 0x10000 : v;
		}
	}
	return { start, end, count, state };
}

export interface ScanZ64SamplesOptions {
	/** Smallest compressed size to accept (default 32 bytes). */
	minSize?: number;
	/** Largest compressed size to accept (default 1 MiB). */
	maxSize?: number;
	/**
	 * Only accept VADPCM samples (default true). The other codecs
	 * are rare and are not decodable by this module.
	 */
	adpcmOnly?: boolean;
	/**
	 * Verify each candidate by decoding it (default true).
	 *
	 * Structural checks alone still admit the occasional coincidence,
	 * and a header paired with the wrong codebook decodes to
	 * saturated noise rather than failing. Since VADPCM read with its
	 * own codebook essentially never clamps, the clamp ratio is a
	 * decisive filter — it lifts Majora's Mask from ~70% to ~100%
	 * clean without discarding real samples.
	 */
	validate?: boolean;
	/**
	 * Maximum fraction of decoded samples allowed to hit the 16-bit
	 * clamp (default 0.005).
	 */
	maxClampRatio?: number;
}

/**
 * Find every sample header in an Audiobank.
 *
 * `audiotable` supplies the waveform data: it bounds the sample data
 * offsets and, when `validate` is on, lets each candidate be checked
 * by decoding it. Results are ordered by header offset and
 * de-duplicated by data offset, since instruments across different
 * soundfonts often share a waveform.
 */
export function scanZ64Samples(
	audiobank: Uint8Array,
	audiotable: Uint8Array,
	options: ScanZ64SamplesOptions = {},
): Z64Sample[] {
	const minSize = options.minSize ?? 32;
	const maxSize = options.maxSize ?? 1024 * 1024;
	const adpcmOnly = options.adpcmOnly ?? true;
	const validate = options.validate ?? true;
	const maxClampRatio = options.maxClampRatio ?? 0.005;
	const audiotableSize = audiotable.length;

	const out: Z64Sample[] = [];
	const seenData = new Set<number>();

	// Headers are word-aligned within the bank.
	for (let offset = 0; offset + SAMPLE_HEADER_SIZE <= audiobank.length; offset += 4) {
		const word0 = readU32(audiobank, offset);
		const size = word0 & 0xffffff;
		if (size < minSize || size > maxSize) continue;

		const dataOffset = readU32(audiobank, offset + 4);
		if (dataOffset + size > audiotableSize) continue;

		const loopOffset = readU32(audiobank, offset + 8);
		const bookOffset = readU32(audiobank, offset + 12);
		// Both must be real in-bank offsets. Zero would be a null
		// pointer, which a usable sample never has.
		if (loopOffset === 0 || loopOffset + 16 > audiobank.length) continue;
		if (bookOffset === 0 || bookOffset + 8 > audiobank.length) continue;

		// The strongest check: the book offset must land on something
		// shaped like a VADPCM codebook.
		const book = parseVadpcmBook(audiobank, bookOffset);
		if (!book) continue;
		// Every retail Zelda 64 sample uses order 2; anything else at
		// this offset is a coincidence.
		if (book.order !== 2) continue;

		const codec = (word0 >>> 24) & 0x0f;
		if (adpcmOnly && codec !== Codec.ADPCM) continue;

		if (seenData.has(dataOffset)) continue;

		const sampleCount =
			Math.floor(size / VADPCM_FRAME_SIZE) * VADPCM_SAMPLES_PER_FRAME;
		// Sanitise rather than reject on a bad loop descriptor.
		//
		// The loop pointer is the weakest field in the header — many
		// otherwise-perfect samples (verified by decoding without a
		// single clamped output) carry a descriptor that reads as
		// nonsense, e.g. a loop count in the hundreds of millions.
		// Discarding those would throw away ~40% of the real audio, so
		// an implausible descriptor is reported as "no loop info"
		// instead. A genuine loop runs forwards, stays inside the
		// sample, and repeats a small number of times (or 0xFFFFFFFF
		// for "forever").
		let loop = parseZ64Loop(audiobank, loopOffset);
		if (
			loop &&
			(loop.start > loop.end ||
				loop.end > sampleCount ||
				(loop.count > 0xffff && loop.count !== 0xffffffff))
		) {
			loop = null;
		}

		const candidate: Z64Sample = {
			headerOffset: offset,
			dataOffset,
			size,
			codec,
			book,
			bookOffset,
			loop,
			loopOffset,
			sampleCount,
		};

		if (validate) {
			const decoded = decodeZ64Sample(audiotable, candidate);
			if (decoded.samples.length === 0) continue;
			if (decoded.clamped / decoded.samples.length > maxClampRatio) continue;
		}

		seenData.add(dataOffset);
		out.push(candidate);
	}
	return out;
}

/**
 * Decode one sample's frames from Audiotable.
 *
 * The decode is verifiable without a reference: VADPCM read with the
 * wrong codebook saturates constantly, so a near-zero
 * `clamped` count in the result means the header and codebook were
 * paired correctly.
 */
export function decodeZ64Sample(
	audiotable: Uint8Array,
	sample: Z64Sample,
): VadpcmDecodeResult {
	const end = Math.min(audiotable.length, sample.dataOffset + sample.size);
	return decodeVadpcm(audiotable.subarray(sample.dataOffset, end), sample.book);
}

/**
 * Encode 16-bit mono PCM as a RIFF/WAVE file.
 *
 * Included here so callers can hand decoded samples straight to an
 * `<audio>` element.
 */
export function encodeWav(
	samples: Int16Array,
	sampleRate = Z64_NOMINAL_SAMPLE_RATE,
): Uint8Array {
	const dataBytes = samples.length * 2;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	const tag = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			out[offset + i] = text.charCodeAt(i);
		}
	};
	tag(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits
	tag(36, 'data');
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < samples.length; i++) {
		view.setInt16(44 + i * 2, samples[i], true);
	}
	return out;
}
