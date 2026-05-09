/**
 * @tootallnate/brotli-wasm
 *
 * Streaming Brotli decoder backed by Google's reference C
 * implementation compiled to WebAssembly via wasi-sdk.
 *
 * Mirrors the shape of `@tootallnate/zstd-wasm` so swapping
 * codecs is a search-and-replace. The compiled `brotli.wasm` is
 * shipped alongside this module but the caller is responsible
 * for loading it (see `decompressBytes`'s first argument).
 *
 * Public API:
 *
 *   // Streaming (idiomatic — mirrors DecompressionStream):
 *   compressedReadable.pipeThrough(new BrotliDecompressStream(wasm))
 *
 *   // One-shot:
 *   const out = await decompressBytes(wasm, compressedBytes);
 *
 *   // Low-level (manual chunk feeding):
 *   const dec = await BrotliDecoder.create(wasm);
 *   dec.push(chunk, (out) => { ... });
 *   dec.dispose();
 */

/**
 * Anything that can be turned into a `WebAssembly.Module`. Pass
 * an already-compiled module to skip the compile step on every
 * `create()` call.
 */
export type BrotliWasmSource =
	| WebAssembly.Module
	| BufferSource
	| Promise<WebAssembly.Module | BufferSource>

// We keep a per-source-identity cache of compiled modules. A
// `WebAssembly.Module` passed in directly is its own cache entry;
// `BufferSource` inputs are compiled and the result is cached
// against the buffer's identity (so repeated calls with the same
// `Uint8Array` reuse the compiled module).
const compiledCache = new WeakMap<object, WebAssembly.Module>()

async function compileSource(
	source: BrotliWasmSource,
): Promise<WebAssembly.Module> {
	const resolved = await source
	if (resolved instanceof WebAssembly.Module) return resolved
	const buf = resolved as BufferSource
	const cacheKey: object =
		(buf as ArrayBufferView).buffer instanceof ArrayBuffer
			? (buf as ArrayBufferView).buffer
			: (buf as ArrayBuffer)
	const cached = compiledCache.get(cacheKey)
	if (cached) return cached
	const compiled = await WebAssembly.compile(buf)
	compiledCache.set(cacheKey, compiled)
	return compiled
}

/**
 * Brotli decoder result codes — directly map to the
 * `BrotliDecoderResult` enum in `<brotli/decode.h>`. Returned by
 * the wrapper's `decompress_stream` export.
 */
const RESULT_ERROR = 0
const RESULT_SUCCESS = 1
const RESULT_NEEDS_MORE_INPUT = 2
const RESULT_NEEDS_MORE_OUTPUT = 3

interface WasmExports {
	memory: WebAssembly.Memory
	brotli_malloc: (n: number) => number
	brotli_free: (p: number) => void
	dctx_new: () => number
	dctx_free: (dctx: number) => void
	decompress_stream: (dctx: number, buf: number) => number
	is_finished: (dctx: number) => number
	get_error_code: (dctx: number) => number
	get_error_name: (code: number) => number
}

/** Layout of the `JsBuf` struct in `c/wrapper.c`. */
const BUF_LAYOUT = {
	src: 0,
	srcSize: 4,
	srcPos: 8,
	dst: 12,
	dstSize: 16,
	dstPos: 20,
	SIZE: 24,
} as const

/** Default I/O buffer size — 64 KB matches Brotli's recommended
 *  window for streaming throughput without spending too much
 *  WASM heap. */
const DEFAULT_IO_BUF_SIZE = 64 * 1024

function readCString(memory: WebAssembly.Memory, ptr: number): string {
	const bytes = new Uint8Array(memory.buffer, ptr)
	let end = 0
	while (bytes[end] !== 0 && end < bytes.length) end++
	return new TextDecoder().decode(bytes.subarray(0, end))
}

/**
 * One decoder owns one Brotli `BrotliDecoderState` plus a pair
 * of input/output buffers in WASM linear memory. A decoder is
 * single-threaded and stateful — feed input bytes in order until
 * the wrapper reports `RESULT_SUCCESS`.
 *
 * Allocations are reused across calls. Call `dispose()` when
 * done (or just leave it to GC — the WASM memory is owned by
 * the `WebAssembly.Instance` and goes away with it).
 */
