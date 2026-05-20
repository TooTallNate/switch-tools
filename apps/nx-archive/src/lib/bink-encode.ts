/**
 * Decode-and-encode pipeline for Bink (`.bik`) and Bink 2 (`.bk2`)
 * files.
 *
 *   1. The new dpkg-style `@tootallnate/ffmpeg-wasm` (LGPL-only)
 *      decodes frames sequentially. The base WASM ships zero codecs;
 *      we load 4 extensions at create time:
 *        - bink-demuxer (shared container)
 *        - bink-video   (Bink 1)
 *        - bink2-video  (Bink 2)
 *        - bink-audio   (binkaudio RDFT + DCT)
 *      The wrapper auto-picks the right codec per-stream based on
 *      the demuxer's `codec_id` field — same code path for .bik
 *      and .bk2.
 *   2. Each decoded YUV420p frame becomes a WebCodecs `VideoFrame`,
 *      run through `VideoEncoder` (hardware-accelerated H.264) into
 *      `EncodedVideoChunk`s.
 *   3. The same iteration drains any audio samples that decoded
 *      since the last video frame, packages them as `AudioData`,
 *      and feeds them to `AudioEncoder` (AAC, falling back to Opus).
 *   4. `mp4-muxer` writes the result to an in-memory MP4 byte
 *      stream which we return as a Blob to drop into a `<video>`.
 *
 * Replaces the previous monolithic `bink1-encode.ts` (LGPL FFmpeg
 * monolith @tootallnate/bink1-wasm) and `bink2-encode.ts` (GPL-3
 * cnc-ra-libs @tootallnate/bink2-wasm). The new stack is LGPL-only
 * so the WASMs can be shipped directly — no more "user must provide
 * bink2.wasm" friction.
 *
 * Progress reporting and cancellation semantics are unchanged from
 * the legacy encoders.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

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

export interface BinkEncodeResult {
	/** The encoded MP4 file, ready for a `<video>` element. */
	mp4: Blob
	/** Pixel dimensions of the encoded video. */
	width: number
	height: number
	/** Total frames written. */
	frameCount: number
	/** Effective frames per second (from the Bink header). */
	fps: number
	/** Microseconds in the encoded video. */
	durationUs: number
	/** True iff an audio track was successfully encoded alongside the video. */
	hasAudio: boolean
	/** Codec actually used for audio, or null when no audio was muxed. */
	audioCodec: 'aac' | 'opus' | null
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
 * AAC + Opus codec configs we try in order. AAC-LC inside MP4 is the
 * most universally-playable choice, but several browsers won't
 * *encode* AAC (Safari < 18.4, certain Firefox builds). Opus inside
 * MP4 is widely playable too (Safari 17.4+, Chrome/Edge, Firefox)
 * and encodes everywhere, making it our fallback.
 *
 * Audio failure is non-fatal — if neither encoder will start we ship
 * video-only and surface `audioCodec: null` to the caller.
 */
const AUDIO_CANDIDATES: Array<{
	kind: 'aac' | 'opus'
	codec: string
	muxerCodec: 'aac' | 'opus'
}> = [
	// AAC-LC (Audio Object Type 2).
	{ kind: 'aac', codec: 'mp4a.40.2', muxerCodec: 'aac' },
	// Opus — always available where WebCodecs encode is supported.
	{ kind: 'opus', codec: 'opus', muxerCodec: 'opus' },
]

async function pickAudioConfig(
	sampleRate: number,
	channels: number,
): Promise<{ config: AudioEncoderConfig; muxerCodec: 'aac' | 'opus' } | null> {
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
				return { config: support.config, muxerCodec: candidate.muxerCodec }
			}
		} catch {
			// fall through to the next candidate
		}
	}
	return null
}

