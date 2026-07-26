/**
 * SSM sound-sample bank.
 *
 * SSM is HAL Laboratory's sound-effect bank, the companion to the `.hps` music
 * streams in *Super Smash Bros. Melee*: one file per stage or character holding
 * every voice clip and impact sound it needs. Where HPS is a single long stream
 * split into blocks, an SSM is many short sounds packed end to end. The payload
 * is DSP-ADPCM either way, so `@tootallnate/dsp-adpcm` does the codec work.
 *
 * Everything is big-endian. There is no magic number, which is the format's one
 * real inconvenience — see {@link isSsm}.
 *
 * ## Header, 0x10 bytes
 *
 *   0x00 u32 entryTableSize — bytes of sound descriptors following this header
 *   0x04 u32 dataSize       — bytes of ADPCM payload
 *   0x08 u32 soundCount
 *   0x0C u32 baseSoundId    — id of the first sound; the game indexes globally
 *
 * The payload begins at `align32(0x10 + entryTableSize)`. That 32-byte alignment
 * is not decoration: without it the computed start is off by 8 to 24 bytes and
 * every sound decodes to noise. It holds on all 55 retail banks.
 *
 * ## Sound descriptors
 *
 * Each sound is `8 + 64 * channelCount` bytes:
 *
 *   +0x00 u32 channelCount  — 1 or 2
 *   +0x04 u32 sampleRate
 *   +0x08 ... one 64-byte channel header per channel
 *
 * So a mono sound occupies 72 bytes and a stereo one 136. Descriptors are
 * variable-length for that reason, and must be walked rather than indexed — a
 * fixed stride silently desynchronises on the first stereo entry.
 *
 * ## Channel headers
 *
 * Each is a standard GameCube `.dsp` header with its first 0x0C bytes omitted
 * (the sample count, nibble count and rate that would live there are either
 * derivable or already in the descriptor):
 *
 *   +0x00 u16 loopFlag, u16 format
 *   +0x04 u32 loopStart     — nibble address
 *   +0x08 u32 loopEnd       — nibble address; the end of this channel's audio
 *   +0x0C u32 currentAddress— nibble address; the *start* of it
 *   +0x10 s16 coefficients[16]
 *   +0x30 u16 gain, u16 predictorScale
 *   +0x34 u16 yn1, u16 yn2
 *   +0x38 u16 loopPredictorScale, u16 loopYn1, u16 loopYn2, u16 padding
 *
 * ## Nibble addressing
 *
 * Positions are **nibble** addresses, not byte offsets, and the mapping isn't a
 * simple halving. DSP-ADPCM packs 14 samples into each 8-byte frame, whose first
 * byte is a predictor/scale header — so nibbles 0 and 1 of every frame carry no
 * audio. A sound therefore starts at nibble 2, not 0, and
 * {@link ssmNibbleToSample} has to skip those two nibbles per frame. Treating a
 * nibble address as `byte * 2` puts every sound one byte early and yields noise.
 *
 * Channels are stored sequentially rather than interleaved, and each sound begins
 * exactly where the previous one ended, so the whole payload is one contiguous
 * run.
 */

import {
	decodeFrames,
	interleavePcm16,
	makeDspState,
	type DspChannelState,
} from '@tootallnate/dsp-adpcm';

/** Size of the file header. */
export const SSM_HEADER_SIZE = 0x10;

/** Size of one channel header. */
export const SSM_CHANNEL_HEADER_SIZE = 0x40;

/** Bytes a descriptor uses before its channel headers. */
export const SSM_ENTRY_PREFIX_SIZE = 8;

/** DSP-ADPCM coefficients per channel. */
export const SSM_COEFFICIENTS_PER_CHANNEL = 16;

/** The payload is aligned up to this boundary. */
export const SSM_DATA_ALIGNMENT = 32;

const DSP_SAMPLES_PER_FRAME = 14;
const DSP_FRAME_SIZE = 8;
const DSP_NIBBLES_PER_FRAME = 16;
/** Nibbles at the start of each frame taken by its predictor/scale byte. */
const DSP_HEADER_NIBBLES = 2;

/** Plausible sample rates, used to sanity-check a headerless file. */
const MIN_RATE = 4000;
const MAX_RATE = 96000;