export class BrotliDecoder {
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
	 * Compile the bundled `brotli.wasm` (or a pre-compiled
	 * module) and return a ready-to-use `BrotliDecoder`.
	 */
	static async create(wasm: BrotliWasmSource): Promise<BrotliDecoder> {
		const module = await compileSource(wasm)
		const instance = await WebAssembly.instantiate(module, {})
		const exports = instance.exports as unknown as WasmExports
		const dctxPtr = exports.dctx_new()
		if (!dctxPtr) {
			throw new Error('brotli: failed to allocate decompression context')
		}
		const inCap = DEFAULT_IO_BUF_SIZE
		const outCap = DEFAULT_IO_BUF_SIZE
		const inPtr = exports.brotli_malloc(inCap)
		const outPtr = exports.brotli_malloc(outCap)
		const bufPtr = exports.brotli_malloc(BUF_LAYOUT.SIZE)
		if (!inPtr || !outPtr || !bufPtr) {
			throw new Error('brotli: failed to allocate streaming buffers')
		}
		return new BrotliDecoder(exports, dctxPtr, inPtr, inCap, outPtr, outCap, bufPtr)
	}

	dispose(): void {
		if (!this.dctxPtr) return
		const e = this.exports
		e.dctx_free(this.dctxPtr)
		e.brotli_free(this.inPtr)
		e.brotli_free(this.outPtr)
		e.brotli_free(this.bufPtr)
		this.dctxPtr = 0
	}

	/**
	 * Get a fresh `Uint8Array` view of WASM linear memory.
	 *
	 * IMPORTANT: any call into WASM may grow `memory.buffer`,
	 * which detaches all existing `ArrayBuffer`-backed views.
	 * Always re-acquire views from this getter (and `bufView`)
	 * AFTER each WASM call rather than caching them.
	 */
	private get heap(): Uint8Array {
		return new Uint8Array(this.exports.memory.buffer)
	}

	private get bufView(): DataView {
		return new DataView(
			this.exports.memory.buffer,
			this.bufPtr,
			BUF_LAYOUT.SIZE,
		)
	}

	private throwIfError(code: number): void {
		if (code === RESULT_ERROR) {
			const errCode = this.exports.get_error_code(this.dctxPtr)
			const errName = readCString(
				this.exports.memory,
				this.exports.get_error_name(errCode),
			)
			throw new Error(`brotli: ${errName} (code ${errCode})`)
		}
	}

	/**
	 * Feed `chunk` to the decoder and pull out as much decoded
	 * data as fits in our output buffer. Calls `onOutput` zero
	 * or more times with non-empty `Uint8Array` slices into
	 * WASM memory.
	 *
	 * IMPORTANT: the slices passed to `onOutput` are views into
	 * WASM memory and are only valid until the next decoder
	 * call. Callers that need to keep the data must copy it
	 * (`.slice()` or `.set()` into their own buffer).
	 */
	push(chunk: Uint8Array, onOutput: (out: Uint8Array) => void): void {
		const e = this.exports
		let chunkOffset = 0
		// Outer loop: feed one window of input bytes at a time.
		while (chunkOffset < chunk.length) {
			const copyLen = Math.min(chunk.length - chunkOffset, this.inCap)
			this.heap.set(
				chunk.subarray(chunkOffset, chunkOffset + copyLen),
				this.inPtr,
			)
			chunkOffset += copyLen

			// Inner loop: drive the decoder until it asks for
			// more input (NEEDS_MORE_INPUT) or finishes (SUCCESS).
			// On NEEDS_MORE_OUTPUT we drain the buffer and call
			// again *without* advancing the input cursor — Brotli
			// still has unwritten output in its internal state.
			let srcPos = 0
			let done = false
			while (!done) {
				let view = this.bufView
				view.setUint32(BUF_LAYOUT.src, this.inPtr, true)
				view.setUint32(BUF_LAYOUT.srcSize, copyLen, true)
				view.setUint32(BUF_LAYOUT.srcPos, srcPos, true)
				view.setUint32(BUF_LAYOUT.dst, this.outPtr, true)
				view.setUint32(BUF_LAYOUT.dstSize, this.outCap, true)
				view.setUint32(BUF_LAYOUT.dstPos, 0, true)

				const ret = e.decompress_stream(this.dctxPtr, this.bufPtr)
				this.throwIfError(ret)

				// Memory may have grown — refresh views.
				view = this.bufView
				const dstPos = view.getUint32(BUF_LAYOUT.dstPos, true)
				if (dstPos > 0) {
					onOutput(this.heap.subarray(this.outPtr, this.outPtr + dstPos))
				}
				const newSrcPos = view.getUint32(BUF_LAYOUT.srcPos, true)
				const consumed = newSrcPos - srcPos
				srcPos = newSrcPos

				if (ret === RESULT_SUCCESS) {
					// Frame fully decoded. Stop here; any extra
					// input is left for the caller to handle.
					done = true
				} else if (ret === RESULT_NEEDS_MORE_INPUT) {
					// Need more input bytes. Exit inner loop and
					// the outer loop will refill the input window.
					done = true
				} else if (ret === RESULT_NEEDS_MORE_OUTPUT) {
					// Output buffer is full but the frame isn't
					// done. Loop again with a fresh output buffer
					// (the next iteration zeroes dstPos) — Brotli
					// will keep producing without needing fresh
					// input. Bail out only if the call made zero
					// progress, which would otherwise loop forever.
					if (consumed === 0 && dstPos === 0) {
						throw new Error(
							'brotli: NEEDS_MORE_OUTPUT but decoder made no progress',
						)
					}
				} else {
					throw new Error(
						`brotli: unexpected decoder result ${ret}`,
					)
				}
			}
		}
	}

