/**
 * AST streamed audio.
 *
 * AST (`STRM`) is Nintendo's first-party streaming music container for the
 * GameCube and Wii — Mario Kart: Double Dash!!, Super Mario Galaxy, Twilight
 * Princess. Structurally it is the simplest of the family: a fixed header
 * followed by a flat run of equally-sized `BLCK` chunks, each holding one
 * block's worth of every channel.
 *
 * Everything is big-endian.
 *
 * ## Header, 0x40 bytes
 *
 *   0x00 char[4] magic `STRM`
 *   0x04 u32     size of everything after this header
 *   0x08 u16     codec — 0 = DSP-ADPCM, 1 = PCM16
 *   0x0A u16     bit depth
 *   0x0C u16     channelCount
 *   0x0E u16     unknown, 0xFFFF in retail data
 *   0x10 u32     sampleRate
 *   0x14 u32     sampleCount, per channel
 *   0x18 u32     loopStart, in samples
 *   0x1C u32     loopEnd, in samples
 *   0x20 u32     size of the first block
 *   0x24 ...     unknown / zero
 *
 * ## Blocks
 *
 *   0x00 char[4] magic `BLCK`
 *   0x04 u32     blockSize — bytes **per channel**, not in total
 *   0x08 u8[24]  reserved
 *   0x20 ...     payload: all of channel 0, then all of channel 1, …
 *
 * Two things are easy to get wrong.
 *
 * **`blockSize` is per channel.** A block occupies `0x20 + blockSize *
 * channelCount` bytes, so treating the field as a total advances the chain at
 * half speed and desynchronises on the second block.
 *
 * **Channels are contiguous halves, not interleaved samples.** Within a block
 * every sample of channel 0 comes first, then every sample of channel 1 — the
 * same arrangement HPS uses. Reading it as interleaved L/R pairs still produces
 * audio-like output, so it isn't obvious by ear; it was settled by measuring
 * continuity across block boundaries, where the interleaved reading gives a mean
 * seam discontinuity roughly 2.7x larger.
 *
 * ## Codecs
 *
 * Only PCM16 is implemented. Every AST in the corpus this was built against
 * (all 37 in Double Dash) is codec 1, and DSP-ADPCM AST files exist but were not
 * available to validate against — so {@link decodeAst} refuses codec 0 rather
 * than emitting a plausible-sounding guess. {@link parseAst} still describes such
 * a file so a caller can report what it is.
 */

export const AST_MAGIC = 'STRM';
export const AST_BLOCK_MAGIC = 'BLCK';

/** Size of the file header. */
export const AST_HEADER_SIZE = 0x40;

/** Size of a block header, before its payload. */
export const AST_BLOCK_HEADER_SIZE = 0x20;

export const AstCodec = {
	/** DSP-ADPCM. Recognised but not decoded; see the module comment. */
	ADPCM: 0,
	/** Big-endian signed 16-bit PCM. */
	PCM16: 1,
} as const;

const MIN_RATE = 4000;
const MAX_RATE = 192000;
const MAX_CHANNELS = 8;
/** Runaway guard for the block walk. */
const MAX_BLOCKS = 1 << 20;

export interface AstBlock {
	index: number;
	/** Absolute offset of the block header. */
	offset: number;
	/** Bytes **per channel**. */
	blockSize: number;
	/** Absolute offset of the payload. */
	dataOffset: number;
}

export interface AstFile {
	codec: number;
	bitDepth: number;
	channelCount: number;
	sampleRate: number;
	/** Declared samples per channel. */
	sampleCount: number;
	loopStart: number;
	loopEnd: number;
	/** True when the loop range is a real subrange of the track. */
	looped: boolean;
	blocks: AstBlock[];
	/** Samples per channel the blocks actually supply. */
	decodableSamples: number;
	durationSeconds: number;
}

export interface DecodedAst {
	sampleRate: number;
	channelCount: number;
	/** Samples per channel. */
	sampleCount: number;
	/** Interleaved signed 16-bit PCM, ready for `encodeWav`. */
	samples: Int16Array;
}

function magicAt(bytes: Uint8Array, offset: number, magic: string): boolean {
	if (offset < 0 || offset + magic.length > bytes.length) return false;
	for (let i = 0; i < magic.length; i++) {
		if (bytes[offset + i] !== magic.charCodeAt(i)) return false;
	}
	return true;
}

