/**
 * Decode-and-stream pipeline for Nintendo THP video (`.thp`).
 *
 * Re-encodes to fragmented H.264 / AAC MP4 and feeds the fragments into a
 * `<video>` element via MediaSource Extensions, so playback starts long before
 * the whole file has been processed. This is the same shape as
 * {@link ./bink-encode.ts}, and intentionally so — but with one whole stage
 * removed:
 *
 *   1. **No decoder needed.** A THP frame *is* a baseline JPEG, so instead of
 *      an ffmpeg-wasm decode we hand the bytes to `createImageBitmap`, which is
 *      the browser's own (usually GPU-assisted) JPEG path. Likewise the audio
 *      is ordinary DSP-ADPCM, decoded synchronously in plain JS by
 *      `@tootallnate/thp`. Nothing here loads a WASM module.
 *   2. Each `ImageBitmap` becomes a WebCodecs `VideoFrame` and goes through
 *      `VideoEncoder` (hardware H.264) into `EncodedVideoChunk`s.
 *   3. Decoded PCM is fed to `AudioEncoder` (AAC, falling back to Opus) in
 *      chunks paced to the video cadence.
 *   4. Encoded chunks become Mediabunny `EncodedPacket`s on an `Output` with
 *      `Mp4OutputFormat({ fastStart: 'fragmented' })`.
 *   5. The MP4's boxes are captured via `onFtyp`/`onMoov`/`onMoof`/`onMdat` and
 *      coalesced into *atomic* MSE media segments before being appended to the
 *      `SourceBuffer`, because MSE's parser wants a whole `moof`+`mdat` pair per
 *      append and drops fragments if fed the muxer's individual small writes.
 *
 * ## Why re-encode at all, when the frames are already JPEG?
 *
 * Because no browser will play motion JPEG inside MP4. The alternative — a
 * `<canvas>` fed by a `requestAnimationFrame` loop — means reimplementing
 * playback, seeking, buffering and A/V sync by hand, and gets no hardware
 * decode. Re-encoding to H.264 hands all of that to the browser's media stack,
 * which is what the Bink and USM previews already do.
 *
 * ## A note on sync
 *
 * THP's video and audio durations do not necessarily agree — the file this was
 * developed against is 70.50 s of video and 70.57 s of audio. Both tracks are
 * given explicit timestamps derived from their own clocks (frame index / fps for
 * video, running sample count / sample rate for audio) rather than being assumed
 * to advance in lockstep, so the muxer lays them out at their true positions and
 * the browser reconciles them.
 *
 * NOTE: unlike the container parsing in `@tootallnate/thp`, this module cannot
 * be exercised outside a browser — WebCodecs and MediaSource have no Node
 * equivalent. It follows the Bink pipeline closely for that reason.
 */

import {
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedVideoPacketSource,
	Mp4OutputFormat,
	NullTarget,
	Output,
} from 'mediabunny';

import {
	MTH_TICK_RATE,
	mthFrameJpeg,
	mthFrameTicks,
	parseMth,
	type MthRateTable,
} from '@tootallnate/mth';
import { decodeHps, parseHps } from '@tootallnate/hps';
import {
	decodeThpAudio,
	parseThp,
	thpFrameJpeg,
	type ThpFile,
} from '@tootallnate/thp';

/** Per-frame progress callback payload. */
export interface ThpEncodeProgress {
	/** 0-indexed frame just completed. */
	frame: number;
	/** Total frame count. */
	total: number;
	/** Encode rate measured over the last batch (fps). */
	fps: number;
}

/** Container metadata, available as soon as the header is parsed. */
export interface ThpStreamInfo {
	width: number;
	height: number;
	/** Encoded MP4's coded size (H.264 requires even dimensions). */
	codedWidth: number;
	codedHeight: number;
	fps: number;
	frameCount: number;
	hasAudio: boolean;
	audioChannels?: number;
	audioSampleRate?: number;
	/** Codec actually chosen for audio, or `null` when none was muxed. */
	audioCodec: 'aac' | 'opus' | null;
	durationUs: number;
}