export interface SsmChannel {
	index: number;
	looped: boolean;
	format: number;
	/** Nibble address where this channel's audio starts. */
	startNibble: number;
	/** Nibble address where it ends. */
	endNibble: number;
	loopStartNibble: number;
	/** Absolute offset of the 16 big-endian coefficients. */
	coefficientsOffset: number;
	coefficients: Int16Array;
	gain: number;
	predictorScale: number;
	yn1: number;
	yn2: number;
	/** Absolute offset of this channel's first ADPCM frame. */
	dataOffset: number;
	/** Decodable samples. */
	sampleCount: number;
	/** Byte length of the frames covering those samples. */
	byteLength: number;
}

export interface SsmSound {
	index: number;
	/** Global id: the bank's `baseSoundId` plus the index. */
	id: number;
	channelCount: number;
	sampleRate: number;
	/** Absolute offset of the descriptor. */
	offset: number;
	channels: SsmChannel[];
	/** Samples per channel. */
	sampleCount: number;
	durationSeconds: number;
}

export interface SsmBank {
	entryTableSize: number;
	dataSize: number;
	soundCount: number;
	baseSoundId: number;
	/** Absolute offset of the ADPCM payload. */
	dataOffset: number;
	sounds: SsmSound[];
}

export interface DecodedSsmSound {
	sampleRate: number;
	channelCount: number;
	/** Samples per channel. */
	sampleCount: number;
	/** Interleaved signed 16-bit PCM, ready for `encodeWav`. */
	samples: Int16Array;
}

/**
 * Sample index a nibble address refers to.
 *
 * Two nibbles per frame belong to its predictor/scale byte and hold no audio,
 * which is why a sound's first nibble is 2 rather than 0.
 */
export function ssmNibbleToSample(nibble: number): number {
	const frame = Math.floor(nibble / DSP_NIBBLES_PER_FRAME);
	const within = nibble - frame * DSP_NIBBLES_PER_FRAME;
	return frame * DSP_SAMPLES_PER_FRAME + Math.max(0, within - DSP_HEADER_NIBBLES);
}

/** Byte offset of the frame containing a nibble address. */
export function ssmNibbleToFrameByte(nibble: number): number {
	return Math.floor(nibble / DSP_NIBBLES_PER_FRAME) * DSP_FRAME_SIZE;
}

/** Where the payload starts, given the entry-table size. */
export function ssmDataOffset(entryTableSize: number): number {
	const unaligned = SSM_HEADER_SIZE + entryTableSize;
	return (
		(unaligned + (SSM_DATA_ALIGNMENT - 1)) & ~(SSM_DATA_ALIGNMENT - 1)
	);
}

/**
 * Heuristic check for an SSM.
 *
 * The format has no magic, so this is entirely a consistency argument: the
 * header's own numbers have to account for the file exactly, the sound count has
 * to be plausible, and the first descriptor has to declare a sane channel count
 * and sample rate. That combination is specific enough in practice — a random
 * file almost never satisfies the size identity — but it is a heuristic, not a
 * proof, so callers should prefer the extension when they have one.
 */
export function isSsm(bytes: Uint8Array, offset = 0): boolean {
	return parseSsm(bytes, offset) !== null;
}

/**
 * Parse a bank.
 *
 * Returns `null` when the header doesn't account for the file, when a descriptor
 * escapes the entry table, or when a channel's nibble range escapes the payload.
 * Being strict here is what makes {@link isSsm} usable at all.
 */
