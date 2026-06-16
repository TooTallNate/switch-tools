/**
 * @tootallnate/zstd-wasm
 *
 * Streaming Zstandard compressor + decompressor backed by a
 * WebAssembly module compiled from upstream zstd 1.5.7's single-file
 * library via wasi-sdk.
 *
 * The compiled `zstd.wasm` is shipped alongside this module but the
 * caller is responsible for loading it. Pass the bytes (or a
 * pre-compiled `WebAssembly.Module`) as the first argument to any of
 * the factory functions / constructors. That keeps this package free
 * of `fetch` / `fs` assumptions and lets the caller decide how to
 * source the WASM (bundler asset URL, `fs.readFile`, `fetch`, embedded
 * base64, …).
 *
 * Public API:
 *
 *   // Streaming (idiomatic — mirrors {De,}CompressionStream):
 *   plainReadable.pipeThrough(new ZstdCompressStream(wasmBytes))
 *   compressedReadable.pipeThrough(new ZstdDecompressStream(wasmBytes))
 *
 *   // One-shot:
 *   const compressed = await compressBytes(wasmBytes, plainBytes);
 *   const plain = await decompressBytes(wasmBytes, compressedBytes);
 *
 *   // Low-level (manual chunk feeding):
 *   const enc = await ZstdEncoder.create(wasmBytes);
 *   enc.push(chunk, (out) => { ... });
 *   enc.finish((out) => { ... }); // flushes + closes the frame
 *   enc.dispose();
 *
 *   const dec = await ZstdDecoder.create(wasmBytes);
 *   dec.push(chunk, (out) => { ... });
 *   dec.dispose();
 */

/**
 * Anything that can be turned into a `WebAssembly.Module`. Pass an
 * already-compiled module to skip the compile step on every
 * `create()` call.
 */
export type ZstdWasmSource =
	| WebAssembly.Module
	| BufferSource
	| Promise<WebAssembly.Module | BufferSource>;

// We keep a per-source-identity cache of compiled modules. A
// `WebAssembly.Module` passed in directly is its own cache entry;
// `BufferSource` inputs are compiled and the result is cached
// against the buffer's identity (so repeated calls with the same
// `Uint8Array` reuse the compiled module).
const compiledCache = new WeakMap<object, WebAssembly.Module>();

