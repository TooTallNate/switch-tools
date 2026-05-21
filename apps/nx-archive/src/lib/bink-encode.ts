/**
 * Decode-and-stream pipeline for Bink (`.bik`) and Bink 2 (`.bk2`)
 * files. Re-encodes them to fragmented H.264 / AAC MP4 and feeds
 * the fragments into a `<video>` element via MediaSource Extensions
 * so playback starts within ~1 frame's worth of work — without
 * waiting for the full decode pass to finish.
 *
 *   1. The dpkg-style `@tootallnate/ffmpeg-wasm` (LGPL-only) decodes
 *      frames sequentially. The base WASM ships zero codecs; we load
 *      4 extensions at create time:
 *        - bink-demuxer (shared container)
 *        - bink-video   (Bink 1)
 *        - bink2-video  (Bink 2)
 *        - bink-audio   (binkaudio RDFT + DCT)
 *      The wrapper auto-picks the right codec per-stream based on the
 *      demuxer's `codec_id` field — same code path for .bik and .bk2.
 *   2. Each decoded YUV420p frame becomes a WebCodecs `VideoFrame`,
 *      run through `VideoEncoder` (hardware-accelerated H.264) into
 *      `EncodedVideoChunk`s.
 *   3. The same iteration drains audio samples that decoded since the
 *      last video frame, packages them as `AudioData`, and feeds them
 *      to `AudioEncoder` (AAC, falling back to Opus).
 *   4. Encoded chunks are converted to Mediabunny `EncodedPacket`s
 *      and fed to `EncodedVideoPacketSource` / `EncodedAudioPacketSource`
 *      on a Mediabunny `Output` configured with `Mp4OutputFormat`
 *      (`fastStart: 'fragmented'`). The output streams its bytes via
 *      `StreamTarget` to a `WritableStream` that splits each chunk
 *      two ways: into the in-memory accumulator (for the "Save .mp4"
 *      Blob) and into the MediaSource's `SourceBuffer` (for the
 *      live `<video>` playback).
 *   5. Fragments are appended as they arrive; the `<video>` plays
 *      from the MediaSource. The browser's media stack handles
 *      buffering, seeking (within the already-appended range), and
 *      playback timing.
 *
 * Replaces the previous monolithic `bink1-encode.ts` (LGPL FFmpeg
 * monolith @tootallnate/bink1-wasm) and `bink2-encode.ts` (GPL-3
 * cnc-ra-libs @tootallnate/bink2-wasm). The new stack is LGPL-only so
 * the WASMs can be shipped directly — no more "user must provide
 * bink2.wasm" friction.
 *
 * Muxing migrated from `mp4-muxer` (deprecated) to `mediabunny`
 * (same author, broader scope, supersedes both `mp4-muxer` and
 * `webm-muxer`).
 */

import {
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedVideoPacketSource,
	Mp4OutputFormat,
	NullTarget,
	Output,
} from 'mediabunny'

import {
	Ffmpeg,
	FfmpegError,
	type FfmpegFrame,
	type FfmpegInfo,
} from '@tootallnate/ffmpeg-wasm'

/** Per-frame progress callback. */
export interface BinkEncodeProgress {
	/** 0-indexed frame just completed. */
	frame: number
	/** Total frame count for this video. */
	total: number
	/** Decode+encode rate measured over the last batch (fps). */
	fps: number
}

/**
 * Which Bink video codec to load. We load only the one we need
 * (Bink 1 ≈ 52 KB, Bink 2 ≈ 99 KB) — the shared base + demuxer +
 * audio modules are cached separately and used by both.
 */
export type BinkVideoFormat = 'bink1' | 'bink2'

/** Container metadata produced by `ff.open()`, surfaced once known. */
export interface BinkStreamInfo {
	width: number
	height: number
	/** Encoded MP4's coded width (rounded down to even px). */
	codedWidth: number
	/** Encoded MP4's coded height (rounded down to even px). */
	codedHeight: number
	fps: number
	frameCount: number
	hasAudio: boolean
	audioChannels?: number
	audioSampleRate?: number
	/** Codec actually picked for audio, or `null` when no audio was muxed. */
	audioCodec: 'aac' | 'opus' | null
	/** Microseconds in the encoded video. */
	durationUs: number
}

/** Result handed back when encoding completes (resolves `done`). */
export interface BinkStreamResult {
	/** The fully-encoded MP4 file, ready for a "Save .mp4" download. */
	mp4: Blob
	info: BinkStreamInfo
}

export interface BinkEncodeOptions {
	/** Which video codec to load + use for this file. */
	format: BinkVideoFormat
	/** The `.bik` (bink1) or `.bk2` (bink2) file bytes. */
	binkBytes: Uint8Array
	/** Progress callback (fires every ~16 frames). */
	onProgress?: (p: BinkEncodeProgress) => void
	/** Aborts decoding mid-flight when fired. */
	signal?: AbortSignal
}

/**
 * Handle returned synchronously from `streamBinkToMp4` so the caller
 * can wire `<video src={mediaSourceUrl}>` immediately, before any
 * actual decoding starts.
 */
export interface BinkStreamHandle {
	/**
	 * `URL.createObjectURL` of a MediaSource the `<video>` should
	 * play. Caller MUST `URL.revokeObjectURL` after unmounting.
	 */
	mediaSourceUrl: string
	/**
	 * Resolves with container metadata once `ff.open()` returns
	 * (typically within the first ~50ms). Useful for setting the
	 * `<video>`'s aspect ratio before the first fragment arrives.
	 */
	info: Promise<BinkStreamInfo>
	/**
	 * Resolves with the fully-encoded MP4 Blob once encoding
	 * completes. Used for the "Save .mp4" download button.
	 */
	done: Promise<BinkStreamResult>
}

/** Thrown when the host browser lacks WebCodecs (Safari < 16.4, etc.). */
export class WebCodecsUnavailableError extends Error {
	constructor() {
		super(
			'WebCodecs is not available in this browser. ' +
				'Bink preview requires Safari 16.4+, Chrome/Edge, or Firefox 130+.',
		)
		this.name = 'WebCodecsUnavailableError'
	}
}