export function parseSsm(bytes: Uint8Array, offset = 0): SsmBank | null {
	if (offset < 0 || offset + SSM_HEADER_SIZE > bytes.length) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(o, false);
	const u16 = (o: number) => view.getUint16(o, false);

	const entryTableSize = u32(offset + 0x00);
	const dataSize = u32(offset + 0x04);
	const soundCount = u32(offset + 0x08);
	const baseSoundId = u32(offset + 0x0c);

	if (soundCount === 0 || soundCount > 0xffff) return null;
	// A mono sound is the smallest descriptor, so this bounds the table.
	const minTable = soundCount * (SSM_ENTRY_PREFIX_SIZE + SSM_CHANNEL_HEADER_SIZE);
	if (entryTableSize < minTable) return null;

	const dataOffset = offset + ssmDataOffset(entryTableSize);
	// The header must account for the file exactly. This identity is the main
	// reason a headerless format can be recognised at all, and it holds on every
	// retail bank.
	if (dataOffset + dataSize !== bytes.length - offset + offset) {
		if (dataOffset + dataSize !== bytes.length) return null;
	}

	const tableEnd = offset + SSM_HEADER_SIZE + entryTableSize;
	if (tableEnd > bytes.length) return null;

	const sounds: SsmSound[] = [];
	let at = offset + SSM_HEADER_SIZE;
	for (let i = 0; i < soundCount; i++) {
		if (at + SSM_ENTRY_PREFIX_SIZE > tableEnd) return null;
		const channelCount = u32(at + 0x00);
		const sampleRate = u32(at + 0x04);
		if (channelCount < 1 || channelCount > 2) return null;
		if (sampleRate < MIN_RATE || sampleRate > MAX_RATE) return null;
		const entrySize =
			SSM_ENTRY_PREFIX_SIZE + channelCount * SSM_CHANNEL_HEADER_SIZE;
		if (at + entrySize > tableEnd) return null;

		const channels: SsmChannel[] = [];
		let soundSamples = 0;
		for (let c = 0; c < channelCount; c++) {
			const cb = at + SSM_ENTRY_PREFIX_SIZE + c * SSM_CHANNEL_HEADER_SIZE;
			const coefficientsOffset = cb + 0x10;
			const coefficients = new Int16Array(SSM_COEFFICIENTS_PER_CHANNEL);
			for (let k = 0; k < SSM_COEFFICIENTS_PER_CHANNEL; k++) {
				coefficients[k] = view.getInt16(coefficientsOffset + k * 2, false);
			}
			const endNibble = u32(cb + 0x08);
			const startNibble = u32(cb + 0x0c);
			if (endNibble < startNibble) return null;
			const sampleCount =
				ssmNibbleToSample(endNibble) - ssmNibbleToSample(startNibble) + 1;
			const frameByte = ssmNibbleToFrameByte(startNibble);
			const byteLength =
				Math.ceil(sampleCount / DSP_SAMPLES_PER_FRAME) * DSP_FRAME_SIZE;
			if (sampleCount <= 0) return null;
			if (frameByte + byteLength > dataSize) return null;

			channels.push({
				index: c,
				looped: u16(cb + 0x00) !== 0,
				format: u16(cb + 0x02),
				startNibble,
				endNibble,
				loopStartNibble: u32(cb + 0x04),
				coefficientsOffset,
				coefficients,
				gain: u16(cb + 0x30),
				predictorScale: u16(cb + 0x32),
				yn1: view.getInt16(cb + 0x34, false),
				yn2: view.getInt16(cb + 0x36, false),
				dataOffset: dataOffset + frameByte,
				sampleCount,
				byteLength,
			});
			if (c === 0) soundSamples = sampleCount;
			else soundSamples = Math.min(soundSamples, sampleCount);
		}

		sounds.push({
			index: i,
			id: baseSoundId + i,
			channelCount,
			sampleRate,
			offset: at,
			channels,
			sampleCount: soundSamples,
			durationSeconds: soundSamples / sampleRate,
		});
		at += entrySize;
	}

	return {
		entryTableSize,
		dataSize,
		soundCount,
		baseSoundId,
		dataOffset,
		sounds,
	};
}

/**
 * Decode one sound to interleaved PCM16.
 *
 * Each channel carries its own coefficients and starting history, and the
 * channels sit one after another in the payload rather than interleaved — so
 * decoding is per-channel and nothing is threaded between them.
 */
export function decodeSsmSound(
	bytes: Uint8Array,
	sound: SsmSound,
): DecodedSsmSound | null {
	const { channelCount, sampleRate, sampleCount } = sound;
	if (sampleCount <= 0) {
		return { sampleRate, channelCount, sampleCount: 0, samples: new Int16Array(0) };
	}

	const planes: Int16Array[] = [];
	for (const channel of sound.channels) {
		const out = new Int16Array(sampleCount);
		// Hand over the file's own big-endian coefficient bytes; SSM is a
		// PowerPC format, so `littleEndian` is always false.
		const state: DspChannelState = makeDspState(
			bytes.subarray(
				channel.coefficientsOffset,
				channel.coefficientsOffset + SSM_COEFFICIENTS_PER_CHANNEL * 2,
			),
			{ littleEndian: false, hist1: channel.yn1, hist2: channel.yn2 },
		);
		const available = Math.max(0, bytes.length - channel.dataOffset);
		decodeFrames(
			bytes.subarray(
				channel.dataOffset,
				channel.dataOffset + Math.min(channel.byteLength, available),
			),
			0,
			Math.min(sampleCount, channel.sampleCount),
			state,
			out,
			0,
			1,
		);
		planes.push(out);
	}

	return {
		sampleRate,
		channelCount,
		sampleCount,
		samples: channelCount === 1 ? planes[0] : interleavePcm16(planes),
	};
}

