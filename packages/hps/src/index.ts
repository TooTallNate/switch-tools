/**
 * HPS streamed audio.
 *
 * HPS is HAL Laboratory's music container — the format behind every track in
 * *Super Smash Bros. Melee*, and also used by *Kirby Air Ride*. Like most
 * GameCube audio it carries DSP-ADPCM, so the codec work is already done by
 * `@tootallnate/dsp-adpcm`; what HPS contributes is a block-streaming layout
 * built for playing long music off a disc without buffering it.
 *
 * Everything is big-endian.
 *
 * ## Header
 *
 *   0x00 char[8]  magic — `" HALPST\0"`. Note the **leading space**: the magic
 *                 is eight bytes and starts with 0x20, which is easy to miss and
 *                 makes a naive `startsWith('HALPST')` check fail.
 *   0x08 u32      sampleRate
 *   0x0C u32      channelCount
 *   0x10 ...      one 0x38-byte channel descriptor per channel
 *
 * Channel descriptor:
 *
 *   +0x00 u32     largest block size, in bytes
 *   +0x04 u32     format — 2 for DSP-ADPCM
 *   +0x08 u32     nibble count
 *   +0x0C u32     unknown, always 2 in retail data
 *   +0x10 s16[16] DSP-ADPCM coefficients
 *   +0x30 u32     initial predictor/scale
 *   +0x34 u32     initial history
 *
 * ## Blocks
 *
 * Audio follows the header as a linked list of blocks:
 *
 *   +0x00 u32     blockSize — payload bytes, summed across all channels
 *   +0x04 u32     nibble count for this block, minus one
 *   +0x08 u32     nextOffset — absolute file offset of the following block
 *   +0x0C ...     eight bytes per channel: u16 ps, s16 yn1, s16 yn2, u16 padding
 *   then padding to a 32-byte boundary, then the payload
 *
 * Two details matter for getting this right.
 *
 * **Looping is expressed by the chain, not by a flag.** The final block's
 * `nextOffset` points *backwards* — usually at the second block — rather than
 * holding a terminator. So a decoder that simply follows `nextOffset` never
 * stops. {@link parseHps} walks until it revisits a block it has already seen and
 * reports where the loop points, which is also how the loop start is recovered.
 * A non-looping track uses `0xFFFFFFFF` instead.
 *
 * **Channels are stored as contiguous halves, not interleaved frames.** Within a
 * block, all of channel 0's ADPCM comes first, then all of channel 1's. This is
 * worth stating because the alternative — 8-byte frames alternating between
 * channels, as several other GameCube formats use — also decodes to
 * plausible-sounding audio, so it isn't obvious from listening that it's wrong.
 * The layout was confirmed deterministically instead: each block header stores
 * every channel's initial predictor/scale byte, which must equal the first byte
 * of that channel's first frame. Across six retail tracks the contiguous reading
 * matched on 100% of channels while the interleaved reading matched about half —
 * exactly the rate chance predicts, since channel 0 sits at the same place under
 * both.
 *
 * Each block also restates every channel's `yn1`/`yn2`, so blocks are
 * independently decodable and seeking is cheap. That is the entire point of the
 * format.
 */

import {
	decodeFrames,
	interleavePcm16,
	makeDspState,
	type DspChannelState,
} from '@tootallnate/dsp-adpcm';

/** Magic bytes. Note the leading space. */
export const HPS_MAGIC = ' HALPST\0';

/** Size of one channel descriptor. */
export const HPS_CHANNEL_INFO_SIZE = 0x38;

/** Offset of the first channel descriptor. */
export const HPS_CHANNEL_INFO_OFFSET = 0x10;

/** DSP-ADPCM coefficients per channel. */
export const HPS_COEFFICIENTS_PER_CHANNEL = 16;

/** Block headers are padded up to this boundary before the payload. */
export const HPS_BLOCK_ALIGNMENT = 32;

/** `nextOffset` value used by a track that does not loop. */
export const HPS_NO_NEXT_BLOCK = 0xffffffff;

/** DSP-ADPCM packs 14 samples into each 8-byte frame. */
const DSP_SAMPLES_PER_FRAME = 14;
const DSP_FRAME_SIZE = 8;

/** Guard against a corrupt chain producing an unbounded walk. */
const MAX_BLOCKS = 1 << 20;

