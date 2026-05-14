/**
 * Parser for Nintendo's BWAV audio container.
 *
 * BWAV is the modern (BotW 2 / Tears of the Kingdom / Mario Wonder era)
 * single-track audio file format that supersedes BFWAV in Nintendo's
 * newer titles. It supports three codecs:
 *
 *   - **0**: PCM16LE (interleaved across channels).
 *   - **1**: Nintendo DSP-ADPCM ("Switch Audio" — same encoding our
 *     `@tootallnate/dsp-adpcm` package decodes; per-channel coefficient
 *     tables live in the per-channel header).
 *   - **2**: Nintendo Switch Opus (NXOpus). Each channel is a separate
 *     sub-stream at its own offset. Stereo BWAVs interleave two NXOpus
 *     streams (one per channel) and a player would need to mux them.
 *
 * On-disk layout:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ Header (0x00 .. 0x10)                            │
 *   │   u32 'BWAV' magic                               │
 *   │   u16 0xFEFF BOM                                 │
 *   │   u16 version (0x0001)                           │
 *   │   u32 crc32                                      │
 *   │   u16 isPrefetch flag                            │
 *   │   u16 channelCount                               │
 *   ├──────────────────────────────────────────────────┤
 *   │ Channel headers (channelCount × 0x4C bytes)      │
 *   │   u16 codec        (0 / 1 / 2)                   │
 *   │   u16 channelLayout (0=L, 1=R, 2=C)              │
 *   │   u32 sampleRate                                 │
 *   │   u32 numSamplesFull                             │
 *   │   u32 numSamples                                 │
 *   │   bytes coefs[0x20] (DSP-ADPCM only; zeroed otherwise)
 *   │   u32 fullOffset    (full-file payload offset)   │
 *   │   u32 flag (always 1)                            │
 *   │   u32 payloadOffset (in this file)               │
 *   │   s32 loopEnd       (-1 = no loop)               │
 *   │   s32 loopStart                                  │
 *   │   bytes startContext[0x06] (DSP-ADPCM: pred+hist)
 *   │   u16 padding                                    │
 *   └──────────────────────────────────────────────────┘
 *
 * Reference: vgmstream's `src/meta/bwav.c` is the canonical decode
 * source. This parser is a pure-TS clean-room re-implementation of
 * the on-disk format described there; no codec data is touched here.
 */

export const BWAV_MAGIC = 0x42574156; // 'BWAV' big-endian, read as LE u32 = 0x56415742; we test bytes directly
export const BWAV_HEADER_SIZE = 0x10;
export const BWAV_CHANNEL_HEADER_SIZE = 0x4c;
export const BWAV_BOM_LE = 0xfeff;

export const BWAV_CODEC_PCM16LE = 0;
export const BWAV_CODEC_DSP_ADPCM = 1;
export const BWAV_CODEC_NX_OPUS = 2;

export interface BwavChannel {
	/** Codec id; see `BWAV_CODEC_*`. */
	codec: number;
	/** Speaker layout: 0=Left, 1=Right, 2=Center. */
	layout: number;
	/** Sample rate in Hz (same for every channel, in practice). */
	sampleRate: number;
	/** Total sample count in the original (non-prefetch) file. */
	numSamplesFull: number;
	/** Sample count present in this BWAV (= numSamplesFull when not prefetched). */
	numSamples: number;
	/**
	 * 16 signed 16-bit DSP-ADPCM coefficients (8 pairs). Meaningful
	 * only for codec 1; zeroed for other codecs.
	 */
	coefs: Int16Array;
	/** Byte offset to this channel's audio payload within the BWAV. */
	payloadOffset: number;
	/** Loop end sample (or `-1` for no loop). */
	loopEnd: number;
	/** Loop start sample (only meaningful when looped). */
	loopStart: number;
	/** DSP-ADPCM initial predictor (codec 1 only). */
	startPredictor: number;
	/** DSP-ADPCM initial hist1 (codec 1 only). */
	startHist1: number;
	/** DSP-ADPCM initial hist2 (codec 1 only). */
	startHist2: number;
}

export interface ParsedBwav {
	/** File-level header CRC-32 (informational only; not validated here). */
	crc32: number;
	/** True iff the file is a stub for streaming (only a header prefix). */
	isPrefetch: boolean;
	/** Per-channel headers in disc order. */
	channels: BwavChannel[];
}

export class BwavParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BwavParseError';
	}
}