export interface ThpStreamResult {
	/** The finished MP4, for a "Save .mp4" download. */
	mp4: Blob;
	info: ThpStreamInfo;
}

/**
 * A supplier of JPEG frames for the shared encoder.
 *
 * Both of Nintendo's per-frame-JPEG containers on this disc feed the same
 * pipeline. THP carries DSP-ADPCM audio; MTH is video-only. Rather than keep two
 * copies of the WebCodecs and MSE plumbing in step, the container-specific part
 * is reduced to this: geometry, a frame count, decoded audio when there is any,
 * and a way to fetch frame `i` as a JPEG a browser will accept.
 */
export interface JpegVideoSource {
	/** Human-readable container name, used in error messages. */
	label: string;
	width: number;
	height: number;
	fps: number;
	frameCount: number;
	/** Fully decoded PCM, or `null` for a silent container. */
	audio: ReturnType<typeof decodeThpAudio> | null;
	/**
	 * Frame `index` rebuilt as a standards-compliant JPEG, or `null` to skip it.
	 * Both formats omit entropy byte-stuffing, so this is never the stored bytes.
	 */
	jpegAt(index: number): Uint8Array | null;
	/**
	 * Presentation time of frame `index`, in microseconds. Omit for a constant
	 * rate. MTH movies can hold a frame for many display ticks, and a constant
	 * rate makes their audio drift.
	 */
	timestampUsAt?(index: number): number;
}

export interface ThpEncodeOptions {
	/** The `.thp` file bytes. */
	thpBytes: Uint8Array;
	/** Progress callback (fires roughly every 16 frames). */
	onProgress?: (p: ThpEncodeProgress) => void;
	/** Aborts encoding mid-flight. */
	signal?: AbortSignal;
}

export interface MthEncodeOptions {
	/** The `.mth` file bytes. */
	mthBytes: Uint8Array;
	/**
	 * The accompanying `.hps` stream, when one was paired. MTH carries no audio
	 * of its own; see `MTH_AUDIO_PAIRS` in `archive.ts` for where this comes from
	 * and how firm the pairing is.
	 */
	hpsBytes?: Uint8Array;
	/** Name of that stream, for display. */
	hpsName?: string;
	/** Frame-pacing schedule, when the movie uses one. */
	rateTable?: MthRateTable | null;
	onProgress?: (p: ThpEncodeProgress) => void;
	signal?: AbortSignal;
}

/**
 * Returned synchronously so the caller can wire `<video src>` before any work
 * starts — the MediaSource only opens once a media element attaches to it.
 */
export interface ThpStreamHandle {
	/** Object URL of a MediaSource. The caller MUST revoke it on unmount. */
	mediaSourceUrl: string;
	/** Resolves once the THP header is parsed. */
	info: Promise<ThpStreamInfo>;
	/** Resolves with the finished MP4. */
	done: Promise<ThpStreamResult>;
}

export class ThpWebCodecsUnavailableError extends Error {
	constructor() {
		super(
			'WebCodecs is not available in this browser, so THP video cannot be ' +
				're-encoded for playback.',
		);
		this.name = 'ThpWebCodecsUnavailableError';
	}
}

export class ThpMediaSourceUnavailableError extends Error {
	constructor() {
		super(
			"This browser doesn't support MediaSource Extensions, so THP video " +
				'cannot be streamed.',
		);
		this.name = 'ThpMediaSourceUnavailableError';
	}
}

export class ThpH264UnavailableError extends Error {
	constructor(detail: string) {
		super(`No usable H.264 encoder configuration for this THP: ${detail}`);
		this.name = 'ThpH264UnavailableError';
	}
}

export class ThpParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ThpParseError';
	}
}

