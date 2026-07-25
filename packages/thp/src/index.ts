/**
 * THP video container.
 *
 * THP is Nintendo's in-house video format for the GameCube and Wii — the one
 * behind cutscenes and attract loops in Wind Waker, Super Mario Sunshine,
 * Pikmin, Metroid Prime and most other first-party discs. It is unusually
 * pleasant to work with for a console video format, because it doesn't invent
 * a video codec: **every frame is a baseline JPEG**, and the audio is ordinary
 * GameCube DSP-ADPCM. All THP contributes is the container.
 *
 * That design makes sense once you remember the hardware. The GameCube had no
 * video decode block, so frames had to be decoded on a 486 MHz PowerPC. JPEG
 * was already implemented for other purposes, is intra-only (so seeking is
 * trivial and a dropped frame costs nothing), and decodes in predictable time.
 * The cost is size — there is no interframe compression at all, which is why a
 * 70-second 640×480 clip runs to 70 MB.
 *
 * Everything is big-endian.
 *
 * ## File header, 0x30 bytes
 *
 *   0x00 char[4] magic 'THP\0'
 *   0x04 u32     version         — 0x00010000, or 0x00011000 for 1.1
 *   0x08 u32     maxBufferSize   — largest frame payload, for the game's read buffer
 *   0x0C u32     maxAudioSamples — largest per-frame audio sample count
 *   0x10 f32     fps
 *   0x14 u32     frameCount
 *   0x18 u32     firstFrameSize
 *   0x1C u32     dataSize        — total bytes of all frames
 *   0x20 u32     componentDataOffset
 *   0x24 u32     offsetsDataOffset  — optional frame-offset table; 0 when absent
 *   0x28 u32     firstFrameOffset
 *   0x2C u32     lastFrameOffset
 *
 * ## Component table
 *
 * At `componentDataOffset`: a `u32` component count, then a *fixed* 16-byte
 * array of component type tags (0 = video, 1 = audio, 0xFF = unused), then one
 * descriptor per declared component, in tag order:
 *
 *   video: u32 width, u32 height  (+ u32 videoType when version >= 1.1)
 *   audio: u32 channels, u32 sampleRate, u32 sampleCount
 *                                 (+ u32 numData when version >= 1.1)
 *
 * The type array is always 16 bytes regardless of how many components exist,
 * which is easy to miss and shifts every descriptor if you get it wrong.
 *
 * ## Frames
 *
 * Frames form a doubly-linked list by *size*, not by offset:
 *
 *   u32 nextFrameSize
 *   u32 previousFrameSize
 *   u32 payloadSize      × componentCount   (video size, then audio size)
 *
 * so the header is `8 + 4 * componentCount` bytes. The critical subtlety:
 * `nextFrameSize` is the size of the **next** frame, not this one. To walk the
 * list you must already know the current frame's size — which for the first
 * frame comes from the file header's `firstFrameSize`, and thereafter from the
 * previous frame's `nextFrameSize`. Advancing by `nextFrameSize` instead is a
 * natural mistake and desynchronises immediately.
 *
 * Each frame's total size is its header plus payloads, rounded up to a 32-byte
 * boundary (the GameCube's DVD read granularity).
 *
 * ## Audio frames
 *
 *   u32 channelSize          — ADPCM bytes per channel
 *   u32 sampleCount
 *   s16 coefficients[channels][16]
 *   s16 history[channels][2] — yn-1, yn-2
 *   then `channelSize` bytes of DSP-ADPCM per channel, one channel after another
 *
 * Coefficients are repeated in full in every frame, and the stored history is
 * zero throughout retail files, which together mean each audio frame decodes
 * independently. That is deliberate: it's what lets the game seek to any frame
 * and start playing without decoding everything before it.
 *
 * This module is container-only by design: it delegates the ADPCM to
 * `@tootallnate/dsp-adpcm` and leaves JPEG decoding to the caller (a browser can
 * do it natively). The one exception is byte stuffing — THP's entropy data omits
 * it, so {@link thpFrameJpeg} has to rebuild each frame before anything else
 * will decode it. See that function for the details.
 */

