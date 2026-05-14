/**
 * Decode-and-encode pipeline for `.bk2` files:
 *
 *   1. `Bink2Decoder` (WASM) decodes frames sequentially from the
 *      user-supplied `.bk2` bytes.
 *   2. Each decoded YUV420p frame becomes a WebCodecs `VideoFrame`,
 *      run through `VideoEncoder` (hardware-accelerated H.264) into
 *      `EncodedVideoChunk`s.
 *   3. The same iteration pulls the matching audio sub-packet for
 *      track 0 (when present), feeds it to `AudioEncoder` (AAC,
 *      falling back to Opus if the host doesn't encode AAC), and
 *      lets `mp4-muxer` interleave the resulting chunks alongside
 *      the video.
 *   4. `mp4-muxer` writes the result to an in-memory MP4 byte
 *      stream which we return as a Blob to drop into a `<video>`.
 *
 * The pipeline is staged because Bink2 inter-frames must be decoded
 * in monotonic order — random-access seek requires going back to a
 * keyframe. Same constraint applies to audio (block lapping). We
 * decode + encode every frame once, up-front, then hand the
 * resulting MP4 to the `<video>` element which provides scrubbing
 * UI as if it were a native MP4.
 *
 * Progress reporting: callers pass `onProgress({ frame, total })` to
 * receive per-frame updates from a long-running React effect. The
 * pipeline yields to the event loop every ~16 frames so the UI can
 * paint the progress bar.
 *
 * Errors: the pipeline aborts on the first decode or encode failure,
 * disposes the decoder, and throws. The `AbortSignal` allows the
 * caller (e.g. an unmounting React component) to cancel cleanly.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

import { Bink2Decoder, type Bink2Frame } from '@tootallnate/bink2-wasm'

/** Per-frame progress callback. */
export interface Bink2EncodeProgress {
	/** 0-indexed frame just completed. */
	frame: number
	/** Total frame count for this video. */
	total: number
	/** Decode+encode rate measured over the last batch (fps). */
	fps: number
}

export interface Bink2EncodeOptions {
	/** WASM bytes for `@tootallnate/bink2-wasm` (compiled by user). */
	wasmBytes: Uint8Array
	/** `.bk2` file bytes. */
	bk2Bytes: Uint8Array
	/** Progress callback (fires every ~250ms during encode). */
	onProgress?: (p: Bink2EncodeProgress) => void
	/** Aborts decoding mid-flight when fired. */
	signal?: AbortSignal
}

export interface Bink2EncodeResult {
	/** The encoded MP4 file, ready for a `<video>` element. */
	mp4: Blob
	/** Pixel dimensions of the encoded video. */
	width: number
	height: number
	/** Total frames written. */
	frameCount: number
	/** Effective frames per second (from the Bink2 header). */
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
				'Bink2 preview requires Safari 16.4+, Chrome/Edge, or Firefox 130+.',
		)
		this.name = 'WebCodecsUnavailableError'
	}
}