/** Flush the encoder when its queue gets this deep, to bound memory. */
const MAX_ENCODE_QUEUE = 8;
/** Emit a keyframe about this often (seconds). */
const KEYFRAME_INTERVAL_SECONDS = 2;
/** Audio samples per `AudioData` handed to the encoder. */
const AUDIO_CHUNK_SAMPLES = 1024;
/** Give up if no `<video>` attaches to the MediaSource within this long. */
const SOURCE_OPEN_TIMEOUT_MS = 10_000;

/**
 * `SourceBuffer.appendBuffer()` allows only one append in flight, signalled by
 * `updateend`. The muxer produces fragments on its own schedule, so queue them
 * and drain as fast as MSE permits.
 */
function createSourceBufferQueue(sb: SourceBuffer): {
	push: (data: Uint8Array<ArrayBuffer>) => void;
	drained: () => Promise<void>;
	close: () => void;
} {
	const queue: Uint8Array<ArrayBuffer>[] = [];
	let updating = false;
	let closed = false;
	let drainedResolve: (() => void) | null = null;

	const tryDrain = (): void => {
		if (updating || closed) return;
		if (queue.length === 0) {
			drainedResolve?.();
			drainedResolve = null;
			return;
		}
		const next = queue.shift()!;
		updating = true;
		try {
			sb.appendBuffer(next);
		} catch (err) {
			// The browser may refuse when its buffer is fuller than it cares to
			// keep. Put the chunk back; by the next `updateend` it will have
			// evicted older samples.
			if (err instanceof DOMException && err.name === 'QuotaExceededError') {
				queue.unshift(next);
				updating = false;
				return;
			}
			throw err;
		}
	};

	sb.addEventListener('updateend', () => {
		updating = false;
		tryDrain();
	});

	return {
		push(data) {
			if (closed) return;
			queue.push(data);
			tryDrain();
		},
		drained() {
			if (!updating && queue.length === 0) return Promise.resolve();
			return new Promise<void>((resolve) => {
				drainedResolve = resolve;
			});
		},
		close() {
			closed = true;
			queue.length = 0;
			drainedResolve?.();
			drainedResolve = null;
		},
	};
}

/**
 * Find an H.264 configuration that both `VideoEncoder` and MediaSource accept.
 *
 * Both checks matter: a profile the encoder supports is useless if MSE won't
 * demux it, and vice versa. We try progressively less demanding profiles.
 */
async function pickVideoConfig(
	width: number,
	height: number,
	fps: number,
): Promise<{ config: VideoEncoderConfig; mseMime: string }> {
	// High, Main, then Baseline — all level 4.0, which covers 640x480 easily.
	const candidates = ['avc1.640028', 'avc1.4d0028', 'avc1.420028'];
	const attempts: string[] = [];
	for (const codec of candidates) {
		const config: VideoEncoderConfig = {
			codec,
			width,
			height,
			framerate: fps,
			// Annex-B would need converting; `avc` gives us the length-prefixed
			// form plus a description, which is what the MP4 muxer wants.
			avc: { format: 'avc' },
			// THP is intra-only and often quite detailed; a generous bitrate
			// keeps the re-encode from visibly degrading the source.
			bitrate: Math.max(1_000_000, Math.round(width * height * fps * 0.15)),
			latencyMode: 'quality',
		};
		const mseMime = `video/mp4; codecs="${codec}"`;
		try {
			const support = await VideoEncoder.isConfigSupported(config);
			if (
				support.supported &&
				support.config &&
				typeof MediaSource !== 'undefined' &&
				MediaSource.isTypeSupported(mseMime)
			) {
				return { config: support.config as VideoEncoderConfig, mseMime };
			}
			attempts.push(`${codec} (encoder=${support.supported ? 'ok' : 'no'})`);
		} catch (err) {
			attempts.push(`${codec} (${err instanceof Error ? err.message : 'error'})`);
		}
	}
	throw new ThpH264UnavailableError(attempts.join(', '));
}

