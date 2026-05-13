/**
 * @tootallnate/oodle-wasm
 *
 * Decompress Oodle Data Compression streams (Kraken, Mermaid, Selkie,
 * Leviathan, …) from JavaScript, via a WebAssembly module built from
 * RAD Game Tools' official Oodle source.
 *
 * **The compiled `oodle.wasm` is NOT shipped with this package.** It
 * is RAD's proprietary code (under the Unreal Engine EULA) and we
 * are not permitted to redistribute it. Callers are expected to
 * supply the WASM bytes themselves — see the README for build
 * instructions (`make setup && make setup-source && make`).
 *
 * Public API:
 *
 *   // One-shot (you know the decompressed size):
 *   const out = await decompressBytes(wasmBytes, compressedBytes, expectedSize);
 *
 *   // Long-lived decoder (re-use across many calls):
 *   const decoder = await OodleDecoder.create(wasmBytes);
 *   const out = decoder.decompress(compressedBytes, expectedSize);
 *   // ... more calls ...
 *   decoder.dispose();
 */

/**
 * Anything that can be turned into a `WebAssembly.Module`. Pass an
 * already-compiled module to skip the compile step on every
 * `create()` call.
 */
export type OodleWasmSource =
	| WebAssembly.Module
	| BufferSource
	| Promise<WebAssembly.Module | BufferSource>;

/** Compile a `WebAssembly.Module` from `source`, caching by buffer identity. */
const compiledCache = new WeakMap<object, WebAssembly.Module>();