/** Thrown when the encoder can't accept the requested H.264 config. */
export class H264UnavailableError extends Error {
	constructor(configName: string) {
		super(`This browser's VideoEncoder doesn't support ${configName}. Bink2 preview is unavailable.`)
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
const AUDIO_CANDIDATES: Array<{ kind: 'aac' | 'opus'; codec: string; muxerCodec: 'aac' | 'opus' }> = [
	// AAC-LC (Audio Object Type 2). 'mp4a.40.2' is the canonical
	// string MP4 / DASH / HLS use; the WebCodecs codec registry
	// recognises it.
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
 * "should always work". Configs that pass `VideoEncoder.isConfigSupported`
 * are used; we pick the first one that the host accepts.
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

/**
 * Pick the highest-quality avc1 config the host VideoEncoder accepts
 * for the given dimensions / fps. We probe lazily because
 * `isConfigSupported` is async and modestly expensive.
 */
async function pickH264Config(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
	const bitsPerSecond = Math.round(width * height * fps * 0.12)
	for (const codec of H264_CANDIDATES) {
		const config: VideoEncoderConfig = {
			codec,
			width,
			height,
			bitrate: bitsPerSecond,
			framerate: fps,
			// `avc` (vs annexb): packets carry length prefixes; required
			// by mp4-muxer's H.264 writer.
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
	throw new H264UnavailableError('any of avc1 main/baseline @ levels 3.1–5.1')
}

/**
 * The Bink2 decoder hands us aligned YUV (multiple of 32 px); the
 * encoder wants the visible region cropped to the header's width /
 * height. We crop in two steps:
 *
 *   1. Allocate a tight YUV420p buffer (`w * h * 3 / 2` bytes).
 *   2. Copy Y, then U, then V (each row at a time to skip the
 *      aligned-stride padding).
 *
 * The cropped bytes go into a `VideoFrame` constructor with a single
 * layout describing the three plane offsets.
 */
function frameToVideoFrame(
	frame: Bink2Frame,
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
	// Copy Y row-by-row, stripping the aligned-stride padding.
	for (let y = 0; y < height; y++) {
		buf.set(frame.y.subarray(y * frame.lumaStride, y * frame.lumaStride + width), y * width)
	}
	// U.
	for (let y = 0; y < ch; y++) {
		buf.set(
			frame.u.subarray(y * frame.chromaStride, y * frame.chromaStride + cw),
			ySize + y * cw,
		)
	}
	// V.
	for (let y = 0; y < ch; y++) {
		buf.set(
			frame.v.subarray(y * frame.chromaStride, y * frame.chromaStride + cw),
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
 * Decode every frame of a Bink 2 file and re-encode it as H.264 MP4.
 * Returns the encoded MP4 as a Blob.
 */
export async function encodeBink2ToMp4(options: Bink2EncodeOptions): Promise<Bink2EncodeResult> {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new WebCodecsUnavailableError()
	}
	// AudioEncoder/AudioData are optional: we proceed video-only if
	// the host lacks audio WebCodecs (very rare; same vintage as
	// VideoEncoder support).

	const { wasmBytes, bk2Bytes, onProgress, signal } = options
	signal?.throwIfAborted()

	const decoder = await Bink2Decoder.create(wasmBytes, bk2Bytes)
	try {
		const info = decoder.info
		const fps = info.fpsDen > 0 ? info.fpsNum / info.fpsDen : 30
		// Per-frame duration in microseconds (the WebCodecs unit).
		const frameDurUs = Math.round(1_000_000 / fps)
		// H.264 requires even pixel dimensions. The Bink2 decoder
		// already aligns to 32, but the *visible* region may be odd
		// (e.g. 1280×720 is even, but 854×480 is also fine, 853×479 is
		// not). Round down to even — losing one pixel column / row is
		// preferable to encode failure.
		const evenW = info.width & ~1
		const evenH = info.height & ~1

		const encoderConfig = await pickH264Config(evenW, evenH, fps)

		// --- Audio probe ------------------------------------------------
		// We attempt to enable audio iff:
		//   1. The container has at least one audio track.
		//   2. The Bink decoder can initialise track 0 (parameters valid).
		//   3. The host AudioEncoder accepts AAC or Opus at the track's
		//      sample rate / channel count.
		// Any failure falls back gracefully to video-only.
		let audioCodec: 'aac' | 'opus' | null = null
		let audioConfig: AudioEncoderConfig | null = null
		let audioChannels = 0
		let audioSampleRate = 0
		if (info.audioTrackCount > 0) {
			try {
				const init = decoder.initAudio(0)
				audioChannels = init.channels
				audioSampleRate = init.sampleRate
				const picked = await pickAudioConfig(audioSampleRate, audioChannels)
				if (picked) {
					audioCodec = picked.muxerCodec
					audioConfig = picked.config
				}
			} catch {
				// Decoder rejected the audio parameters — proceed video-only.
			}
		}

		// mp4-muxer requires an integer `frameRate`; we still drive
		// per-frame timestamps from the precise `fps` so timing stays
		// correct even when the source fps is fractional (e.g. Bink's
		// 5000000/333333 ≈ 15.00001500…).
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

		// Audio encoder is optional; only constructed when the probe
		// above settled on a codec the host accepts.
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
		// Hint a keyframe at fixed intervals so the MP4 has its own
		// seek points (the source Bink2's keyframes are far enough
		// apart that the seek granularity is poor). Encoder will
		// honour `keyFrame: true` regardless of compression effort.
		const KEYFRAME_INTERVAL = Math.max(1, Math.round(fps * 2))
		// Yield to the event loop every PROGRESS_BATCH frames so React
		// gets a chance to repaint progress.
		const PROGRESS_BATCH = 16
		let batchStart = performance.now()

		// Bink audio packets are 1:1 with video frames but their
		// sample counts vary per packet (typically `frame_len -
		// overlap_len`). To assign a monotonically-correct timestamp
		// to each AudioData we maintain a running sample counter and
		// derive a microsecond timestamp from it via the decoded
		// sample rate.
		let audioSampleCursor = 0

		try {
			for (frameIndex = 0; frameIndex < total; frameIndex++) {
				signal?.throwIfAborted()
				if (encodeError) throw encodeError

				const frame = decoder.decodeFrame(frameIndex)
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

				// Audio: pull this frame's packet for track 0 if audio
				// is enabled. Empty packets are normal — many frames
				// don't carry new audio for a given track.
				if (audioEncoder) {
					try {
						const audioFrame = decoder.decodeAudio(frameIndex, 0)
						if (audioFrame.samplesPerChannel > 0) {
							const timestampUs = Math.round(
								(audioSampleCursor / audioSampleRate) * 1_000_000,
							)
							// Copy out of the WASM-view: AudioData reads
							// lazily and the view is invalidated on the
							// next decodeAudio() call (when we reach the
							// next frame).
							const copy = new Float32Array(audioFrame.interleaved)
							const audioData = new AudioData({
								format: 'f32',
								sampleRate: audioSampleRate,
								numberOfChannels: audioChannels,
								numberOfFrames: audioFrame.samplesPerChannel,
								timestamp: timestampUs,
								data: copy,
							})
							try {
								audioEncoder.encode(audioData)
							} finally {
								audioData.close()
							}
							audioSampleCursor += audioFrame.samplesPerChannel
						}
					} catch {
						// Audio decode hiccup is non-fatal: we ship what
						// we've encoded so far + skip the rest of audio
						// for this stream. Close the audio encoder so the
						// muxer doesn't wait for more chunks.
						try {
							audioEncoder.close()
						} catch {
							// already closed
						}
						audioEncoder = null
					}
				}

				// Backpressure: if either encoder is many frames behind,
				// wait for the queue to drain. Without this, large videos
				// can build a huge in-memory queue.
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
			// Best-effort cleanup.
			try {
				encoder.close()
			} catch {
				// Already closed or errored.
			}
			try {
				audioEncoder?.close()
			} catch {
				// Already closed or errored.
			}
			throw err
		}

		const target = muxer.target as ArrayBufferTarget
		const mp4 = new Blob([target.buffer], { type: 'video/mp4' })
		return {
			mp4,
			width: evenW,
			height: evenH,
			frameCount: total,
			fps,
			durationUs: total * frameDurUs,
			hasAudio: audioCodec !== null,
			audioCodec,
		}
	} finally {
		decoder.dispose()
	}
}