/** True iff `bytes` starts with the `BWAV` magic. */
export function isBwavMagic(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x42 && // 'B'
		bytes[1] === 0x57 && // 'W'
		bytes[2] === 0x41 && // 'A'
		bytes[3] === 0x56    // 'V'
	);
}

/**
 * Parse a BWAV from a raw byte buffer. The returned channel records
 * point at byte offsets *within the same buffer* via `payloadOffset`;
 * the caller is responsible for slicing out the encoded audio data
 * before passing it to a codec-specific decoder.
 */
export function parseBwav(bytes: Uint8Array): ParsedBwav {
	if (!isBwavMagic(bytes)) {
		throw new BwavParseError('not a BWAV file (missing BWAV magic)');
	}
	if (bytes.length < BWAV_HEADER_SIZE) {
		throw new BwavParseError(`BWAV header truncated (${bytes.length} < ${BWAV_HEADER_SIZE})`);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const bom = dv.getUint16(0x04, true);
	if (bom !== BWAV_BOM_LE) {
		throw new BwavParseError(`Unexpected BOM 0x${bom.toString(16)} (expected 0xFEFF LE)`);
	}
	// version at 0x06 (we don't validate; only 0x0001 is known)
	const crc32 = dv.getUint32(0x08, true);
	const isPrefetch = dv.getUint16(0x0c, true) !== 0;
	const channelCount = dv.getUint16(0x0e, true);
	if (channelCount === 0) throw new BwavParseError('BWAV has 0 channels');
	if (channelCount > 32) {
		// Defensive: real-world BWAVs are 1 or 2 channels. A header that
		// claims 1000 channels is corrupt/misidentified.
		throw new BwavParseError(`BWAV channelCount=${channelCount} is implausible`);
	}
	const channelsEnd = BWAV_HEADER_SIZE + channelCount * BWAV_CHANNEL_HEADER_SIZE;
	if (bytes.length < channelsEnd) {
		throw new BwavParseError(
			`BWAV channel-header table truncated (need ${channelsEnd}, have ${bytes.length})`,
		);
	}
	const channels: BwavChannel[] = [];
	for (let i = 0; i < channelCount; i++) {
		const base = BWAV_HEADER_SIZE + i * BWAV_CHANNEL_HEADER_SIZE;
		const codec = dv.getUint16(base + 0x00, true);
		const layout = dv.getUint16(base + 0x02, true);
		const sampleRate = dv.getInt32(base + 0x04, true);
		const numSamplesFull = dv.getInt32(base + 0x08, true);
		const numSamples = dv.getInt32(base + 0x0c, true);
		const coefs = new Int16Array(16);
		for (let c = 0; c < 16; c++) coefs[c] = dv.getInt16(base + 0x10 + c * 2, true);
		// const fullOffset = dv.getUint32(base + 0x30, true); (unused; same as payload when not prefetch)
		// const flag = dv.getUint32(base + 0x38, true); (always 1)
		const payloadOffset = dv.getUint32(base + 0x34, true);
		const loopEnd = dv.getInt32(base + 0x3c, true);
		const loopStart = dv.getInt32(base + 0x40, true);
		const startPredictor = dv.getUint16(base + 0x44, true);
		const startHist1 = dv.getInt16(base + 0x46, true);
		const startHist2 = dv.getInt16(base + 0x48, true);
		channels.push({
			codec,
			layout,
			sampleRate,
			numSamplesFull,
			numSamples,
			coefs,
			payloadOffset,
			loopEnd,
			loopStart,
			startPredictor,
			startHist1,
			startHist2,
		});
	}
	return { crc32, isPrefetch, channels };
}

/**
 * For each channel, compute the (start, end) byte range of its audio
 * payload within the source BWAV. The end is inferred from the next
 * channel's start, or from the buffer length for the last channel.
 *
 * Returned ranges are suitable for `Uint8Array.subarray(start, end)`.
 */
export function bwavChannelByteRanges(
	parsed: ParsedBwav,
	totalBytes: number,
): Array<{ start: number; end: number }> {
	const sortedStarts = parsed.channels
		.map((c, i) => ({ i, off: c.payloadOffset }))
		.sort((a, b) => a.off - b.off);
	const rangesByIndex = new Array<{ start: number; end: number }>(parsed.channels.length);
	for (let k = 0; k < sortedStarts.length; k++) {
		const { i, off } = sortedStarts[k];
		const next = k + 1 < sortedStarts.length ? sortedStarts[k + 1].off : totalBytes;
		rangesByIndex[i] = { start: off, end: next };
	}
	return rangesByIndex;
}
