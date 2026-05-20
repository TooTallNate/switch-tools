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
 *   4. `mp4-muxer` in `fastStart: 'fragmented'` mode emits a stream of
 *      `moof + mdat` fragments through `StreamTarget`'s `onData`
 *      callback. Each fragment is independently playable.
 *   5. Fragments are appended to a `MediaSource`'s `SourceBuffer` as
 *      they arrive; the `<video>` plays from the MediaSource. The
 *      browser's media stack handles buffering, seeking (within the
 *      already-appended range), and playback timing.
 *   6. Fragments are also accumulated into an `ArrayBuffer` so the
 *      caller can finalize a downloadable MP4 Blob via the
 *      `done` Promise.
 *
 * Replaces the previous monolithic `bink1-encode.ts` (LGPL FFmpeg
 * monolith @tootallnate/bink1-wasm) and `bink2-encode.ts` (GPL-3
 * cnc-ra-libs @tootallnate/bink2-wasm). The new stack is LGPL-only so
 * the WASMs can be shipped directly — no more "user must provide
 * bink2.wasm" friction.
 */

import { Muxer, StreamTarget } from 'mp4-muxer'

import {
	Ffmpeg,
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

		// Collect chunks for the final downloadable Blob in parallel
		// with feeding them to MSE.
		const blobParts: Uint8Array<ArrayBuffer>[] = []

		// mp4-muxer in fragmented mode emits fragments asynchronously.
		// `chunked: true` accumulates small writes into ~16 KB blocks
		// before invoking onData, reducing the number of MSE
		// appendBuffer() calls (each has fixed overhead).
		const muxer = new Muxer({
			target: new StreamTarget({
				onData: (data, _position) => {
					if (signal?.aborted) return
					// Copy the data (mp4-muxer may reuse buffers
					// between calls).
					const copy = new Uint8Array(data.byteLength)
					copy.set(data)
					blobParts.push(copy)
					videoQueue?.push(copy)
				},
				chunked: false,
			}),
			video: {
				codec: 'avc',
				width: evenW,
				height: evenH,
				frameRate: Math.max(1, Math.round(fps)),
			},
			...(audioCodec && audioConfig
				? {
						audio: {
							codec: audioCodec,
							numberOfChannels: audioChannels,
							sampleRate: audioSampleRate,
						},
					}
				: {}),
			fastStart: 'fragmented',
			// Short fragments → low play-press latency. 0.5s means
			// the first ~15 frames (at 30fps) trigger a flush, so
			// the <video> can start playing within ~500ms of
			// encoding starting.
			minFragmentDuration: 0.5,
		})

		let encodeError: Error | null = null
		const encoder = new VideoEncoder({
			output: (chunk, meta) => {
				muxer.addVideoChunk(chunk, meta)
			},
			error: (e) => {
				encodeError = e
			},
		})
		encoder.configure(videoEncoderConfig)

		let audioEncoder: AudioEncoder | null = null
		if (audioConfig) {
			audioEncoder = new AudioEncoder({
				output: (chunk, meta) => {
					muxer.addAudioChunk(chunk, meta)
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

		try {
			for (;;) {
				signal?.throwIfAborted()
				if (encodeError) throw encodeError

				const frame = ff.decodeFrame()
				if (!frame) break

				const videoFrame = frameToVideoFrame(
					frame,
					evenW,
					evenH,
					frameIndex * frameDurUs,
					frameDurUs,
				)
				try {
					encoder.encode(videoFrame, {
						keyFrame: frameIndex % KEYFRAME_INTERVAL === 0,
					})
				} finally {
					videoFrame.close()
				}

				if (audioEncoder) {
					try {
						const chunk = ff.drainAudio(0)
						if (chunk && chunk.sampleFrames > 0) {
							const timestampUs = Math.round(
								(audioSampleCursor / audioSampleRate) * 1_000_000,
							)
							const copy = new Float32Array(chunk.samples)
							const audioData = new AudioData({
								format: 'f32',
								sampleRate: audioSampleRate,
								numberOfChannels: audioChannels,
								numberOfFrames: chunk.sampleFrames,
								timestamp: timestampUs,
								data: copy,
							})
							try {
								audioEncoder.encode(audioData)
							} finally {
								audioData.close()
							}
							audioSampleCursor += chunk.sampleFrames
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

				// Backpressure on the encoder queues (independent of
				// the MSE queue, which the browser drains in its own
				// time).
				if (
					encoder.encodeQueueSize > 32 ||
					(audioEncoder?.encodeQueueSize ?? 0) > 32
				) {
					while (
						encoder.encodeQueueSize > 16 ||
						(audioEncoder?.encodeQueueSize ?? 0) > 16
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
			muxer.finalize()

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
