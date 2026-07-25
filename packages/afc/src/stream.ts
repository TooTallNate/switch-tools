/**
 * `.afc` streamed-audio container.
 *
 * This is the file format Wind Waker uses for every piece of streamed audio —
 * background music, cutscene beds, ambient loops — under `Audiores/Stream/`.
 * It is a 0x20-byte header followed by raw {@link decodeAfc} block data, with no
 * magic number of any kind. That absence is the defining awkwardness of the
 * format: you cannot sniff an `.afc`, you can only check that its header is
 * self-consistent, which is what {@link isAfcStream} does.
 *
 * Header (big-endian, as everything on a PowerPC console is):
 *
 *   0x00 u32 dataSize          — payload bytes following the header
 *   0x04 u32 sampleCount       — per channel
 *   0x08 u16 sampleRate        — 32000 or 44100 in retail data
 *   0x0A u16 bitsPerSample     — 4
 *   0x0C u16 samplesPerBlock   — 16
 *   0x0E u16 unknown           — 30, or 60 on a handful of files
 *   0x10 u32[4] unknown/zero   — one field tracks a loop point
 *   0x20     block data
 *
 * ## Why the channel count is derived rather than read
 *
 * Nothing in the header states how many channels there are. Every retail file
 * is stereo, and the obvious candidate field at 0x0A is 4 — which is the *bit
 * depth*, not a channel count, as the constant 16 at 0x0C (the AFC block size
 * in samples) makes clear.
 *
 * Rather than hardcode 2, we recover it from arithmetic that the format cannot
 * lie about: the payload has to be exactly one block per channel per group of
 * 16 samples, so
 *
 *   channels = dataSize / (ceil(sampleCount / 16) * blockSize)
 *
 * must come out a small whole number. This doubles as the header's integrity
 * check — on all 76 streams in Wind Waker it yields exactly 2 with zero
 * remainder, and on a non-AFC file it yields nonsense and the parse is
 * rejected. A header with no magic has to earn trust some other way.
 *
 * ## Channel interleaving
 *
 * Blocks are interleaved per channel, not stored as separate planes: one block
 * of left, one block of right, repeating. So channel `c`'s block `b` lives at
 * `dataOffset + (b * channels + c) * blockSize`. Each channel carries its own
 * independent ADPCM history, which is why {@link decodeAfcStream} keeps one
 * {@link AfcState} per channel rather than one for the file.
 */

import {
	AFC_SAMPLES_PER_BLOCK,
	AfcVariant,
	decodeAfcBlock,
	isAfcVariant,
	newAfcState,
	type AfcVariantValue,
} from './afc.js';

/** Size of the `.afc` header. */
export const AFC_STREAM_HEADER_SIZE = 0x20;

/** Largest channel count we will believe from the size arithmetic. */
const MAX_CHANNELS = 8;

/** Sample rates we consider plausible when validating a headerless file. */
const MIN_SAMPLE_RATE = 4000;
const MAX_SAMPLE_RATE = 96000;

export interface AfcStreamHeader {
	/** Payload bytes after the header. */
	dataSize: number;
	/** Samples per channel. */
	sampleCount: number;
	sampleRate: number;
	/** Bits per encoded sample: 4 (or 2 for the low-quality variant). */
	bitsPerSample: number;
	/** Samples per block; 16 for every AFC stream. */
	samplesPerBlock: number;
	/** Meaning unknown; 30 on most files, 60 on a few. Preserved for round-tripping. */
	unknown0e: number;
	/** Derived from the payload size; see the note in the module comment. */
	channelCount: number;
	/** Block size in bytes, i.e. the {@link AfcVariant}. */
	variant: AfcVariantValue;
	/** Absolute offset of the block data. */
	dataOffset: number;
	/** Duration in seconds, for convenience. */
	durationSeconds: number;
}

export interface DecodedAfcStream {
	sampleRate: number;
	channelCount: number;
	/** Samples per channel. */
	sampleCount: number;
	/**
	 * Interleaved signed 16-bit PCM, `sampleCount * channelCount` long —
	 * the layout `encodeWav` and the Web Audio API both expect.
	 */
	samples: Int16Array;
}

/**
 * Work out the channel count and block size implied by a header's own numbers.
 *
 * Returns `null` when no combination divides evenly, which is the strongest
 * signal available that this isn't an AFC stream.
 */
function deriveLayout(
	dataSize: number,
	sampleCount: number,
	bitsPerSample: number,
): { channelCount: number; variant: AfcVariantValue } | null {
	if (dataSize <= 0 || sampleCount <= 0) return null;
	const blocks = Math.ceil(sampleCount / AFC_SAMPLES_PER_BLOCK);
	if (blocks <= 0) return null;

	// Trust the declared bit depth if it names a variant we know, but fall back
	// to trying both — a couple of tools write 0 here.
	const candidates: AfcVariantValue[] =
		bitsPerSample === 2
			? [AfcVariant.LQ_2BIT, AfcVariant.HQ_4BIT]
			: [AfcVariant.HQ_4BIT, AfcVariant.LQ_2BIT];

	for (const variant of candidates) {
		const perChannel = blocks * variant;
		if (perChannel <= 0) continue;
		if (dataSize % perChannel !== 0) continue;
		const channelCount = dataSize / perChannel;
		if (channelCount >= 1 && channelCount <= MAX_CHANNELS) {
			return { channelCount, variant };
		}
	}
	return null;
}

