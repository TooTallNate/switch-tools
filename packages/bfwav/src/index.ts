/**
 * BFWAV — single-shot Nintendo audio file (`FWAV` magic).
 *
 * BFWAV is the "baked" companion to BFSTM: where streams are
 * block-interleaved for low-overhead playback, BFWAV stores each
 * channel's samples contiguously, ready to drop into a sample
 * memory pool. It's the format BARS archives embed for sound
 * effects, and the format BFWARs bundle by the dozen.
 *
 * The Switch endian and version space ("FWAV" with BOM `0xFFFE`,
 * version `0x0001MMmm` typically) is the only one this parser
 * handles in detail; Wii U BE-mode files would parse fine if needed
 * but are untested here.
 *
 * Wire layout (offsets relative to file start):
 *
 *   ┌──────────────────────────────┐
 *   │ FWAV header           (0x40) │  magic, BOM, version, file_size,
 *   │                              │  num_blocks, block table
 *   ├──────────────────────────────┤
 *   │ INFO block (typeId 0x7000)   │  codec, sample_rate, loop range,
 *   │                              │  channel ref-table → per-channel
 *   │                              │  info → DSP-ADPCM coef offsets
 *   ├──────────────────────────────┤
 *   │ DATA block (typeId 0x7001)   │  per-channel sample bytes
 *   └──────────────────────────────┘
 *
 * Each channel's sample data starts at
 * `data_offset + 0x08 + sample_data_offset[ch]`. For DSP-ADPCM the
 * per-channel byte length is `ceil(num_samples/14) * 8`; for PCM16
 * it's `num_samples * 2`; for PCM8, `num_samples`.
 *
 * References:
 *   - https://github.com/vgmstream/vgmstream/blob/master/src/meta/bfwav.c
 *   - https://github.com/Thealexbarney/VGAudio/blob/master/src/VGAudio/Containers/NintendoWare/BCFstmReader.cs
 */

import {
	makeDspState,
	decodeChannel,
	dspBytesForSamples,
} from '@tootallnate/dsp-adpcm';

/** ASCII "FWAV" — file magic at offset 0. */
export const BFWAV_MAGIC = 'FWAV';

/** Codec values found in a BFWAV INFO header at offset 0x08. */
export enum BfwavCodec {
	Pcm8 = 0,
	Pcm16 = 1,
	DspAdpcm = 2,
	ImaAdpcm = 3,
}

export type Endian = 'big' | 'little';

/**
 * Parsed view of a BFWAV's header + INFO block + per-channel
 * metadata. The DATA block is left as a lazy `Blob` slice; call
 * {@link decodeBfwavToPcm16} (or unpack the channels yourself
 * using `channels[i].sampleDataOffset`) to actually decode the
 * audio samples.
 */
export interface ParsedBfwav {
	endian: Endian;
	version: number;
	fileSize: number;
	codec: BfwavCodec;
	codecName: string;
	loopFlag: boolean;
	sampleRate: number;
	loopStart: number;
	/** Total decoded sample count (also doubles as `loop_end` when looping). */
	totalSamples: number;
	channels: BfwavChannel[];
	/** Lazy view of the file's `DATA` block (including its 8-byte header). */
	dataBlock: Blob;
	/** Absolute file offset of the `DATA` block. */
	dataOffset: number;
}

/**
 * Per-channel metadata extracted from a BFWAV's INFO block. The
 * DSP-ADPCM coefficient table is read up-front because it's only
 * 32 bytes per channel and the parser already has a `Uint8Array`
 * containing the INFO block in memory.
 */
export interface BfwavChannel {
	/**
	 * Byte offset of this channel's first sample, relative to
	 * `dataOffset + 0x08` (i.e. the start of the DATA block payload).
	 */
	sampleDataOffset: number;
	/**
	 * 16 × s16 DSP-ADPCM coefficient table, decoded into native
	 * Int16Array. `null` for non-DSP codecs.
	 */
	coefs: Int16Array | null;
	/** Initial pred/scale byte from the channel's DSP info struct, if any. */
	initialPredScale: number;
	/** Initial yn-1 history value, if any. Usually 0. */
	initialHist1: number;
	/** Initial yn-2 history value, if any. Usually 0. */
	initialHist2: number;
	/** Loop predictor/scale, if any. */
	loopPredScale: number;
	/** Loop hist1, if any. */
	loopHist1: number;
	/** Loop hist2, if any. */
	loopHist2: number;
}

/** Cheap (4-byte) magic check. */
export async function isBfwav(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x46 /* F */ &&
		head[1] === 0x57 /* W */ &&
		head[2] === 0x41 /* A */ &&
		head[3] === 0x56 /* V */
	);
}

/**
 * Parse a BFWAV's header, INFO block, and per-channel metadata.
 * Reads roughly the first ~1 KB of the file (header + INFO) and
 * leaves the DATA block as a lazy `Blob` slice — you can decode
 * audio at any time by calling {@link decodeBfwavToPcm16}.
 */
