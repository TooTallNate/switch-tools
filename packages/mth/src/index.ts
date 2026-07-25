/**
 * MTH video container.
 *
 * MTH is the video format in Super Smash Bros. Melee, holding the opening
 * movie, the How-to-Play demo, the 25 character congratulation reels and one
 * 28-minute attract loop. It sits alongside THP rather than replacing it: HAL
 * shipped both on the same disc, THP for anything needing sound and MTH for
 * everything silent.
 *
 * Like THP it invents no video codec — **every frame is a JPEG** — for the same
 * reason THP does. The GameCube had no video decode hardware, so frames were
 * decoded on a 486 MHz PowerPC, and a per-frame JPEG is both cheap to decode and
 * randomly seekable without a keyframe search. What MTH contributes is a smaller
 * container than THP's, which is what you would design if you knew in advance
 * that you never needed an audio track.
 *
 * ## Header
 *
 * A flat 0x40 bytes, big-endian throughout, as everything on a PowerPC console
 * is:
 *
 *   +0x00 char[4]  `MTHP`
 *   +0x04 s16      version major (8 on this disc)
 *   +0x06 s16      version minor (0)
 *   +0x08 s32      size marker, always 2
 *   +0x0C s32      largest frame in the file, including its header and padding
 *   +0x10 s32      width
 *   +0x14 s32      height
 *   +0x18 s32      frame rate, in whole frames per second
 *   +0x1C s32      frame count
 *   +0x20 s32      offset of the first video frame (0x40 in practice)
 *   +0x24 s32      offset of the first audio frame
 *   +0x28 s32      size of the first video frame
 *   +0x2C s32      size of the first audio frame
 *   +0x30 s32[4]   further channels
 *
 * The audio and channel fields exist but are unused: across all 28 files on the
 * retail disc every one of those six words is zero. So MTH as shipped is
 * video-only, and this parser reports the fields rather than pretending to
 * support a track nobody has an example of.
 *
 * ## Frames are a chain, not a table
 *
 * There is no offset table. Each frame begins with a single s32 giving the size
 * of the **next** frame, and the header seeds the walk with the first frame's
 * size. So a frame's own size is only known from its predecessor, and reaching
 * frame *n* means walking all *n*. The payload is the rest of the frame after
 * that s32, and each frame is padded so its total is a multiple of 0x20 — the
 * GameCube's DVD reads in aligned blocks, and aligning frames lets one be pulled
 * straight into memory without a straddling read.
 *
 * The chain is self-checking, which is worth something in a format with no
 * magic beyond four bytes: walking it must yield exactly the header's frame
 * count and land exactly at the end of the file. On the retail disc all 28 files
 * satisfy both, all 28 have a JPEG at every payload offset, and the final
 * frame's `next` size points back at the first — the loop that lets an attract
 * movie repeat without a seek.
 *
 * ## The JPEGs need repair
 *
 * MTH frames carry the same dialect as THP's: the entropy-coded data is **not
 * byte-stuffed**, so a literal `0xFF` in the scan is written bare where the
 * standard demands `FF 00`. Nintendo's decoder never scans for markers
 * mid-stream so their encoder skips it; every compliant decoder walks into the
 * first stray byte, decides it has found a marker, and gives up. Use
 * {@link mthFrameJpeg} to get a frame a browser will accept, and
 * {@link mthFrameJpegRaw} for the bytes as stored.
 *
 * Derived from the MTH reader in `Ploaj/MeleeMedia` (`MeleeMediaLib/Video/MTH.cs`)
 * and checked against every `.mth` file on a retail disc.
 */

import { thpRestuffJpeg } from '@tootallnate/thp';

/** `MTHP`, the only magic the format has. */
export const MTH_MAGIC = 0x4d544850;

/** The header is a fixed 0x40 bytes; the first frame follows it. */
export const MTH_HEADER_SIZE = 0x40;

/** Frames are padded so their total size is a multiple of this. */
export const MTH_FRAME_ALIGNMENT = 0x20;

/**
 * Display ticks per second — the rate frames are actually paced at.
 *
 * The header carries a `frameRate` field, and it is a trap: on this disc every
 * file says 30, but the player never consults it for timing. `lbMthp_GetFrame`
 * (`doldecomp/melee`, `src/melee/lb/lbmthp.c`) advances the frame from a tick
 * counter driven by video retrace, so with no rate table one frame lasts one
 * tick and the movie runs at the console's 59.94 Hz — twice what the field
 * claims. The field survives only in a debug print.
 *
 * The arithmetic settles it. `MvOmake15` holds 50,280 frames: at the declared 30
 * that is 1,676s against 845s of paired music, so the music would have to loop
 * twice; at 59.94 it is 838.8s, which fits 845s of music with none left over.
 * The longest character ending is 420 frames — 7.01s at 59.94 against an
 * `ending.hps` of 7.00s, a fit too exact to be coincidence.
 */