async function compileSource(source: ZstdWasmSource): Promise<WebAssembly.Module> {
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
 * Lower-level interface that mirrors zstd's `ZSTD_inBuffer` /
 * `ZSTD_outBuffer` API. This is what `decodeStream` builds on; it's
 * exposed so callers that want fine-grained control over chunking or
 * back-pressure can drive the decoder themselves.
 */
interface WasmExports {
	memory: WebAssembly.Memory;
	zstd_malloc: (n: number) => number;
	zstd_free: (p: number) => void;
	// Decompression
	dctx_new: () => number;
	dctx_free: (dctx: number) => void;
	decompress_stream: (dctx: number, buf: number) => number;
	dstream_in_size: () => number;
	dstream_out_size: () => number;
	// Compression
	cctx_new: () => number;
	cctx_free: (cctx: number) => void;
	cctx_set_level: (cctx: number, level: number) => number;
	compress_stream: (cctx: number, buf: number, endOp: number) => number;
	cstream_in_size: () => number;
	cstream_out_size: () => number;
	// Shared
	is_error: (code: number) => number;
	get_error_name: (code: number) => number;
}

/** `ZSTD_EndDirective` values (see `c/zstd.h`). */
const enum ZstdEndOp {
	Continue = 0,
	Flush = 1,
	End = 2,
}

/**
 * Default compression level. Matches zstd's own default
 * (`ZSTD_CLEVEL_DEFAULT`) of 3 — a good balance of ratio and speed.
 */
export const DEFAULT_COMPRESSION_LEVEL = 3;

/** Layout of the JsBuf struct in `c/wrapper.c`. */
const BUF_LAYOUT = {
	src: 0,
	srcSize: 4,
	srcPos: 8,
	dst: 12,
	dstSize: 16,
	dstPos: 20,
	SIZE: 24,
} as const;

function readCString(memory: WebAssembly.Memory, ptr: number): string {
	const bytes = new Uint8Array(memory.buffer, ptr);
	let end = 0;
	while (bytes[end] !== 0 && end < bytes.length) end++;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * One encoder owns one zstd `CCtx` plus a pair of input/output
 * buffers in WASM linear memory. An encoder is single-threaded and
 * stateful — feed plaintext in order with `push()`, then call
 * `finish()` exactly once to flush zstd's internal buffers and close
 * the frame. After `finish()` the encoder cannot be reused.
 *
 * Allocations are reused across calls. Call `dispose()` when done
 * (or just leave it to GC — the WASM memory is owned by the
 * `WebAssembly.Instance` and goes away with it).
 */
export class ZstdEncoder {
	private finished = false;

	private constructor(
		private readonly exports: WasmExports,
		private cctxPtr: number,
		private inPtr: number,
		private inCap: number,
		private outPtr: number,
		private outCap: number,
		private bufPtr: number,
	) {}

	/**
	 * Compile the bundled `zstd.wasm` (or a pre-compiled module) and
	 * return a ready-to-use `ZstdEncoder`.
	 *
	 * @param level zstd compression level (1–22). Defaults to
	 *   {@link DEFAULT_COMPRESSION_LEVEL}. Higher = smaller + slower.
	 */
	static async create(
		wasm: ZstdWasmSource,
		level: number = DEFAULT_COMPRESSION_LEVEL,
	): Promise<ZstdEncoder> {
		const module = await compileSource(wasm);
		const instance = await WebAssembly.instantiate(module, {});
		const exports = instance.exports as unknown as WasmExports;
		const cctxPtr = exports.cctx_new();
		if (!cctxPtr) throw new Error('zstd: failed to allocate compression context');
		const levelRet = exports.cctx_set_level(cctxPtr, level);
		if (exports.is_error(levelRet) !== 0) {
			const name = readCString(exports.memory, exports.get_error_name(levelRet));
			exports.cctx_free(cctxPtr);
			throw new Error(`zstd: failed to set compression level ${level}: ${name}`);
		}
		const inCap = exports.cstream_in_size();
		const outCap = exports.cstream_out_size();
		const inPtr = exports.zstd_malloc(inCap);
		const outPtr = exports.zstd_malloc(outCap);
		const bufPtr = exports.zstd_malloc(BUF_LAYOUT.SIZE);
		if (!inPtr || !outPtr || !bufPtr) {
			exports.cctx_free(cctxPtr);
			throw new Error('zstd: failed to allocate streaming buffers');
		}
		return new ZstdEncoder(exports, cctxPtr, inPtr, inCap, outPtr, outCap, bufPtr);
	}

	dispose(): void {
		if (!this.cctxPtr) return;
		const e = this.exports;
		e.cctx_free(this.cctxPtr);
		e.zstd_free(this.inPtr);
		e.zstd_free(this.outPtr);
		e.zstd_free(this.bufPtr);
		this.cctxPtr = 0;
	}

	/** See `ZstdDecoder.heap` — views must be re-acquired after each WASM call. */
	private get heap(): Uint8Array {
		return new Uint8Array(this.exports.memory.buffer);
	}

	private get bufView(): DataView {
		return new DataView(this.exports.memory.buffer, this.bufPtr, BUF_LAYOUT.SIZE);
	}

	private checkError(ret: number): void {
		if (this.exports.is_error(ret) !== 0) {
			const name = readCString(this.exports.memory, this.exports.get_error_name(ret));
			throw new Error(`zstd: ${name} (code ${ret})`);
		}
	}

	/**
	 * Run the compressor over one slice of input already copied into
	 * the WASM input buffer (`[inPtr, inPtr + size)`), repeatedly
	 * calling `onOutput` with the produced compressed bytes.
	 *
	 * `endOp` controls the terminal directive: `Continue` while more
	 * input may follow, `End` to flush and close the frame. The loop
	 * runs until all input is consumed and (for flush/end ops) zstd
	 * reports its buffers are fully drained.
	 */
	private run(
		size: number,
		endOp: ZstdEndOp,
		onOutput: (out: Uint8Array) => void,
	): void {
		const e = this.exports;
		let srcPos = 0;
		for (;;) {
			// Re-acquire `bufView` each iteration in case WASM grew memory.
			let view = this.bufView;
			view.setUint32(BUF_LAYOUT.src, this.inPtr, true);
			view.setUint32(BUF_LAYOUT.srcSize, size, true);
			view.setUint32(BUF_LAYOUT.srcPos, srcPos, true);
			view.setUint32(BUF_LAYOUT.dst, this.outPtr, true);
			view.setUint32(BUF_LAYOUT.dstSize, this.outCap, true);
			view.setUint32(BUF_LAYOUT.dstPos, 0, true);

			const ret = e.compress_stream(this.cctxPtr, this.bufPtr, endOp);
			this.checkError(ret);

			// Memory may have grown — refresh views.
			view = this.bufView;
			const dstPos = view.getUint32(BUF_LAYOUT.dstPos, true);
			if (dstPos > 0) {
				onOutput(this.heap.subarray(this.outPtr, this.outPtr + dstPos));
			}
			srcPos = view.getUint32(BUF_LAYOUT.srcPos, true);

			if (endOp === ZstdEndOp.Continue) {
				// Keep going until all input is consumed. zstd only emits
				// output once it has a full block buffered, so `dstPos`
				// may legitimately be 0 here.
				if (srcPos >= size) break;
			} else {
				// Flush / End: `ret` is the number of bytes still to flush.
				// 0 means input consumed AND internal buffers drained.
				if (ret === 0) break;
			}
		}
	}

	/**
	 * Feed `chunk` of plaintext to the compressor and pull out any
	 * compressed bytes that zstd chooses to emit. Calls `onOutput`
	 * zero or more times with non-empty `Uint8Array` slices into WASM
	 * memory.
	 *
	 * IMPORTANT: the slices passed to `onOutput` are views into WASM
	 * memory and are only valid until the next encoder call. Callers
	 * that need to keep the data must copy it (`.slice()` or
	 * `.set()` into their own buffer).
	 */
	push(chunk: Uint8Array, onOutput: (out: Uint8Array) => void): void {
		if (this.finished) throw new Error('zstd: encoder already finished');
		let chunkOffset = 0;
		// Always make at least one pass so empty `push()` calls are no-ops
		// rather than errors; the loop below naturally skips when length 0.
		while (chunkOffset < chunk.length) {
			const copyLen = Math.min(chunk.length - chunkOffset, this.inCap);
			// Refresh `heap` after every WASM call (memory may have grown).
			this.heap.set(
				chunk.subarray(chunkOffset, chunkOffset + copyLen),
				this.inPtr,
			);
			chunkOffset += copyLen;
			this.run(copyLen, ZstdEndOp.Continue, onOutput);
		}
	}

	/**
	 * Flush all buffered input and close the frame, emitting the
	 * trailing compressed bytes (including the zstd frame epilogue)
	 * via `onOutput`. Must be called exactly once; the encoder is
	 * unusable afterwards (call `dispose()` to free it).
	 */
	finish(onOutput: (out: Uint8Array) => void): void {
		if (this.finished) throw new Error('zstd: encoder already finished');
		this.finished = true;
		this.run(0, ZstdEndOp.End, onOutput);
	}

	/**
	 * Compress an entire plaintext buffer in one shot and return the
	 * complete zstd frame. Convenient for small inputs; large inputs
	 * should prefer `ZstdCompressStream` to avoid buffering everything.
	 */
	encode(plain: Uint8Array): Uint8Array {
		const out: Uint8Array[] = [];
		let total = 0;
		const collect = (chunk: Uint8Array) => {
			const copy = new Uint8Array(chunk);
			out.push(copy);
			total += copy.length;
		};
		this.push(plain, collect);
		this.finish(collect);
		const result = new Uint8Array(total);
		let off = 0;
		for (const c of out) {
			result.set(c, off);
			off += c.length;
		}
		return result;
	}
}

/**
 * One decoder owns one zstd `DCtx` plus a pair of input/output
 * buffers in WASM linear memory. A decoder is single-threaded and
 * stateful — feed input frames in order until `dstPos === 0` and
 * the decoder reports the end of the frame.
 *
 * Allocations are reused across calls. Call `dispose()` when done
 * (or just leave it to GC — the WASM memory is owned by the
 * `WebAssembly.Instance` and goes away with it).
 */
export class ZstdDecoder {
	private constructor(
		private readonly exports: WasmExports,
		private dctxPtr: number,
		private inPtr: number,
		private inCap: number,
		private outPtr: number,
		private outCap: number,
		private bufPtr: number,
	) {}

	/**
	 * Compile the bundled `zstd.wasm` (or a pre-compiled module) and
	 * return a ready-to-use `ZstdDecoder`.
	 */
	static async create(wasm: ZstdWasmSource): Promise<ZstdDecoder> {
		const module = await compileSource(wasm);
		const instance = await WebAssembly.instantiate(module, {});
		const exports = instance.exports as unknown as WasmExports;
		const dctxPtr = exports.dctx_new();
		if (!dctxPtr) throw new Error('zstd: failed to allocate decompression context');
		const inCap = exports.dstream_in_size();
		const outCap = exports.dstream_out_size();
		const inPtr = exports.zstd_malloc(inCap);
		const outPtr = exports.zstd_malloc(outCap);
		const bufPtr = exports.zstd_malloc(BUF_LAYOUT.SIZE);
		if (!inPtr || !outPtr || !bufPtr) {
			throw new Error('zstd: failed to allocate streaming buffers');
		}
		return new ZstdDecoder(exports, dctxPtr, inPtr, inCap, outPtr, outCap, bufPtr);
	}

	dispose(): void {
		if (!this.dctxPtr) return;
		const e = this.exports;
		e.dctx_free(this.dctxPtr);
		e.zstd_free(this.inPtr);
		e.zstd_free(this.outPtr);
		e.zstd_free(this.bufPtr);
		this.dctxPtr = 0;
	}

	/**
	 * Get a fresh `Uint8Array` view of WASM linear memory.
	 *
	 * IMPORTANT: any call into WASM may grow `memory.buffer`, which
	 * detaches all existing `ArrayBuffer`-backed views. Always
	 * re-acquire views from this getter (and `bufView`) AFTER each
	 * WASM call rather than caching them.
	 */
	private get heap(): Uint8Array {
		return new Uint8Array(this.exports.memory.buffer);
	}

	private get bufView(): DataView {
		return new DataView(this.exports.memory.buffer, this.bufPtr, BUF_LAYOUT.SIZE);
	}

	private checkError(ret: number): void {
		if (this.exports.is_error(ret) !== 0) {
			const name = readCString(this.exports.memory, this.exports.get_error_name(ret));
			throw new Error(`zstd: ${name} (code ${ret})`);
		}
	}

	/**
	 * Feed `chunk` to the decoder and pull out as much decoded data
	 * as fits in our output buffer. Calls `onOutput` zero or more
	 * times with non-empty `Uint8Array` slices into the WASM memory.
	 *
	 * IMPORTANT: the slices passed to `onOutput` are views into WASM
	 * memory and are only valid until the next decoder call. Callers
	 * that need to keep the data must copy it (`.slice()` or
	 * `.set()` into their own buffer).
	 */
	push(chunk: Uint8Array, onOutput: (out: Uint8Array) => void): void {
		const e = this.exports;
		let chunkOffset = 0;
		while (chunkOffset < chunk.length) {
			const copyLen = Math.min(chunk.length - chunkOffset, this.inCap);
			// Refresh `heap` after every WASM call (memory may have grown).
			this.heap.set(
				chunk.subarray(chunkOffset, chunkOffset + copyLen),
				this.inPtr,
			);
			chunkOffset += copyLen;

			// Drive the decoder until it has consumed all of the input
			// buffer (it might yield mid-frame to flush its output buffer).
			let srcPos = 0;
			while (srcPos < copyLen) {
				// Re-acquire `bufView` each iteration in case WASM grew memory.
				let view = this.bufView;
				view.setUint32(BUF_LAYOUT.src, this.inPtr, true);
				view.setUint32(BUF_LAYOUT.srcSize, copyLen, true);
				view.setUint32(BUF_LAYOUT.srcPos, srcPos, true);
				view.setUint32(BUF_LAYOUT.dst, this.outPtr, true);
				view.setUint32(BUF_LAYOUT.dstSize, this.outCap, true);
				view.setUint32(BUF_LAYOUT.dstPos, 0, true);

				const ret = e.decompress_stream(this.dctxPtr, this.bufPtr);
				this.checkError(ret);

				// Memory may have grown — refresh both views.
				view = this.bufView;
				const dstPos = view.getUint32(BUF_LAYOUT.dstPos, true);
				if (dstPos > 0) {
					onOutput(this.heap.subarray(this.outPtr, this.outPtr + dstPos));
				}
				const newSrcPos = view.getUint32(BUF_LAYOUT.srcPos, true);
				if (newSrcPos === srcPos && dstPos === 0) {
					// Decoder consumed nothing and produced nothing — should
					// not happen on valid input. Bail to avoid an infinite loop.
					throw new Error('zstd: decoder made no progress');
				}
				srcPos = newSrcPos;
				if (ret === 0 && srcPos === copyLen) break; // frame done
			}
		}
	}

	/**
	 * Decompress an entire compressed buffer in one shot. Convenient
	 * for small inputs; large inputs should prefer
	 * `ZstdDecompressStream` to avoid buffering everything in memory.
	 */
	decode(compressed: Uint8Array): Uint8Array {
		const out: Uint8Array[] = [];
		let total = 0;
		this.push(compressed, (chunk) => {
			const copy = new Uint8Array(chunk);
			out.push(copy);
			total += copy.length;
		});
		// Concatenate
		const result = new Uint8Array(total);
		let off = 0;
		for (const c of out) {
			result.set(c, off);
			off += c.length;
		}
		return result;
	}
}

/**
 * `TransformStream` that compresses bytes into a Zstandard frame.
 * Mirrors the shape of the platform's built-in `CompressionStream`
 * (which doesn't yet support zstd), so callers can compose with
 * `.pipeThrough(new ZstdCompressStream())`.
 *
 * The terminal frame bytes are emitted from the stream's `flush`
 * handler (when the writable side closes), so the resulting output is
 * a single complete, decodable zstd frame.
 *
 * Owns its own `ZstdEncoder` for the lifetime of the stream and
 * disposes it when the stream finishes (or is cancelled).
 */
export class ZstdCompressStream extends TransformStream<Uint8Array, Uint8Array> {
	/**
	 * @param wasm  the `zstd.wasm` bytes or a pre-compiled module.
	 * @param level zstd compression level (1–22). Defaults to
	 *   {@link DEFAULT_COMPRESSION_LEVEL}.
	 */
	constructor(wasm: ZstdWasmSource, level: number = DEFAULT_COMPRESSION_LEVEL) {
		// `ZstdEncoder.create()` is async; resolve it lazily on the
		// first `transform` (or in `flush`, for empty inputs) and cache
		// the promise.
		let encoderPromise: Promise<ZstdEncoder> | null = null;
		const getEncoder = () => {
			if (!encoderPromise) encoderPromise = ZstdEncoder.create(wasm, level);
			return encoderPromise;
		};

		super({
			async transform(chunk, controller) {
				try {
					const enc = await getEncoder();
					enc.push(chunk, (out) => {
						// Copy out of WASM memory before enqueuing — the
						// next encoder call invalidates this view.
						controller.enqueue(new Uint8Array(out));
					});
				} catch (err) {
					controller.error(err);
				}
			},
			async flush(controller) {
				try {
					// Ensure the encoder exists even for zero-input streams
					// so we still emit a valid (empty) zstd frame.
					const enc = await getEncoder();
					enc.finish((out) => {
						controller.enqueue(new Uint8Array(out));
					});
					enc.dispose();
				} catch (err) {
					controller.error(err);
				}
			},
		});
	}
}

/**
 * `TransformStream` that decompresses Zstandard-compressed bytes.
 * Mirrors the shape of the platform's built-in `DecompressionStream`
 * (which doesn't yet support zstd), so callers can compose with
 * `.pipeThrough(new ZstdDecompressStream())`.
 *
 * Owns its own `ZstdDecoder` for the lifetime of the stream and
 * disposes it when the stream finishes (or is cancelled).
 */
export class ZstdDecompressStream extends TransformStream<Uint8Array, Uint8Array> {
	constructor(wasm: ZstdWasmSource) {
		// `start` runs synchronously before any `transform` calls, but
		// `ZstdDecoder.create()` is async. We resolve the decoder lazily
		// on the first `transform` and cache the promise.
		let decoderPromise: Promise<ZstdDecoder> | null = null;
		const getDecoder = () => {
			if (!decoderPromise) decoderPromise = ZstdDecoder.create(wasm);
			return decoderPromise;
		};

		super({
			async transform(chunk, controller) {
				try {
					const dec = await getDecoder();
					dec.push(chunk, (out) => {
						// Copy out of WASM memory before enqueuing — the
						// next `push` invalidates this view.
						controller.enqueue(new Uint8Array(out));
					});
				} catch (err) {
					controller.error(err);
				}
			},
			async flush() {
				if (decoderPromise) {
					try {
						const dec = await decoderPromise;
						dec.dispose();
					} catch {
						// Decoder failed to initialize — nothing to dispose.
					}
				}
			},
		});
	}
}

/**
 * Decompress an entire compressed buffer in one shot. Reads
 * everything into memory; only suitable for inputs that comfortably
 * fit. For multi-MB / GB inputs, use `ZstdDecompressStream` instead.
 */
export async function decompressBytes(
	wasm: ZstdWasmSource,
	compressed: Uint8Array,
): Promise<Uint8Array> {
	const dec = await ZstdDecoder.create(wasm);
	try {
		return dec.decode(compressed);
	} finally {
		dec.dispose();
	}
}

/**
 * Compress an entire plaintext buffer in one shot and return a
 * complete zstd frame. Reads everything into memory; only suitable
 * for inputs that comfortably fit. For multi-MB / GB inputs, use
 * `ZstdCompressStream` instead.
 *
 * @param level zstd compression level (1–22). Defaults to
 *   {@link DEFAULT_COMPRESSION_LEVEL}.
 */
export async function compressBytes(
	wasm: ZstdWasmSource,
	plain: Uint8Array,
	level: number = DEFAULT_COMPRESSION_LEVEL,
): Promise<Uint8Array> {
	const enc = await ZstdEncoder.create(wasm, level);
	try {
		return enc.encode(plain);
	} finally {
		enc.dispose();
	}
}