import {
	decodeFrames,
	dspBytesForSamples,
	makeDspState,
	type DspChannelState,
} from '@tootallnate/dsp-adpcm';

export const THP_MAGIC = 'THP\0';

/** Size of the fixed file header. */
export const THP_HEADER_SIZE = 0x30;

/** The component type array is a fixed 16 entries, however many are used. */
export const THP_COMPONENT_SLOTS = 16;

/** Frames are padded up to this boundary — the DVD read granularity. */
export const THP_FRAME_ALIGNMENT = 32;

/** DSP-ADPCM coefficients per channel. */
export const THP_COEFFICIENTS_PER_CHANNEL = 16;

export const ThpVersion = {
	V1_0: 0x00010000,
	V1_1: 0x00011000,
} as const;

export const ThpComponentType = {
	VIDEO: 0,
	AUDIO: 1,
	NONE: 0xff,
} as const;

export interface ThpVideoInfo {
	width: number;
	height: number;
	/** Present from version 1.1; 0 in every retail file seen. */
	videoType: number;
}

export interface ThpAudioInfo {
	channelCount: number;
	sampleRate: number;
	/** Total samples per channel across the whole file. */
	sampleCount: number;
	/** Present from version 1.1. */
	numData: number;
}

export interface ThpHeader {
	version: number;
	/** e.g. `'1.1'`. */
	versionName: string;
	maxBufferSize: number;
	maxAudioSamples: number;
	fps: number;
	frameCount: number;
	firstFrameSize: number;
	dataSize: number;
	componentDataOffset: number;
	/** Optional frame-offset table; 0 when the file has none. */
	offsetsDataOffset: number;
	/** Absolute offset of the first frame. */
	firstFrameOffset: number;
	/** Absolute offset of the last frame. */
	lastFrameOffset: number;
	/** Component tags in order, excluding the unused 0xFF slots. */
	componentTypes: number[];
	video: ThpVideoInfo | null;
	audio: ThpAudioInfo | null;
	/** `8 + 4 * componentCount`. */
	frameHeaderSize: number;
	durationSeconds: number;
}

export interface ThpFrame {
	index: number;
	/** Absolute offset of the frame header. */
	offset: number;
	/** This frame's total size, including header and padding. */
	size: number;
	/** Size of the following frame, as stored. */
	nextSize: number;
	/** Size of the preceding frame, as stored. */
	previousSize: number;
	/** Absolute offset of the JPEG payload, or -1 when there's no video component. */
	videoOffset: number;
	videoSize: number;
	/** Absolute offset of the audio payload, or -1 when there's no audio component. */
	audioOffset: number;
	audioSize: number;
}

export interface ThpFile {
	header: ThpHeader;
	frames: ThpFrame[];
}

export interface ThpAudioFrame {
	/** ADPCM bytes per channel. */
	channelSize: number;
	sampleCount: number;
	/** One 16-entry coefficient table per channel. */
	coefficients: Int16Array[];
	/** Per-channel `[yn-1, yn-2]` at the start of this frame. */
	history: { hist1: number; hist2: number }[];
	/**
	 * Absolute offset of the big-endian coefficient block. Kept so decoding can
	 * pass the original bytes to `makeDspState` rather than re-serialising the
	 * parsed `Int16Array`s and having to reason about host byte order.
	 */
	coefficientsOffset: number;
	/** Absolute offset of the first channel's ADPCM data. */
	dataOffset: number;
}

export interface DecodedThpAudio {
	sampleRate: number;
	channelCount: number;
	/** Samples per channel. */
	sampleCount: number;
	/** Interleaved signed 16-bit PCM, ready for `encodeWav`. */
	samples: Int16Array;
}

function magicAt(bytes: Uint8Array, offset: number): boolean {
	return (
		bytes[offset] === 0x54 && // 'T'
		bytes[offset + 1] === 0x48 && // 'H'
		bytes[offset + 2] === 0x50 && // 'P'
		bytes[offset + 3] === 0x00
	);
}