export interface HpsChannelInfo {
	index: number;
	/** Largest block size in bytes, from the descriptor. */
	maxBlockSize: number;
	/** Format tag; 2 means DSP-ADPCM. */
	format: number;
	nibbleCount: number;
	/** Absolute offset of this channel's 16 big-endian coefficients. */
	coefficientsOffset: number;
	coefficients: Int16Array;
	initialPs: number;
	initialHistory: number;
}

export interface HpsBlockChannelState {
	/** Predictor/scale of this channel's first frame in the block. */
	ps: number;
	/** Previous sample at the start of the block. */
	yn1: number;
	/** Sample before that. */
	yn2: number;
}

export interface HpsBlock {
	index: number;
	/** Absolute offset of the block header. */
	offset: number;
	/** Payload bytes, summed across all channels. */
	size: number;
	/** Stored nibble count, minus one. */
	nibbleCount: number;
	/** Absolute offset of the next block, or {@link HPS_NO_NEXT_BLOCK}. */
	nextOffset: number;
	/** Absolute offset of the payload. */
	dataOffset: number;
	/** Per-channel decoder state at the start of this block. */
	states: HpsBlockChannelState[];
}

export interface HpsFile {
	sampleRate: number;
	channelCount: number;
	channels: HpsChannelInfo[];
	blocks: HpsBlock[];
	/** Total decodable samples per channel across all blocks. */
	sampleCount: number;
	/** Whether the chain loops rather than terminating. */
	looped: boolean;
	/**
	 * Index into {@link blocks} that the final block loops back to, or -1 when
	 * the track does not loop.
	 */
	loopBlockIndex: number;
	/** Duration in seconds of one pass through the chain. */
	durationSeconds: number;
}

export interface DecodedHps {
	sampleRate: number;
	channelCount: number;
	/** Samples per channel. */
	sampleCount: number;
	/** Interleaved signed 16-bit PCM, ready for `encodeWav`. */
	samples: Int16Array;
}

function hasMagic(bytes: Uint8Array, offset: number): boolean {
	if (offset < 0 || offset + HPS_MAGIC.length > bytes.length) return false;
	for (let i = 0; i < HPS_MAGIC.length; i++) {
		if (bytes[offset + i] !== HPS_MAGIC.charCodeAt(i)) return false;
	}
	return true;
}

/** Cheap magic check. Safe on arbitrary bytes. */
export function isHps(bytes: Uint8Array, offset = 0): boolean {
	return hasMagic(bytes, offset);
}

/** Samples one channel's `byteLength` of DSP-ADPCM yields. */
function samplesForBytes(byteLength: number): number {
	return Math.floor(byteLength / DSP_FRAME_SIZE) * DSP_SAMPLES_PER_FRAME;
}

/**
 * Parse the header and walk the block chain.
 *
 * The walk stops on a terminator, on leaving the buffer, or on revisiting a
 * block — the last of which is the normal case, since a looping track's final
 * block points backwards. Returns `null` when the magic or geometry is wrong.
 */