/**
 * Thrown when the host browser lacks MediaSource Extensions. We use
 * MSE for progressive playback — without it we'd have to fall back
 * to buffering the entire encode in memory before mounting `<video>`.
 */
export class MediaSourceUnavailableError extends Error {
	constructor() {
		super(
			"This browser doesn't support MediaSource Extensions. " +
				'Bink streaming preview requires Chrome/Edge, Firefox, ' +
				'or Safari 8+.',
		)
		this.name = 'MediaSourceUnavailableError'
	}
}

/** Thrown when the encoder can't accept the requested H.264 config. */
export class H264UnavailableError extends Error {
	constructor(configName: string) {
		super(
			`This browser's VideoEncoder doesn't support ${configName}. Bink preview is unavailable.`,
		)
		this.name = 'H264UnavailableError'
	}
}

/**
 * Thrown when ffmpeg's bink2 decoder rejects a frame it can't
 * handle. The two known failure modes — both upstream FFmpeg
 * limitations, not bugs in this stack — are:
 *
 *   - KB2n + alpha channel: Paul B Mahol's bink2 patch covers
 *     versions 'f'..'n' but the alpha-channel path was never
 *     adapted to KB2n's slightly different slice layout. The
 *     decoder returns AVERROR_INVALIDDATA on the first frame.
 *
 *   - Corrupt / truncated files: rare in practice but possible
 *     for files that were repacked outside the original game's
 *     toolchain.
 *
 * Surfaced specifically so the preview UI can render a friendly
 * "this codec variant isn't yet supported" message instead of
 * the raw ffmpeg error code.
 */
export class BinkDecodeError extends Error {
	readonly avError: number
	constructor(format: 'bink1' | 'bink2', avError: number, errorName: string) {
		const label = format === 'bink2' ? 'Bink 2' : 'Bink 1'
		super(
			`The ${label} decoder rejected this file (${errorName}). ` +
				(errorName === 'INVALIDDATA'
					? `Some ${label} variants — particularly KB2n with an ` +
						`alpha channel — aren't supported by the upstream ` +
						`FFmpeg patch this preview uses. Reference FFmpeg builds ` +
						`reject the same files.`
					: `This usually indicates the source file is truncated or ` +
						`encoded with an unsupported codec variant.`),
		)
		this.name = 'BinkDecodeError'
		this.avError = avError
	}
}

/**
 * Audio codec candidates. AAC-LC inside MP4 is the most
 * universally-playable choice, but several browsers won't *encode*
 * AAC (Safari < 18.4, certain Firefox builds). Opus inside MP4 is
 * widely playable too (Safari 17.4+, Chrome/Edge, Firefox) and
 * encodes everywhere, making it our fallback.
 *
 * Audio failure is non-fatal — if neither encoder will start we ship
 * video-only and surface `audioCodec: null` to the caller.
 *
 * **MSE caveat**: MediaSource's `sourceBuffer` requires the audio
 * codec inside the codecs string. AAC is `mp4a.40.2`; Opus inside
 * MP4 is `Opus`. We pass both through to `isTypeSupported` to pick
 * the best one the browser can both ENCODE and PLAY.
 */
const AUDIO_CANDIDATES: Array<{
	kind: 'aac' | 'opus'
	codec: string
	muxerCodec: 'aac' | 'opus'
	/** Codecs string MSE wants for `isTypeSupported`. */
	mseCodec: string
}> = [
	{ kind: 'aac', codec: 'mp4a.40.2', muxerCodec: 'aac', mseCodec: 'mp4a.40.2' },
	{ kind: 'opus', codec: 'opus', muxerCodec: 'opus', mseCodec: 'opus' },
]

async function pickAudioConfig(
	sampleRate: number,
	channels: number,
): Promise<
	| {
			config: AudioEncoderConfig
			muxerCodec: 'aac' | 'opus'
			mseCodec: string
	  }
	| null
> {
	if (typeof AudioEncoder === 'undefined') return null
	for (const candidate of AUDIO_CANDIDATES) {
		const config: AudioEncoderConfig = {
			codec: candidate.codec,
			sampleRate,
			numberOfChannels: channels,
			bitrate: 128_000,
		}
		try {
			const support = await AudioEncoder.isConfigSupported(config)
			if (support.supported && support.config) {
				return {
					config: support.config,
					muxerCodec: candidate.muxerCodec,
					mseCodec: candidate.mseCodec,
				}
			}
		} catch {
			// fall through to the next candidate
		}
	}
	return null
}

/**
 * H.264 (avc1) codec strings tried in order from highest profile to
 * "should always work". We additionally probe each candidate against
 * `MediaSource.isTypeSupported` so the picked profile is one MSE can
 * both decode AND the encoder can produce.
 */
const H264_CANDIDATES = [
	// Main profile, level 5.1 — supports 1920×1080@60.
	'avc1.4d0033',
	// Main profile, level 4.0 — supports 1920×1080@30.
	'avc1.4d0028',
	// Baseline profile, level 5.1 — universal fallback.
	'avc1.42E033',
	// Baseline profile, level 3.1 — ultra-portable.
	'avc1.42E01F',
] as const

async function pickH264Config(
	width: number,
	height: number,
	fps: number,
	audioMseCodec: string | null,
): Promise<{ config: VideoEncoderConfig; mseMime: string }> {
	const bitsPerSecond = Math.round(width * height * fps * 0.12)
	for (const codec of H264_CANDIDATES) {
		const config: VideoEncoderConfig = {
			codec,
			width,
			height,
			bitrate: bitsPerSecond,
			framerate: fps,
			avc: { format: 'avc' },
			// 'realtime' tells the encoder to emit chunks as soon as
			// they're ready instead of buffering frames for deeper
			// lookahead / rate control. We trade a small amount of
			// compression efficiency for the ability to stream
			// fragments into MediaSource progressively. Without this,
			// the encoder buffers ~30 frames before emitting any
			// output, which means the muxer can't close fragments,
			// which means MSE has nothing to play after the first
			// fragment lands.
			latencyMode: 'realtime',
		}
		// Build the MSE codecs string. Adding audio raises the bar — we
		// need a combo MSE can decode AS A WHOLE, not just the video.
		const codecs = audioMseCodec ? `${codec}, ${audioMseCodec}` : codec
		const mseMime = `video/mp4; codecs="${codecs}"`
		try {
			const support = await VideoEncoder.isConfigSupported(config)
			if (
				support.supported &&
				support.config &&
				MediaSource.isTypeSupported(mseMime)
			) {
				return { config: support.config, mseMime }
			}
		} catch {
			// Some browsers throw on unsupported codec strings instead
			// of returning `{ supported: false }`. Treat both alike.
		}
	}
	throw new H264UnavailableError(
		`any of avc1 main/baseline @ levels 3.1–5.1 (audio=${audioMseCodec ?? 'none'})`,
	)
}

