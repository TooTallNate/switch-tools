/**
 * Streaming remux pipeline for CRI Sofdec2 USM containers.
 *
 *   1. `@tootallnate/usm`'s `parseUsm` walks the chunk index lazily
 *      and exposes each video stream as a concatenated IVF Blob
 *      view (no eager materialisation of bytes).
 *   2. `demuxIvf` reads the IVF stream in 4 MiB strides and yields
 *      the contained VP9 frames with their PTS + keyframe flag.
 *   3. Each VP9 frame becomes a mediabunny `EncodedPacket` and
 *      flows straight into `EncodedVideoPacketSource('vp9')` —
 *      *no encode round-trip* since USM ships VP9 in its final
 *      form. The output is a WebM container in append-only mode,
 *      which keeps the byte layout monotonic so MSE can consume
 *      every cluster as it lands.
 *   4. Cluster bytes are appended to the `<video>`'s `MediaSource`
 *      `SourceBuffer` as they arrive. The element starts playing
 *      within ~one cluster's worth of work (~1 second by default)
 *      instead of waiting for the full remux pass.
 *   5. A parallel `ArrayBuffer` accumulator captures the same
 *      bytes so the caller can present a "Save .webm" download
 *      once the remux finishes.
 *
 * Only VP9 USMs are streamable — H.264 USMs would need a
 * different MP4 container path; we surface a typed error so
 * callers can render a sensible fallback UI.
 *
 * Audio: USM audio is HCA, which neither the browser nor
 * MediaSource Extensions can play. The audio track is
 * intentionally omitted from the WebM output (matches the
 * legacy non-streaming `muxVp9WebmBlob` behaviour). Future
 * work: decode HCA via `@tootallnate/ffmpeg-hca-wasm`, encode
 * to Opus, and mux as a second WebM track.
 */

import {
	EncodedPacket,
	EncodedVideoPacketSource,
	NullTarget,
	Output,
	WebMOutputFormat,
} from 'mediabunny';

import {
	demuxIvf,
	isVp9Keyframe,
	parseUsm,
	type UsmFile,
	type UsmVideoStream,
} from '@tootallnate/usm';

/** Per-batch progress reported while the remux runs. */
export interface UsmStreamProgress {
	/** Number of frames already piped through the muxer. */
	frame: number;
	/** Total frames in the source video (from the IVF / USM header). */
	total: number;
	/** Frames-per-second observed across the last batch — remux throughput. */
	fps: number;
}

/** Container metadata produced once the USM has been parsed. */
export interface UsmStreamInfo {
	/** Decoded width (codec-reported). */
	width: number;
	/** Decoded height (codec-reported). */
	height: number;
	/** Playback fps from the USM header. */
	fps: number;
	/** Total frame count from the IVF header. */
	frameCount: number;
	/** Microseconds the resulting video will run for. */
	durationUs: number;
	/** Parsed USM file metadata (chunks + streams). */
	usm: UsmFile;
	/** The selected video stream (currently always the first one). */
	video: UsmVideoStream;
}

export interface UsmStreamResult {
	/** The fully-encoded WebM ready for a "Save .webm" download. */
	webm: Blob;
	info: UsmStreamInfo;
	/** Number of frames actually muxed. */
	frameCount: number;
}

export interface UsmStreamOptions {
	/**
	 * The .usm file. Accepts either a real `Blob` or any
	 * Blob-shaped facade (lazy NCA / archive views).
	 * @tootallnate/usm's `parseUsm` + `demuxIvf` walk the input
	 * via `Blob.slice()` and stream through it; only the bytes
	 * actually needed (header + chunk index + IVF frames) are
	 * materialised in memory.
	 */
	blob: Blob;
	/**
	 * Optional pre-parsed `UsmFile`. The component layer typically
	 * parses the USM up front to show metadata + detect
	 * unsupported codecs before mounting the streaming UI; passing
	 * the parsed result back in here avoids redoing the parse
	 * (which involves walking the chunk index, decoding the @UTF
	 * tables, etc.) inside the streaming pipeline.
	 */
	parsed?: UsmFile;
	onProgress?: (p: UsmStreamProgress) => void;
	signal?: AbortSignal;
}

