/**
 * `@tootallnate/ffmpeg-wasm` — public TypeScript API.
 *
 * Usage (Bink 2 video + audio):
 *
 *   ```ts
 *   import { Ffmpeg } from '@tootallnate/ffmpeg-wasm';
 *   import baseUrl from '@tootallnate/ffmpeg-wasm/ffmpeg.wasm?url';
 *   import demuxerUrl from '@tootallnate/ffmpeg-bink-demuxer-wasm/bink-demuxer.so?url';
 *   import bink2Url from '@tootallnate/ffmpeg-bink2-video-wasm/bink2-video.so?url';
 *   import audioUrl from '@tootallnate/ffmpeg-bink-audio-wasm/bink-audio.so?url';
 *
 *   const [base, demuxer, video, audio] = await Promise.all([
 *     fetch(baseUrl).then(r => r.arrayBuffer()),
 *     fetch(demuxerUrl).then(r => r.arrayBuffer()),
 *     fetch(bink2Url).then(r => r.arrayBuffer()),
 *     fetch(audioUrl).then(r => r.arrayBuffer()),
 *   ]);
 *
 *   const ff = await Ffmpeg.create({
 *     wasm: base,
 *     extensions: [
 *       { name: 'bink-demuxer', wasm: demuxer },
 *       { name: 'bink2-video',  wasm: video },
 *       { name: 'bink-audio',   wasm: audio },
 *     ],
 *   });
 *   await ff.open(fileBytes);
 *   console.log(ff.info);  // { width, height, frameCount, fps, audioTracks, ... }
 *   const frame = ff.decodeFrame();
 *   // frame.{y,u,v} are views into WASM memory, valid until next decode.
 *   const audio = ff.drainAudio(0); // interleaved Float32 samples
 *   ```
 *
 * The base WASM ships no codecs / demuxers of its own — every
 * codec + demuxer lives in a separate extension that's
 * dynamically linked at `create()` time. The TS loader
 * auto-registers codecs/demuxers each extension advertises (via
 * its `ffmpeg_ext_<name>_codec(_N)?` / `_demuxer(_N)?` exports),
 * and `ffmpeg_open(bytes)` picks the right demuxer (probe) +
 * codec (by codec_id) for each stream automatically.
 */

import { loadExtension, type ExtensionDescriptor, type LoadedExtension } from './loader.js';

export type { ExtensionDescriptor, LoadedExtension };

/** Header / container metadata for the currently-open file. */
export interface FfmpegInfo {
	width: number;
	height: number;
	/** From the container; 0 if unknown. */
	frameCount: number;
	fpsNum: number;
	fpsDen: number;
	/** Raw `AVPixelFormat` enum value (see FFmpeg's `pixfmt.h`). */
	pixelFormat: number;
	/** One entry per audio track that has a matching decoder loaded. */
	audioTracks: FfmpegAudioTrack[];
}

/**
 * View of a single decoded YUV420P frame. The plane buffers are
 * sliced from the WASM module's linear memory; they're valid
 * until the next `decodeFrame()` or `close()` call.
 */
export interface FfmpegFrame {
	width: number;
	height: number;
	y: Uint8Array;
	u: Uint8Array;
	v: Uint8Array;
	yStride: number;
	uStride: number;
	vStride: number;
}

/** Options for `Ffmpeg.create()`. */
export interface FfmpegCreateOptions {
	/**
	 * Base `ffmpeg.wasm` bytes (or a pre-compiled
	 * `WebAssembly.Module`). The Vite/bundler-friendly way to get
	 * these is `import url from '@tootallnate/ffmpeg-wasm/ffmpeg.wasm?url'`
	 * then `await fetch(url).then(r => r.arrayBuffer())`.
	 */
	wasm: BufferSource | WebAssembly.Module;
	/**
	 * Extensions to load. Each extension is a separate `.so`
	 * compiled against the same base. Multiple extensions can be
	 * loaded into the same `Ffmpeg` instance — pick the right one
	 * at `open()` time via the `extension` option.
	 */
	extensions?: ExtensionDescriptor[];
}

