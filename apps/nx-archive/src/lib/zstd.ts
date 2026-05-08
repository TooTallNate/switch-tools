/**
 * Lazy-loaded zstd helpers for NCZ decompression.
 *
 * Backed by `@tootallnate/zstd-wasm`. We hand the WASM bytes to the
 * decoder; vite handles the asset URL via the `?url` import suffix
 * and we fetch + compile once on first use.
 */
import type { ZstdDecompressBytes, ZstdDecompressStream } from '@tootallnate/ncz';
import zstdWasmUrl from '@tootallnate/zstd-wasm/zstd.wasm?url';

let wasmPromise: Promise<WebAssembly.Module> | null = null;
function getWasm(): Promise<WebAssembly.Module> {
	if (!wasmPromise) {
		wasmPromise =
			typeof WebAssembly.compileStreaming === 'function'
				? WebAssembly.compileStreaming(fetch(zstdWasmUrl))
				: fetch(zstdWasmUrl)
						.then((r) => r.arrayBuffer())
						.then((b) => WebAssembly.compile(b));
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

/** One-shot decompress: used by NCZ block-mode for each compressed block. */
export const zstdDecompressBytes: ZstdDecompressBytes = async (compressed) => {
	const [z, wasm] = await Promise.all([getZstd(), getWasm()]);
	return z.decompressBytes(wasm, compressed);
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