/** Cheap magic check. Safe on arbitrary bytes. */
export function isThp(bytes: Uint8Array, offset = 0): boolean {
	if (offset < 0 || offset + THP_HEADER_SIZE > bytes.length) return false;
	return magicAt(bytes, offset);
}

/**
 * Parse the file header and component table.
 *
 * Returns `null` on a bad magic, an unknown version, or a component table that
 * runs past the buffer. Offsets in the header are absolute already, so unlike
 * RARC there's nothing to rebase.
 */
export function parseThpHeader(bytes: Uint8Array, offset = 0): ThpHeader | null {
	if (!isThp(bytes, offset)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(offset + o, false);

	const version = u32(0x04);
	if (version !== ThpVersion.V1_0 && version !== ThpVersion.V1_1) return null;
	const hasExtras = version >= ThpVersion.V1_1;

	const componentDataOffset = u32(0x20);
	if (
		componentDataOffset < THP_HEADER_SIZE ||
		componentDataOffset + 4 + THP_COMPONENT_SLOTS > bytes.length
	) {
		return null;
	}

	let p = componentDataOffset;
	const componentCount = view.getUint32(p, false);
	p += 4;
	// Implausible counts would make the descriptor walk run away.
	if (componentCount === 0 || componentCount > THP_COMPONENT_SLOTS) return null;
	const tags = Array.from(
		bytes.subarray(p, p + THP_COMPONENT_SLOTS),
	).slice(0, componentCount);
	p += THP_COMPONENT_SLOTS;

	let video: ThpVideoInfo | null = null;
	let audio: ThpAudioInfo | null = null;
	for (const tag of tags) {
		if (tag === ThpComponentType.VIDEO) {
			const need = hasExtras ? 12 : 8;
			if (p + need > bytes.length) return null;
			video = {
				width: view.getUint32(p, false),
				height: view.getUint32(p + 4, false),
				videoType: hasExtras ? view.getUint32(p + 8, false) : 0,
			};
			p += need;
		} else if (tag === ThpComponentType.AUDIO) {
			const need = hasExtras ? 16 : 12;
			if (p + need > bytes.length) return null;
			audio = {
				channelCount: view.getUint32(p, false),
				sampleRate: view.getUint32(p + 4, false),
				sampleCount: view.getUint32(p + 8, false),
				numData: hasExtras ? view.getUint32(p + 12, false) : 0,
			};
			p += need;
		} else if (tag === ThpComponentType.NONE) {
			// An unused slot inside the declared count: nothing follows for it.
			continue;
		} else {
			// Unknown component: we can't know its descriptor width, so we
			// can't safely keep walking.
			return null;
		}
	}

	// A video stream is the entire point; a file without one isn't usable.
	if (!video || video.width === 0 || video.height === 0) return null;
	if (audio && (audio.channelCount === 0 || audio.channelCount > 8)) return null;
	if (audio && (audio.sampleRate < 1000 || audio.sampleRate > 192000)) return null;

	const fps = view.getFloat32(offset + 0x10, false);
	if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) return null;
	const frameCount = u32(0x14);
	if (frameCount === 0) return null;

	return {
		version,
		versionName: version === ThpVersion.V1_1 ? '1.1' : '1.0',
		maxBufferSize: u32(0x08),
		maxAudioSamples: u32(0x0c),
		fps,
		frameCount,
		firstFrameSize: u32(0x18),
		dataSize: u32(0x1c),
		componentDataOffset,
		offsetsDataOffset: u32(0x24),
		firstFrameOffset: u32(0x28),
		lastFrameOffset: u32(0x2c),
		componentTypes: tags,
		video,
		audio,
		frameHeaderSize: 8 + 4 * componentCount,
		durationSeconds: frameCount / fps,
	};
}