// ----- SEM (HAL sound-effect map) -----

/** Number of count-prefixed arrays the file is built from. */
export const SEM_ARRAY_COUNT = 5;

/** Index of the group table and of the sound-offset table within those arrays. */
export const SEM_GROUP_ARRAY = 2;
export const SEM_SOUND_ARRAY = 3;

export interface SemSound {
	/** Index in the flat, cross-group sound list. */
	index: number;
	offset: number;
	size: number;
}

export interface SemGroup {
	index: number;
	/** Where this group starts in the flat sound list. */
	firstSound: number;
	sounds: SemSound[];
}

/**
 * Parse a HAL sound-effect map (`smash2.sem`).
 *
 * The file is not a table but five count-prefixed `u32` arrays laid end to end,
 * each `{ u32 count, u32 values[count] }`. Melee's loader walks them in order
 * and keeps five pointers; only two carry anything on the retail disc.
 *
 *     array 0  empty
 *     array 1  empty
 *     array 2  55 group start indices — one per `.ssm` bank
 *     array 3  4,035 sound-entry offsets
 *     array 4  empty
 *
 * Arrays 1, 3 and 4 have the file's base address added to every element as they
 * load, which is what identifies them as offsets rather than values; 0 and 2 are
 * left alone. That distinction is the only thing separating a group's *index*
 * into the sound list from a sound's *offset* into the file, and the two are
 * easy to confuse because both are small ascending integers.
 *
 * The layout proves itself: the five arrays consume exactly 0x3FFC bytes, which
 * is precisely where the first sound offset points. The last group starts at
 * 4,034 against a sound count of 4,035, so it holds one sound, and every offset
 * lands inside the file.
 *
 * Entries are variable length — 28, 24, 32 and 20 bytes are the common sizes —
 * so a sound's extent comes from the next offset rather than a stride. What is
 * inside one is not interpreted here; the useful part is the grouping, since
 * group *i* corresponds to the *i*th `.ssm` bank and nothing in either file
 * says so on its own.
 */
export function parseSem(bytes: Uint8Array): SemGroup[] | null {
	if (bytes.length < SEM_ARRAY_COUNT * 4) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const arrays: number[][] = [];
	let at = 0;
	for (let i = 0; i < SEM_ARRAY_COUNT; i++) {
		if (at + 4 > bytes.length) return null;
		const count = view.getUint32(at, false);
		at += 4;
		// A bogus count would otherwise allocate wildly before failing.
		if (count > 0x100000 || at + count * 4 > bytes.length) return null;
		const values: number[] = [];
		for (let k = 0; k < count; k++) {
			values.push(view.getUint32(at + k * 4, false));
		}
		at += count * 4;
		arrays.push(values);
	}

	const starts = arrays[SEM_GROUP_ARRAY];
	const offsets = arrays[SEM_SOUND_ARRAY];
	if (starts.length === 0 || offsets.length === 0) return null;
	for (const offset of offsets) {
		if (offset < at || offset > bytes.length) return null;
	}

	const groups: SemGroup[] = [];
	for (let g = 0; g < starts.length; g++) {
		const first = starts[g];
		const stop = g + 1 < starts.length ? starts[g + 1] : offsets.length;
		if (first > stop || stop > offsets.length) return null;
		const sounds: SemSound[] = [];
		for (let s = first; s < stop; s++) {
			// The final entry runs to the end of the file.
			const end = s + 1 < offsets.length ? offsets[s + 1] : bytes.length;
			sounds.push({ index: s, offset: offsets[s], size: Math.max(0, end - offsets[s]) });
		}
		groups.push({ index: g, firstSound: first, sounds });
	}
	return groups;
}

/** Total sounds across every group. */
export function semSoundCount(groups: readonly SemGroup[]): number {
	return groups.reduce((total, group) => total + group.sounds.length, 0);
}