export const MTH_TICK_RATE = 59.94;

/**
 * Guards against a corrupt count turning into an unbounded walk. The largest
 * file on the Melee disc holds 50,280 frames, so this leaves generous room.
 */
const MAX_FRAMES = 1 << 20;

/** Nothing sensible has a dimension beyond this, and it bounds bad reads. */
const MAX_DIMENSION = 8192;

export interface MthHeader {
	versionMajor: number;
	versionMinor: number;
	/** Always 2 on observed files; retained because its meaning is unknown. */
	sizeMarker: number;
	/** Largest frame in the file, including its size word and padding. */
	maxFrameSize: number;
	width: number;
	height: number
	/**
	 * The header's frame-rate field. **Not the playback rate** — see
	 * {@link MTH_TICK_RATE}. Reported because it is in the file, not because it
	 * is useful.
	 */
	frameRate: number;
	frameCount: number;
	/** Absolute offset of the first video frame. */
	videoOffset: number;
	/** Absolute offset of the first audio frame; zero on every observed file. */
	audioOffset: number;
	/** Size of the first video frame, which seeds the chain walk. */
	videoSize: number;
	/** Size of the first audio frame; zero on every observed file. */
	audioSize: number;
	/** The four further channel words at +0x30; zero on every observed file. */
	channels: [number, number, number, number];
	/** True when no audio or extra channel is declared. */
	videoOnly: boolean;
	/**
	 * Runtime at one frame per display tick, which is how a movie plays when the
	 * caller supplies no rate table. Movies that do supply one — the opening and
	 * the how-to-play demo — hold individual frames for many ticks and run
	 * longer; that schedule lives in the executable, not in this file, so it
	 * cannot be accounted for here.
	 */
	durationSeconds: number;
	/** What the header's own field would imply, for comparison. */
	declaredDurationSeconds: number;
}

/**
 * A frame-pacing schedule: `[frameCount, ticksPerFrame]` pairs, in order.
 *
 * The opening movie and the how-to-play demo are not played at a constant rate.
 * `lbMthp_GetFrame` walks a table of these pairs, so the first `count` frames
 * each last `divisor` ticks, then the next run, and so on. How-to-play uses it
 * to hold single frames for 19, 85 or 101 ticks while narration plays — a still
 * instruction screen — which no constant rate can express.
 *
 * The table lives in the executable rather than the movie, so it has to be
 * supplied by the caller.
 */
export type MthRateTable = ReadonlyArray<readonly [count: number, ticks: number]>;

/**
 * Cumulative display ticks before each frame, and the total.
 *
 * With no table every frame lasts one tick. A table's final pair usually carries
 * an enormous count as a catch-all, so runs are clamped to the frames that
 * actually exist.
 */
export function mthFrameTicks(
	frameCount: number,
	table?: MthRateTable | null,
): { offsets: Uint32Array; totalTicks: number } {
	const offsets = new Uint32Array(frameCount);
	if (!table || table.length === 0) {
		for (let i = 0; i < frameCount; i++) offsets[i] = i;
		return { offsets, totalTicks: frameCount };
	}
	let frame = 0;
	let tick = 0;
	for (const [count, ticks] of table) {
		if (frame >= frameCount) break;
		const take = Math.min(count, frameCount - frame);
		for (let i = 0; i < take; i++) {
			offsets[frame + i] = tick;
			tick += ticks;
		}
		frame += take;
	}
	// A table that runs out before the frames do: hold the rest at one tick each
	// rather than stacking them all on the same timestamp.
	for (; frame < frameCount; frame++) {
		offsets[frame] = tick;
		tick += 1;
	}
	return { offsets, totalTicks: tick };
}

export interface MthFrame {
	index: number;
	/** Absolute offset of the frame, at its size word. */
	offset: number;
	/** Total bytes including the size word and trailing padding. */
	size: number;
	/** Absolute offset of the JPEG payload. */
	payloadOffset: number;
	/**
	 * Payload bytes as the chain describes them. This includes the alignment
	 * padding, since the frame's size is all the format states; the JPEG's own
	 * `EOI` is what actually ends the image.
	 */
	payloadSize: number;
	/** Size of the next frame, as stored in this one. */
	nextSize: number;
}

export interface MthFile {
	header: MthHeader;
	frames: MthFrame[];
	/**
	 * True when the walk produced exactly `header.frameCount` frames and
	 * consumed the file. A false value means the chain disagrees with the
	 * header, and the frames listed are only what could be followed.
	 */
	complete: boolean;
}

/** Does this look like an MTH container? */
export function isMth(bytes: Uint8Array, offset = 0): boolean {
	if (offset < 0 || offset + MTH_HEADER_SIZE > bytes.length) return false;
	return (
		bytes[offset] === 0x4d &&
		bytes[offset + 1] === 0x54 &&
		bytes[offset + 2] === 0x48 &&
		bytes[offset + 3] === 0x50
	);
}