/**
 * Parse an `.afc` header, deriving the channel count and block size.
 *
 * Returns `null` if the header is not self-consistent. We deliberately do *not*
 * require the payload to be fully present: streams are frequently padded or
 * truncated on disc, and a short read should still tell you what the file is.
 */
export function parseAfcStreamHeader(
	bytes: Uint8Array,
	offset = 0,
): AfcStreamHeader | null {
	if (offset < 0 || offset + AFC_STREAM_HEADER_SIZE > bytes.length) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	const dataSize = view.getUint32(offset + 0x00, false);
	const sampleCount = view.getUint32(offset + 0x04, false);
	const sampleRate = view.getUint16(offset + 0x08, false);
	const bitsPerSample = view.getUint16(offset + 0x0a, false);
	const samplesPerBlock = view.getUint16(offset + 0x0c, false);
	const unknown0e = view.getUint16(offset + 0x0e, false);

	if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) return null;
	// AFC is defined in terms of 16-sample blocks; anything else isn't AFC.
	if (samplesPerBlock !== AFC_SAMPLES_PER_BLOCK) return null;
	if (bitsPerSample !== 2 && bitsPerSample !== 4 && bitsPerSample !== 0) return null;

	const layout = deriveLayout(dataSize, sampleCount, bitsPerSample);
	if (!layout) return null;
	if (!isAfcVariant(layout.variant)) return null;

	return {
		dataSize,
		sampleCount,
		sampleRate,
		bitsPerSample,
		samplesPerBlock,
		unknown0e,
		channelCount: layout.channelCount,
		variant: layout.variant,
		dataOffset: offset + AFC_STREAM_HEADER_SIZE,
		durationSeconds: sampleCount / sampleRate,
	};
}

/**
 * Heuristic check for an `.afc`. Since the format has no magic, this is just
 * "does {@link parseAfcStreamHeader} accept it" — the size arithmetic is doing
 * all the work.
 */
export function isAfcStream(bytes: Uint8Array, offset = 0): boolean {
	return parseAfcStreamHeader(bytes, offset) !== null;
}

/**
 * Decode a whole `.afc` to interleaved PCM16.
 *
 * Blocks are walked in stored order so that each channel's ADPCM history
 * advances in step, and samples are written straight to their interleaved
 * position — that avoids materialising a per-channel plane and then a second
 * interleaved copy, which for a 7 MB stream is a meaningful saving.
 *
 * A truncated payload yields a correspondingly short result rather than an
 * error, so a partially-extracted stream still plays.
 */
export function decodeAfcStream(
	bytes: Uint8Array,
	offset = 0,
): DecodedAfcStream | null {
	const header = parseAfcStreamHeader(bytes, offset);
	if (!header) return null;

	const { channelCount, variant, dataOffset, sampleRate } = header;
	const available = Math.max(0, bytes.length - dataOffset);
	const usable = Math.min(header.dataSize, available);
	// Only whole interleaved groups (one block per channel) are decodable.
	const groupBytes = variant * channelCount;
	const blocksPerChannel = Math.floor(usable / groupBytes);
	const producible = blocksPerChannel * AFC_SAMPLES_PER_BLOCK;
	const sampleCount = Math.min(header.sampleCount, producible);
	if (sampleCount <= 0) {
		return { sampleRate, channelCount, sampleCount: 0, samples: new Int16Array(0) };
	}

	const samples = new Int16Array(sampleCount * channelCount);
	const states = Array.from({ length: channelCount }, () => newAfcState());
	// One block's worth of scratch, reused for every block of every channel.
	const scratch = new Int16Array(AFC_SAMPLES_PER_BLOCK);

	for (let b = 0; b < blocksPerChannel; b++) {
		const firstSample = b * AFC_SAMPLES_PER_BLOCK;
		if (firstSample >= sampleCount) break;
		// The final block is usually partial once the declared length is honoured.
		const take = Math.min(AFC_SAMPLES_PER_BLOCK, sampleCount - firstSample);
		for (let c = 0; c < channelCount; c++) {
			const at = dataOffset + (b * channelCount + c) * variant;
			if (decodeAfcBlock(bytes, at, variant, states[c], scratch, 0) === 0) {
				return {
					sampleRate,
					channelCount,
					sampleCount: firstSample,
					samples: samples.subarray(0, firstSample * channelCount),
				};
			}
			let out = firstSample * channelCount + c;
			for (let i = 0; i < take; i++) {
				samples[out] = scratch[i];
				out += channelCount;
			}
		}
	}

	return { sampleRate, channelCount, sampleCount, samples };
}