/**
 * A decoded audio segment for a single track. Samples are
 * interleaved Float32 in the range [-1, 1].
 */
export interface FfmpegAudioChunk {
	/** Track index (0..audioTrackCount). */
	trackIndex: number;
	channels: number;
	sampleRate: number;
	/**
	 * Interleaved Float32 samples — `samples.length === sampleFrames * channels`.
	 * This is a view into WASM memory; copy it if you need to retain it
	 * past the next `drainAudio()` call.
	 */
	samples: Float32Array;
	/** Number of sample-frames (samples per channel). */
	sampleFrames: number;
}

/** Per-audio-track metadata. */
export interface FfmpegAudioTrack {
	channels: number;
	sampleRate: number;
}

/** Thrown for any errors during decode operations. */
export class FfmpegError extends Error {
	/** Raw libavutil AVERROR code (negative) when the error came from
	 * a wrapper return value. `undefined` when the error originated
	 * in the TS layer (e.g. "no file open"). */
	readonly code?: number;

	constructor(message: string, code?: number) {
		super(message);
		this.name = 'FfmpegError';
		this.code = code;
	}
}

/**
 * Convert an `AVERROR(*)` code to a human-readable name. FFmpeg
 * builds these via `FFERRTAG('I','N','D','A')` etc. — a 4-char
 * mnemonic packed into the low 32 bits, negated.
 *
 * We recognise the common ones here so the error message says
 * `INVALIDDATA` instead of `-1094995529`. Unknown codes fall
 * through as the raw integer.
 */
export function formatAvError(code: number): string {
	const KNOWN: Record<number, string> = {
		[-1094995529]: 'INVALIDDATA',
		[-541478725]: 'EOF',
		[-558323010]: 'BUG',
		[-1599361103]: 'OPTION_NOT_FOUND',
		[-1163346256]: 'PATCHWELCOME',
		[-542266451]: 'STREAM_NOT_FOUND',
		[-541934916]: 'DEMUXER_NOT_FOUND',
		[-541279556]: 'DECODER_NOT_FOUND',
		[-541870406]: 'FILTER_NOT_FOUND',
		[-542069328]: 'PROTOCOL_NOT_FOUND',
		[-1313558101]: 'UNKNOWN',
		[-1414092869]: 'EXIT',
		[-559175749]: 'EXTERNAL',
		// POSIX errno wrappers — `AVERROR(EAGAIN)` = `-EAGAIN`,
		// using the WASI/Linux errno numbers.
		[-11]: 'EAGAIN',
		[-1]: 'EPERM',
		[-2]: 'ENOENT',
		[-5]: 'EIO',
		[-12]: 'ENOMEM',
		[-22]: 'EINVAL',
	};
	return KNOWN[code] ?? `AVERROR(${code})`;
}

interface BaseExports {
	memory: WebAssembly.Memory;
	_initialize?: () => void;
	__indirect_function_table: WebAssembly.Table;
	__stack_pointer: WebAssembly.Global;
	malloc: (n: number) => number;
	ffmpeg_malloc: (n: number) => number;
	ffmpeg_free: (p: number) => void;
	ffmpeg_register_codec: (ptr: number) => number;
	ffmpeg_register_demuxer: (ptr: number) => number;
	ffmpeg_open: (dataPtr: number, size: number) => number;
	ffmpeg_close: () => void;
	ffmpeg_width: () => number;
	ffmpeg_height: () => number;
	ffmpeg_frame_count: () => number;
	ffmpeg_fps_num: () => number;
	ffmpeg_fps_den: () => number;
	ffmpeg_pix_fmt: () => number;
	ffmpeg_decode_frame: () => number;
	ffmpeg_frame_width: () => number;
	ffmpeg_frame_height: () => number;
	ffmpeg_frame_y_ptr: () => number;
	ffmpeg_frame_u_ptr: () => number;
	ffmpeg_frame_v_ptr: () => number;
	ffmpeg_frame_y_stride: () => number;
	ffmpeg_frame_u_stride: () => number;
	ffmpeg_frame_v_stride: () => number;
	ffmpeg_audio_track_count: () => number;
	ffmpeg_audio_track_sample_rate: (i: number) => number;
	ffmpeg_audio_track_channels: (i: number) => number;
	ffmpeg_drain_audio: (track: number) => number;
	ffmpeg_audio_drain_ptr: (track: number) => number;
	ffmpeg_set_log_level: (level: number) => void;
}