/**
 * Parse the fixed header.
 *
 * Returns `null` unless the magic matches and the declared geometry and frame
 * layout are self-consistent — four bytes of magic alone is thin, so the
 * dimensions, the frame count and the first frame's placement are all required
 * to make sense before this claims a file.
 */
export function parseMthHeader(
	bytes: Uint8Array,
	offset = 0,
	fileSize = bytes.length,
): MthHeader | null {
	if (!isMth(bytes, offset)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const s32 = (o: number) => view.getInt32(offset + o, false);

	const width = s32(0x10);
	const height = s32(0x14);
	const frameRate = s32(0x18);
	const frameCount = s32(0x1c);
	const videoOffset = s32(0x20);
	const videoSize = s32(0x28);

	if (width <= 0 || height <= 0) return null;
	if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
	if (frameRate <= 0 || frameRate > 240) return null;
	if (frameCount <= 0 || frameCount > MAX_FRAMES) return null;
	// The first frame must start after the header and inside the file, and be
	// large enough to hold its own size word.
	if (videoOffset < MTH_HEADER_SIZE || videoOffset >= fileSize) return null;
	if (videoSize <= 4 || videoOffset + videoSize > fileSize) return null;

	const audioOffset = s32(0x24);
	const audioSize = s32(0x2c);
	const channels: [number, number, number, number] = [
		s32(0x30),
		s32(0x34),
		s32(0x38),
		s32(0x3c),
	];

	return {
		versionMajor: view.getInt16(offset + 0x04, false),
		versionMinor: view.getInt16(offset + 0x06, false),
		sizeMarker: s32(0x08),
		maxFrameSize: s32(0x0c),
		width,
		height,
		frameRate,
		frameCount,
		videoOffset,
		audioOffset,
		videoSize,
		audioSize,
		channels,
		videoOnly:
			audioOffset === 0 &&
			audioSize === 0 &&
			channels.every((c) => c === 0),
		durationSeconds: frameCount / MTH_TICK_RATE,
		declaredDurationSeconds: frameCount / frameRate,
	};
}

/**
 * Walk the frame chain.
 *
 * Each frame states the size of the next, so this is inherently sequential;
 * there is no table to index. The walk stops at the declared frame count, at
 * the end of the file, or on a size that cannot be right — and reports through
 * {@link MthFile.complete} whether it managed the whole thing, rather than
 * throwing. A truncated file should still preview the frames it has.
 *
 * `maxFrames` caps the work for a caller that only wants the opening frames of
 * a long movie; the result is then deliberately incomplete.
 */
export function parseMth(
	bytes: Uint8Array,
	offset = 0,
	maxFrames = MAX_FRAMES,
): MthFile | null {
	const header = parseMthHeader(bytes, offset);
	if (!header) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const frames: MthFrame[] = [];
	const limit = Math.min(header.frameCount, maxFrames);

	let at = offset + header.videoOffset;
	let size = header.videoSize;
	while (frames.length < limit) {
		// The size word itself has to be readable, and the frame has to fit.
		if (at < 0 || at + 4 > bytes.length) break;
		if (size <= 4 || at + size > bytes.length) break;
		const nextSize = view.getInt32(at, false);
		frames.push({
			index: frames.length,
			offset: at,
			size,
			payloadOffset: at + 4,
			payloadSize: size - 4,
			nextSize,
		});
		at += size;
		size = nextSize;
	}

	return {
		header,
		frames,
		complete:
			frames.length === header.frameCount && limit === header.frameCount,
	};
}

/**
 * A frame's payload exactly as stored, including alignment padding.
 *
 * Standard decoders will refuse these; see {@link mthFrameJpeg}. Kept for
 * callers that want to inspect or re-emit the original bytes.
 */
export function mthFrameJpegRaw(
	bytes: Uint8Array,
	frame: MthFrame,
): Uint8Array | null {
	if (frame.payloadOffset < 0 || frame.payloadSize <= 0) return null;
	if (frame.payloadOffset + frame.payloadSize > bytes.length) return null;
	return bytes.subarray(
		frame.payloadOffset,
		frame.payloadOffset + frame.payloadSize,
	);
}

/**
 * A frame as a JPEG any decoder will accept.
 *
 * MTH shares THP's unstuffed entropy data, so the repair is the same and is
 * shared with it rather than reimplemented: headers copied verbatim, scan data
 * re-stuffed, one terminating `EOI`. That last part also trims the alignment
 * padding, since the rebuilt file ends at the image.
 *
 * Returns `null` when the payload is missing or its JPEG structure can't be
 * walked. The result is a fresh buffer, not a view.
 */
export function mthFrameJpeg(
	bytes: Uint8Array,
	frame: MthFrame,
): Uint8Array | null {
	const raw = mthFrameJpegRaw(bytes, frame);
	if (!raw) return null;
	return thpRestuffJpeg(raw);
}