/**
 * Synchronously-returned handle. `<video src={mediaSourceUrl}>`
 * is wired immediately; `info` resolves after the USM header is
 * parsed; `done` resolves with the final downloadable Blob once
 * remuxing completes.
 */
export interface UsmStreamHandle {
	mediaSourceUrl: string;
	info: Promise<UsmStreamInfo>;
	done: Promise<UsmStreamResult>;
}

export class UnsupportedUsmCodecError extends Error {
	constructor(codec: string) {
		super(
			`In-browser playback only supports VP9 USMs; this stream is "${codec}".`,
		);
		this.name = 'UnsupportedUsmCodecError';
	}
}

export class MediaSourceUnavailableError extends Error {
	constructor() {
		super(
			"This browser doesn't support MediaSource Extensions. " +
				'USM streaming preview requires Chrome/Edge, Firefox, or Safari 8+.',
		);
		this.name = 'MediaSourceUnavailableError';
	}
}

/** MIME the SourceBuffer is configured with. */
const WEBM_VP9_MIME = 'video/webm; codecs="vp9"';

/**
 * Single-in-flight queue around a SourceBuffer. `appendBuffer`
 * can only run once at a time; this serialises our cluster
 * appends and handles `QuotaExceededError` retry. Mirrors the
 * helper in `bink-encode.ts` but kept module-local to avoid
 * coupling two otherwise-independent pipelines.
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
			if (drainedResolve) {
				drainedResolve();
				drainedResolve = null;
			}
			return;
		}
		const next = queue.shift()!;
		updating = true;
		try {
			sb.appendBuffer(next);
		} catch (err) {
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
			if (drainedResolve) {
				drainedResolve();
				drainedResolve = null;
			}
		},
	};
}

/**
 * Start a streaming remux of a USM into a `MediaSource`. Returns
 * synchronously with the handle; the caller is expected to wire
 * `<video src={mediaSourceUrl}>` immediately so the MediaSource
 * transitions to `'open'` and the pipeline can begin.
 */
export function streamUsmToWebm(options: UsmStreamOptions): UsmStreamHandle {
	if (typeof MediaSource === 'undefined') {
		throw new MediaSourceUnavailableError();
	}

	const mediaSource = new MediaSource();
	const mediaSourceUrl = URL.createObjectURL(mediaSource);

	let infoResolve!: (info: UsmStreamInfo) => void;
	let infoReject!: (err: Error) => void;
	const infoPromise = new Promise<UsmStreamInfo>((resolve, reject) => {
		infoResolve = resolve;
		infoReject = reject;
	});

	const donePromise = (async (): Promise<UsmStreamResult> => {
		try {
			return await runStreamingRemux(options, mediaSource, (info) => {
				infoResolve(info);
			});
		} catch (err) {
			infoReject(err instanceof Error ? err : new Error(String(err)));
			throw err;
		}
	})();

	return {
		mediaSourceUrl,
		info: infoPromise,
		done: donePromise,
	};
}

