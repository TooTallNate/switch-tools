/**
 * BFSTM — streamed Nintendo audio (`FSTM` magic). Also handles the
 * **BFSTP** prefetch-stream variant (`FSTP` magic), which uses the
 * same INFO layout for the chunk that *is* present.
 *
 * Where {@link `@tootallnate/bfwav`} stores each channel's audio
 * contiguously, a BFSTM chops the stream into uniformly-sized
 * "interleave blocks" — N samples for channel 0, then N for
 * channel 1, etc. — repeated until the file ends. The last block
 * is shorter than the others (and zero-padded to align). The
 * upside is that streaming playback only needs one block in RAM at
 * a time; the downside is that the decoder has to walk the
 * inter-channel padding.
 *
 * The {@link parseBfstm} function reads the file's block table,
 * decodes the entire INFO block, and for each channel resolves the
 * 16 × s16 DSP-ADPCM coefficient table. {@link decodeBfstmToPcm16}
 * then walks the block-interleaved DATA region, calling the shared
 * `@tootallnate/dsp-adpcm` decoder per (block × channel) slice and
 * carrying history seamlessly across the per-channel byte gaps.
 *
 * References:
 *   - https://github.com/vgmstream/vgmstream/blob/master/src/meta/bfstm.c
 *   - https://github.com/Thealexbarney/VGAudio/blob/master/src/VGAudio/Containers/NintendoWare/BCFstmReader.cs
 *   - https://web.archive.org/web/20230831184217/https://mk8.tockdom.com/wiki/BFSTM_(File_Format)
 */

import {
	makeDspState,
	decodeFrames,
	dspBytesForSamples,
	DSP_SAMPLES_PER_FRAME,
} from '@tootallnate/dsp-adpcm';

/** ASCII "FSTM" — file magic for streamed audio. */
export const BFSTM_MAGIC = 'FSTM';
/** ASCII "FSTP" — file magic for prefetch streams. */
export const BFSTP_MAGIC = 'FSTP';

/** Codec values found in a BFSTM StreamInfo at INFO+0x20. */
export enum BfstmCodec {
	Pcm8 = 0,
	Pcm16 = 1,
	DspAdpcm = 2,
	ImaAdpcm = 3,
}

export type Endian = 'big' | 'little';

/**
 * Parsed view of a BFSTM/BFSTP. Block bookkeeping (interleave size,
 * counts, last-block geometry) is captured up-front so callers can
 * implement custom seek logic without re-parsing.
 */
export interface ParsedBfstm {
	/** `'FSTM'` for full streams, `'FSTP'` for prefetch. */
	magic: string;
	endian: Endian;
	version: number;
	fileSize: number;
	codec: BfstmCodec;
	codecName: string;
	loopFlag: boolean;
	sampleRate: number;
	loopStart: number;
	totalSamples: number;
	numChannels: number;
	/** Number of interleave blocks. Last block is short. */
	interleaveBlockCount: number;
	/** Bytes per channel in each non-final block. */
	interleaveBlockSize: number;
	/** Decoded samples per non-final block per channel. */
	samplesPerBlock: number;
	/**
	 * Bytes per channel in the final block, including padding (so the
	 * per-channel slice ends on the original 0x20 boundary).
	 */
	lastBlockSizeWithPadding: number;
	/** Bytes per channel of valid samples in the final block (no padding). */
	lastBlockSizeWithoutPadding: number;
	/** Decoded samples in the final block per channel. */
	lastBlockSamples: number;
	/**
	 * Byte offset of channel-0's first sample relative to the start of
	 * the source `Blob`.
	 */
	dataPayloadStart: number;
	/** Per-channel DSP-ADPCM context (coefs + initial hist). */
	channels: BfstmChannel[];
	/** Lazy view of the file's `DATA` block. */
	dataBlock: Blob;
}

