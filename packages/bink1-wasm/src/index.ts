/**
 * @tootallnate/bink1-wasm
 *
 * Decode Bink 1 (`.bik`) video AND audio files from JavaScript via
 * a WebAssembly module built from a slim ffmpeg configuration
 * (Bink 1 decoder + Bink audio decoders + Bink demuxer only).
 *
 * The compiled `bink1.wasm` IS shipped with this package. ffmpeg is
 * LGPL-2.1-or-later, which permits redistribution of compiled
 * binaries provided users retain the right to relink against
 * modified ffmpeg builds. See `scripts/setup-source.sh` and the
 * package README for build reproduction instructions.
 *
 * Public API:
 *
 *   const decoder = await Bink1Decoder.create(wasmBytes, bikBytes);
 *   const info = decoder.info;        // {width, height, frameCount, fpsNum, fpsDen, audioTrackCount}
 *
 *   while (true) {
 *     const frame = decoder.decodeNextFrame();
 *     if (!frame) break;              // end of stream
 *     // frame.{y,u,v} are Uint8Array views into WASM memory; copy
 *     // them before the next decodeNextFrame() call or they'll
 *     // be overwritten.
 *
 *     // Audio packets are decoded inline with video advancement;
 *     // pull whatever was buffered for each track:
 *     for (let t = 0; t < info.audioTrackCount; t++) {
 *       const audio = decoder.drainAudio(t);
 *       if (audio.samplesPerChannel > 0) handleSamples(audio);
 *     }
 *   }
 *
 *   decoder.dispose();
 *
 * Frames are decoded in monotonic order only (the decoder is a
 * forward streaming pull). Arbitrary seek is not yet implemented;
 * callers needing it should rebuild a new decoder instance.
 */

export type Bink1WasmSource =
	| WebAssembly.Module
	| BufferSource
	| Promise<WebAssembly.Module | BufferSource>;

/** Header / container metadata for a .bik file. */
export interface Bink1Info {
	/** Pixel width of the displayed video. */
	width: number;
	/** Pixel height of the displayed video. */
	height: number;
	/** Total number of frames in the file (as reported by the demuxer). */
	frameCount: number;
	/** Frames-per-second numerator. (fps = fpsNum / fpsDen.) */
	fpsNum: number;
	/** Frames-per-second denominator. */
	fpsDen: number;
	/** Number of audio tracks in the container. */
	audioTrackCount: number;
}

/** Metadata for a single audio track in the container. */
export interface Bink1AudioTrackInfo {
	/** Container-declared sample rate in Hz. */
	sampleRate: number;
	/** Number of channels (1 = mono, 2 = stereo). */
	channels: number;
}

/**
 * Audio samples drained for one track from the decoder's internal
 * FIFO. Returned by {@link Bink1Decoder.drainAudio}.
 *
 * **The `interleaved` array is a view into WASM memory** and is only
 * valid until the next `drainAudio()` call on the same track. Copy
 * the bytes (`new Float32Array(view)`) if you need them past that
 * point.
 *
 * `samplesPerChannel === 0` means "no audio has been decoded for
 * this track since the last drain" — this is normal between
 * successive video frames.
 */
export interface Bink1AudioFrame {
	/** Number of channels (matches `audioTrack(i).channels`). */
	channels: number;
	/** Number of samples per channel. */
	samplesPerChannel: number;
	/** Interleaved Float32 samples; length = `channels * samplesPerChannel`. */
	interleaved: Float32Array;
}

/**
 * One decoded frame, as views into WASM linear memory.
 *
 * **The plane views are only valid until the next
 * `decodeNextFrame()` or `dispose()` call.** Copy the data (e.g.
 * `new Uint8Array(plane)`) before doing anything else with the
 * decoder.
 *
 * Bink 1 emits YUV420P: Y is `yStride * height` bytes, U/V are each
 * `chromaStride * (height/2)` bytes. The visible width/height come
 * from `info.width` / `info.height`; the strides may be larger due
 * to ffmpeg's row alignment.
 */