/**
 * Parse the header and walk the whole frame list.
 *
 * The walk is bounded by `frameCount` *and* by the buffer, and stops early
 * rather than throwing if a frame header would fall off the end — a truncated
 * download still yields the frames it does contain.
 */
export function parseThp(bytes: Uint8Array, offset = 0): ThpFile | null {
	const header = parseThpHeader(bytes, offset);
	if (!header) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const hdrLen = header.frameHeaderSize;
	const hasVideo = header.video !== null;
	const hasAudio = header.audio !== null;

	const frames: ThpFrame[] = [];
	let at = header.firstFrameOffset;
	// `firstFrameSize` bootstraps the walk; every later size comes from the
	// previous frame's `nextFrameSize`.
	let size = header.firstFrameSize;

	for (let i = 0; i < header.frameCount; i++) {
		if (at < 0 || at + hdrLen > bytes.length) break;
		const nextSize = view.getUint32(at, false);
		const previousSize = view.getUint32(at + 4, false);

		// Payload sizes follow in component order.
		let q = at + 8;
		let videoSize = 0;
		let audioSize = 0;
		if (hasVideo) {
			videoSize = view.getUint32(q, false);
			q += 4;
		}
		if (hasAudio) {
			audioSize = view.getUint32(q, false);
			q += 4;
		}

		const videoOffset = hasVideo ? at + hdrLen : -1;
		const audioOffset = hasAudio ? at + hdrLen + videoSize : -1;
		// Reject a frame whose payloads escape the buffer instead of handing
		// back ranges that would read someone else's bytes.
		if (at + hdrLen + videoSize + audioSize > bytes.length) break;

		frames.push({
			index: i,
			offset: at,
			size,
			nextSize,
			previousSize,
			videoOffset,
			videoSize,
			audioOffset,
			audioSize,
		});

		if (size <= 0) break;
		at += size;
		size = nextSize;
	}

	return { header, frames };
}

/**
 * Offset just past a JPEG's `SOS` header, i.e. where entropy-coded data starts.
 *
 * Walks the marker segments rather than searching for a byte pattern, because
 * THP's entropy data is full of byte sequences that look like markers (see
 * {@link thpFrameJpeg}).
 */
function scanDataStart(jpeg: Uint8Array): number {
	let q = 2;
	while (q + 3 < jpeg.length) {
		if (jpeg[q] !== 0xff) {
			q++;
			continue;
		}
		const marker = jpeg[q + 1];
		// Standalone markers carry no length field.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			q += 2;
			continue;
		}
		const length = (jpeg[q + 2] << 8) | jpeg[q + 3];
		if (length < 2) return -1;
		if (marker === 0xda) return q + 2 + length;
		q += 2 + length;
	}
	return -1;
}

/** Index of the last `FFD9` in `jpeg`, or -1. */
function lastEoi(jpeg: Uint8Array, from: number): number {
	for (let q = jpeg.length - 2; q >= from; q--) {
		if (jpeg[q] === 0xff && jpeg[q + 1] === 0xd9) return q;
	}
	return -1;
}

/**
 * The raw, unmodified video payload for a frame.
 *
 * These bytes are *not* a decodable JPEG — see {@link thpFrameJpeg}. Exposed for
 * callers that want to inspect or re-pack the original data.
 */
export function thpFrameJpegRaw(bytes: Uint8Array, frame: ThpFrame): Uint8Array | null {
	if (frame.videoOffset < 0 || frame.videoSize <= 0) return null;
	const end = frame.videoOffset + frame.videoSize;
	if (end > bytes.length) return null;
	return bytes.subarray(frame.videoOffset, end);
}

