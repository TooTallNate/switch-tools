/**
 * Lazy-loaded zstd helpers for NCZ decompression.
 *
 * Backed by `@tootallnate/zstd-wasm`. We hand the WASM bytes to the
 * decoder; vite handles the asset URL via the `?url` import suffix
 * and we fetch + compile once on first use.
 */
import type { ZstdDecompressBytes, ZstdDecompressStream } from '@tootallnate/ncz';
import zstdWasmUrl from '@tootallnate/zstd-wasm/zstd.wasm?url';

import { compileWasmUrl } from './wasm-url';

let wasmPromise: Promise<WebAssembly.Module> | null = null;
function getWasm(): Promise<WebAssembly.Module> {
	if (!wasmPromise) {
		wasmPromise = compileWasmUrl(zstdWasmUrl);
	}
	return wasmPromise;
}

let zstdMod: typeof import('@tootallnate/zstd-wasm') | null = null;
async function getZstd() {
	if (!zstdMod) {
		zstdMod = await import('@tootallnate/zstd-wasm');
	}
	return zstdMod;
}

/**
 * One shared decoder for one-shot decompression. A fresh instance per
 * call (each with its own WebAssembly memory) ran out of memory on
 * games with thousands of small frames, such as Super Mario Party
 * Jamboree's `.bea` assets. Decoding is synchronous, so calls never
 * overlap; a decoder that failed mid-frame is replaced.
 */
let shared: Promise<import('@tootallnate/zstd-wasm').ZstdDecoder> | null = null;

/** One-shot decompress: NCZ blocks, BEA assets and the like. */
export const zstdDecompressBytes: ZstdDecompressBytes = async (compressed) => {
	if (!shared) {
		shared = Promise.all([getZstd(), getWasm()]).then(([z, wasm]) => z.ZstdDecoder.create(wasm));
		shared.catch(() => (shared = null));
	}
	const dec = await shared;
	try {
		// A fresh context per frame: a truncated input can't poison the next one.
		dec.reset();
		return dec.decode(compressed);
	} catch (err) {
		dec.dispose();
		if (shared && (await shared) === dec) shared = null;
		throw err;
	}
};

/**
 * Streaming zstd decompression: pipes a `ReadableStream` through a
 * fresh `ZstdDecompressStream` `TransformStream`. The decoder is
 * allocated lazily on the first chunk and disposed when the stream
 * finishes (or is cancelled).
 *
 * The platform's built-in `DecompressionStream` doesn't support
 * zstd yet, so this is the equivalent for that codec.
 */
export const zstdDecompressStream: ZstdDecompressStream = (input) => {
	let pipedStream: ReadableStream<Uint8Array> | null = null;
	let pipeError: unknown = null;
	const ready = (async () => {
		try {
			const [z, wasm] = await Promise.all([getZstd(), getWasm()]);
			pipedStream = input.pipeThrough(new z.ZstdDecompressStream(wasm));
		} catch (err) {
			pipeError = err;
		}
	})();

	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			await ready;
			if (pipeError) {
				controller.error(pipeError);
				return;
			}
			if (!reader) reader = pipedStream!.getReader();
			const { value, done } = await reader.read();
			if (done) {
				controller.close();
			} else {
				controller.enqueue(value);
			}
		},
		async cancel(reason) {
			await ready;
			if (reader) {
				try {
					await reader.cancel(reason);
				} finally {
					reader.releaseLock();
				}
			} else if (pipedStream) {
				await pipedStream.cancel(reason);
			} else {
				input.cancel(reason);
			}
		},
	});
};