export function parseHps(bytes: Uint8Array, offset = 0): HpsFile | null {
	if (!hasMagic(bytes, offset)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(o, false);

	const sampleRate = u32(offset + 0x08);
	const channelCount = u32(offset + 0x0c);
	if (sampleRate < 1000 || sampleRate > 192000) return null;
	if (channelCount < 1 || channelCount > 8) return null;

	const headerEnd =
		offset + HPS_CHANNEL_INFO_OFFSET + channelCount * HPS_CHANNEL_INFO_SIZE;
	if (headerEnd > bytes.length) return null;

	const channels: HpsChannelInfo[] = [];
	for (let c = 0; c < channelCount; c++) {
		const at = offset + HPS_CHANNEL_INFO_OFFSET + c * HPS_CHANNEL_INFO_SIZE;
		const coefficientsOffset = at + 0x10;
		const coefficients = new Int16Array(HPS_COEFFICIENTS_PER_CHANNEL);
		for (let k = 0; k < HPS_COEFFICIENTS_PER_CHANNEL; k++) {
			coefficients[k] = view.getInt16(coefficientsOffset + k * 2, false);
		}
		channels.push({
			index: c,
			maxBlockSize: u32(at + 0x00),
			format: u32(at + 0x04),
			nibbleCount: u32(at + 0x08),
			coefficientsOffset,
			coefficients,
			initialPs: u32(at + 0x30),
			initialHistory: u32(at + 0x34),
		});
	}

	// Header size per channel, rounded up to the payload's alignment.
	const blockHeaderSize =
		(0x0c + channelCount * 8 + (HPS_BLOCK_ALIGNMENT - 1)) &
		~(HPS_BLOCK_ALIGNMENT - 1);

	const blocks: HpsBlock[] = [];
	const seen = new Map<number, number>();
	let at = headerEnd;
	let looped = false;
	let loopBlockIndex = -1;

	for (let i = 0; i < MAX_BLOCKS; i++) {
		if (at === HPS_NO_NEXT_BLOCK) break;
		if (at < 0 || at + blockHeaderSize > bytes.length) break;
		const already = seen.get(at);
		if (already !== undefined) {
			// The chain came back around: this is how HPS expresses a loop.
			looped = true;
			loopBlockIndex = already;
			break;
		}
		seen.set(at, blocks.length);

		const size = u32(at + 0x00);
		const nibbleCount = u32(at + 0x04);
		const nextOffset = u32(at + 0x08);
		const dataOffset = at + blockHeaderSize;
		// A block claiming more payload than the file holds, or a size that
		// isn't divisible across the channels, means we've lost the chain.
		if (size <= 0 || size % channelCount !== 0) break;
		if (dataOffset + size > bytes.length) break;

		const states: HpsBlockChannelState[] = [];
		for (let c = 0; c < channelCount; c++) {
			const o = at + 0x0c + c * 8;
			states.push({
				ps: view.getUint16(o, false),
				yn1: view.getInt16(o + 2, false),
				yn2: view.getInt16(o + 4, false),
			});
		}

		blocks.push({
			index: blocks.length,
			offset: at,
			size,
			nibbleCount,
			nextOffset,
			dataOffset,
			states,
		});

		if (nextOffset === HPS_NO_NEXT_BLOCK) break;
		at = nextOffset;
	}

	if (blocks.length === 0) return null;

	let sampleCount = 0;
	for (const b of blocks) sampleCount += samplesForBytes(b.size / channelCount);

	return {
		sampleRate,
		channelCount,
		channels,
		blocks,
		sampleCount,
		looped,
		loopBlockIndex,
		durationSeconds: sampleCount / sampleRate,
	};
}

/**
 * Absolute offset of one channel's ADPCM within a block.
 *
 * Channels occupy contiguous halves of the payload — see the note in the module
 * comment about why this isn't the interleaving other GameCube formats use.
 */
export function hpsChannelDataOffset(
	block: HpsBlock,
	channel: number,
	channelCount: number,
): number {
	return block.dataOffset + channel * (block.size / channelCount);
}

/**
 * Decode the whole chain to interleaved PCM16.
 *
 * One pass only: a looping track is decoded from its first block through its
 * last, without following the loop back, which yields the full track exactly
 * once. Each block restates its channels' history, so decoding is per-block and
 * no state is threaded between them.
 */
export function decodeHps(bytes: Uint8Array, file: HpsFile): DecodedHps | null {
	const { channelCount, sampleRate, sampleCount } = file;
	if (sampleCount <= 0) {
		return { sampleRate, channelCount, sampleCount: 0, samples: new Int16Array(0) };
	}

	const planes: Int16Array[] = [];
	for (let c = 0; c < channelCount; c++) planes.push(new Int16Array(sampleCount));

	let written = 0;
	for (const block of file.blocks) {
		const perChannel = block.size / channelCount;
		const samples = Math.min(samplesForBytes(perChannel), sampleCount - written);
		if (samples <= 0) break;
		for (let c = 0; c < channelCount; c++) {
			const info = file.channels[c];
			// Hand over the file's own big-endian coefficient bytes; HPS is a
			// PowerPC format, so `littleEndian` is always false.
			const state: DspChannelState = makeDspState(
				bytes.subarray(
					info.coefficientsOffset,
					info.coefficientsOffset + HPS_COEFFICIENTS_PER_CHANNEL * 2,
				),
				{
					littleEndian: false,
					hist1: block.states[c].yn1,
					hist2: block.states[c].yn2,
				},
			);
			const at = hpsChannelDataOffset(block, c, channelCount);
			decodeFrames(
				bytes.subarray(at, at + perChannel),
				0,
				samples,
				state,
				planes[c],
				written,
				1,
			);
		}
		written += samples;
	}

	const trimmed =
		written === sampleCount ? planes : planes.map((p) => p.subarray(0, written));
	return {
		sampleRate,
		channelCount,
		sampleCount: written,
		samples:
			channelCount === 1 ? (trimmed[0] as Int16Array) : interleavePcm16(trimmed),
	};
}