/** `av_log` verbosity levels (mirrors FFmpeg's `libavutil/log.h`). */
export const LogLevel = {
	Quiet: -8,
	Panic: 0,
	Fatal: 8,
	Error: 16,
	Warning: 24,
	Info: 32,
	Verbose: 40,
	Debug: 48,
	Trace: 56,
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** Main FFmpeg interface. */
export class Ffmpeg {
	#exports: BaseExports;
	#extensions: Map<string, LoadedExtension>;
	#open = false;
	#info: FfmpegInfo | null = null;
	#disposed = false;

	private constructor(
		exports: BaseExports,
		extensions: Map<string, LoadedExtension>,
	) {
		this.#exports = exports;
		this.#extensions = extensions;
	}

	/**
	 * Instantiate the base WASM and load extensions. Returns an
	 * Ffmpeg instance ready to `open()` files.
	 */
	static async create(opts: FfmpegCreateOptions): Promise<Ffmpeg> {
		const module =
			opts.wasm instanceof WebAssembly.Module
				? opts.wasm
				: await WebAssembly.compile(opts.wasm);

		// WASI shim — the base WASM links against wasi-libc for
		// libc functions (malloc, snprintf, etc.); we provide
		// stubs for the syscalls libc occasionally calls. Most
		// of these are unused at runtime by the decode path
		// because FFmpeg in our config doesn't touch fs / proc.
		// `fd_write` is wired up so `av_log_default_callback`'s
		// stderr output reaches the host console.
		let memoryRef: WebAssembly.Memory | null = null;
		const wasi = makeWasiStubs(() => memoryRef!);
		const instance = await WebAssembly.instantiate(module, {
			env: { clock: () => 0n },
			wasi_snapshot_preview1: wasi,
		});
		const exports = instance.exports as unknown as BaseExports;
		memoryRef = exports.memory;
		exports._initialize?.();

		const loaded = new Map<string, LoadedExtension>();
		for (const ext of opts.extensions ?? []) {
			if (loaded.has(ext.name)) {
				throw new FfmpegError(
					`Duplicate extension name: ${ext.name}. Each extension must have a unique name.`,
				);
			}
			loaded.set(ext.name, await loadExtension(ext, instance.exports));
		}

		// Quiet down upstream FFmpeg by default. The library defaults
		// to AV_LOG_INFO which means every codec's AV_LOG_ERROR is
		// surfaced to the host console — including thousands of
		// per-packet messages from codecs that don't understand
		// quirky bitstreams. AV_LOG_FATAL keeps only truly
		// catastrophic upstream messages; consumers that want
		// diagnostics can opt in via `setLogLevel(LogLevel.Info)`
		// or higher.
		//
		// We set this AFTER loading extensions so any extension
		// ctor that calls `av_log_set_level` (none currently do,
		// but FFmpeg codecs sometimes initialise their own
		// logging defaults) doesn't override us.
		exports.ffmpeg_set_log_level(LogLevel.Fatal);

		return new Ffmpeg(exports, loaded);
	}

	/**
	 * Open a file for decoding. The matching demuxer + codecs are
	 * automatically picked from those registered by loaded extensions
	 * (each extension registers its codecs / demuxers at `create()`
	 * time via the loader). After this returns, `info` is populated
	 * and `decodeFrame()` can be called repeatedly.
	 */
	async open(bytes: Uint8Array): Promise<void> {
		if (this.#disposed) throw new FfmpegError('Ffmpeg.open after dispose()');
		if (this.#open)
			throw new FfmpegError(
				'Ffmpeg.open called while another file is already open. Call close() first.',
			);

		// Allocate + copy the file bytes into WASM memory.
		const dataPtr = this.#exports.ffmpeg_malloc(bytes.byteLength);
		if (!dataPtr) {
			throw new FfmpegError(
				`ffmpeg_malloc(${bytes.byteLength}) failed (out of memory?)`,
			);
		}
		new Uint8Array(this.#exports.memory.buffer).set(bytes, dataPtr);

		const ret = this.#exports.ffmpeg_open(dataPtr, bytes.byteLength);
		if (ret < 0) {
			this.#exports.ffmpeg_free(dataPtr);
			throw new FfmpegError(
				`ffmpeg_open() returned ${ret}. No registered demuxer matched the file, or no codec was available for its video stream.`,
			);
		}

		this.#open = true;

		const audioTrackCount = this.#exports.ffmpeg_audio_track_count();
		const audioTracks: FfmpegAudioTrack[] = [];
		for (let i = 0; i < audioTrackCount; i++) {
			audioTracks.push({
				channels: this.#exports.ffmpeg_audio_track_channels(i),
				sampleRate: this.#exports.ffmpeg_audio_track_sample_rate(i),
			});
		}

		this.#info = {
			width: this.#exports.ffmpeg_width(),
			height: this.#exports.ffmpeg_height(),
			frameCount: this.#exports.ffmpeg_frame_count(),
			fpsNum: this.#exports.ffmpeg_fps_num(),
			fpsDen: this.#exports.ffmpeg_fps_den(),
			pixelFormat: this.#exports.ffmpeg_pix_fmt(),
			audioTracks,
		};
	}

	/** Header info for the currently-open file. */
	get info(): FfmpegInfo {
		if (!this.#info) throw new FfmpegError('No file open');
		return this.#info;
	}

	/**
	 * Decode the next frame. Returns null at EOF. The returned
	 * frame's plane buffers are views into WASM memory; they're
	 * only valid until the next `decodeFrame()` or `close()` call.
	 */
	decodeFrame(): FfmpegFrame | null {
		if (!this.#open) throw new FfmpegError('No file open');
		const ret = this.#exports.ffmpeg_decode_frame();
		if (ret === 0) return null;
		if (ret < 0) {
			throw new FfmpegError(
				`ffmpeg_decode_frame failed with ${formatAvError(ret)}`,
				ret,
			);
		}

		const buf = this.#exports.memory.buffer;
		const width = this.#exports.ffmpeg_frame_width();
		const height = this.#exports.ffmpeg_frame_height();
		const yStride = this.#exports.ffmpeg_frame_y_stride();
		const uStride = this.#exports.ffmpeg_frame_u_stride();
		const vStride = this.#exports.ffmpeg_frame_v_stride();
		const yPtr = this.#exports.ffmpeg_frame_y_ptr();
		const uPtr = this.#exports.ffmpeg_frame_u_ptr();
		const vPtr = this.#exports.ffmpeg_frame_v_ptr();
		return {
			width,
			height,
			yStride,
			uStride,
			vStride,
			y: new Uint8Array(buf, yPtr, yStride * height),
			u: new Uint8Array(buf, uPtr, uStride * (height >> 1)),
			v: new Uint8Array(buf, vPtr, vStride * (height >> 1)),
		};
	}

	/**
	 * Drain any audio samples that have accumulated since the last
	 * call for `trackIndex`. Returns a chunk whose `samples` view
	 * points into WASM memory — valid only until the next
	 * `drainAudio(trackIndex)` or `close()`. Returns null when no
	 * samples are available (e.g. before the first `decodeFrame()`,
	 * or between calls when nothing new was decoded).
	 *
	 * Standard usage is to call `drainAudio(i)` for each track
	 * after every successful `decodeFrame()` to keep the FIFO
	 * bounded.
	 */
	drainAudio(trackIndex: number): FfmpegAudioChunk | null {
		if (!this.#open) throw new FfmpegError('No file open');
		const tracks = this.#info?.audioTracks;
		if (!tracks || trackIndex < 0 || trackIndex >= tracks.length) {
			throw new FfmpegError(
				`drainAudio: invalid trackIndex ${trackIndex} (audioTracks.length=${tracks?.length ?? 0})`,
			);
		}
		const sampleFrames = this.#exports.ffmpeg_drain_audio(trackIndex);
		if (sampleFrames === 0) return null;
		const { channels, sampleRate } = tracks[trackIndex]!;
		const ptr = this.#exports.ffmpeg_audio_drain_ptr(trackIndex);
		const samples = new Float32Array(
			this.#exports.memory.buffer,
			ptr,
			sampleFrames * channels,
		);
		return { trackIndex, channels, sampleRate, samples, sampleFrames };
	}

	/** Close the current file and free its resources. */
	close(): void {
		if (!this.#open) return;
		this.#exports.ffmpeg_close();
		this.#open = false;
		this.#info = null;
	}

	/**
	 * Set FFmpeg's `av_log` verbosity. Useful for debugging — call
	 * before `open()` and FFmpeg's internal messages will be
	 * surfaced through the WASI stderr stub (this layer routes
	 * them to `console.error` / `process.stderr`).
	 */
	setLogLevel(level: LogLevel | number): void {
		this.#exports.ffmpeg_set_log_level(level);
	}

	/** Permanently dispose this Ffmpeg instance. */
	dispose(): void {
		if (this.#disposed) return;
		this.close();
		this.#disposed = true;
	}
}

/**
 * Stub WASI imports for the base WASM. None of the functions
 * we call in our supported configuration actually touch the
 * filesystem; the imports exist because wasi-libc references
 * them unconditionally. We return EBADF (8) / 0 to keep libc
 * happy if it does call into them defensively.
 *
 * `fd_write` is wired up — av_log writes there, and surfacing
 * those lines to the host's stderr is critical for debugging.
 */
function makeWasiStubs(
	getMemory: () => WebAssembly.Memory,
): Record<string, WebAssembly.ImportValue> {
	const stub = () => 0;

	// Per-fd line buffers so multi-write log lines come out clean.
	const buffers = new Map<number, string>();
	const decoder = new TextDecoder('utf-8', { fatal: false });

	const fd_write = (
		fd: number,
		iovsPtr: number,
		iovsLen: number,
		nwrittenPtr: number,
	): number => {
		// We only care about stderr (2) and stdout (1).
		if (fd !== 1 && fd !== 2) return 8; // EBADF
		const mem = getMemory();
		const view = new DataView(mem.buffer);
		const u8 = new Uint8Array(mem.buffer);
		let total = 0;
		let chunks = '';
		for (let i = 0; i < iovsLen; i++) {
			const base = view.getUint32(iovsPtr + i * 8, true);
			const len = view.getUint32(iovsPtr + i * 8 + 4, true);
			if (len === 0) continue;
			chunks += decoder.decode(u8.subarray(base, base + len), { stream: true });
			total += len;
		}
		view.setUint32(nwrittenPtr, total, true);

		// Line-buffer; emit complete lines to console.
		const prev = buffers.get(fd) ?? '';
		const data = prev + chunks;
		const lastNl = data.lastIndexOf('\n');
		if (lastNl >= 0) {
			const complete = data.slice(0, lastNl);
			buffers.set(fd, data.slice(lastNl + 1));
			const sink = fd === 1 ? console.log : console.error;
			for (const line of complete.split('\n')) sink(line);
		} else {
			buffers.set(fd, data);
		}
		return 0;
	};

	return {
		environ_get: stub,
		environ_sizes_get: stub,
		clock_time_get: stub,
		fd_close: stub,
		fd_fdstat_get: stub,
		fd_fdstat_set_flags: stub,
		fd_prestat_get: () => 8, // EBADF
		fd_prestat_dir_name: stub,
		fd_read: stub,
		fd_seek: stub,
		fd_write,
		path_open: () => 8, // EBADF
		poll_oneoff: stub,
		proc_exit: (code: number) => {
			throw new FfmpegError(`WASM called proc_exit(${code})`);
		},
	};
}
