/**
 * Decode-and-encode pipeline for `.bik` files (Bink 1):
 *
 *   1. `Bink1Decoder` (WASM) walks the .bik forward frame-by-frame.
 *      Audio packets are decoded inline by the WASM and exposed via
 *      `drainAudio()` after each video frame.
 *   2. Each decoded YUV420p frame becomes a WebCodecs `VideoFrame`,
 *      run through `VideoEncoder` (hardware-accelerated H.264) into
 *      `EncodedVideoChunk`s.
 *   3. The same iteration drains the matching audio buffer for
 *      track 0, feeds it to `AudioEncoder` (AAC, falling back to
 *      Opus), and lets `mp4-muxer` interleave the chunks alongside
 *      the video.
 *   4. `mp4-muxer` writes the result to an in-memory MP4 byte
 *      stream which we return as a Blob to drop into a `<video>`.
 *
 * This mirrors `bink2-encode.ts` but adapts to Bink 1's pull-style
 * API (`decodeNextFrame` + `drainAudio` rather than indexed
 * `decodeFrame(i)` / `decodeAudio(i, t)`). Bink 1 is also far
 * simpler architecturally — there is no alpha plane, and ffmpeg's
 * Bink demuxer hands us frames in monotonic order natively.
 *
 * Progress reporting, AbortSignal, audio fallback (AAC → Opus →
 * video-only) match Bink 2's pipeline so the UI code can share
 * the same shape.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

import { Bink1Decoder, type Bink1Frame } from '@tootallnate/bink1-wasm'

/** Per-frame progress callback. */
export interface Bink1EncodeProgress {
	/** 0-indexed frame just completed. */
	frame: number
	/** Total frame count for this video. */
	total: number
	/** Decode+encode rate measured over the last batch (fps). */
	fps: number
}

export interface Bink1EncodeOptions {
	/** WASM bytes for `@tootallnate/bink1-wasm` (shipped with the package). */
	wasmBytes: Uint8Array
	/** `.bik` file bytes. */
	bikBytes: Uint8Array
	/** Progress callback (fires every ~PROGRESS_BATCH frames). */
	onProgress?: (p: Bink1EncodeProgress) => void
	/** Aborts decoding mid-flight when fired. */
	signal?: AbortSignal
}

export interface Bink1EncodeResult {
	/** The encoded MP4 file, ready for a `<video>` element. */
	mp4: Blob
	/** Pixel dimensions of the encoded video. */
	width: number
	height: number
	/** Total frames written. */
	frameCount: number
	/** Effective frames per second (from the Bink1 header). */
	fps: number
	/** Microseconds in the encoded video. */
	durationUs: number
	/** True iff an audio track was successfully encoded alongside the video. */
	hasAudio: boolean
	/** Codec actually used for audio, or null when no audio was muxed. */
	audioCodec: 'aac' | 'opus' | null
}

/** Thrown when the host browser lacks WebCodecs. */
export class WebCodecsUnavailableError extends Error {
	constructor() {
		super(
			'WebCodecs is not available in this browser. ' +
				'Bink1 preview requires Safari 16.4+, Chrome/Edge, or Firefox 130+.',
		)
		this.name = 'WebCodecsUnavailableError'
	}
}

/** Thrown when the encoder can't accept the requested H.264 config. */
export class H264UnavailableError extends Error {
	constructor(configName: string) {
		super(`This browser's VideoEncoder doesn't support ${configName}. Bink1 preview is unavailable.`)
		this.name = 'H264UnavailableError'
	}
}

const AUDIO_CANDIDATES: Array<{ kind: 'aac' | 'opus'; codec: string; muxerCodec: 'aac' | 'opus' }> = [
	{ kind: 'aac', codec: 'mp4a.40.2', muxerCodec: 'aac' },
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
			// fall through
		}
	}
	return null
}

const H264_CANDIDATES = [
	'avc1.4d0033', // Main 5.1
	'avc1.4d0028', // Main 4.0
	'avc1.42E033', // Baseline 5.1
	'avc1.42E01F', // Baseline 3.1
] as const

async function pickH264Config(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
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
			// fall through
		}
	}
	throw new H264UnavailableError('any of avc1 main/baseline @ levels 3.1–5.1')
}

/**
 * Crop the Bink 1 frame's planes from `*Stride`-padded layout into a
 * tightly-packed YUV420p buffer for `new VideoFrame({ format: 'I420' })`.
 *
 * Bink 1 emits the visible region directly (no 32-pixel alignment
 * like Bink 2), but ffmpeg still adds row stride padding for SIMD
 * compatibility — we strip it here.
 */