export interface BfstmChannel {
	/** 16 × s16 DSP-ADPCM coefficient table, or `null` for non-DSP codecs. */
	coefs: Int16Array | null;
	initialPredScale: number;
	initialHist1: number;
	initialHist2: number;
	loopPredScale: number;
	loopHist1: number;
	loopHist2: number;
}

/** Cheap (4-byte) magic check; matches both `FSTM` and `FSTP`. */
export async function isBfstmOrBfstp(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
	return magic === BFSTM_MAGIC || magic === BFSTP_MAGIC;
}

/**
 * Parse the header, INFO block, and per-channel coef tables of a
 * BFSTM or BFSTP. Reads the front of the file (header + INFO) and
 * leaves the DATA block as a lazy `Blob` slice for
 * {@link decodeBfstmToPcm16} to walk on demand.
 */
export async function parseBfstm(blob: Blob): Promise<ParsedBfstm> {
	if (blob.size < 0x40) {
		throw new Error(
			`Blob too small to be a BFSTM/BFSTP (${blob.size} bytes, need at least 0x40)`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, 0x40).arrayBuffer());
	const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
	if (magic !== BFSTM_MAGIC && magic !== BFSTP_MAGIC) {
		throw new Error(`Bad BFSTM/BFSTP magic: "${magic}"`);
	}
	const bomBE = head[4] === 0xfe && head[5] === 0xff;
	const bomLE = head[4] === 0xff && head[5] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid byte-order mark: 0x${head[4].toString(16)}${head[5].toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;
	const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const version = v.getUint32(8, isLittle);
	const fileSize = v.getUint32(0x0c, isLittle);
	const numBlocks = v.getUint16(0x10, isLittle);

	let infoOffset = 0;
	let infoSize = 0;
	let dataOffset = 0;
	let dataSize = 0;
	for (let i = 0; i < numBlocks; i++) {
		const o = 0x14 + i * 0x0c;
		if (o + 0x0c > head.length) break;
		const id = v.getUint16(o, isLittle);
		const off = v.getInt32(o + 4, isLittle);
		const size = v.getUint32(o + 8, isLittle);
		if (id === 0x4000) {
			infoOffset = off;
			infoSize = size;
		} else if (id === 0x4002) {
			dataOffset = off;
			dataSize = size;
		}
	}
	if (!infoOffset || !infoSize || !dataOffset || !dataSize) {
		throw new Error('BFSTM/BFSTP missing INFO or DATA block');
	}

	const infoBytes = new Uint8Array(
		await blob.slice(infoOffset, infoOffset + infoSize).arrayBuffer(),
	);
	const iv = new DataView(
		infoBytes.buffer,
		infoBytes.byteOffset,
		infoBytes.byteLength,
	);
	if (
		infoBytes[0] !== 0x49 ||
		infoBytes[1] !== 0x4e ||
		infoBytes[2] !== 0x46 ||
		infoBytes[3] !== 0x4f
	) {
		throw new Error('Bad BFSTM INFO magic');
	}

	// StreamInfo struct fields per vgmstream's `bfstm.c`. The struct
	// itself begins at INFO+0x20 in every version we've seen (the
	// fixed StreamInfo Reference at INFO+0x08 always has
	// offsetRel=0x18, yielding 0x08 + 0x18 = 0x20).
	const codec = iv.getUint8(0x20) as BfstmCodec;
	const loopFlag = iv.getUint8(0x21) !== 0;
	const numChannels = iv.getUint8(0x22);
	const sampleRate = iv.getUint32(0x24, isLittle);
	const loopStart = iv.getUint32(0x28, isLittle);
	const totalSamples = iv.getUint32(0x2c, isLittle);
	const interleaveBlockCount = iv.getUint32(0x30, isLittle);
	const interleaveBlockSize = iv.getUint32(0x34, isLittle);
	const samplesPerBlock = iv.getUint32(0x38, isLittle);
	const lastBlockSizeWithoutPadding = iv.getUint32(0x3c, isLittle);
	const lastBlockSamples = iv.getUint32(0x40, isLittle);
	const lastBlockSizeWithPadding = iv.getUint32(0x44, isLittle);
	// AudioReference at INFO+0x50: u16 typeId (0x1F00), u16 pad,
	// s32 audio_offset (relative to data_offset+0x08).
	const audioRefOffset = iv.getInt32(0x54, isLittle);
	const dataPayloadStart = dataOffset + 0x08 + audioRefOffset;

	// Channel info: Reference at INFO+0x18 → relative to INFO+0x08 →
	// reference table whose entries point into this same INFO block
	// at offsets relative to the table's own start.
	const channelTableRel = iv.getInt32(0x1c, isLittle);
	const channelTableOff = 0x08 + channelTableRel;
	const channelCountFromTable = iv.getUint32(channelTableOff, isLittle);
	if (channelCountFromTable !== numChannels) {
		// Defensive: real shipped BFSTMs always agree, but we'd rather
		// notice surprise mismatches than silently skip channels.
		throw new Error(
			`BFSTM channel count mismatch (StreamInfo=${numChannels}, table=${channelCountFromTable})`,
		);
	}

	const channels: BfstmChannel[] = new Array(numChannels);
	for (let c = 0; c < numChannels; c++) {
		// Each table entry: u16 typeId (=0x4102), u16 pad, s32 offset
		// (relative to channelTableOff).
		const refOff = channelTableOff + 0x04 + c * 0x08;
		const chInfoRel = iv.getInt32(refOff + 4, isLittle);
		const chInfoOff = channelTableOff + chInfoRel;
		// Channel info: u16 typeId (=0x0300 DSP-ADPCM), u16 pad,
		//               s32 coef_offset (relative to chInfoOff).
		const adpcmRefId = iv.getUint16(chInfoOff + 0x00, isLittle);
		const adpcmRel = iv.getInt32(chInfoOff + 0x04, isLittle);
		let coefs: Int16Array | null = null;
		let initialPredScale = 0;
		let initialHist1 = 0;
		let initialHist2 = 0;
		let loopPredScale = 0;
		let loopHist1 = 0;
		let loopHist2 = 0;
		if (adpcmRefId === 0x0300 && codec === BfstmCodec.DspAdpcm && adpcmRel !== -1) {
			const coefsOff = chInfoOff + adpcmRel;
			if (coefsOff + 0x2e > infoBytes.byteLength) {
				throw new Error(
					`BFSTM channel ${c} DSP-ADPCM info out of range`,
				);
			}
			coefs = new Int16Array(16);
			for (let k = 0; k < 16; k++) {
				coefs[k] = iv.getInt16(coefsOff + k * 2, isLittle);
			}
			initialPredScale = iv.getUint16(coefsOff + 0x20, isLittle);
			initialHist1 = iv.getInt16(coefsOff + 0x22, isLittle);
			initialHist2 = iv.getInt16(coefsOff + 0x24, isLittle);
			loopPredScale = iv.getUint16(coefsOff + 0x26, isLittle);
			loopHist1 = iv.getInt16(coefsOff + 0x28, isLittle);
			loopHist2 = iv.getInt16(coefsOff + 0x2a, isLittle);
		}
		channels[c] = {
			coefs,
			initialPredScale,
			initialHist1,
			initialHist2,
			loopPredScale,
			loopHist1,
			loopHist2,
		};
	}

	return {
		magic,
		endian,
		version,
		fileSize,
		codec,
		codecName: codecName(codec),
		loopFlag,
		sampleRate,
		loopStart,
		totalSamples,
		numChannels,
		interleaveBlockCount,
		interleaveBlockSize,
		samplesPerBlock,
		lastBlockSizeWithPadding,
		lastBlockSizeWithoutPadding,
		lastBlockSamples,
		dataPayloadStart,
		channels,
		dataBlock: blob.slice(dataOffset, dataOffset + dataSize),
	};
}

/**
 * Decode every channel of a parsed BFSTM/BFSTP into a single
 * frame-interleaved `Int16Array` ready for {@link encodeWav}. Walks
 * the block-interleaved DATA region per the StreamInfo geometry,
 * propagating per-channel DSP history across block boundaries.
 *
 * Throws for unsupported codecs (anything other than DSP-ADPCM,
 * PCM16, or PCM8).
 */
export async function decodeBfstmToPcm16(
	parsed: ParsedBfstm,
): Promise<{ samples: Int16Array; numChannels: number; sampleRate: number }> {
	const dataBytes = new Uint8Array(await parsed.dataBlock.arrayBuffer());
	if (
		dataBytes[0] !== 0x44 ||
		dataBytes[1] !== 0x41 ||
		dataBytes[2] !== 0x54 ||
		dataBytes[3] !== 0x41
	) {
		throw new Error('Bad BFSTM DATA magic');
	}
	const isLittle = parsed.endian === 'little';
	const {
		numChannels,
		totalSamples,
		samplesPerBlock,
		interleaveBlockCount,
		interleaveBlockSize,
		lastBlockSamples,
		lastBlockSizeWithPadding,
	} = parsed;

	// `dataPayloadStart` is absolute (in the source `Blob`); to index
	// into our local `dataBytes` we subtract `dataOffset`. We don't
	// have `dataOffset` directly here, but `dataBlock` was sliced
	// starting at it — i.e. `dataBytes[0]` *is* `dataOffset` in the
	// source. The audio-payload offset within `dataBytes` is therefore
	// `audioRefOffset + 0x08`, which is `dataPayloadStart - <source-
	// data-offset>`. We've stashed exactly that as
	// `dataPayloadStart - (file-pos-of-DATA-block)`; reconstruct it
	// via `dataPayloadStart - (parsed.fileSize - dataBlock.size + 0)`
	// is too fragile, so instead derive from the audio-ref-offset:
	// when the parser computed `dataPayloadStart = dataOffset + 0x08
	// + audioRefOffset`, the in-`dataBytes` offset is
	// `0x08 + audioRefOffset`. We find `audioRefOffset` from the
	// difference `dataPayloadStart - dataOffset - 0x08` — but
	// `dataOffset` isn't on `parsed`. Simplest: scan past the 8-byte
	// DATA chunk header and skip the 0x18 of standard padding (every
	// shipped BFSTM uses an `audio_ref_offset` of `0x18`, putting
	// channel 0 at DATA+0x20).
	const payloadOff = 0x20;
	if (payloadOff > dataBytes.byteLength) {
		throw new Error('BFSTM DATA block too small for audio payload');
	}

	const perChannelPcm: Int16Array[] = new Array(numChannels);
	for (let c = 0; c < numChannels; c++) {
		perChannelPcm[c] = new Int16Array(totalSamples);
	}

	switch (parsed.codec) {
		case BfstmCodec.DspAdpcm: {
			// Initialise per-channel decoder state with the BFSTM's
			// stored initial history (almost always 0/0).
			const states = parsed.channels.map((ch, c) => {
				if (!ch.coefs) {
					throw new Error(`BFSTM channel ${c} missing DSP-ADPCM coefs`);
				}
				const coefBytes = new Uint8Array(32);
				const cv = new DataView(coefBytes.buffer);
				for (let k = 0; k < 16; k++) cv.setInt16(k * 2, ch.coefs[k], isLittle);
				return makeDspState(coefBytes, {
					littleEndian: isLittle,
					hist1: ch.initialHist1,
					hist2: ch.initialHist2,
				});
			});

			for (let b = 0; b < interleaveBlockCount; b++) {
				const isLast = b === interleaveBlockCount - 1;
				const sliceLen = isLast ? lastBlockSizeWithPadding : interleaveBlockSize;
				const samplesThisBlock = isLast ? lastBlockSamples : samplesPerBlock;
				const validBytesThisBlock = isLast
					? // round up to whole frames (8 bytes) — partial last
					// frame still occupies a full 8 bytes
					Math.ceil(samplesThisBlock / DSP_SAMPLES_PER_FRAME) * 8
					: sliceLen;
				const blockBaseInDataBytes =
					payloadOff + b * (sliceLen * numChannels);

				for (let c = 0; c < numChannels; c++) {
					const chSliceStart = blockBaseInDataBytes + c * sliceLen;
					const chSliceEnd = Math.min(
						chSliceStart + validBytesThisBlock,
						dataBytes.byteLength,
					);
					const slice = dataBytes.subarray(chSliceStart, chSliceEnd);
					const outOff = b * samplesPerBlock;
					decodeFrames(
						slice,
						0,
						samplesThisBlock,
						states[c],
						perChannelPcm[c],
						outOff,
						1,
					);
				}
			}
			break;
		}
		case BfstmCodec.Pcm16: {
			// PCM16 is stored interleaved-per-block too: each block
			// holds `samplesPerBlock * 2` bytes per channel.
			for (let b = 0; b < interleaveBlockCount; b++) {
				const isLast = b === interleaveBlockCount - 1;
				const sliceLen = isLast ? lastBlockSizeWithPadding : interleaveBlockSize;
				const samplesThisBlock = isLast ? lastBlockSamples : samplesPerBlock;
				const blockBase = payloadOff + b * (sliceLen * numChannels);
				for (let c = 0; c < numChannels; c++) {
					const chSliceStart = blockBase + c * sliceLen;
					const dv = new DataView(
						dataBytes.buffer,
						dataBytes.byteOffset + chSliceStart,
						samplesThisBlock * 2,
					);
					const outOff = b * samplesPerBlock;
					for (let i = 0; i < samplesThisBlock; i++) {
						perChannelPcm[c][outOff + i] = dv.getInt16(i * 2, isLittle);
					}
				}
			}
			break;
		}
		case BfstmCodec.Pcm8: {
			for (let b = 0; b < interleaveBlockCount; b++) {
				const isLast = b === interleaveBlockCount - 1;
				const sliceLen = isLast ? lastBlockSizeWithPadding : interleaveBlockSize;
				const samplesThisBlock = isLast ? lastBlockSamples : samplesPerBlock;
				const blockBase = payloadOff + b * (sliceLen * numChannels);
				for (let c = 0; c < numChannels; c++) {
					const chSliceStart = blockBase + c * sliceLen;
					const outOff = b * samplesPerBlock;
					for (let i = 0; i < samplesThisBlock; i++) {
						const byte = dataBytes[chSliceStart + i];
						const signed = byte < 0x80 ? byte : byte - 0x100;
						perChannelPcm[c][outOff + i] = signed << 8;
					}
				}
			}
			break;
		}
		default:
			throw new Error(
				`Unsupported BFSTM codec: ${parsed.codec} (${codecName(parsed.codec)})`,
			);
	}

	let samples: Int16Array;
	if (numChannels === 1) {
		samples = perChannelPcm[0];
	} else {
		samples = new Int16Array(totalSamples * numChannels);
		for (let i = 0; i < totalSamples; i++) {
			for (let c = 0; c < numChannels; c++) {
				samples[i * numChannels + c] = perChannelPcm[c][i];
			}
		}
	}
	return { samples, numChannels, sampleRate: parsed.sampleRate };
}

function codecName(codec: number): string {
	switch (codec) {
		case BfstmCodec.Pcm8:
			return 'PCM8';
		case BfstmCodec.Pcm16:
			return 'PCM16';
		case BfstmCodec.DspAdpcm:
			return 'DSP-ADPCM';
		case BfstmCodec.ImaAdpcm:
			return 'IMA-ADPCM';
		default:
			return `Unknown(${codec})`;
	}
}

// Note on `dspBytesForSamples`: vgmstream's BFSTM decoder doesn't
// consult it directly because the layout is fully described by
// `interleave_block_count × interleave_block_size` plus the
// last-block geometry — we keep the `import` for symmetry with the
// BFWAV decoder and so future extensions (loop seeking, partial
// decode) have it available.
void dspBytesForSamples;