/** Pick an audio codec MSE will accept alongside H.264, preferring AAC. */
async function pickAudioConfig(
	channels: number,
	sampleRate: number,
	videoCodec: string,
): Promise<{ codec: 'aac' | 'opus'; config: AudioEncoderConfig; mseMime: string } | null> {
	if (typeof AudioEncoder === 'undefined') return null;
	const candidates: { codec: 'aac' | 'opus'; encoderCodec: string; mp4Codec: string }[] = [
		{ codec: 'aac', encoderCodec: 'mp4a.40.2', mp4Codec: 'mp4a.40.2' },
		{ codec: 'opus', encoderCodec: 'opus', mp4Codec: 'opus' },
	];
	for (const c of candidates) {
		const config: AudioEncoderConfig = {
			codec: c.encoderCodec,
			numberOfChannels: channels,
			sampleRate,
			bitrate: 128_000,
		};
		try {
			const support = await AudioEncoder.isConfigSupported(config);
			const mime = `video/mp4; codecs="${videoCodec}, ${c.mp4Codec}"`;
			if (support.supported && support.config && MediaSource.isTypeSupported(mime)) {
				return {
					codec: c.codec,
					config: support.config as AudioEncoderConfig,
					mseMime: mime,
				};
			}
		} catch {
			// try the next codec
		}
	}
	return null;
}

/** Convert a WebCodecs chunk into a Mediabunny packet. */
function toPacket(chunk: EncodedVideoChunk | EncodedAudioChunk): EncodedPacket {
	const data = new Uint8Array(chunk.byteLength);
	chunk.copyTo(data);
	return new EncodedPacket(
		data,
		chunk.type === 'key' ? 'key' : 'delta',
		chunk.timestamp / 1e6,
		(chunk.duration ?? 0) / 1e6,
	);
}

/**
 * Re-encode a THP and stream it as fragmented MP4 through MediaSource.
 *
 * Returns synchronously; assign `mediaSourceUrl` to a `<video>` immediately, or
 * the MediaSource never opens and the pipeline aborts after ten seconds.
 */
/** Build a source over a `.thp`, decoding its audio track up front. */
function thpSource(thpBytes: Uint8Array): JpegVideoSource {
	const file: ThpFile | null = parseThp(thpBytes);
	if (!file) throw new ThpParseError('Not a valid THP video');
	const video = file.header.video;
	if (!video) throw new ThpParseError('This THP has no video component');
	// Decoded up front: it's pure JS over bytes already in memory and costs a
	// fraction of the video work, which makes the pacing loop trivial.
	const audio = file.header.audio ? decodeThpAudio(thpBytes, file) : null;
	return {
		label: 'THP',
		width: video.width,
		height: video.height,
		fps: file.header.fps,
		frameCount: file.frames.length,
		audio: audio && audio.sampleCount > 0 ? audio : null,
		jpegAt: (i) => {
			const frame = file.frames[i];
			return frame ? thpFrameJpeg(thpBytes, frame) : null;
		},
	};
}

/**
 * Build a source over a `.mth`.
 *
 * Melee's MTH declares audio fields but every file on the disc leaves them
 * zero, so this is video-only until a counter-example turns up — inventing a
 * silent track would just add a stream nothing asked for.
 */
function mthSource(
	mthBytes: Uint8Array,
	hpsBytes?: Uint8Array,
	rateTable?: MthRateTable | null,
): JpegVideoSource {
	const file = parseMth(mthBytes);
	if (!file) throw new ThpParseError('Not a valid MTH video');
	// Paced by display ticks, not by the header's frame-rate field; see
	// MTH_TICK_RATE. Using the field runs every movie at half speed, which shows
	// up as audio drifting further behind as the film goes on.
	const { offsets, totalTicks } = mthFrameTicks(file.frames.length, rateTable);
	const durationSeconds = totalTicks / MTH_TICK_RATE;
	return {
		label: 'MTH',
		timestampUsAt: (i) => (offsets[i] / MTH_TICK_RATE) * 1e6,
		width: file.header.width,
		height: file.header.height,
		fps: MTH_TICK_RATE,
		frameCount: file.frames.length,
		audio: hpsBytes ? loopHpsToDuration(hpsBytes, durationSeconds) : null,
		jpegAt: (i) => {
			const frame = file.frames[i];
			return frame ? mthFrameJpeg(mthBytes, frame) : null;
		},
	};
}