async function compileSource(source: OodleWasmSource): Promise<WebAssembly.Module> {
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
 * Build a no-op import table for `wasi_snapshot_preview1`. The Oodle
 * WASM build pulls in a handful of WASI symbols transitively from
 * libc (printf → fd_write, etc.) but never actually calls them at
 * runtime when used purely as a decompressor with our wrapper's
 * silent plugins installed.
 *
 * We return `52` (WASI's `ENOSYS`) from every stub so that if
 * something ever does call one, the failure is loud rather than
 * silent.
 */
function buildWasiStubs(): Record<string, (...args: number[]) => number> {
	const ENOSYS = 52;
	const stub = (..._args: number[]): number => ENOSYS;
	// Cover the symbols we currently see pulled in. We list them
	// explicitly (rather than via a Proxy) so importers can see what
	// the WASM actually depends on by reading this code.
	return {
		fd_close: stub,
		fd_seek: stub,
		fd_write: stub,
		// Future-proofing: if more WASI symbols leak in across Oodle
		// SDK versions, add them here. (A Proxy fallback was tempting
		// but masks the "what's actually imported" question, and the
		// Oodle decode path itself never invokes these so the cost of
		// missing a stub is "WASM fails to instantiate at create()
		// time" — easy to catch.)
		proc_exit: stub,
		environ_get: stub,
		environ_sizes_get: stub,
		args_get: stub,
		args_sizes_get: stub,
		clock_time_get: stub,
		clock_res_get: stub,
		random_get: stub,
		poll_oneoff: stub,
		fd_fdstat_get: stub,
		fd_fdstat_set_flags: stub,
		fd_prestat_get: stub,
		fd_prestat_dir_name: stub,
		fd_read: stub,
		fd_pread: stub,
		fd_pwrite: stub,
		fd_filestat_get: stub,
		fd_filestat_set_size: stub,
		path_open: stub,
		path_filestat_get: stub,
		path_create_directory: stub,
		path_remove_directory: stub,
		path_unlink_file: stub,
		path_rename: stub,
		sched_yield: stub,
	};
}

interface WasmExports {
	memory: WebAssembly.Memory;
	oodle_init: () => number;
	oodle_malloc: (n: number) => number;
	oodle_free: (p: number) => void;
	oodle_decompress: (
		compressed: number,
		compressedSize: number,
		decompressed: number,
		expectedRawSize: number,
	) => number;
}

/** Thrown when Oodle reports a failure (returns 0 from `OodleLZ_Decompress`). */
export class OodleDecompressError extends Error {
	constructor(
		message: string,
		readonly compressedSize: number,
		readonly expectedRawSize: number,
	) {
		super(message);
		this.name = 'OodleDecompressError';
	}
}

/**
 * Long-lived Oodle decoder. One instance owns its own WebAssembly
 * instance (and therefore its own linear memory). Construction is
 * async because compiling the WASM is async; once you have a decoder
 * you can call `decompress()` synchronously as many times as you like.
 *
 * The decoder grows its internal scratch buffers as needed. Repeatedly
 * decoding similar-sized blocks reuses the same buffers; decoding a
 * larger block grows them; you never shrink (call `dispose()` instead).
 */
export class OodleDecoder {
	#exports: WasmExports;
	#srcBuf = 0;
	#srcBufCap = 0;
	#dstBuf = 0;
	#dstBufCap = 0;
	#disposed = false;

	private constructor(exports: WasmExports) {
		this.#exports = exports;
	}

	/** Compile (if needed) and instantiate the WASM, then call `oodle_init`. */
	static async create(source: OodleWasmSource): Promise<OodleDecoder> {
		const module = await compileSource(source);
		const instance = await WebAssembly.instantiate(module, {
			// The WASM is built with wasi-sdk's libc, which pulls in a
			// few WASI imports (stdio writes for printf, file-descriptor
			// helpers) even though our wrapper.c installs no-op plugins
			// for Oodle's logging callbacks. None of these are ever
			// actually called at runtime for the pure-decompress path
			// we expose, but the module must be instantiable. Stub
			// every entry as a no-op that reports failure (errno).
			wasi_snapshot_preview1: buildWasiStubs(),
		});
		const exports = instance.exports as unknown as WasmExports;
		const initResult = exports.oodle_init();
		if (initResult !== 0) {
			throw new Error(`oodle_init returned ${initResult}; WASM is unusable.`);
		}
		return new OodleDecoder(exports);
	}

	/**
	 * Decompress `compressed` into a freshly-allocated `Uint8Array` of
	 * size `expectedRawSize`. Throws {@link OodleDecompressError} if
	 * the decoder rejects the input (corruption, truncation, unknown
	 * compressor variant, etc.).
	 *
	 * Each call copies the input into WASM linear memory, runs the
	 * decoder, then copies the output back into a JS buffer. For very
	 * large payloads consider streaming via {@link decompressInto}
	 * which lets you reuse a single output buffer.
	 */
	decompress(compressed: Uint8Array, expectedRawSize: number): Uint8Array {
		const out = new Uint8Array(expectedRawSize);
		this.decompressInto(compressed, out);
		return out;
	}

	/**
	 * Decompress into a caller-provided output buffer. Useful when the
	 * caller already owns suitable storage (e.g. allocated as part of
	 * an `ArrayBuffer` shared with another decoder pass).
	 *
	 * Returns the number of bytes actually written. Throws on failure.
	 */
	decompressInto(compressed: Uint8Array, output: Uint8Array): number {
		if (this.#disposed) throw new Error('OodleDecoder.decompressInto called after dispose()');
		this.#ensureSrcBuf(compressed.length);
		this.#ensureDstBuf(output.length);
		this.#mem8().set(compressed, this.#srcBuf);
		const written = this.#exports.oodle_decompress(
			this.#srcBuf, compressed.length,
			this.#dstBuf, output.length,
		);
		if (written === 0) {
			throw new OodleDecompressError(
				'OodleLZ_Decompress returned failure (likely corrupted or unsupported input).',
				compressed.length,
				output.length,
			);
		}
		if (written !== output.length) {
			// Caller asked for `output.length` decompressed bytes but
			// the decoder produced fewer. The output buffer beyond
			// `written` is undefined; the caller probably mis-sized
			// `expectedRawSize`. Surface as an error so silent partial
			// decodes don't propagate.
			throw new OodleDecompressError(
				`OodleLZ_Decompress wrote ${written} bytes, expected ${output.length}.`,
				compressed.length,
				output.length,
			);
		}
		// Copy out before the WASM memory potentially moves on the
		// next call (it can grow under us).
		output.set(this.#mem8().subarray(this.#dstBuf, this.#dstBuf + written));
		return written;
	}

	/** Release the WASM-side input/output buffers and prevent further use. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#srcBuf) this.#exports.oodle_free(this.#srcBuf);
		if (this.#dstBuf) this.#exports.oodle_free(this.#dstBuf);
		this.#srcBuf = 0;
		this.#dstBuf = 0;
	}

	#mem8(): Uint8Array {
		return new Uint8Array(this.#exports.memory.buffer);
	}

	#ensureSrcBuf(size: number): void {
		if (size <= this.#srcBufCap) return;
		if (this.#srcBuf) this.#exports.oodle_free(this.#srcBuf);
		this.#srcBuf = this.#exports.oodle_malloc(size);
		if (!this.#srcBuf) throw new Error(`oodle_malloc(${size}) for src buffer failed.`);
		this.#srcBufCap = size;
	}

	#ensureDstBuf(size: number): void {
		if (size <= this.#dstBufCap) return;
		if (this.#dstBuf) this.#exports.oodle_free(this.#dstBuf);
		this.#dstBuf = this.#exports.oodle_malloc(size);
		if (!this.#dstBuf) throw new Error(`oodle_malloc(${size}) for dst buffer failed.`);
		this.#dstBufCap = size;
	}
}

/**
 * One-shot decompression. Convenience wrapper around
 * {@link OodleDecoder.create} + `decompress` + `dispose` for callers
 * that only need to decode one blob.
 *
 * If you'll decode many blobs in succession, create a decoder once
 * and reuse it — that amortises the per-call buffer allocations.
 */
export async function decompressBytes(
	source: OodleWasmSource,
	compressed: Uint8Array,
	expectedRawSize: number,
): Promise<Uint8Array> {
	const decoder = await OodleDecoder.create(source);
	try {
		return decoder.decompress(compressed, expectedRawSize);
	} finally {
		decoder.dispose();
	}
}