export interface Bink1Frame {
	/** Width of the decoded frame (matches `info.width`). */
	width: number;
	/** Height of the decoded frame (matches `info.height`). */
	height: number;
	/** Byte stride between rows of the Y plane. */
	yStride: number;
	/** Byte stride between rows of the U plane. */
	uStride: number;
	/** Byte stride between rows of the V plane. */
	vStride: number;
	/** Y (luma) plane, view into WASM memory. */
	y: Uint8Array;
	/** U (Cb) plane, view into WASM memory; half-width, half-height of Y. */
	u: Uint8Array;
	/** V (Cr) plane, view into WASM memory; half-width, half-height of Y. */
	v: Uint8Array;
}

/** Thrown when the decoder rejects the input or fails during decode. */
export class Bink1DecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Bink1DecodeError';
	}
}

const compiledCache = new WeakMap<object, WebAssembly.Module>();

async function compileSource(source: Bink1WasmSource): Promise<WebAssembly.Module> {
	const resolved = await source;
	if (resolved instanceof WebAssembly.Module) return resolved;
	const buf = resolved as BufferSource;
	const cacheKey: object =
		(buf as ArrayBufferView).buffer instanceof ArrayBuffer
			? (buf as ArrayBufferView).buffer
			: (buf as ArrayBuffer);
	const cached = compiledCache.get(cacheKey);
	if (cached) return cached;
	const compiled = await WebAssembly.compile(buf);
	compiledCache.set(cacheKey, compiled);
	return compiled;
}

/**
 * Stub table for the WASI snapshot-1 imports that wasi-libc pulls
 * into the module transitively. The decoder's hot path never invokes
 * any of these — they're dragged in by libc's printf/fopen/etc.,
 * which ffmpeg uses for av_log diagnostics — but every imported
 * symbol must be present at instantiation time.
 *
 * Most stubs return 52 (ENOSYS) so a misroute is loud. `environ_*`
 * and `args_*` answer "empty" success because libc's `getenv` will
 * abort the module if they fail.
 */
function buildWasiStubs(
	getMemory: () => WebAssembly.Memory,
): Record<string, (...args: number[]) => number> {
	const ENOSYS = 52;
	const ENOENT = 44;
	const ESUCCESS = 0;
	const stub = (..._args: number[]): number => ENOSYS;
	const noent = (..._args: number[]): number => ENOENT;
	const emptyOk = (countPtr: number, bufSizePtr: number): number => {
		const view = new DataView(getMemory().buffer);
		view.setUint32(countPtr, 0, true);
		view.setUint32(bufSizePtr, 0, true);
		return ESUCCESS;
	};
	const procExit = (..._args: number[]): number => {
		throw new Error('Bink1: wasm called proc_exit (unexpected)');
	};
	// fd_write goes to stderr/stdout for ffmpeg's av_log diagnostics.
	// We swallow it silently — pretending the write succeeded — so
	// libc's stdio buffers don't trigger a fallback path that
	// proc_exits the module. Length-out is the requested length.
	const fdWrite = (
		_fd: number,
		iovsPtr: number,
		iovsLen: number,
		nwrittenPtr: number,
	): number => {
		const view = new DataView(getMemory().buffer);
		let total = 0;
		for (let i = 0; i < iovsLen; i++) {
			total += view.getUint32(iovsPtr + i * 8 + 4, true);
		}
		view.setUint32(nwrittenPtr, total, true);
		return ESUCCESS;
	};
	return {
		fd_close: noent,
		fd_seek: noent,
		fd_write: fdWrite,
		fd_read: noent,
		fd_fdstat_get: noent,
		fd_fdstat_set_flags: noent,
		fd_prestat_get: noent,
		fd_prestat_dir_name: noent,
		proc_exit: procExit,
		environ_get: () => ESUCCESS,
		environ_sizes_get: emptyOk,
		clock_time_get: stub,
		random_get: stub,
		poll_oneoff: stub,
		path_open: noent,
	};
}

interface WasmExports {
	memory: WebAssembly.Memory;
	_initialize?: () => void;

	bink1_malloc: (n: number) => number;
	bink1_free: (p: number) => void;
	bink1_open: (data: number, len: number) => number;
	bink1_close: () => void;

	bink1_width: () => number;
	bink1_height: () => number;
	bink1_frame_count: () => number;
	bink1_fps_num: () => number;
	bink1_fps_den: () => number;
	bink1_audio_track_count: () => number;
	bink1_audio_track_sample_rate: (i: number) => number;
	bink1_audio_track_channels: (i: number) => number;