/**
 * Decode an HPS stream and repeat it to cover a video's duration.
 *
 * The paired music is shorter than the movie it plays under — `swm_15min` runs
 * 845s beneath a 1,676s film — because the game loops it. HPS says where: the
 * final block's `next` offset points backwards to the loop point rather than
 * ending the chain, and {@link parseHps} reports that as `loopBlockIndex`.
 *
 * None of the four paired streams actually declares a loop point — every one
 * ends its block chain — yet all four are shorter than the movie they play
 * under, and `swm_15min` sits at 1.98 passes of a 1,676s film, which is two
 * loops and a rounding error. Music that stops half way through a 28-minute
 * attract loop is not what the game does, so the track is repeated to fill the
 * duration and the last pass is cut off wherever the video ends.
 *
 * The repeat starts from the beginning. That can leave an audible seam at the
 * join, which is the honest cost of not knowing the intended loop point.
 */
function loopHpsToDuration(
	hpsBytes: Uint8Array,
	seconds: number,
): ReturnType<typeof decodeThpAudio> | null {
	const file = parseHps(hpsBytes);
	if (!file) return null;
	const decoded = decodeHps(hpsBytes, file);
	if (!decoded || decoded.sampleCount === 0) return null;

	const { channelCount, sampleRate } = decoded;
	const wanted = Math.ceil(seconds * sampleRate);
	// A shortfall of under a second means the music simply finishes just before
	// the picture does, which is what the game does; restarting the track for a
	// fraction of a second would be an audible blip where there should be none.
	const REPEAT_THRESHOLD_SECONDS = 1;
	if (wanted <= decoded.sampleCount + REPEAT_THRESHOLD_SECONDS * sampleRate) {
		return {
			channelCount,
			sampleRate,
			sampleCount: decoded.sampleCount,
			samples: decoded.samples,
		};
	}

	// Repeated from the start rather than from the loop point. HPS marks where
	// the chain rejoins, but as a block index over ADPCM data, and converting
	// that to a sample offset means assuming a frame layout this code has not
	// verified. Repeating the whole track can put a seam at the join; guessing
	// the loop point wrong would put one in the middle of the music.
	const out = new Int16Array(wanted * channelCount);
	let filled = 0;
	while (filled < wanted) {
		const take = Math.min(decoded.sampleCount, wanted - filled);
		out.set(
			decoded.samples.subarray(0, take * channelCount),
			filled * channelCount,
		);
		filled += take;
	}
	return { channelCount, sampleRate, sampleCount: wanted, samples: out };
}

/** Encode any {@link JpegVideoSource} into a streaming MP4. */
function streamSourceToMp4(
	source: JpegVideoSource,
	onProgress: ThpEncodeOptions['onProgress'],
	signal: AbortSignal | undefined,
): ThpStreamHandle {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new ThpWebCodecsUnavailableError();
	}
	if (typeof MediaSource === 'undefined') {
		throw new ThpMediaSourceUnavailableError();
	}

	const mediaSource = new MediaSource();
	const mediaSourceUrl = URL.createObjectURL(mediaSource);

	let infoResolve!: (i: ThpStreamInfo) => void;
	let infoReject!: (e: Error) => void;
	const info = new Promise<ThpStreamInfo>((resolve, reject) => {
		infoResolve = resolve;
		infoReject = reject;
	});

	const done = (async (): Promise<ThpStreamResult> => {
		try {
			return await runThpEncode(
				{ source, onProgress, signal },
				mediaSource,
				infoResolve,
			);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			infoReject(e);
			throw e;
		}
	})();

	return { mediaSourceUrl, info, done };
}

/** Stream a Melee `.mth` movie into a playable MP4. */
export function streamMthToMp4(options: MthEncodeOptions): ThpStreamHandle {
	return streamSourceToMp4(
		mthSource(options.mthBytes, options.hpsBytes, options.rateTable),
		options.onProgress,
		options.signal,
	);
}