export async function parseBfwav(blob: Blob): Promise<ParsedBfwav> {
	if (blob.size < 0x40) {
		throw new Error(
			`Blob too small to be a BFWAV (${blob.size} bytes, need at least 0x40)`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, 0x40).arrayBuffer());
	if (
		head[0] !== 0x46 ||
		head[1] !== 0x57 ||
		head[2] !== 0x41 ||
		head[3] !== 0x56
	) {
		throw new Error('Bad BFWAV magic');
	}
	const bomBE = head[4] === 0xfe && head[5] === 0xff;
	const bomLE = head[4] === 0xff && head[5] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid BFWAV byte-order mark: 0x${head[4].toString(16)}${head[5].toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;
	const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const version = v.getUint32(8, isLittle);
	const fileSize = v.getUint32(0x0c, isLittle);
	const numBlocks = v.getUint16(0x10, isLittle);
	if (numBlocks < 2 || numBlocks > 8) {
		throw new Error(`Implausible BFWAV block count: ${numBlocks}`);
	}

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
		if (id === 0x7000) {
			infoOffset = off;
			infoSize = size;
		} else if (id === 0x7001) {
			dataOffset = off;
			dataSize = size;
		}
	}
	if (!infoOffset || !infoSize || !dataOffset || !dataSize) {
		throw new Error('BFWAV missing INFO or DATA block');
	}
	if (infoOffset + infoSize > blob.size) {
		throw new Error('BFWAV INFO block runs past end of blob');
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
		throw new Error('Bad BFWAV INFO magic');
	}
	const codec = iv.getUint8(0x08) as BfwavCodec;
	const loopFlag = iv.getUint8(0x09) !== 0;
	const sampleRate = iv.getUint32(0x0c, isLittle);
	const loopStart = iv.getUint32(0x10, isLittle);
	const totalSamples = iv.getUint32(0x14, isLittle);

	// Channel reference table at INFO+0x1C.
	const chTableOff = 0x1c;
	const channelCount = iv.getUint32(chTableOff, isLittle);
	if (channelCount > 16) {
		throw new Error(`Implausible BFWAV channel count: ${channelCount}`);
	}

	const channels: BfwavChannel[] = new Array(channelCount);
	for (let c = 0; c < channelCount; c++) {
		// Each ref entry: u16 typeId (=0x7100), u16 pad, s32 offset
		// (relative to chTableOff = INFO+0x1C, the start of the
		// reference-table count word).
		const refOff = chTableOff + 0x04 + c * 0x08;
		const chInfoRel = iv.getInt32(refOff + 4, isLittle);
		const chInfoOff = chTableOff + chInfoRel;

		// Channel info block:
		//   0x00 u16  typeId 0x1F00 (sample-data ref)
		//   0x04 s32  sample_data_offset (rel to data_offset+0x08)
		//   0x08 u16  typeId 0x0300 (DSP info ref) or 0x0301 (IMA), or 0
		//   0x0C s32  adpcm_info_offset (rel to chInfoOff itself)
		const sampleDataOff = iv.getInt32(chInfoOff + 0x04, isLittle);
		const adpcmRefId = iv.getUint16(chInfoOff + 0x08, isLittle);
		const adpcmRel = iv.getInt32(chInfoOff + 0x0c, isLittle);

		let coefs: Int16Array | null = null;
		let initialPredScale = 0;
		let initialHist1 = 0;
		let initialHist2 = 0;
		let loopPredScale = 0;
		let loopHist1 = 0;
		let loopHist2 = 0;
		if (
			adpcmRefId === 0x0300 &&
			adpcmRel !== -1 &&
			codec === BfwavCodec.DspAdpcm
		) {
			const adpcmOff = chInfoOff + adpcmRel;
			if (adpcmOff + 0x2e > infoBytes.byteLength) {
				throw new Error(
					`BFWAV channel ${c} DSP-ADPCM info struct out of range`,
				);
			}
			coefs = new Int16Array(16);
			for (let k = 0; k < 16; k++) {
				coefs[k] = iv.getInt16(adpcmOff + k * 2, isLittle);
			}
			initialPredScale = iv.getUint16(adpcmOff + 0x20, isLittle);
			initialHist1 = iv.getInt16(adpcmOff + 0x22, isLittle);
			initialHist2 = iv.getInt16(adpcmOff + 0x24, isLittle);
			loopPredScale = iv.getUint16(adpcmOff + 0x26, isLittle);
			loopHist1 = iv.getInt16(adpcmOff + 0x28, isLittle);
			loopHist2 = iv.getInt16(adpcmOff + 0x2a, isLittle);
		}

		channels[c] = {
			sampleDataOffset: sampleDataOff,
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
		endian,
		version,
		fileSize,
		codec,
		codecName: codecName(codec),
		loopFlag,
		sampleRate,
		loopStart,
		totalSamples,
		channels,
		dataOffset,
		dataBlock: blob.slice(dataOffset, dataOffset + dataSize),
	};
}

/**
 * Decode every channel of a parsed BFWAV into a single
 * frame-interleaved `Int16Array` ready for {@link encodeWav}. For
 * unsupported codecs (e.g. IMA-ADPCM, which Switch BFWAVs almost
 * never use), throws — callers should check {@link ParsedBfwav#codec}
 * first if they want to surface a graceful "can't play this file"
 * UX.
 *
 * Reads the entire DATA block into memory. That's fine for the
 * single-shot effects BFWAV is used for — typical sizes are a few
 * dozen KB and the largest BARS-embedded FWAV in BotW is ~600 KB.
 */
export async function decodeBfwavToPcm16(
	parsed: ParsedBfwav,
): Promise<{ samples: Int16Array; numChannels: number; sampleRate: number }> {
	const dataBytes = new Uint8Array(await parsed.dataBlock.arrayBuffer());
	if (
		dataBytes[0] !== 0x44 ||
		dataBytes[1] !== 0x41 ||
		dataBytes[2] !== 0x54 ||
		dataBytes[3] !== 0x41
	) {
		throw new Error('Bad BFWAV DATA magic');
	}
	// Sample-data offsets in the per-channel info are relative to
	// `data_offset + 0x08`, i.e. the first byte after the 8-byte
	// DATA chunk header.
	const payload = dataBytes.subarray(0x08);
	const numChannels = parsed.channels.length;
	const numSamples = parsed.totalSamples;
	const isLittle = parsed.endian === 'little';

	const perChannelPcm: Int16Array[] = new Array(numChannels);
	switch (parsed.codec) {
		case BfwavCodec.DspAdpcm: {
			for (let c = 0; c < numChannels; c++) {
				const ch = parsed.channels[c];
				if (!ch.coefs) {
					throw new Error(`Channel ${c} missing DSP-ADPCM coefs`);
				}
				const startByte = ch.sampleDataOffset;
				const byteCount = dspBytesForSamples(numSamples);
				const slice = payload.subarray(startByte, startByte + byteCount);
				// Assemble the channel's coef blob in-endian for the shared decoder.
				const coefBytes = new Uint8Array(32);
				const coefView = new DataView(coefBytes.buffer);
				for (let k = 0; k < 16; k++) {
					coefView.setInt16(k * 2, ch.coefs[k], isLittle);
				}
				const state = makeDspState(coefBytes, {
					littleEndian: isLittle,
					hist1: ch.initialHist1,
					hist2: ch.initialHist2,
				});
				perChannelPcm[c] = decodeChannel(slice, numSamples, state);
			}
			break;
		}
		case BfwavCodec.Pcm16: {
			for (let c = 0; c < numChannels; c++) {
				const ch = parsed.channels[c];
				const startByte = ch.sampleDataOffset;
				const out = new Int16Array(numSamples);
				const sampleView = new DataView(
					payload.buffer,
					payload.byteOffset + startByte,
					numSamples * 2,
				);
				for (let i = 0; i < numSamples; i++) {
					out[i] = sampleView.getInt16(i * 2, isLittle);
				}
				perChannelPcm[c] = out;
			}
			break;
		}
		case BfwavCodec.Pcm8: {
			for (let c = 0; c < numChannels; c++) {
				const ch = parsed.channels[c];
				const startByte = ch.sampleDataOffset;
				const out = new Int16Array(numSamples);
				for (let i = 0; i < numSamples; i++) {
					// Switch BFWAVs use signed 8-bit PCM; sign-extend to s16
					// by left-shifting (matches what `<audio>` / WAV expects
					// in s16 form).
					const b = payload[startByte + i];
					const signed = b < 0x80 ? b : b - 0x100;
					out[i] = signed << 8;
				}
				perChannelPcm[c] = out;
			}
			break;
		}
		default:
			throw new Error(
				`Unsupported BFWAV codec: ${parsed.codec} (${codecName(parsed.codec)})`,
			);
	}

	// Interleave for WAV output.
	let samples: Int16Array;
	if (numChannels === 1) {
		samples = perChannelPcm[0];
	} else {
		samples = new Int16Array(numSamples * numChannels);
		for (let i = 0; i < numSamples; i++) {
			for (let c = 0; c < numChannels; c++) {
				samples[i * numChannels + c] = perChannelPcm[c][i];
			}
		}
	}
	return { samples, numChannels, sampleRate: parsed.sampleRate };
}

function codecName(codec: number): string {
	switch (codec) {
		case BfwavCodec.Pcm8:
			return 'PCM8';
		case BfwavCodec.Pcm16:
			return 'PCM16';
		case BfwavCodec.DspAdpcm:
			return 'DSP-ADPCM';
		case BfwavCodec.ImaAdpcm:
			return 'IMA-ADPCM';
		default:
			return `Unknown(${codec})`;
	}
}