/**
 * Convert an FfmpegFrame (YUV420p, may be aligned-stride) to a
 * WebCodecs VideoFrame cropped to `width × height`. The Bink
 * decoders return planes whose stride may exceed the visible width
 * (Bink 2 in particular aligns to 32px); we compact to a tight I420
 * layout row-by-row.
 */
function frameToVideoFrame(
	frame: FfmpegFrame,
	width: number,
	height: number,
	timestampUs: number,
	durationUs: number,
): VideoFrame {
	const cw = (width + 1) >> 1
	const ch = (height + 1) >> 1
	const ySize = width * height
	const cSize = cw * ch
	const buf = new Uint8Array(ySize + 2 * cSize)
	for (let y = 0; y < height; y++) {
		buf.set(
			frame.y.subarray(y * frame.yStride, y * frame.yStride + width),
			y * width,
		)
	}
	for (let y = 0; y < ch; y++) {
		buf.set(
			frame.u.subarray(y * frame.uStride, y * frame.uStride + cw),
			ySize + y * cw,
		)
	}
	for (let y = 0; y < ch; y++) {
		buf.set(
			frame.v.subarray(y * frame.vStride, y * frame.vStride + cw),
			ySize + cSize + y * cw,
		)
	}
	return new VideoFrame(buf, {
		format: 'I420',
		codedWidth: width,
		codedHeight: height,
		timestamp: timestampUs,
		duration: durationUs,
		layout: [
			{ offset: 0, stride: width },
			{ offset: ySize, stride: cw },
			{ offset: ySize + cSize, stride: cw },
		],
	})
}

/**
 * Convert a WebCodecs `EncodedVideoChunk` (`VideoEncoder.output`'s
 * deliverable) into a Mediabunny `EncodedPacket`. Mediabunny
 * timestamps are in seconds; WebCodecs uses microseconds.
 */
function encodedVideoChunkToPacket(chunk: EncodedVideoChunk): EncodedPacket {
	const data = new Uint8Array(chunk.byteLength)
	chunk.copyTo(data)
	return new EncodedPacket(
		data,
		chunk.type, // 'key' | 'delta'
		chunk.timestamp / 1_000_000,
		(chunk.duration ?? 0) / 1_000_000,
	)
}

/**
 * Convert a WebCodecs `EncodedAudioChunk` (`AudioEncoder.output`'s
 * deliverable) into a Mediabunny `EncodedPacket`. Audio chunks
 * from compressed codecs (AAC, Opus) are always 'key' frames.
 */
function encodedAudioChunkToPacket(chunk: EncodedAudioChunk): EncodedPacket {
	const data = new Uint8Array(chunk.byteLength)
	chunk.copyTo(data)
	return new EncodedPacket(
		data,
		chunk.type, // always 'key' for AAC / Opus
		chunk.timestamp / 1_000_000,
		(chunk.duration ?? 0) / 1_000_000,
	)
}

/*
 * --------------------------------------------------------------------
 * WASM module cache
 * --------------------------------------------------------------------
 *
 * The base + extension WebAssembly modules are fetched + compiled
 * on first preview and reused across previews for the page lifetime.
 * Per-format video codecs are lazy: `.bik` skips bink2-video.so and
 * vice versa.
 */
interface SharedModules {
	baseModule: WebAssembly.Module
	demuxerModule: WebAssembly.Module
	binkAudioModule: WebAssembly.Module
}

let sharedPromise: Promise<SharedModules> | null = null
let binkVideoPromise: Promise<WebAssembly.Module> | null = null
let bink2VideoPromise: Promise<WebAssembly.Module> | null = null