/**
 * A frame as a **standards-compliant JPEG**.
 *
 * THP frames are very nearly baseline JPEGs — correct `DQT`/`SOF0`/`DHT`/`SOS`
 * segments, 4:2:0, all four Huffman tables — with one crucial deviation: the
 * entropy-coded data is **not byte-stuffed**.
 *
 * In a real JPEG a literal `0xFF` inside the scan must be written as `FF 00`, so
 * that any other `FF xx` can be recognised as a marker. Nintendo's decoder never
 * scans for markers mid-stream, so their encoder skips the stuffing and saves a
 * fraction of a percent. The result is that *every* standards-compliant decoder
 * — every browser, libjpeg, ImageIO — walks into the first stray `0xFF`, decides
 * it has found a marker, and aborts. Measured on a retail file: 210,285
 * unstuffed `0xFF` bytes against 442 coincidentally-stuffed ones, affecting 2111
 * of 2113 frames. Frames that appear to "work" are decoding partially and
 * silently producing a mostly-blank image.
 *
 * So this function rebuilds the file: headers are copied verbatim, then the
 * entropy data is re-stuffed (`FF` → `FF 00`) and terminated with a single
 * `EOI`. Note that sequences in the range `FFD0`–`FFD7` are stuffed like any
 * other data, *not* preserved as restart markers — the frames declare no `DRI`,
 * so those bytes are compressed data that merely resembles a marker.
 *
 * Returns `null` when the frame has no video payload or its JPEG structure can't
 * be walked. The result is a fresh buffer, not a view.
 */
export function thpFrameJpeg(bytes: Uint8Array, frame: ThpFrame): Uint8Array | null {
	const raw = thpFrameJpegRaw(bytes, frame);
	if (!raw) return null;
	return thpRestuffJpeg(raw);
}

/**
 * Re-stuff a THP-dialect JPEG so a standards-compliant decoder will read it.
 *
 * Split out from {@link thpFrameJpeg} because the dialect is not confined to
 * frames inside a container. Melee ships 75 files with a `.thp` extension that
 * are single JPEG stills rather than videos, and they have the same unstuffed
 * entropy data — a retail example carries 533 `0xFF` bytes in its scan of which
 * just one is stuffed, so a browser aborts almost immediately.
 *
 * Headers are copied verbatim; the entropy data is re-stuffed and terminated
 * with a single `EOI`. Returns `null` when the JPEG structure can't be walked.
 * The result is a fresh buffer, not a view.
 */
export function thpRestuffJpeg(raw: Uint8Array): Uint8Array | null {
	const scanStart = scanDataStart(raw);
	if (scanStart < 0) return null;
	// The payload is padded to a 4-byte boundary after the terminating EOI, so
	// the last EOI in the range is the real one.
	const eoi = lastEoi(raw, scanStart);
	const scanEnd = eoi < 0 ? raw.length : eoi;

	// Worst case every scan byte is 0xFF and doubles in size.
	const out = new Uint8Array(scanStart + (scanEnd - scanStart) * 2 + 2);
	out.set(raw.subarray(0, scanStart), 0);
	let w = scanStart;
	for (let q = scanStart; q < scanEnd; q++) {
		const byte = raw[q];
		out[w++] = byte;
		if (byte === 0xff) out[w++] = 0x00;
	}
	out[w++] = 0xff;
	out[w++] = 0xd9;
	return out.subarray(0, w);
}

/** Parse one frame's audio header. Returns `null` when it doesn't fit. */
export function parseThpAudioFrame(
	bytes: Uint8Array,
	frame: ThpFrame,
	channelCount: number,
): ThpAudioFrame | null {
	if (frame.audioOffset < 0 || frame.audioSize < 8) return null;
	if (channelCount < 1) return null;
	const base = frame.audioOffset;
	const stateBytes =
		channelCount * THP_COEFFICIENTS_PER_CHANNEL * 2 + channelCount * 4;
	if (base + 8 + stateBytes > bytes.length) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const channelSize = view.getUint32(base, false);
	const sampleCount = view.getUint32(base + 4, false);

	// Coefficients for every channel come first as one contiguous block, then
	// the history values for every channel. Interleaving the two per channel is
	// the tempting misreading, and it silently yields channel 1's first two
	// coefficients as channel 0's history.
	const coefBase = base + 8;
	const histBase = coefBase + channelCount * THP_COEFFICIENTS_PER_CHANNEL * 2;
	const coefficients: Int16Array[] = [];
	const history: { hist1: number; hist2: number }[] = [];
	for (let c = 0; c < channelCount; c++) {
		const table = new Int16Array(THP_COEFFICIENTS_PER_CHANNEL);
		for (let k = 0; k < THP_COEFFICIENTS_PER_CHANNEL; k++) {
			table[k] = view.getInt16(
				coefBase + (c * THP_COEFFICIENTS_PER_CHANNEL + k) * 2,
				false,
			);
		}
		coefficients.push(table);
		history.push({
			hist1: view.getInt16(histBase + c * 4, false),
			hist2: view.getInt16(histBase + c * 4 + 2, false),
		});
	}

	const dataOffset = histBase + channelCount * 4;
	if (dataOffset + channelSize * channelCount > bytes.length) return null;

	return {
		channelSize,
		sampleCount,
		coefficients,
		history,
		coefficientsOffset: coefBase,
		dataOffset,
	};
}