	bink1_frame_width: () => number;
	bink1_frame_height: () => number;
	bink1_frame_y_stride: () => number;
	bink1_frame_u_stride: () => number;
	bink1_frame_v_stride: () => number;
	bink1_frame_y_ptr: () => number;
	bink1_frame_u_ptr: () => number;
	bink1_frame_v_ptr: () => number;
	bink1_frame_pix_fmt: () => number;
	bink1_decode_next_frame: () => number;

	bink1_drain_audio: (trackIndex: number) => number;
	bink1_audio_drain_ptr: (trackIndex: number) => number;
}

/** AVPixelFormat YUV420P numeric value, the only format Bink 1 emits. */
const AV_PIX_FMT_YUV420P = 0;

/**
 * Owning handle for a decoded Bink 1 file.
 *
 * Always call `dispose()` when done to free the WASM memory.
 */
export class Bink1Decoder {
	#exports: WasmExports;
	#info: Bink1Info;
	#disposed = false;
	#framesEmitted = 0;

	private constructor(exports: WasmExports) {
		this.#exports = exports;
		this.#info = {
			width: exports.bink1_width(),
			height: exports.bink1_height(),
			frameCount: exports.bink1_frame_count(),
			fpsNum: exports.bink1_fps_num(),
			fpsDen: exports.bink1_fps_den(),
			audioTrackCount: exports.bink1_audio_track_count(),
		};
	}

	/**
	 * Compile (if needed) and instantiate the WASM, then open the
	 * given `.bik` byte buffer.
	 *
	 * The `bikBytes` are copied into WASM memory once during this
	 * call and held there for the decoder's lifetime — ffmpeg's
	 * demuxer reads from this buffer on demand. The caller is free
	 * to discard their copy after this returns.
	 */
	static async create(source: Bink1WasmSource, bikBytes: Uint8Array): Promise<Bink1Decoder> {
		const module = await compileSource(source);
		let memHolder: WebAssembly.Memory | undefined;
		const instance = await WebAssembly.instantiate(module, {
			wasi_snapshot_preview1: buildWasiStubs(() => {
				if (!memHolder) throw new Error('Bink1: stub called before instantiate completed');
				return memHolder;
			}),
			env: {
				// ffmpeg's libavutil pulls in a `clock` symbol (from
				// libc's <time.h>) that wasi-libc declares but does
				// not link by default. Stub it as "0 ticks elapsed".
				clock: (): number => 0,
			},
		});
		const exports = instance.exports as unknown as WasmExports;
		memHolder = exports.memory;

		exports._initialize?.();

		// Allocate inside WASM and copy the .bik bytes in. The C side
		// transfers ownership of this buffer on success (it holds onto
		// it for the demuxer's lifetime), so we don't free here.
		const ptr = exports.bink1_malloc(bikBytes.length);
		if (!ptr) throw new Bink1DecodeError(`bink1_malloc(${bikBytes.length}) failed`);
		new Uint8Array(exports.memory.buffer, ptr, bikBytes.length).set(bikBytes);
		const ok = exports.bink1_open(ptr, bikBytes.length);
		// On failure bink1_open freed the buffer itself; on success it
		// retains it.
		if (!ok) throw new Bink1DecodeError('bink1_open failed: not a valid Bink 1 file (or unsupported sub-variant)');

		return new Bink1Decoder(exports);
	}

	/** Container metadata: dimensions, fps, frame count, etc. */
	get info(): Bink1Info { return this.#info; }

	/** Metadata for audio track `i`. */
	audioTrack(i: number): Bink1AudioTrackInfo {
		if (this.#disposed) throw new Error('Bink1Decoder used after dispose()');
		if (i < 0 || i >= this.#info.audioTrackCount) {
			throw new Bink1DecodeError(`audio track index ${i} out of range (0..${this.#info.audioTrackCount - 1})`);
		}
		return {
			sampleRate: this.#exports.bink1_audio_track_sample_rate(i),
			channels: this.#exports.bink1_audio_track_channels(i),
		};
	}

	/**
	 * Decode the next video frame in monotonic order. Returns
	 * `null` once the end of stream is reached; throws on decode
	 * errors. Plane views become invalid on the next call.
	 */
	decodeNextFrame(): Bink1Frame | null {
		if (this.#disposed) throw new Error('Bink1Decoder.decodeNextFrame called after dispose()');
		const rc = this.#exports.bink1_decode_next_frame();
		if (rc === 0) return null;
		if (rc < 0) throw new Bink1DecodeError(`bink1_decode_next_frame failed at frame ${this.#framesEmitted}`);

		const fmt = this.#exports.bink1_frame_pix_fmt();
		if (fmt !== AV_PIX_FMT_YUV420P) {
			throw new Bink1DecodeError(`Unexpected pixel format ${fmt}; expected YUV420P (${AV_PIX_FMT_YUV420P})`);
		}

		const mem = this.#exports.memory.buffer;
		const w = this.#exports.bink1_frame_width();
		const h = this.#exports.bink1_frame_height();
		const yStride = this.#exports.bink1_frame_y_stride();
		const uStride = this.#exports.bink1_frame_u_stride();
		const vStride = this.#exports.bink1_frame_v_stride();
		const yPtr = this.#exports.bink1_frame_y_ptr();
		const uPtr = this.#exports.bink1_frame_u_ptr();
		const vPtr = this.#exports.bink1_frame_v_ptr();
		const cH = (h + 1) >> 1;
		this.#framesEmitted++;
		return {
			width: w,
			height: h,
			yStride,
			uStride,
			vStride,
			y: new Uint8Array(mem, yPtr, yStride * h),
			u: new Uint8Array(mem, uPtr, uStride * cH),
			v: new Uint8Array(mem, vPtr, vStride * cH),
		};
	}

	/**
	 * Copy the visible region (cropped to `info.width` x `info.height`,
	 * stride-stripped) of the current frame's planes into
	 * freshly-allocated JS-side buffers. Use this when you want to
	 * keep plane bytes around past the next `decodeNextFrame()` call.
	 *
	 * The returned planes are tightly packed (`stride === width`):
	 * Y is `width * height`, U/V are `(width/2) * (height/2)`.
	 */
	copyVisiblePlanes(frame: Bink1Frame): {
		width: number;
		height: number;
		y: Uint8Array;
		u: Uint8Array;
		v: Uint8Array;
	} {
		const w = frame.width;
		const h = frame.height;
		const cw = (w + 1) >> 1;
		const ch = (h + 1) >> 1;
		const cropPlane = (src: Uint8Array, srcStride: number, dw: number, dh: number): Uint8Array => {
			if (srcStride === dw) return src.slice(0, dw * dh);
			const out = new Uint8Array(dw * dh);
			for (let y = 0; y < dh; y++) {
				out.set(src.subarray(y * srcStride, y * srcStride + dw), y * dw);
			}
			return out;
		};
		return {
			width: w,
			height: h,
			y: cropPlane(frame.y, frame.yStride, w, h),
			u: cropPlane(frame.u, frame.uStride, cw, ch),
			v: cropPlane(frame.v, frame.vStride, cw, ch),
		};
	}

	/**
	 * Drain decoded audio for track `trackIndex` that the
	 * `decodeNextFrame` loop has accumulated since the last drain.
	 * Returns an interleaved Float32 view into WASM memory; the
	 * view is invalidated by the next `drainAudio(trackIndex)`
	 * call (other tracks have independent buffers).
	 *
	 * Typical usage: call once per audio track after each
	 * `decodeNextFrame()`. After end-of-stream you should drain
	 * once more to pick up any tail samples flushed by the
	 * decoder's `send_packet(NULL)` step.
	 */
	drainAudio(trackIndex: number): Bink1AudioFrame {
		if (this.#disposed) throw new Error('Bink1Decoder.drainAudio called after dispose()');
		if (trackIndex < 0 || trackIndex >= this.#info.audioTrackCount) {
			throw new Bink1DecodeError(`audio track index ${trackIndex} out of range (0..${this.#info.audioTrackCount - 1})`);
		}
		const channels = this.#exports.bink1_audio_track_channels(trackIndex);
		const samples = this.#exports.bink1_drain_audio(trackIndex);
		const ptr = this.#exports.bink1_audio_drain_ptr(trackIndex);
		return {
			channels,
			samplesPerChannel: samples,
			interleaved: samples > 0 && ptr
				? new Float32Array(this.#exports.memory.buffer, ptr, samples * channels)
				: new Float32Array(0),
		};
	}

	/** Close the session and free the WASM-owned buffers. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#exports.bink1_close();
	}
}