/**
 * H.264 (avc1) codec strings tried in order from highest profile to
 * "should always work".
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
): Promise<VideoEncoderConfig> {
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
		try {
			const support = await VideoEncoder.isConfigSupported(config)
			if (support.supported && support.config) return support.config
		} catch {
			// Some browsers throw on unsupported codec strings instead
			// of returning `{ supported: false }`. Treat both alike.
		}
	}
	throw new H264UnavailableError(
		'any of avc1 main/baseline @ levels 3.1–5.1',
	)
}

/**
 * Convert an FfmpegFrame (YUV420p, may be aligned-stride) to a
 * WebCodecs VideoFrame cropped to `width × height`.
 *
 * The Bink decoders return luma/chroma planes whose stride may
 * exceed the visible width (Bink 2 in particular aligns to 32px).
 * We compact to a tight I420 layout row-by-row.
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
	// Y.
	for (let y = 0; y < height; y++) {
		buf.set(
			frame.y.subarray(y * frame.yStride, y * frame.yStride + width),
			y * width,
		)
	}
	// U.
	for (let y = 0; y < ch; y++) {
		buf.set(
			frame.u.subarray(y * frame.uStride, y * frame.uStride + cw),
			ySize + y * cw,
		)
	}
	// V.
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
 * Compiled-WebAssembly module cache, split into "shared" (used by
 * both formats) and per-format (only loaded when needed). The
 * browser caches the underlying bytes by URL, but compiling +
 * dynamic-linking still costs ~50 ms per module, so we hold
 * `WebAssembly.Module`s in memory for the page lifetime.
 *
 * Lazy: a `.bik` preview never downloads or compiles
 * `bink2-video.so`; a `.bk2` preview never downloads
 * `bink-video.so`. The shared modules are fetched on the first
 * preview of either kind and reused thereafter.
 *
 * The compile cache is NOT an active `Ffmpeg` instance — each
 * decode session creates a fresh one so failures, memory, and
 * file lifetime stay decoupled per preview.
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
	// `WebAssembly.compileStreaming` is faster when available and
	// the response has the right Content-Type, but Vite serves
	// `.so` files as application/octet-stream which fails
	// compileStreaming's MIME check. Fall back to arrayBuffer().
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
		sharedPromise = null // allow retry on transient failure
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

/**
 * Decode every frame of a Bink (.bik) or Bink 2 (.bk2) file and
 * re-encode it as H.264 MP4. Returns the encoded MP4 as a Blob
 * ready for a `<video src>` element.
 *
 * Auto-detects which codec to use (Bink 1 vs Bink 2) via the
 * registered demuxer + per-stream codec_id matching. No caller
 * branching required.
 */
export async function encodeBinkToMp4(
	options: BinkEncodeOptions,
): Promise<BinkEncodeResult> {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new WebCodecsUnavailableError()
	}

	const { format, binkBytes, onProgress, signal } = options
	signal?.throwIfAborted()

	// Load shared modules in parallel with the format-specific video
	// codec. Both are cached after the first preview, so subsequent
	// previews of the same format hit the in-memory cache.
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

	try {
		await ff.open(binkBytes)
		signal?.throwIfAborted()
		const info: FfmpegInfo = ff.info
		const fps = info.fpsDen > 0 ? info.fpsNum / info.fpsDen : 30
		// Per-frame duration in microseconds (the WebCodecs unit).
		const frameDurUs = Math.round(1_000_000 / fps)
		// H.264 requires even pixel dimensions; lose at most one
		// row/column of edge data.
		const evenW = info.width & ~1
		const evenH = info.height & ~1

		const encoderConfig = await pickH264Config(evenW, evenH, fps)

		// --- Audio probe ------------------------------------------------
		let audioCodec: 'aac' | 'opus' | null = null
		let audioConfig: AudioEncoderConfig | null = null
		let audioChannels = 0
		let audioSampleRate = 0
		if (info.audioTracks.length > 0) {
			const track0 = info.audioTracks[0]!
			audioChannels = track0.channels
			audioSampleRate = track0.sampleRate
			const picked = await pickAudioConfig(audioSampleRate, audioChannels)
			if (picked) {
				audioCodec = picked.muxerCodec
				audioConfig = picked.config
			}
		}

		const muxer = new Muxer({
			target: new ArrayBufferTarget(),
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
			fastStart: 'in-memory',
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
		encoder.configure(encoderConfig)

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

		const total = info.frameCount
		let frameIndex = 0
		const KEYFRAME_INTERVAL = Math.max(1, Math.round(fps * 2))
		const PROGRESS_BATCH = 16
		let batchStart = performance.now()
		// Cumulative sample-frames pulled from track 0 (drives audio
		// PTS in microseconds).
		let audioSampleCursor = 0

		try {
			for (;;) {
				signal?.throwIfAborted()
				if (encodeError) throw encodeError

				const frame = ff.decodeFrame()
				if (!frame) break // EOF

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

				// Drain any audio samples decoded since last frame.
				if (audioEncoder) {
					try {
						const chunk = ff.drainAudio(0)
						if (chunk && chunk.sampleFrames > 0) {
							const timestampUs = Math.round(
								(audioSampleCursor / audioSampleRate) * 1_000_000,
							)
							// Copy out of WASM memory — view is invalidated
							// on the next drain.
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
						// Audio hiccup is non-fatal: close the encoder
						// and ship video-only from here on.
						try {
							audioEncoder.close()
						} catch {
							// already closed
						}
						audioEncoder = null
					}
				}

				// Backpressure.
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
					// Yield to repaint.
					await new Promise<void>((r) => setTimeout(r, 0))
				}
			}

			await encoder.flush()
			if (audioEncoder) await audioEncoder.flush()
			if (encodeError) throw encodeError
			encoder.close()
			if (audioEncoder) audioEncoder.close()
			muxer.finalize()
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

		const target = muxer.target as ArrayBufferTarget
		const mp4 = new Blob([target.buffer], { type: 'video/mp4' })
		return {
			mp4,
			width: evenW,
			height: evenH,
			frameCount: frameIndex,
			fps,
			durationUs: frameIndex * frameDurUs,
			hasAudio: audioCodec !== null,
			audioCodec,
		}
	} finally {
		ff.dispose()
	}
}
