/**
 * @tootallnate/bink2-wasm
 *
 * Decode Bink 2 (`.bk2`) video files from JavaScript via a
 * WebAssembly module built from `bbit-git/cnc-ra-libs`' in-tree
 * Bink 2 decoder.
 *
 * **The compiled `bink2.wasm` is NOT shipped with this package.**
 * The upstream source is GPL-3.0; the compiled artifact inherits
 * that license, and this MIT repository does not redistribute it.
 * Callers supply the WASM bytes themselves — see the README for
 * build instructions (`make setup && make setup-source && make`).
 *
 * Public API:
 *
 *   const decoder = await Bink2Decoder.create(wasmBytes, bk2Bytes);
 *   const info = decoder.info;        // {width, height, frameCount, fpsNum, fpsDen, ...}
 *
 *   for (let i = 0; i < info.frameCount; i++) {
 *     const frame = decoder.decodeFrame(i);  // throws on failure
 *     // frame.{y,u,v} are Uint8Array views into WASM memory; copy
 *     // them before the next decodeFrame() call or they'll be
 *     // overwritten.
 *   }
 *
 *   decoder.dispose();
 *
 * Frames MUST be decoded in monotonic order (inter-frames need the
 * previous decoded frame as a reference). You may seek to a keyframe
 * and resume forward iteration from there.
 */

export type Bink2WasmSource =
	| WebAssembly.Module
	| BufferSource
	| Promise<WebAssembly.Module | BufferSource>;

/** Header / container metadata for a .bk2 file. */
export interface Bink2Info {
	/** Pixel width of the displayed video. */
	width: number;
	/** Pixel height of the displayed video. */
	height: number;
	/** Total number of frames in the file. */
	frameCount: number;
	/** Frames-per-second numerator. (fps = fpsNum / fpsDen.) */
	fpsNum: number;
	/** Frames-per-second denominator. */
	fpsDen: number;
	/** Number of audio tracks in the container. Call `initAudio(i)` to decode one. */
	audioTrackCount: number;
	/** True iff the video has an alpha plane. */
	hasAlpha: boolean;
}

/** Metadata for a single audio track in the container. */
export interface Bink2AudioTrackInfo {
	/** Container-declared sample rate in Hz. */
	sampleRate: number;
	/** True iff the track is stereo (1 / 2 channels otherwise). */
	stereo: boolean;
	/** True iff the track uses the DCT transform (vs RDFT). */
	useDct: boolean;
	/** Container-level track flags. Useful for debugging. */
	flags: number;
	/** Track id (per-track u32, unique within the container). */
	id: number;
}

/**
 * Audio decoded for one frame (= one Bink audio packet) of one track.
 * Samples are interleaved Float32 in the nominal [-1.0, 1.0] range,
 * matching what WebCodecs `AudioData` with `format: 'f32'` expects.
 *
 * **The `interleaved` array is a view into WASM memory** and is only
 * valid until the next `decodeAudio()` call on the same track. Copy
 * the bytes before doing anything else with the decoder.
 *
 * `samplesPerChannel === 0` means "this frame carries no audio for
 * this track" (legitimate; many frames have audio only on some tracks).
 */
export interface Bink2AudioFrame {
	/** Number of channels (1 = mono, 2 = stereo). */
	channels: number;
	/** Number of samples per channel (not the total length of `interleaved`). */
	samplesPerChannel: number;
	/** Interleaved samples, length = channels * samplesPerChannel. */
	interleaved: Float32Array;
}

/**
 * One decoded frame, as views into WASM linear memory.
 *
 * **The plane views are only valid until the next `decodeFrame()`
 * or `dispose()` call.** Copy the data (e.g. `new Uint8Array(plane)`)
 * before doing anything else with the decoder.
 *
 * Planes are stored at `alignedWidth` x `alignedHeight` (multiples
 * of 32), and the visible region is `info.width` x `info.height`
 * from the top-left corner. The stride between consecutive rows of
 * each plane is given by `lumaStride` (Y, A) or `chromaStride` (U, V).
 */
export interface Bink2Frame {
	/** Width of the underlying plane buffers (padded to 32-pixel multiple). */
	alignedWidth: number;
	/** Height of the underlying plane buffers (padded to 32-pixel multiple). */
	alignedHeight: number;
	/** Byte stride between rows of the Y/A planes. */
	lumaStride: number;
	/** Byte stride between rows of the U/V planes. */
	chromaStride: number;
	/** Y (luma) plane, view into WASM memory. */
	y: Uint8Array;
	/** U (Cb) plane, view into WASM memory; half-width, half-height of Y. */
	u: Uint8Array;
	/** V (Cr) plane, view into WASM memory; half-width, half-height of Y. */
	v: Uint8Array;
	/** Alpha plane, or null if the video has no alpha. View into WASM memory. */
	a: Uint8Array | null;
}