	/**
	 * Decompress an entire compressed buffer in one shot.
	 * Convenient for small inputs; large inputs should prefer
	 * `BrotliDecompressStream` to avoid buffering everything in
	 * memory.
	 */
	decode(compressed: Uint8Array): Uint8Array {
		const out: Uint8Array[] = []
		let total = 0
		this.push(compressed, (chunk) => {
			const copy = new Uint8Array(chunk)
			out.push(copy)
			total += copy.length
		})
		const result = new Uint8Array(total)
		let off = 0
		for (const c of out) {
			result.set(c, off)
			off += c.length
		}
		return result
	}
}

/**
 * `TransformStream` that decompresses Brotli-compressed bytes.
 * Mirrors the shape of the platform's built-in
 * `DecompressionStream`, so callers can compose with
 * `.pipeThrough(new BrotliDecompressStream())`.
 *
 * Owns its own `BrotliDecoder` for the lifetime of the stream
 * and disposes it when the stream finishes (or is cancelled).
 */
export class BrotliDecompressStream extends TransformStream<
	Uint8Array,
	Uint8Array
> {
	constructor(wasm: BrotliWasmSource) {
		// `start` runs synchronously before any `transform`
		// calls, but `BrotliDecoder.create()` is async. We
		// resolve the decoder lazily on the first `transform`
		// and cache the promise.
		let decoderPromise: Promise<BrotliDecoder> | null = null
		const getDecoder = () => {
			if (!decoderPromise) decoderPromise = BrotliDecoder.create(wasm)
			return decoderPromise
		}

		super({
			async transform(chunk, controller) {
				try {
					const dec = await getDecoder()
					dec.push(chunk, (out) => {
						// Copy out of WASM memory before enqueuing —
						// the next `push` invalidates this view.
						controller.enqueue(new Uint8Array(out))
					})
				} catch (err) {
					controller.error(err)
				}
			},
			async flush() {
				if (decoderPromise) {
					try {
						const dec = await decoderPromise
						dec.dispose()
					} catch {
						// Decoder failed to initialize — nothing to dispose.
					}
				}
			},
		})
	}
}

/**
 * Decompress an entire compressed buffer in one shot. Reads
 * everything into memory; only suitable for inputs that
 * comfortably fit. For multi-MB inputs, use
 * `BrotliDecompressStream` instead.
 */
export async function decompressBytes(
	wasm: BrotliWasmSource,
	compressed: Uint8Array,
): Promise<Uint8Array> {
	const dec = await BrotliDecoder.create(wasm)
	try {
		return dec.decode(compressed)
	} finally {
		dec.dispose()
	}
}