/**
 * Decode one audio frame to interleaved PCM16.
 *
 * Each channel's ADPCM is stored contiguously, one channel after another, and
 * carries its own coefficients and starting history — so a frame stands alone.
 */
export function decodeThpAudioFrame(
	bytes: Uint8Array,
	audioFrame: ThpAudioFrame,
	channelCount: number,
	out: Int16Array,
	outSampleOffset: number,
): number {
	const take = Math.min(
		audioFrame.sampleCount,
		Math.max(0, out.length / channelCount - outSampleOffset),
	);
	if (take <= 0) return 0;

	for (let c = 0; c < channelCount; c++) {
		// Hand over the file's own big-endian coefficient bytes; THP is a
		// PowerPC format, so `littleEndian` is always false here.
		const coefAt =
			audioFrame.coefficientsOffset +
			c * THP_COEFFICIENTS_PER_CHANNEL * 2;
		const state: DspChannelState = makeDspState(
			bytes.subarray(coefAt, coefAt + THP_COEFFICIENTS_PER_CHANNEL * 2),
			{
				littleEndian: false,
				hist1: audioFrame.history[c].hist1,
				hist2: audioFrame.history[c].hist2,
			},
		);
		const at = audioFrame.dataOffset + c * audioFrame.channelSize;
		const slice = bytes.subarray(at, at + audioFrame.channelSize);
		decodeFrames(
			slice,
			0,
			take,
			state,
			out,
			outSampleOffset * channelCount + c,
			channelCount,
		);
	}
	return take;
}

/**
 * Decode the whole audio track to interleaved PCM16.
 *
 * The result is capped at the header's declared `sampleCount` so a final
 * partially-used ADPCM frame doesn't append padding samples.
 */
export function decodeThpAudio(
	bytes: Uint8Array,
	file: ThpFile,
): DecodedThpAudio | null {
	const info = file.header.audio;
	if (!info) return null;
	const { channelCount, sampleRate } = info;

	// Trust the frames over the header for total length: a truncated file has
	// fewer frames than the header claims.
	let available = 0;
	const parsed: ThpAudioFrame[] = [];
	for (const frame of file.frames) {
		const af = parseThpAudioFrame(bytes, frame, channelCount);
		if (!af) break;
		parsed.push(af);
		available += af.sampleCount;
	}
	const sampleCount = Math.min(info.sampleCount, available);
	if (sampleCount <= 0) {
		return { sampleRate, channelCount, sampleCount: 0, samples: new Int16Array(0) };
	}

	const samples = new Int16Array(sampleCount * channelCount);
	let written = 0;
	for (const af of parsed) {
		if (written >= sampleCount) break;
		written += decodeThpAudioFrame(bytes, af, channelCount, samples, written);
	}
	return { sampleRate, channelCount, sampleCount: written, samples };
}

/** Bytes one channel of `sampleCount` DSP-ADPCM samples occupies. */
export function thpAudioBytesForSamples(sampleCount: number): number {
	return dspBytesForSamples(sampleCount);
}