function frameToVideoFrame(
	frame: Bink1Frame,
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
		buf.set(frame.y.subarray(y * frame.yStride, y * frame.yStride + width), y * width)
	}
	for (let y = 0; y < ch; y++) {
		buf.set(frame.u.subarray(y * frame.uStride, y * frame.uStride + cw), ySize + y * cw)
	}
	for (let y = 0; y < ch; y++) {
		buf.set(frame.v.subarray(y * frame.vStride, y * frame.vStride + cw), ySize + cSize + y * cw)
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
 * Decode every frame of a Bink 1 file and re-encode it as H.264 MP4.
 * Returns the encoded MP4 as a Blob.
 */
export async function encodeBink1ToMp4(options: Bink1EncodeOptions): Promise<Bink1EncodeResult> {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new WebCodecsUnavailableError()
	}

	const { wasmBytes, bikBytes, onProgress, signal } = options
	signal?.throwIfAborted()

	const decoder = await Bink1Decoder.create(wasmBytes, bikBytes)
	try {
		const info = decoder.info
		const fps = info.fpsDen > 0 ? info.fpsNum / info.fpsDen : 30
		const frameDurUs = Math.round(1_000_000 / fps)
		// H.264 requires even dimensions; round down.
		const evenW = info.width & ~1
		const evenH = info.height & ~1

		const encoderConfig = await pickH264Config(evenW, evenH, fps)

		// --- Audio probe -------------------------------------------------
		let audioCodec: 'aac' | 'opus' | null = null
		let audioConfig: AudioEncoderConfig | null = null
		let audioChannels = 0
		let audioSampleRate = 0
		if (info.audioTrackCount > 0) {
			try {
				const track = decoder.audioTrack(0)
				audioChannels = track.channels
				audioSampleRate = track.sampleRate
				const picked = await pickAudioConfig(audioSampleRate, audioChannels)
				if (picked) {
					audioCodec = picked.muxerCodec
					audioConfig = picked.config
				}
			} catch {
				// Decoder rejected audio metadata — proceed video-only.
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
			output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
			error: (e) => {
				encodeError = e
			},
		})
		encoder.configure(encoderConfig)

		let audioEncoder: AudioEncoder | null = null
		if (audioConfig) {
			audioEncoder = new AudioEncoder({
				output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
				error: (e) => {
					encodeError = e
				},
			})
			audioEncoder.configure(audioConfig)
		}

		const total = info.frameCount
		// Hint keyframes every ~2 s for better MP4 seek granularity
		// than the source Bink's keyframe interval.
		const KEYFRAME_INTERVAL = Math.max(1, Math.round(fps * 2))
		const PROGRESS_BATCH = 16
		let batchStart = performance.now()

		// Running sample-frame cursor for audio packet timestamps.
		let audioSampleCursor = 0

		// Helper: drain whatever audio has been decoded so far for
		// track 0 and feed it to the encoder. Called after every
		// video frame (and once more after EOS to capture tail
		// samples flushed by send_packet(NULL)).
		const drainAndEncodeAudio = (): void => {
			if (!audioEncoder) return
			try {
				const audio = decoder.drainAudio(0)
				if (audio.samplesPerChannel === 0) return
				const timestampUs = Math.round((audioSampleCursor / audioSampleRate) * 1_000_000)
				// Copy out of the WASM-view: it'll be overwritten on
				// the next drainAudio call.
				const copy = new Float32Array(audio.interleaved)
				const audioData = new AudioData({
					format: 'f32',
					sampleRate: audioSampleRate,
					numberOfChannels: audioChannels,
					numberOfFrames: audio.samplesPerChannel,
					timestamp: timestampUs,
					data: copy,
				})
				try {
					audioEncoder!.encode(audioData)
				} finally {
					audioData.close()
				}
				audioSampleCursor += audio.samplesPerChannel
			} catch {
				// Audio glitch is non-fatal — ship what we have and
				// continue video-only.
				try {
					audioEncoder?.close()
				} catch {
					// already closed
				}
				audioEncoder = null
			}
		}

		let frameIndex = 0
		try {
			for (;;) {
				signal?.throwIfAborted()
				if (encodeError) throw encodeError

				const frame = decoder.decodeNextFrame()
				if (!frame) break

				const videoFrame = frameToVideoFrame(
					frame,
					evenW,
					evenH,
					frameIndex * frameDurUs,
					frameDurUs,
				)
				try {
					encoder.encode(videoFrame, { keyFrame: frameIndex % KEYFRAME_INTERVAL === 0 })
				} finally {
					videoFrame.close()
				}

				drainAndEncodeAudio()

				// Backpressure: pause feed when encoder queue gets deep.
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

				if (frameIndex % PROGRESS_BATCH === 0 || frameIndex === total - 1) {
					const now = performance.now()
					const dt = (now - batchStart) / 1000
					batchStart = now
					const batchFps = dt > 0 ? PROGRESS_BATCH / dt : 0
					onProgress?.({ frame: frameIndex, total, fps: batchFps })
					await new Promise<void>((r) => setTimeout(r, 0))
				}

				frameIndex++
			}

			// Final drain after EOS to pick up any tail audio samples.
			drainAndEncodeAudio()

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
		decoder.dispose()
	}
}