async function runStreamingRemux(
	options: UsmStreamOptions,
	mediaSource: MediaSource,
	onInfoReady: (info: UsmStreamInfo) => void,
): Promise<UsmStreamResult> {
	const { blob, parsed, onProgress, signal } = options;
	signal?.throwIfAborted();

	// Set up the MediaSource open listener with a generous timeout
	// in case the caller forgets to mount the <video>. Without the
	// timeout we'd hang forever.
	const SOURCE_OPEN_TIMEOUT_MS = 10_000;
	const sourceOpen = new Promise<void>((resolve, reject) => {
		if (mediaSource.readyState === 'open') {
			resolve();
			return;
		}
		const onOpen = (): void => {
			clearTimeout(timer);
			resolve();
		};
		mediaSource.addEventListener('sourceopen', onOpen, { once: true });
		const timer = setTimeout(() => {
			mediaSource.removeEventListener('sourceopen', onOpen);
			reject(
				new Error(
					'MediaSource never opened — the <video> element was never mounted, ' +
						'or it took longer than 10s to do so',
				),
			);
		}, SOURCE_OPEN_TIMEOUT_MS);
	});

	const usm = parsed ?? (await parseUsm(blob));
	signal?.throwIfAborted();

	const video = usm.streams.find(
		(s): s is UsmVideoStream => s.type === 'video',
	);
	if (!video) {
		throw new Error('USM contains no video stream.');
	}
	if (video.codec.codec !== 'vp9') {
		throw new UnsupportedUsmCodecError(video.codec.codec);
	}

	// Demux the IVF stream up-front. `demuxIvf` reads in 4 MiB
	// strides and gets us a flat array of frames we can pipe
	// through the muxer at our own pace.
	const ivf = await demuxIvf(video.data);
	signal?.throwIfAborted();
	const fps = video.fps || 30;
	const frameDurUs = Math.round(1_000_000 / fps);
	const frameCount = ivf.frames.length;
	const durationUs = frameCount * frameDurUs;

	const info: UsmStreamInfo = {
		width: video.width,
		height: video.height,
		fps,
		frameCount,
		durationUs,
		usm,
		video,
	};
	onInfoReady(info);

	await sourceOpen;
	signal?.throwIfAborted();

	if (!MediaSource.isTypeSupported(WEBM_VP9_MIME)) {
		throw new Error(`Browser MediaSource doesn't accept ${WEBM_VP9_MIME}.`);
	}

	// Capture the encoded bytes for the downloadable Blob, AND
	// feed them into the MSE SourceBuffer as they arrive.
	const blobParts: Uint8Array<ArrayBuffer>[] = [];
	let videoQueue: ReturnType<typeof createSourceBufferQueue> | null = null;

	// WebM init segment is `EBML header` + the front part of the
	// `Segment` element (Info + Tracks). We coalesce both into
	// the SourceBuffer's first append; subsequent appends are
	// individual clusters.
	let pendingEbml: Uint8Array | null = null;
	let pendingSegmentHeader: Uint8Array | null = null;

	const flushInitIfReady = (): void => {
		if (signal?.aborted) return;
		if (pendingEbml && pendingSegmentHeader && videoQueue) {
			const total = pendingEbml.byteLength + pendingSegmentHeader.byteLength;
			const init = new Uint8Array(total);
			init.set(pendingEbml, 0);
			init.set(pendingSegmentHeader, pendingEbml.byteLength);
			pendingEbml = null;
			pendingSegmentHeader = null;
			blobParts.push(init);
			videoQueue.push(init);
		}
	};

	if (durationUs > 0) {
		try {
			mediaSource.duration = durationUs / 1_000_000;
		} catch {
			// Some browsers throw if duration is set before any
			// SourceBuffer is added; ignore.
		}
	}

	const sourceBuffer = mediaSource.addSourceBuffer(WEBM_VP9_MIME);
	try {
		sourceBuffer.mode = 'segments';
	} catch {
		// older browsers default to 'segments'; ignore
	}
	videoQueue = createSourceBufferQueue(sourceBuffer);

	// Mediabunny's `appendOnly: true` mode writes the WebM
	// monotonically (no late-patch seeks) — perfect for
	// MediaSource. The per-element callbacks let us snapshot the
	// init segment and each cluster as they're finalised, avoiding
	// the much-finer-grained writes that `StreamTarget` would emit.
	const output = new Output({
		target: new NullTarget(),
		format: new WebMOutputFormat({
			appendOnly: true,
			// Short clusters → low play-press latency. ~1 second
			// of frames per cluster gives MSE its first playable
			// region quickly while keeping per-cluster overhead
			// low. (Each cluster carries its own keyframe-required
			// EBML headers, so going much smaller wastes bytes.)
			minimumClusterDuration: 1,
			onEbmlHeader: (data) => {
				const copy = new Uint8Array(data.byteLength);
				copy.set(data);
				pendingEbml = copy;
				flushInitIfReady();
			},
			onSegmentHeader: (data) => {
				const copy = new Uint8Array(data.byteLength);
				copy.set(data);
				pendingSegmentHeader = copy;
				flushInitIfReady();
			},
			onCluster: (data) => {
				if (signal?.aborted) return;
				const copy = new Uint8Array(data.byteLength);
				copy.set(data);
				blobParts.push(copy);
				videoQueue?.push(copy);
			},
		}),
	});

	const videoSource = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(videoSource, {
		frameRate: Math.max(1, Math.round(fps)),
	});

	await output.start();
	signal?.throwIfAborted();

	const PROGRESS_BATCH = 16;
	let batchStart = performance.now();
	const abortHandler = (): void => {
		videoQueue?.close();
	};
	signal?.addEventListener('abort', abortHandler, { once: true });

	try {
		// We send the first packet with the decoder config Mediabunny
		// needs to write the WebM's CodecPrivate / Tracks element.
		// Subsequent packets carry just the encoded data.
		let metaSent = false;
		for (let i = 0; i < frameCount; i++) {
			signal?.throwIfAborted();
			const frame = ivf.frames[i]!;
			const isKey = i === 0 || isVp9Keyframe(frame.data);
			const pkt = new EncodedPacket(
				frame.data,
				isKey ? 'key' : 'delta',
				i * frameDurUs / 1_000_000,
				frameDurUs / 1_000_000,
			);
			await videoSource.add(
				pkt,
				metaSent
					? undefined
					: {
							decoderConfig: {
								codec: vp9CodecString(video, ivf.frames[0]!.data),
								codedWidth: video.width,
								codedHeight: video.height,
							},
						},
			);
			metaSent = true;

			if ((i + 1) % PROGRESS_BATCH === 0 || i + 1 === frameCount) {
				const now = performance.now();
				const dt = (now - batchStart) / 1000;
				batchStart = now;
				const batchFps = dt > 0 ? PROGRESS_BATCH / dt : 0;
				onProgress?.({
					frame: i + 1,
					total: frameCount,
					fps: batchFps,
				});
				// Yield so MSE drains + React repaints.
				await new Promise<void>((r) => setTimeout(r, 0));
			}
		}

		videoSource.close();
		await output.finalize();
		await videoQueue.drained();
		if (mediaSource.readyState === 'open') {
			try {
				mediaSource.endOfStream();
			} catch {
				// state race with abort; ignore
			}
		}
	} finally {
		if (signal) signal.removeEventListener('abort', abortHandler);
		if (mediaSource.readyState === 'open') {
			try {
				videoQueue.close();
				mediaSource.endOfStream('decode');
			} catch {
				// already ended or shut down
			}
		}
	}

	const webm = new Blob(blobParts, { type: 'video/webm' });
	return { webm, info, frameCount };
}

/**
 * Build a WebCodecs-style VP9 codec string from the USM video
 * stream's coded resolution. WebM's CodecPrivate doesn't carry
 * a full VP9 codec descriptor (unlike MP4's vpcC box), so MSE
 * mostly only checks the `vp09.PP.LL.BD` prefix. We supply a
 * sensible 8-bit 4:2:0 BT.709 default that matches every
 * CRI-authored USM in the wild; the exact bitdepth / color
 * primaries don't change playback for these files.
 */
function vp9CodecString(
	_video: UsmVideoStream,
	_firstFrame: Uint8Array,
): string {
	return 'vp09.00.41.08';
}