/** Cheap magic check. Safe on arbitrary bytes. */
export function isAst(bytes: Uint8Array, offset = 0): boolean {
	return magicAt(bytes, offset, AST_MAGIC);
}

/** Bytes one channel of `sampleCount` PCM16 samples occupies. */
export function astPcm16Bytes(sampleCount: number): number {
	return sampleCount * 2;
}

/**
 * Parse the header and walk the block chain.
 *
 * Blocks are laid out consecutively rather than linked, so the walk simply
 * advances by each block's own size. It stops on a missing `BLCK` magic, a
 * zero size, or leaving the buffer — a truncated file yields the blocks it does
 * contain rather than failing outright.
 */
export function parseAst(bytes: Uint8Array, offset = 0): AstFile | null {
	if (!isAst(bytes, offset)) return null;
	if (offset + AST_HEADER_SIZE > bytes.length) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(offset + o, false);
	const u16 = (o: number) => view.getUint16(offset + o, false);

	const codec = u16(0x08);
	const bitDepth = u16(0x0a);
	const channelCount = u16(0x0c);
	const sampleRate = u32(0x10);
	const sampleCount = u32(0x14);
	const loopStart = u32(0x18);
	const loopEnd = u32(0x1c);

	if (channelCount < 1 || channelCount > MAX_CHANNELS) return null;
	if (sampleRate < MIN_RATE || sampleRate > MAX_RATE) return null;
	if (sampleCount === 0) return null;

	const blocks: AstBlock[] = [];
	let at = offset + AST_HEADER_SIZE;
	for (let i = 0; i < MAX_BLOCKS; i++) {
		if (at + AST_BLOCK_HEADER_SIZE > bytes.length) break;
		if (!magicAt(bytes, at, AST_BLOCK_MAGIC)) break;
		const blockSize = view.getUint32(at + 4, false);
		if (blockSize === 0) break;
		const dataOffset = at + AST_BLOCK_HEADER_SIZE;
		// `blockSize` is per channel, so the payload is that times the count.
		const payload = blockSize * channelCount;
		if (dataOffset + payload > bytes.length) break;
		blocks.push({ index: blocks.length, offset: at, blockSize, dataOffset });
		at = dataOffset + payload;
	}
	if (blocks.length === 0) return null;

	// What the blocks can actually supply, which may exceed the declared count
	// by a few samples of padding in the final block.
	let decodable = 0;
	if (codec === AstCodec.PCM16) {
		for (const b of blocks) decodable += Math.floor(b.blockSize / 2);
	}
	const usable = codec === AstCodec.PCM16 ? Math.min(sampleCount, decodable) : 0;

	return {
		codec,
		bitDepth,
		channelCount,
		sampleRate,
		sampleCount,
		loopStart,
		loopEnd,
		// A track that "loops" over its whole length isn't really looping.
		looped: loopEnd > loopStart && loopStart > 0,
		blocks,
		decodableSamples: usable,
		durationSeconds: sampleCount / sampleRate,
	};
}

/** Absolute offset of one channel's samples within a block. */
export function astChannelDataOffset(
	block: AstBlock,
	channel: number,
): number {
	return block.dataOffset + channel * block.blockSize;
}

/**
 * Decode a PCM16 AST to interleaved PCM16.
 *
 * Returns `null` for a codec other than PCM16 — see the module comment on why a
 * guess would be worse than a refusal.
 *
 * The result is capped at the declared sample count so the last block's padding
 * doesn't append a few milliseconds of noise.
 */
export function decodeAst(bytes: Uint8Array, file: AstFile): DecodedAst | null {
	if (file.codec !== AstCodec.PCM16) return null;
	const { channelCount, sampleRate } = file;
	const total = file.decodableSamples;
	if (total <= 0) {
		return { sampleRate, channelCount, sampleCount: 0, samples: new Int16Array(0) };
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = new Int16Array(total * channelCount);
	let written = 0;
	for (const block of file.blocks) {
		if (written >= total) break;
		const inBlock = Math.min(Math.floor(block.blockSize / 2), total - written);
		for (let c = 0; c < channelCount; c++) {
			const base = astChannelDataOffset(block, c);
			let out = written * channelCount + c;
			for (let i = 0; i < inBlock; i++) {
				samples[out] = view.getInt16(base + i * 2, false);
				out += channelCount;
			}
		}
		written += inBlock;
	}

	return { sampleRate, channelCount, sampleCount: written, samples };
}