/** Thrown when the decoder rejects the input or fails during decode. */
export class Bink2DecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Bink2DecodeError';
	}
}

const compiledCache = new WeakMap<object, WebAssembly.Module>();

async function compileSource(source: Bink2WasmSource): Promise<WebAssembly.Module> {
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
 * any of these — they're dragged in by libc's printf/fopen/etc., which
 * the decoder doesn't actually call — but every imported symbol must
 * be present at instantiation time.
 *
 * Each stub returns 52 (ENOSYS) so a misroute is loud rather than silent.
 */
function buildWasiStubs(
	getMemory: () => WebAssembly.Memory,
): Record<string, (...args: number[]) => number> {
	const ENOSYS = 52;
	const ENOENT = 44;
	const ESUCCESS = 0;
	const stub = (..._args: number[]): number => ENOSYS;
	const noent = (..._args: number[]): number => ENOENT;
	// The decoder transitively calls `getenv` (via debug-only env-flag
	// probes). wasi-libc's `getenv` lazily calls `environ_sizes_get` /
	// `environ_get` and aborts the WASM (via `proc_exit(71)`) if those
	// return failure. Return "empty environment" success instead so
	// `getenv` cleanly returns NULL.
	const environSizesGet = (countPtr: number, bufSizePtr: number): number => {
		const view = new DataView(getMemory().buffer);
		view.setUint32(countPtr, 0, true);
		view.setUint32(bufSizePtr, 0, true);
		return ESUCCESS;
	};
	const environGet = (..._args: number[]): number => ESUCCESS;
	const argsSizesGet = (countPtr: number, bufSizePtr: number): number => {
		const view = new DataView(getMemory().buffer);
		view.setUint32(countPtr, 0, true);
		view.setUint32(bufSizePtr, 0, true);
		return ESUCCESS;
	};
	const argsGet = (..._args: number[]): number => ESUCCESS;
	// proc_exit is non-recoverable. wasi-libc calls it on dlopen-style
	// failures and a couple of unrecoverable libc states. The decoder
	// itself never reaches these paths.
	const procExit = (..._args: number[]): number => {
		throw new Error('Bink2: wasm called proc_exit (unexpected)');
	};
	return {
		// File I/O: the decoder operates purely from in-memory buffers
		// (Open_Memory), but wasi-libc pulls these in via its FILE*
		// runtime for printf-family functions the decoder doesn't call.
		// noent (instead of ENOSYS) keeps libc's file path-not-found
		// branches happy if they're ever taken.
		fd_close: noent,
		fd_seek: noent,
		fd_write: noent,
		fd_read: noent,
		fd_pread: noent,
		fd_pwrite: noent,
		fd_fdstat_get: noent,
		fd_fdstat_set_flags: noent,
		fd_prestat_get: noent,
		fd_prestat_dir_name: noent,
		fd_filestat_get: noent,
		fd_filestat_set_size: noent,
		proc_exit: procExit,
		// Environment / args probed lazily by libc — answer "empty".
		environ_get: environGet,
		environ_sizes_get: environSizesGet,
		args_get: argsGet,
		args_sizes_get: argsSizesGet,
		// These should never be invoked by the decode hot path.
		clock_time_get: stub,
		clock_res_get: stub,
		random_get: stub,
		poll_oneoff: stub,
		path_open: noent,
		path_filestat_get: noent,
		path_create_directory: stub,
		path_remove_directory: stub,
		path_unlink_file: stub,
		path_rename: stub,
		sched_yield: stub,
	};
}

interface WasmExports {
	memory: WebAssembly.Memory;
	/** wasi-libc reactor entrypoint (runs C++ constructors). */
	_initialize?: () => void;

	// Audio track inspection + decode.
	bink2_audio_track_count: () => number;
	bink2_audio_track_sample_rate: (i: number) => number;
	bink2_audio_track_flags: (i: number) => number;
	bink2_audio_track_stereo: (i: number) => number;
	bink2_audio_track_use_dct: (i: number) => number;
	bink2_audio_track_id: (i: number) => number;
	bink2_audio_init: (i: number) => number;
	bink2_audio_channels: (i: number) => number;
	bink2_audio_decoded_sample_rate: (i: number) => number;
	bink2_audio_decode_packet: (frameIndex: number, trackIndex: number) => number;
	bink2_audio_interleaved_ptr: (trackIndex: number) => number;
	bink2_audio_interleaved_len: (trackIndex: number) => number;

	bink2_malloc: (n: number) => number;
	bink2_free: (p: number) => void;
	bink2_open: (data: number, len: number) => number;
	bink2_close: () => void;
	bink2_decode_frame: (index: number) => number;

	bink2_width: () => number;
	bink2_height: () => number;
	bink2_frame_count: () => number;
	bink2_fps_num: () => number;
	bink2_fps_den: () => number;
	bink2_audio_tracks: () => number;
	bink2_has_alpha: () => number;
	bink2_is_keyframe: (i: number) => number;

	bink2_frame_aligned_width: () => number;
	bink2_frame_aligned_height: () => number;
	bink2_frame_luma_stride: () => number;
	bink2_frame_chroma_stride: () => number;
	bink2_frame_y_ptr: () => number;
	bink2_frame_u_ptr: () => number;
	bink2_frame_v_ptr: () => number;
	bink2_frame_a_ptr: () => number;
	bink2_frame_y_len: () => number;
	bink2_frame_u_len: () => number;
	bink2_frame_v_len: () => number;
	bink2_frame_a_len: () => number;
}

/**
 * Owning handle for a decoded Bink 2 file.
 *
 * Each instance owns its own WebAssembly memory, so cost scales with
 * `O(.bk2 file size + one decoded YUV frame)` — about
 * `file_size + width*height*1.5` bytes per instance. For typical
 * cinematics (1280x960, 50–100 MB file) that's ~60–110 MB.
 *
 * Always call `dispose()` when done to free the WASM memory.
 */
export class Bink2Decoder {
	#exports: WasmExports;
	#info: Bink2Info;
	#disposed = false;
	/** Last successfully decoded frame index, or -1 if none yet. */
	#lastFrame = -1;

	private constructor(exports: WasmExports) {
		this.#exports = exports;
		this.#info = {
			width: exports.bink2_width(),
			height: exports.bink2_height(),
			frameCount: exports.bink2_frame_count(),
			fpsNum: exports.bink2_fps_num(),
			fpsDen: exports.bink2_fps_den(),
			audioTrackCount: exports.bink2_audio_tracks(),
			hasAlpha: exports.bink2_has_alpha() !== 0,
		};
	}

	/**
	 * Compile (if needed) and instantiate the WASM, then open the
	 * given `.bk2` byte buffer.
	 *
	 * The `bk2Bytes` are copied into WASM memory once during this
	 * call; afterwards the caller is free to discard their copy.
	 */
	static async create(source: Bink2WasmSource, bk2Bytes: Uint8Array): Promise<Bink2Decoder> {
		const module = await compileSource(source);
		// The stub table needs access to `memory` so it can write
		// envc/envv-size pointers, but memory is an export so we
		// can't reference it until after instantiate(). Use a holder
		// the stubs read lazily.
		let memHolder: WebAssembly.Memory | undefined;
		const instance = await WebAssembly.instantiate(module, {
			wasi_snapshot_preview1: buildWasiStubs(() => {
				if (!memHolder) throw new Error('Bink2: stub called before instantiate completed');
				return memHolder;
			}),
			env: {
				// `__cxa_thread_atexit` registers a C++ destructor to run
				// when a thread exits. wasm32-wasip1 builds drag this in
				// transitively via libc++'s allocator machinery even
				// when no thread_local is used directly. The decoder
				// has no per-thread state we care about cleaning up;
				// return success without registering anything.
				__cxa_thread_atexit: (..._args: number[]): number => 0,
			},
		});
		const exports = instance.exports as unknown as WasmExports;
		memHolder = exports.memory;

		// Reactor WASMs (built with `-mexec-model=reactor`) expose an
		// `_initialize` function that runs C++ constructors and wasi-libc
		// init. Must be called before any other export.
		exports._initialize?.();

		// Copy the .bk2 into WASM memory, then call bink2_open.
		const ptr = exports.bink2_malloc(bk2Bytes.length);
		if (!ptr) throw new Error(`bink2_malloc(${bk2Bytes.length}) failed`);
		try {
			new Uint8Array(exports.memory.buffer, ptr, bk2Bytes.length).set(bk2Bytes);
			const ok = exports.bink2_open(ptr, bk2Bytes.length);
			if (!ok) throw new Bink2DecodeError('bink2_open failed: not a valid Bink 2 file');
		} finally {
			// The C++ Open_Memory takes a copy, so we can free
			// the JS-side scratch immediately.
			exports.bink2_free(ptr);
		}

		return new Bink2Decoder(exports);
	}

	/** Container metadata: dimensions, fps, frame count, etc. */
	get info(): Bink2Info { return this.#info; }

	/** True iff frame `i` is a keyframe (decodable without a previous reference). */
	isKeyframe(i: number): boolean {
		if (this.#disposed) throw new Error('Bink2Decoder used after dispose()');
		if (i < 0 || i >= this.#info.frameCount) return false;
		return this.#exports.bink2_is_keyframe(i) !== 0;
	}

	/**
	 * Decode frame `index`. Returns a {@link Bink2Frame} whose plane
	 * fields are views into WASM linear memory; **copy the bytes
	 * before the next `decodeFrame()` call or they'll be overwritten.**
	 *
	 * Frames must be decoded in monotonic order. You may seek to a
	 * keyframe (e.g. `decodeFrame(0)` then `decodeFrame(K)` for a
	 * later keyframe `K`) and resume forward iteration; jumping to a
	 * non-keyframe out of order will throw.
	 */
	decodeFrame(index: number): Bink2Frame {
		if (this.#disposed) throw new Error('Bink2Decoder.decodeFrame called after dispose()');
		if (index < 0 || index >= this.#info.frameCount) {
			throw new Bink2DecodeError(`frame index ${index} out of range (0..${this.#info.frameCount - 1})`);
		}
		// Caller may decode a keyframe out of order to seek; non-keyframes
		// require strictly-increasing index from the last call.
		const isKf = this.isKeyframe(index);
		if (!isKf && (this.#lastFrame === -1 || index !== this.#lastFrame + 1)) {
			throw new Bink2DecodeError(
				`non-keyframe ${index} requested out of order (last decoded: ${this.#lastFrame})`,
			);
		}
		const ok = this.#exports.bink2_decode_frame(index);
		if (!ok) {
			throw new Bink2DecodeError(`bink2_decode_frame(${index}) failed`);
		}
		this.#lastFrame = index;

		// Build plane views. We re-read memory.buffer because the WASM
		// memory could (in theory) have grown between calls.
		const mem = this.#exports.memory.buffer;
		const yPtr = this.#exports.bink2_frame_y_ptr();
		const uPtr = this.#exports.bink2_frame_u_ptr();
		const vPtr = this.#exports.bink2_frame_v_ptr();
		const aPtr = this.#exports.bink2_frame_a_ptr();
		const yLen = this.#exports.bink2_frame_y_len();
		const uLen = this.#exports.bink2_frame_u_len();
		const vLen = this.#exports.bink2_frame_v_len();
		const aLen = this.#exports.bink2_frame_a_len();
		return {
			alignedWidth: this.#exports.bink2_frame_aligned_width(),
			alignedHeight: this.#exports.bink2_frame_aligned_height(),
			lumaStride: this.#exports.bink2_frame_luma_stride(),
			chromaStride: this.#exports.bink2_frame_chroma_stride(),
			y: new Uint8Array(mem, yPtr, yLen),
			u: new Uint8Array(mem, uPtr, uLen),
			v: new Uint8Array(mem, vPtr, vLen),
			a: aPtr && aLen ? new Uint8Array(mem, aPtr, aLen) : null,
		};
	}

	/**
	 * Copy the visible region (cropped to `info.width` x `info.height`)
	 * of the current frame's planes into freshly-allocated JS-side
	 * buffers. Use this when you want to keep plane bytes around
	 * past the next `decodeFrame()` call.
	 *
	 * The returned planes are tightly packed (`stride === width`):
	 * Y is `width * height`, U/V are `(width/2) * (height/2)`.
	 */
	copyVisiblePlanes(frame: Bink2Frame): {
		width: number;
		height: number;
		y: Uint8Array;
		u: Uint8Array;
		v: Uint8Array;
		a: Uint8Array | null;
	} {
		const { width, height } = this.#info;
		const cw = (width + 1) >> 1;
		const ch = (height + 1) >> 1;
		const cropPlane = (src: Uint8Array, srcStride: number, w: number, h: number): Uint8Array => {
			const out = new Uint8Array(w * h);
			for (let y = 0; y < h; y++) {
				out.set(src.subarray(y * srcStride, y * srcStride + w), y * w);
			}
			return out;
		};
		return {
			width,
			height,
			y: cropPlane(frame.y, frame.lumaStride, width, height),
			u: cropPlane(frame.u, frame.chromaStride, cw, ch),
			v: cropPlane(frame.v, frame.chromaStride, cw, ch),
			a: frame.a ? cropPlane(frame.a, frame.lumaStride, width, height) : null,
		};
	}

	/**
	 * Container metadata for audio track `i`. The track has to exist
	 * (`0 <= i < info.audioTrackCount`); throws otherwise.
	 *
	 * Inspection-only — does NOT initialise the decoder. Call
	 * {@link initAudio} before {@link decodeAudio}.
	 */
	audioTrack(i: number): Bink2AudioTrackInfo {
		if (this.#disposed) throw new Error('Bink2Decoder used after dispose()');
		if (i < 0 || i >= this.#info.audioTrackCount) {
			throw new Bink2DecodeError(`audio track index ${i} out of range (0..${this.#info.audioTrackCount - 1})`);
		}
		return {
			sampleRate: this.#exports.bink2_audio_track_sample_rate(i),
			stereo: this.#exports.bink2_audio_track_stereo(i) !== 0,
			useDct: this.#exports.bink2_audio_track_use_dct(i) !== 0,
			flags: this.#exports.bink2_audio_track_flags(i),
			id: this.#exports.bink2_audio_track_id(i),
		};
	}

	/**
	 * Prepare (or reset) the decoder for audio track `i`. Must be
	 * called once before {@link decodeAudio} for that track; calling
	 * again resets the rolling overlap state (useful if you want to
	 * seek backwards and re-decode).
	 *
	 * Returns the post-init {@link Bink2AudioTrackInfo} including the
	 * decoder's declared channel count and sample rate (which may
	 * differ from the container-declared sample rate for RDFT
	 * stereo tracks).
	 */
	initAudio(i: number): {
		channels: number;
		sampleRate: number;
	} {
		if (this.#disposed) throw new Error('Bink2Decoder used after dispose()');
		if (this.#exports.bink2_audio_init(i) === 0) {
			throw new Bink2DecodeError(`bink2_audio_init(${i}) failed`);
		}
		return {
			channels: this.#exports.bink2_audio_channels(i),
			sampleRate: this.#exports.bink2_audio_decoded_sample_rate(i),
		};
	}

	/**
	 * Decode the audio packet for `(trackIndex, frameIndex)`. Returns
	 * an interleaved Float32 view into WASM memory.
	 *
	 * **View invalidation**: the returned `interleaved` array is only
	 * valid until the next `decodeAudio()` call on the same track.
	 * Copy the bytes (`new Float32Array(view)`) if you need them past
	 * that point.
	 *
	 * Empty packets (zero samples) are a legitimate response — many
	 * Bink frames carry audio only on a subset of tracks.
	 *
	 * Bink audio uses block-by-block lapped overlap with the previous
	 * block's tail, so packets MUST be decoded in monotonic frame
	 * order per track. Initiating from a new starting point requires
	 * calling {@link initAudio} again to flush the overlap state.
	 */
	decodeAudio(frameIndex: number, trackIndex: number): Bink2AudioFrame {
		if (this.#disposed) throw new Error('Bink2Decoder used after dispose()');
		if (frameIndex < 0 || frameIndex >= this.#info.frameCount) {
			throw new Bink2DecodeError(`frame index ${frameIndex} out of range (0..${this.#info.frameCount - 1})`);
		}
		const samples = this.#exports.bink2_audio_decode_packet(frameIndex, trackIndex);
		if (samples === 0xffff_ffff) {
			throw new Bink2DecodeError(`bink2_audio_decode_packet(frame=${frameIndex}, track=${trackIndex}) failed`);
		}
		const channels = this.#exports.bink2_audio_channels(trackIndex);
		const ptr = this.#exports.bink2_audio_interleaved_ptr(trackIndex);
		const len = this.#exports.bink2_audio_interleaved_len(trackIndex);
		return {
			channels,
			samplesPerChannel: samples,
			interleaved: ptr && len
				? new Float32Array(this.#exports.memory.buffer, ptr, len)
				: new Float32Array(0),
		};
	}

	/** Close the session and free the WASM-owned file/frame buffers. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#exports.bink2_close();
		this.#lastFrame = -1;
	}
}