export function streamThpToMp4(options: ThpEncodeOptions): ThpStreamHandle {
	return streamSourceToMp4(
		thpSource(options.thpBytes),
		options.onProgress,
		options.signal,
	);
}

async function runThpEncode(
	options: { source: JpegVideoSource; onProgress?: ThpEncodeOptions['onProgress']; signal?: AbortSignal },
	mediaSource: MediaSource,
	onInfoReady: (i: ThpStreamInfo) => void,
): Promise<ThpStreamResult> {
	const { source, onProgress, signal } = options;
	signal?.throwIfAborted();

	if (source.frameCount === 0) {
		throw new ThpParseError(`This ${source.label} has no frames`);
	}

	// H.264 requires even dimensions; both containers are typically already even
	// but crop rather than pad so we never invent pixels.
	const codedWidth = source.width & ~1;
	const codedHeight = source.height & ~1;
	if (codedWidth < 2 || codedHeight < 2) {
		throw new ThpParseError(
			`${source.label} frame size ${source.width}x${source.height} is too small to encode`,
		);
	}

	const { config: videoConfig, mseMime: videoMime } = await pickVideoConfig(
		codedWidth,
		codedHeight,
		source.fps,
	);
	signal?.throwIfAborted();

	// Decode the whole audio track up front. It's pure JS over already-in-memory
	// bytes and costs a fraction of the video work, and having it complete makes
	// the pacing loop below trivial.
	const audio = source.audio;
	const audioPick =
		audio && audio.sampleCount > 0
			? await pickAudioConfig(
					audio.channelCount,
					audio.sampleRate,
					videoConfig.codec,
				)
			: null;
	const mseMime = audioPick ? audioPick.mseMime : videoMime;

	const info: ThpStreamInfo = {
		width: source.width,
		height: source.height,
		codedWidth,
		codedHeight,
		fps: source.fps,
		frameCount: source.frameCount,
		hasAudio: audio !== null && audio.sampleCount > 0,
		audioChannels: audio?.channelCount,
		audioSampleRate: audio?.sampleRate,
		audioCodec: audioPick?.codec ?? null,
		durationUs: Math.round((source.frameCount / source.fps) * 1e6),
	};
	onInfoReady(info);

	// Wait for a `<video>` to attach before adding a SourceBuffer. Without the
	// timeout an abandoned preview would leak the encoder until the tab closes.
	await new Promise<void>((resolve, reject) => {
		if (mediaSource.readyState === 'open') {
			resolve();
			return;
		}
		const onOpen = () => {
			clearTimeout(timer);
			resolve();
		};
		mediaSource.addEventListener('sourceopen', onOpen, { once: true });
		const timer = setTimeout(() => {
			mediaSource.removeEventListener('sourceopen', onOpen);
			reject(
				new Error(
					'MediaSource never opened — no <video> element was mounted within 10s',
				),
			);
		}, SOURCE_OPEN_TIMEOUT_MS);
	});
	signal?.throwIfAborted();

	if (!MediaSource.isTypeSupported(mseMime)) {
		throw new ThpH264UnavailableError(`MediaSource rejected "${mseMime}"`);
	}
	const sourceBuffer = mediaSource.addSourceBuffer(mseMime);
	try {
		sourceBuffer.mode = 'segments';
	} catch {
		// Older browsers already default to 'segments'.
	}
	const queue = createSourceBufferQueue(sourceBuffer);

	// Capture the MP4 at box granularity and coalesce into atomic MSE segments:
	// `ftyp`+`moov` once as the init segment, then each `moof`+`mdat` pair.
	const blobParts: Uint8Array<ArrayBuffer>[] = [];
	let pendingFtyp: Uint8Array | null = null;
	let pendingMoov: Uint8Array | null = null;
	let pendingMoof: Uint8Array | null = null;
	const copyOf = (d: Uint8Array): Uint8Array<ArrayBuffer> => {
		const c = new Uint8Array(d.byteLength) as Uint8Array<ArrayBuffer>;
		c.set(d);
		return c;
	};
	const emit = (segment: Uint8Array<ArrayBuffer>): void => {
		blobParts.push(segment);
		queue.push(segment);
	};
	const flushInit = (): void => {
		if (signal?.aborted || !pendingFtyp || !pendingMoov) return;
		const seg = new Uint8Array(
			pendingFtyp.byteLength + pendingMoov.byteLength,
		) as Uint8Array<ArrayBuffer>;
		seg.set(pendingFtyp, 0);
		seg.set(pendingMoov, pendingFtyp.byteLength);
		pendingFtyp = null;
		pendingMoov = null;
		emit(seg);
	};

	const output = new Output({
		target: new NullTarget(),
		format: new Mp4OutputFormat({
			fastStart: 'fragmented',
			// Short fragments so playback can start promptly.
			minimumFragmentDuration: 0.5,
			onFtyp: (d) => {
				pendingFtyp = copyOf(d);
				flushInit();
			},
			onMoov: (d) => {
				pendingMoov = copyOf(d);
				flushInit();
			},
			onMoof: (d) => {
				pendingMoof = copyOf(d);
			},
			onMdat: (d) => {
				if (signal?.aborted || !pendingMoof) return;
				const seg = new Uint8Array(
					pendingMoof.byteLength + d.byteLength,
				) as Uint8Array<ArrayBuffer>;
				seg.set(pendingMoof, 0);
				seg.set(d, pendingMoof.byteLength);
				pendingMoof = null;
				emit(seg);
			},
		}),
	});

	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource, { frameRate: Math.max(1, Math.round(source.fps)) });
	let audioSource: EncodedAudioPacketSource | null = null;
	if (audioPick && audio) {
		audioSource = new EncodedAudioPacketSource(audioPick.codec);
		output.addAudioTrack(audioSource);
	}
	await output.start();
	signal?.throwIfAborted();

	// WebCodecs delivers chunks on synchronous callbacks while Mediabunny's
	// `add()` is async, so serialise packets through a promise chain rather than
	// awaiting inside the callback.
	let pump: Promise<void> = Promise.resolve();
	let firstVideo = true;
	let firstAudio = true;
	let failure: Error | null = null;
	const chain = (fn: () => Promise<void>): void => {
		pump = pump.then(fn).catch((err) => {
			failure ??= err instanceof Error ? err : new Error(String(err));
		});
	};

	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			const isFirst = firstVideo;
			firstVideo = false;
			chain(async () => {
				await videoSource.add(
					toPacket(chunk),
					isFirst ? (meta as never) : undefined,
				);
			});
		},
		error: (err) => {
			failure ??= err;
		},
	});
	encoder.configure(videoConfig);

	let audioEncoder: AudioEncoder | null = null;
	if (audioPick && audio && audioSource) {
		const src = audioSource;
		audioEncoder = new AudioEncoder({
			output: (chunk, meta) => {
				const isFirst = firstAudio;
				firstAudio = false;
				chain(async () => {
					await src.add(toPacket(chunk), isFirst ? (meta as never) : undefined);
				});
			},
			error: (err) => {
				failure ??= err;
			},
		});
		audioEncoder.configure(audioPick.config);
	}

	const keyEvery = Math.max(1, Math.round(source.fps * KEYFRAME_INTERVAL_SECONDS));
	const frameDurationUs = 1e6 / source.fps;
	let audioCursor = 0; // samples per channel already submitted
	let batchStart = performance.now();
	let batchFrames = 0;

	try {
		for (let frameIndex = 0; frameIndex < source.frameCount; frameIndex++) {
			signal?.throwIfAborted();
			if (failure) throw failure;

			const jpeg = source.jpegAt(frameIndex);
			if (!jpeg) continue;

			// The browser's own JPEG decoder. `thpFrameJpeg` has already
			// rebuilt the frame into a standards-compliant JPEG (THP omits
			// entropy byte-stuffing, which every browser rejects) and returns a
			// fresh buffer, so no further copy is needed here.
			const bitmap = await createImageBitmap(
				new Blob([jpeg as BlobPart], { type: 'image/jpeg' }),
			);
			const timestamp = Math.round(
				source.timestampUsAt
					? source.timestampUsAt(frameIndex)
					: frameIndex * frameDurationUs,
			);
			// A held frame lasts until the next one starts.
			const thisFrameUs = source.timestampUsAt
				? (frameIndex + 1 < source.frameCount
						? source.timestampUsAt(frameIndex + 1)
						: source.timestampUsAt(frameIndex) + frameDurationUs) - timestamp
				: frameDurationUs;
			const vf = new VideoFrame(bitmap, {
				timestamp,
				duration: Math.max(1, Math.round(thisFrameUs)),
			});
			try {
				encoder.encode(vf, { keyFrame: frameIndex % keyEvery === 0 });
			} finally {
				vf.close();
				bitmap.close();
			}

			// Feed the audio that belongs alongside this frame, keeping the two
			// clocks independent (see the module comment on sync).
			if (audioEncoder && audio) {
				const wantedBySample = Math.min(
					audio.sampleCount,
					Math.round(((timestamp + thisFrameUs) * audio.sampleRate) / 1e6),
				);
				while (audioCursor < wantedBySample) {
					const take = Math.min(AUDIO_CHUNK_SAMPLES, wantedBySample - audioCursor);
					const slice = audio.samples.subarray(
						audioCursor * audio.channelCount,
						(audioCursor + take) * audio.channelCount,
					);
					const data = new AudioData({
						format: 's16',
						sampleRate: audio.sampleRate,
						numberOfFrames: take,
						numberOfChannels: audio.channelCount,
						timestamp: Math.round((audioCursor / audio.sampleRate) * 1e6),
						data: slice.slice(),
					});
					try {
						audioEncoder.encode(data);
					} finally {
						data.close();
					}
					audioCursor += take;
				}
			}

			// Bound memory: let the encoder catch up if it falls behind.
			if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
				await encoder.flush();
			}

			batchFrames++;
			if (batchFrames >= 16) {
				const now = performance.now();
				onProgress?.({
					frame: frameIndex,
					total: source.frameCount,
					fps: (batchFrames * 1000) / Math.max(1, now - batchStart),
				});
				batchStart = now;
				batchFrames = 0;
			}
		}

		// Any remaining audio (the track can outlast the video).
		if (audioEncoder && audio) {
			while (audioCursor < audio.sampleCount) {
				const take = Math.min(AUDIO_CHUNK_SAMPLES, audio.sampleCount - audioCursor);
				const slice = audio.samples.subarray(
					audioCursor * audio.channelCount,
					(audioCursor + take) * audio.channelCount,
				);
				const data = new AudioData({
					format: 's16',
					sampleRate: audio.sampleRate,
					numberOfFrames: take,
					numberOfChannels: audio.channelCount,
					timestamp: Math.round((audioCursor / audio.sampleRate) * 1e6),
					data: slice.slice(),
				});
				try {
					audioEncoder.encode(data);
				} finally {
					data.close();
				}
				audioCursor += take;
			}
		}

		await encoder.flush();
		if (audioEncoder) await audioEncoder.flush();
		await pump;
		if (failure) throw failure;

		await output.finalize();
		await pump;
		if (failure) throw failure;

		await queue.drained();
		if (mediaSource.readyState === 'open') {
			try {
				mediaSource.endOfStream();
			} catch {
				// Racing an aborted preview; harmless.
			}
		}

		return {
			mp4: new Blob(blobParts as BlobPart[], { type: 'video/mp4' }),
			info,
		};
	} finally {
		queue.close();
		try {
			if (encoder.state !== 'closed') encoder.close();
		} catch {
			/* already torn down */
		}
		try {
			if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
		} catch {
			/* already torn down */
		}
	}
}