async function fetchAndCompile(url: string): Promise<WebAssembly.Module> {
	const resp = await fetch(url)
	if (!resp.ok) {
		throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`)
	}
	// Vite serves `.so` as application/octet-stream which fails
	// `compileStreaming`'s MIME check. Fall back to arrayBuffer().
	const buf = await resp.arrayBuffer()
	return WebAssembly.compile(buf)
}

async function getSharedModules(): Promise<SharedModules> {
	if (sharedPromise) return sharedPromise
	sharedPromise = (async () => {
		const [baseUrl, demuxerUrl, audioUrl] = await Promise.all([
			import('@tootallnate/ffmpeg-wasm/ffmpeg.wasm?url'),
			import('@tootallnate/ffmpeg-bink-demuxer-wasm/bink-demuxer.so?url'),
			import('@tootallnate/ffmpeg-bink-audio-wasm/bink-audio.so?url'),
		])
		const [baseModule, demuxerModule, binkAudioModule] = await Promise.all([
			fetchAndCompile(baseUrl.default),
			fetchAndCompile(demuxerUrl.default),
			fetchAndCompile(audioUrl.default),
		])
		return { baseModule, demuxerModule, binkAudioModule }
	})()
	try {
		return await sharedPromise
	} catch (err) {
		sharedPromise = null
		throw err
	}
}

async function getBinkVideoModule(): Promise<WebAssembly.Module> {
	if (binkVideoPromise) return binkVideoPromise
	binkVideoPromise = (async () => {
		const url = await import(
			'@tootallnate/ffmpeg-bink-video-wasm/bink-video.so?url'
		)
		return fetchAndCompile(url.default)
	})()
	try {
		return await binkVideoPromise
	} catch (err) {
		binkVideoPromise = null
		throw err
	}
}

async function getBink2VideoModule(): Promise<WebAssembly.Module> {
	if (bink2VideoPromise) return bink2VideoPromise
	bink2VideoPromise = (async () => {
		const url = await import(
			'@tootallnate/ffmpeg-bink2-video-wasm/bink2-video.so?url'
		)
		return fetchAndCompile(url.default)
	})()
	try {
		return await bink2VideoPromise
	} catch (err) {
		bink2VideoPromise = null
		throw err
	}
}

/*
 * --------------------------------------------------------------------
 * MediaSource append queue
 * --------------------------------------------------------------------
 *
 * `SourceBuffer.appendBuffer()` is single-threaded — only one append
 * may be in flight at a time, and the next must wait for an
 * `updateend` event. The encoder produces fragments asynchronously
 * (in arbitrary timing relative to MSE's update cycle), so we queue
 * them and drain as fast as the SourceBuffer allows.
 */
function createSourceBufferQueue(sb: SourceBuffer): {
	push: (data: Uint8Array<ArrayBuffer>) => void
	drained: () => Promise<void>
	close: () => void
} {
	const queue: Uint8Array<ArrayBuffer>[] = []
	let updating = false
	let closed = false
	let drainedResolve: (() => void) | null = null

	const tryDrain = (): void => {
		if (updating || closed) return
		if (queue.length === 0) {
			if (drainedResolve) {
				drainedResolve()
				drainedResolve = null
			}
			return
		}
		const next = queue.shift()!
		updating = true
		try {
			sb.appendBuffer(next)
		} catch (err) {
			// QuotaExceededError can happen if the buffer is fuller
			// than the browser is willing to keep around. Put the
			// chunk back and retry once an update completes — the
			// browser will have evicted old samples by then.
			if (err instanceof DOMException && err.name === 'QuotaExceededError') {
				queue.unshift(next)
				updating = false
				return
			}
			throw err
		}
	}

	sb.addEventListener('updateend', () => {
		updating = false
		tryDrain()
	})

	return {
		push(data: Uint8Array<ArrayBuffer>): void {
			if (closed) return
			queue.push(data)
			tryDrain()
		},
		drained(): Promise<void> {
			if (!updating && queue.length === 0) return Promise.resolve()
			return new Promise<void>((resolve) => {
				drainedResolve = resolve
			})
		},
		close(): void {
			closed = true
			queue.length = 0
			if (drainedResolve) {
				drainedResolve()
				drainedResolve = null
			}
		},
	}
}

/*
 * --------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------
 */

/**
 * Decode a Bink (.bik) or Bink 2 (.bk2) file and stream its
 * re-encoded H.264 / AAC MP4 output through MediaSource Extensions
 * so a `<video>` can start playing within ~1 frame's worth of work
 * (typically under 100 ms after the call).
 *
 * Returns synchronously with a `mediaSourceUrl` to assign to
 * `<video src>` immediately. The actual decode runs in the
 * background; progress fires via `onProgress`; `info` resolves with
 * container metadata after `ff.open()` returns; `done` resolves with
 * the final Blob (for a "Save .mp4" download button) when encoding
 * completes.
 *
 * Cancellation: pass an `AbortSignal`. Aborting closes the
 * MediaSource and unwinds the encoder cleanly. The caller should
 * `URL.revokeObjectURL(mediaSourceUrl)` when the `<video>` unmounts.
 */
export function streamBinkToMp4(options: BinkEncodeOptions): BinkStreamHandle {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new WebCodecsUnavailableError()
	}
	if (typeof MediaSource === 'undefined') {
		throw new MediaSourceUnavailableError()
	}

	const mediaSource = new MediaSource()
	const mediaSourceUrl = URL.createObjectURL(mediaSource)

	let infoResolve!: (info: BinkStreamInfo) => void
	let infoReject!: (err: Error) => void
	const infoPromise = new Promise<BinkStreamInfo>((resolve, reject) => {
		infoResolve = resolve
		infoReject = reject
	})

	// Kick off the actual encode pipeline. We do this AFTER returning
	// the handle so the caller can wire `<video src>` first; the
	// MediaSource's `sourceopen` event then fires on the next tick.
	const donePromise = (async (): Promise<BinkStreamResult> => {
		try {
			return await runStreamingEncode(options, mediaSource, (info) => {
				infoResolve(info)
			})
		} catch (err) {
			infoReject(err instanceof Error ? err : new Error(String(err)))
			throw err
		}
	})()

	return {
		mediaSourceUrl,
		info: infoPromise,
		done: donePromise,
	}
}

/**
 * Inner pipeline. Split out from `streamBinkToMp4` so the latter can
 * stay short and the heavy logic lives in an async function with
 * `try/finally` for cleanup.
 */
async function runStreamingEncode(
	options: BinkEncodeOptions,
	mediaSource: MediaSource,
	onInfoReady: (info: BinkStreamInfo) => void,
): Promise<BinkStreamResult> {
	const { format, binkBytes, onProgress, signal } = options
	signal?.throwIfAborted()

	// Wait for the MediaSource to be in the 'open' state before we
	// can add a SourceBuffer. The transition fires once *something*
	// (a `<video src=mediaSourceUrl>` element) starts fetching the
	// URL. The caller is expected to mount such a `<video>`
	// immediately after `streamBinkToMp4` returns — if they don't
	// within `SOURCE_OPEN_TIMEOUT_MS` we treat the preview as
	// abandoned and bail out. Without a timeout an unmounted
	// preview would leak the encoder + WASM instance until the tab
	// closes.
	const SOURCE_OPEN_TIMEOUT_MS = 10_000
	const sourceOpen = new Promise<void>((resolve, reject) => {
		if (mediaSource.readyState === 'open') {
			resolve()
			return
		}
		const onOpen = (): void => {
			clearTimeout(timer)
			resolve()
		}
		mediaSource.addEventListener('sourceopen', onOpen, { once: true })
		const timer = setTimeout(() => {
			mediaSource.removeEventListener('sourceopen', onOpen)
			reject(
				new Error(
					'MediaSource never opened — the <video> element was never mounted, ' +
						'or it took longer than 10s to do so',
				),
			)
		}, SOURCE_OPEN_TIMEOUT_MS)
	})

	// Load shared modules + format-specific video codec in parallel.
	const [shared, videoModule] = await Promise.all([
		getSharedModules(),
		format === 'bink2' ? getBink2VideoModule() : getBinkVideoModule(),
	])
	signal?.throwIfAborted()

	const ff = await Ffmpeg.create({
		wasm: shared.baseModule,
		extensions: [
			{ name: 'bink-demuxer', wasm: shared.demuxerModule },
			{
				name: format === 'bink2' ? 'bink2-video' : 'bink-video',
				wasm: videoModule,
			},
			{ name: 'bink-audio', wasm: shared.binkAudioModule },
		],
	})

	let videoQueue: ReturnType<typeof createSourceBufferQueue> | null = null
	let cleanupAttached = false

	try {
		await ff.open(binkBytes)
		signal?.throwIfAborted()
		const ffInfo: FfmpegInfo = ff.info
		const fps = ffInfo.fpsDen > 0 ? ffInfo.fpsNum / ffInfo.fpsDen : 30
		const frameDurUs = Math.round(1_000_000 / fps)
		const evenW = ffInfo.width & ~1
		const evenH = ffInfo.height & ~1

		// Audio probe first, because the H.264 profile probe needs
		// to know whether we'll combine it with audio in the MSE
		// codecs string.
		let audioCodec: 'aac' | 'opus' | null = null
		let audioConfig: AudioEncoderConfig | null = null
		let audioMseCodec: string | null = null
		let audioChannels = 0
		let audioSampleRate = 0
		if (ffInfo.audioTracks.length > 0) {
			const track0 = ffInfo.audioTracks[0]!
			audioChannels = track0.channels
			audioSampleRate = track0.sampleRate
			const picked = await pickAudioConfig(audioSampleRate, audioChannels)
			if (picked) {
				audioCodec = picked.muxerCodec
				audioConfig = picked.config
				audioMseCodec = picked.mseCodec
			}
		}

		// Health-probe the audio track BEFORE setting up the muxer.
		//
		// Why: when an audio decoder produces samples for only a
		// fraction of the source timeline (e.g. Switch KB2n
		// binkaudio_dct, where upstream FFmpeg fails on nearly
		// every packet), the result is a fragmented MP4 whose
		// audio track has gaps. MediaSource refuses to advance
		// playback past the smallest of those gaps — so the
		// <video> stalls at e.g. 0.07s while the encoder happily
		// produces video for the next 7 minutes. Closing the
		// audio source mid-stream doesn't help either; the moov
		// already advertises an audio track, so MSE still expects
		// audio samples for the entire video duration.
		//
		// The fix is to commit upfront: decode a probe window of
		// video frames, drain audio after each, and measure the
		// audio sample yield. If it's well below what we expect
		// for `probeWindowSeconds * sampleRate * channels`, drop
		// the audio track entirely. The downstream muxer is then
		// video-only, which streams to MSE cleanly.
		//
		// Probe frames are buffered (copied out of WASM memory)
		// and replayed into the real encode pipeline below, so
		// the cost is just the extra memory for ~PROBE_FRAMES
		// frames' worth of YUV planes.
		//
		// ProbeFrame stores OWNED copies of the YUV planes — the
		// underlying `FfmpegFrame` views become invalid the
		// moment we call `ff.decodeFrame()` again.
		interface ProbeFrame {
			y: Uint8Array
			u: Uint8Array
			v: Uint8Array
			yStride: number
			uStride: number
			vStride: number
			width: number
			height: number
		}
		interface ProbeAudio {
			samples: Float32Array<ArrayBuffer>
			sampleFrames: number
		}
		const probeVideoFrames: ProbeFrame[] = []
		const probeAudioChunks: ProbeAudio[] = []
		const PROBE_FRAMES = 30 // ~1s at 30fps; plenty to judge audio health
		const AUDIO_HEALTH_THRESHOLD = 0.5 // ≥50% of expected samples
		if (audioCodec) {
			let probeAudioSampleFramesDrained = 0
			for (let i = 0; i < PROBE_FRAMES; i++) {
				let f
				try {
					f = ff.decodeFrame()
				} catch (err) {
					if (err instanceof FfmpegError && err.code !== undefined) {
						throw new BinkDecodeError(
							format,
							err.code,
							err.message.replace(
								/^ffmpeg_decode_frame failed with /,
								'',
							),
						)
					}
					throw err
				}
				if (!f) break
				probeVideoFrames.push({
					y: new Uint8Array(f.y),
					u: new Uint8Array(f.u),
					v: new Uint8Array(f.v),
					yStride: f.yStride,
					uStride: f.uStride,
					vStride: f.vStride,
					width: f.width,
					height: f.height,
				})
				const a = ff.drainAudio(0)
				if (a && a.sampleFrames > 0) {
					probeAudioChunks.push({
						samples: new Float32Array(a.samples),
						sampleFrames: a.sampleFrames,
					})
					probeAudioSampleFramesDrained += a.sampleFrames
				}
			}
			const probeWindowSeconds = probeVideoFrames.length / fps
			const expected = probeWindowSeconds * audioSampleRate
			const ratio = expected > 0 ? probeAudioSampleFramesDrained / expected : 0
			if (ratio < AUDIO_HEALTH_THRESHOLD) {
				console.warn(
					`[bink] audio track yields only ${(ratio * 100).toFixed(0)}% ` +
						`of expected samples in the first ${probeWindowSeconds.toFixed(2)}s ` +
						`(${probeAudioSampleFramesDrained} / ${expected.toFixed(0)} sample-frames). ` +
						`Dropping audio track; preview will be video-only.`,
				)
				audioCodec = null
				audioConfig = null
				audioMseCodec = null
				audioChannels = 0
				audioSampleRate = 0
				// Discard probe audio — we won't use it.
				probeAudioChunks.length = 0
			}
		}

		const { config: videoEncoderConfig, mseMime } = await pickH264Config(
			evenW,
			evenH,
			fps,
			audioMseCodec,
		)

		const info: BinkStreamInfo = {
			width: ffInfo.width,
			height: ffInfo.height,
			codedWidth: evenW,
			codedHeight: evenH,
			fps,
			frameCount: ffInfo.frameCount,
			hasAudio: audioCodec !== null,
			audioChannels: audioCodec ? audioChannels : undefined,
			audioSampleRate: audioCodec ? audioSampleRate : undefined,
			audioCodec,
			durationUs:
				ffInfo.frameCount > 0 ? ffInfo.frameCount * frameDurUs : 0,
		}
		onInfoReady(info)

		// Wait for the MediaSource to be open BEFORE wiring the
		// muxer's onData callback. `addSourceBuffer` requires it.
		await sourceOpen
		signal?.throwIfAborted()

		// Cap total duration so MSE can keep buffer eviction sane.
		if (info.durationUs > 0) {
			try {
				mediaSource.duration = info.durationUs / 1_000_000
			} catch {
				// Some browsers throw if duration is set before any
				// SourceBuffer is added; ignore and let MSE infer.
			}
		}

		const sourceBuffer = mediaSource.addSourceBuffer(mseMime)
		// Sequence mode: timestamps in the appended fragments are
		// already correct relative to t=0 (we set them ourselves in
		// the VideoFrame constructor), so MSE shouldn't recompute.
		try {
			sourceBuffer.mode = 'segments'
		} catch {
			// older browsers default to 'segments'; ignore
		}
		videoQueue = createSourceBufferQueue(sourceBuffer)

		// We assemble each MediaSource SourceBuffer append from the
		// muxer's box-level callbacks instead of using StreamTarget
		// directly. Why: MSE wants ATOMIC media segments (one moof
		// paired with its mdat) at a time, not the dozens of tiny
		// individual writes that Mediabunny's StreamTarget would
		// emit per fragment. Appending each tiny write separately
		// drops fragments out of MSE's parser, leading to playback
		// stalls.
		//
		// MediaSource fragmented-MP4 layout:
		//
		//   init segment   = ftyp + moov            ← appended once
		//   media segment  = moof + mdat            ← appended per fragment
		//
		// We hold the ftyp + moov in `initSegmentParts` until both
		// have arrived, then flush as one append. Then for each
		// (moof, mdat) pair we coalesce + flush.
		const blobParts: Uint8Array<ArrayBuffer>[] = []
		let encodeError: Error | null = null
		let pendingFtyp: Uint8Array | null = null
		let pendingMoov: Uint8Array | null = null
		let pendingMoof: Uint8Array | null = null

		const flushIfReady = (): void => {
			if (signal?.aborted) return
			if (pendingFtyp && pendingMoov) {
				const total = pendingFtyp.byteLength + pendingMoov.byteLength
				const segment = new Uint8Array(total)
				segment.set(pendingFtyp, 0)
				segment.set(pendingMoov, pendingFtyp.byteLength)
				pendingFtyp = null
				pendingMoov = null
				blobParts.push(segment)
				videoQueue?.push(segment)
			}
		}

		const output = new Output({
			// NullTarget discards the StreamTarget's monolithic
			// writes — we capture everything via the per-box
			// callbacks below.
			target: new NullTarget(),
			format: new Mp4OutputFormat({
				fastStart: 'fragmented',
				// Short fragments → low play-press latency. 0.5s
				// means the first ~15 frames (at 30fps) flush, so
				// the <video> can start playing within ~500ms of
				// encoding starting.
				minimumFragmentDuration: 0.5,
				onFtyp: (data) => {
					// Box buffers are reused — copy.
					const copy = new Uint8Array(data.byteLength)
					copy.set(data)
					pendingFtyp = copy
					flushIfReady()
				},
				onMoov: (data) => {
					const copy = new Uint8Array(data.byteLength)
					copy.set(data)
					pendingMoov = copy
					flushIfReady()
				},
				onMoof: (data) => {
					const copy = new Uint8Array(data.byteLength)
					copy.set(data)
					pendingMoof = copy
				},
				onMdat: (data) => {
					if (signal?.aborted) return
					if (!pendingMoof) {
						// Shouldn't happen in fragmented mode — moof
						// always precedes its mdat — but guard anyway.
						return
					}
					const total = pendingMoof.byteLength + data.byteLength
					const segment = new Uint8Array(total)
					segment.set(pendingMoof, 0)
					segment.set(data, pendingMoof.byteLength)
					pendingMoof = null
					blobParts.push(segment)
					videoQueue?.push(segment)
				},
			}),
		})

		const videoSource = new EncodedVideoPacketSource('avc')
		output.addVideoTrack(videoSource, {
			frameRate: Math.max(1, Math.round(fps)),
		})

		let audioSource: EncodedAudioPacketSource | null = null
		if (audioCodec && audioConfig) {
			audioSource = new EncodedAudioPacketSource(audioCodec)
			output.addAudioTrack(audioSource)
		}

		// Mediabunny requires `start()` before any media data is
		// added. After this, no more tracks can be added.
		await output.start()
		signal?.throwIfAborted()

		// WebCodecs encoders deliver chunks via synchronous output
		// callbacks. Mediabunny's `source.add(packet)` is async and
		// returns a promise that respects internal backpressure.
		// Fragmented-MP4 output (which is what powers MSE
		// streaming) additionally requires INTERLEAVED packet
		// delivery: the muxer can't close a fragment until it has
		// seen packets from EVERY track covering that fragment's
		// timestamp range. If we add 5 seconds of video and only 1
		// second of audio, the muxer buffers everything past the
		// 1-second mark waiting for more audio — no moof / mdat
		// fragments flush, and MSE gets nothing to play until
		// `finalize()` releases the pile at the end.
		//
		// To get progressive streaming we drain BOTH queues from a
		// single interleaver that respects a timestamp watermark:
		// video packets are only sent up to `audioWatermark`, and
		// audio packets are sent eagerly. When audio production
		// stalls (decoder failure, EOF, etc.) we advance a
		// "max-lag" timeout that lets video flow through anyway —
		// otherwise a broken audio decoder would block playback
		// forever.
		type VideoItem = {
			chunk: EncodedVideoChunk
			meta: EncodedVideoChunkMetadata | undefined
			isFirst: boolean
			/** Presentation timestamp in seconds (chunk.timestamp / 1e6). */
			ts: number
		}
		type AudioItem = {
			chunk: EncodedAudioChunk
			meta: EncodedAudioChunkMetadata | undefined
			isFirst: boolean
			ts: number
		}
		const videoPending: VideoItem[] = []
		const audioPending: AudioItem[] = []
		let videoMetaSent = false
		let audioMetaSent = false
		/** Highest audio timestamp (seconds) seen on the audio queue
		 * since open. Used as the gate for releasing video packets. */
		let audioWatermark = 0
		/** Wall-clock time of the last meaningful audio packet — if
		 * this gets stale we declare audio EOF so video can flow. */
		let lastAudioActivityMs = performance.now()
		/** Once true, audio is considered exhausted; video flows
		 * without waiting for the watermark. */
		let audioEnded = !audioSource

		/** How many seconds of video are allowed to outrun audio
		 * before we treat audio as stalled and let video through
		 * unconditionally. Tuned so a broken-audio file (Switch
		 * KB2n) still streams; the muxer will close fragments on
		 * video alone after this window. */
		const AUDIO_LAG_TOLERANCE_S = 2
		/** How long without a new audio packet before we declare
		 * audio EOF and stop blocking video. */
		const AUDIO_STALL_TIMEOUT_MS = 1500

		const drainInterleaved = async (): Promise<void> => {
			while (true) {
				if (signal?.aborted) return
				if (encodeError) return

				// 1. Send any audio packets that have arrived.
				//    `audioEnded` is set once we've notified mediabunny
				//    via `audioSource.close()`; after that point any
				//    leftover audioPending entries are dropped because
				//    the source no longer accepts adds.
				if (audioSource && !audioEnded && audioPending.length > 0) {
					const item = audioPending.shift()!
					const pkt = encodedAudioChunkToPacket(item.chunk)
					try {
						await audioSource.add(pkt, item.isFirst ? item.meta : undefined)
					} catch (e) {
						encodeError =
							e instanceof Error ? e : new Error(String(e))
						return
					}
					if (item.ts > audioWatermark) audioWatermark = item.ts
					lastAudioActivityMs = performance.now()
					continue
				}

				// 2. Send video packets up to the audio watermark
				//    (plus a generous tolerance, so short audio
				//    starvation doesn't block playback).
				if (videoPending.length === 0) return // nothing more to do for now

				const headTs = videoPending[0]!.ts
				const videoAheadOfAudio = headTs - audioWatermark
				const audioIsStalled =
					audioSource !== null &&
					!audioEnded &&
					performance.now() - lastAudioActivityMs >
						AUDIO_STALL_TIMEOUT_MS

				// Defence-in-depth: even though the audio-health
				// probe before muxer setup should have disabled
				// known-broken audio tracks, a stall here would
				// otherwise hang the entire pipeline. Close the
				// audio source so mediabunny releases any
				// per-track fragment buffer.
				if (audioIsStalled && audioSource) {
					audioSource.close()
					audioEnded = true
					audioPending.length = 0
				}

				const releaseVideo =
					audioEnded || videoAheadOfAudio <= AUDIO_LAG_TOLERANCE_S

				if (!releaseVideo) {
					// Wait for either: an audio packet to arrive,
					// the audio stall timeout to expire, or
					// audioEnded to flip. We poll because there's
					// no single event that covers all three.
					await new Promise<void>((r) => setTimeout(r, 20))
					continue
				}

				const item = videoPending.shift()!
				const pkt = encodedVideoChunkToPacket(item.chunk)
				try {
					await videoSource.add(pkt, item.isFirst ? item.meta : undefined)
				} catch (e) {
					encodeError = e instanceof Error ? e : new Error(String(e))
					return
				}
			}
		}

		let interleaverPromise: Promise<void> | null = null
		const kickInterleaver = (): void => {
			if (interleaverPromise) return
			interleaverPromise = drainInterleaved().finally(() => {
				interleaverPromise = null
				if (
					videoPending.length > 0 ||
					(audioSource && audioPending.length > 0)
				) {
					kickInterleaver()
				}
			})
		}

		// DEBUG counters
		const encoder = new VideoEncoder({
			output: (chunk, meta) => {
				videoPending.push({
					chunk,
					meta,
					isFirst: !videoMetaSent,
					ts: chunk.timestamp / 1_000_000,
				})
				videoMetaSent = true
				kickInterleaver()
			},
			error: (e) => {
				encodeError = e
			},
		})
		encoder.configure(videoEncoderConfig)

		let audioEncoder: AudioEncoder | null = null
		if (audioConfig && audioSource) {
			audioEncoder = new AudioEncoder({
				output: (chunk, meta) => {
					audioPending.push({
						chunk,
						meta,
						isFirst: !audioMetaSent,
						ts: chunk.timestamp / 1_000_000,
					})
					audioMetaSent = true
					kickInterleaver()
				},
				error: (e) => {
					encodeError = e
				},
			})
			audioEncoder.configure(audioConfig)
		}

		// Detach if the caller aborts — we want the cleanup path in
		// `finally` to close everything but we shouldn't try to add
		// further chunks once the MediaSource is shutting down.
		const abortHandler = (): void => {
			videoQueue?.close()
		}
		signal?.addEventListener('abort', abortHandler, { once: true })
		cleanupAttached = true

		const total = ffInfo.frameCount
		let frameIndex = 0
		const KEYFRAME_INTERVAL = Math.max(1, Math.round(fps * 2))
		const PROGRESS_BATCH = 16
		let batchStart = performance.now()
		let audioSampleCursor = 0

		// Helpers for the encode loop. Used both to flush the probe
		// frames we buffered while deciding about audio AND for
		// each freshly-decoded frame in the main loop below.
		const encodeVideoFrame = (
			vf: VideoFrame,
			isKeyFrame: boolean,
		): void => {
			try {
				encoder.encode(vf, { keyFrame: isKeyFrame })
			} finally {
				vf.close()
			}
		}
		const encodeAudioChunk = (
			samples: Float32Array<ArrayBuffer>,
			sampleFrames: number,
		): void => {
			if (!audioEncoder) return
			try {
				const timestampUs = Math.round(
					(audioSampleCursor / audioSampleRate) * 1_000_000,
				)
				const audioData = new AudioData({
					format: 'f32',
					sampleRate: audioSampleRate,
					numberOfChannels: audioChannels,
					numberOfFrames: sampleFrames,
					timestamp: timestampUs,
					data: samples,
				})
				try {
					audioEncoder.encode(audioData)
				} finally {
					audioData.close()
				}
				audioSampleCursor += sampleFrames
			} catch {
				try {
					audioEncoder.close()
				} catch {
					// already closed
				}
				audioEncoder = null
			}
		}

		try {
			// 1. Replay probe frames + audio chunks into the
			//    encoder. These were already decoded above as part
			//    of the audio-health probe; we just need to feed
			//    them through the WebCodecs encoders. `frameToVideoFrame`
			//    accepts any object with the FfmpegFrame shape;
			//    ProbeFrame is structurally compatible.
			for (const probe of probeVideoFrames) {
				signal?.throwIfAborted()
				if (encodeError) throw encodeError
				const vf = frameToVideoFrame(
					probe as FfmpegFrame,
					evenW,
					evenH,
					frameIndex * frameDurUs,
					frameDurUs,
				)
				encodeVideoFrame(vf, frameIndex % KEYFRAME_INTERVAL === 0)
				frameIndex++
			}
			for (const probe of probeAudioChunks) {
				if (!audioEncoder) break // audio was dropped by probe
				signal?.throwIfAborted()
				if (encodeError) throw encodeError
				encodeAudioChunk(probe.samples, probe.sampleFrames)
			}
			// 2. Free probe buffers — they've been handed off to
			//    WebCodecs which made its own copies.
			probeVideoFrames.length = 0
			probeAudioChunks.length = 0

			// 3. Main decode loop: pull frames from ff one by one
			//    and encode them.
			for (;;) {
				signal?.throwIfAborted()
				if (encodeError) throw encodeError

				let frame
				try {
					frame = ff.decodeFrame()
				} catch (err) {
					if (err instanceof FfmpegError && err.code !== undefined) {
						// Map known FFmpeg failure modes to a more
						// actionable error type — particularly important
						// for KB2n + alpha (upstream patch limitation)
						// which surfaces as INVALIDDATA on frame 0.
						throw new BinkDecodeError(
							format,
							err.code,
							err.message.replace(/^ffmpeg_decode_frame failed with /, ''),
						)
					}
					throw err
				}
				if (!frame) break

				const videoFrame = frameToVideoFrame(
					frame,
					evenW,
					evenH,
					frameIndex * frameDurUs,
					frameDurUs,
				)
				encodeVideoFrame(
					videoFrame,
					frameIndex % KEYFRAME_INTERVAL === 0,
				)

				if (audioEncoder) {
					try {
						const chunk = ff.drainAudio(0)
						if (chunk && chunk.sampleFrames > 0) {
							encodeAudioChunk(
								new Float32Array(chunk.samples),
								chunk.sampleFrames,
							)
						}
					} catch {
						try {
							audioEncoder.close()
						} catch {
							// already closed
						}
						audioEncoder = null
					}
				}

				// Backpressure on the encoder queues AND on the
				// per-track muxer queues. If the muxer source can't
				// keep up (e.g. when it's pausing emission to wait
				// for a minimum-duration fragment to close), the
				// encoder will happily race ahead and balloon
				// memory. Hold the decode loop when either is too
				// deep.
				const pendingTooDeep =
					encoder.encodeQueueSize > 32 ||
					(audioEncoder?.encodeQueueSize ?? 0) > 32 ||
					videoPending.length > 32 ||
					audioPending.length > 32
				if (pendingTooDeep) {
					while (
						encoder.encodeQueueSize > 16 ||
						(audioEncoder?.encodeQueueSize ?? 0) > 16 ||
						videoPending.length > 16 ||
						audioPending.length > 16
					) {
						await new Promise<void>((r) => setTimeout(r, 4))
						signal?.throwIfAborted()
						if (encodeError) throw encodeError
					}
				}

				frameIndex++
				if (
					frameIndex % PROGRESS_BATCH === 0 ||
					(total > 0 && frameIndex === total)
				) {
					const now = performance.now()
					const dt = (now - batchStart) / 1000
					batchStart = now
					const batchFps = dt > 0 ? PROGRESS_BATCH / dt : 0
					onProgress?.({
						frame: frameIndex,
						total: total > 0 ? total : frameIndex + 1,
						fps: batchFps,
					})
					// Yield to repaint + let MSE drain its queue.
					await new Promise<void>((r) => setTimeout(r, 0))
				}
			}

			await encoder.flush()
			if (audioEncoder) await audioEncoder.flush()
			if (encodeError) throw encodeError
			encoder.close()
			if (audioEncoder) audioEncoder.close()
			// Encoder.flush() guarantees all encoded chunks have
			// been delivered to our output callback, but those
			// callbacks only pushed onto the per-track pending
			// queue. Drain remaining queued packets through the
			// interleaver before finalising the muxer, so tail
			// packets aren't dropped.
			if (interleaverPromise) await interleaverPromise
			while (
				videoPending.length > 0 ||
				(!audioEnded && audioPending.length > 0)
			) {
				kickInterleaver()
				if (interleaverPromise) await interleaverPromise
			}
			// Tell mediabunny no more samples are coming on either
			// track. This unblocks any per-track buffering inside
			// the muxer and lets `finalize()` flush the tail
			// fragment cleanly. (If audio was stalled mid-stream
			// we already closed the audio source in the
			// interleaver — `audioEnded` covers both cases.)
			if (audioSource && !audioEnded) {
				audioSource.close()
				audioEnded = true
			}
			if (encodeError) throw encodeError
			await output.finalize()

			// Wait for MSE to consume the final fragment, then signal
			// end-of-stream so the `<video>`'s duration becomes the
			// real one (vs. the open-ended mediaSource.duration).
			await videoQueue.drained()
			if (mediaSource.readyState === 'open') {
				try {
					mediaSource.endOfStream()
				} catch {
					// State race with sourceBuffer.abort() etc.
				}
			}
		} catch (err) {
			try {
				encoder.close()
			} catch {
				// already closed
			}
			try {
				audioEncoder?.close()
			} catch {
				// already closed
			}
			throw err
		}

		const mp4 = new Blob(blobParts, { type: 'video/mp4' })
		return {
			mp4,
			info: { ...info, frameCount: frameIndex },
		}
	} finally {
		ff.dispose()
		if (cleanupAttached && signal) {
			signal.removeEventListener('abort', (() => {}) as EventListener)
		}
		if (mediaSource.readyState === 'open') {
			try {
				videoQueue?.close()
				mediaSource.endOfStream('decode')
			} catch {
				// MediaSource closed by abort or already ended
			}
		}
	}
}
