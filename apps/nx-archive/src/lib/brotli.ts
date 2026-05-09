/**
 * Lazy-loaded Brotli helpers for WOFF2 metadata extraction (and
 * any other future Brotli decoding the app needs).
 *
 * Backed by `@tootallnate/brotli-wasm`. We hand the WASM bytes
 * to the decoder; vite handles the asset URL via the `?url`
 * import suffix and we fetch + compile once on first use.
 */
import brotliWasmUrl from '@tootallnate/brotli-wasm/brotli.wasm?url';

let wasmPromise: Promise<WebAssembly.Module> | null = null;
function getWasm(): Promise<WebAssembly.Module> {
	if (!wasmPromise) {
		wasmPromise =
			typeof WebAssembly.compileStreaming === 'function'
				? WebAssembly.compileStreaming(fetch(brotliWasmUrl))
				: fetch(brotliWasmUrl)
						.then((r) => r.arrayBuffer())
						.then((b) => WebAssembly.compile(b));
	}
	return wasmPromise;
}

let brotliMod: typeof import('@tootallnate/brotli-wasm') | null = null;
async function getBrotli() {
	if (!brotliMod) {
		brotliMod = await import('@tootallnate/brotli-wasm');
	}
	return brotliMod;
}

/**
 * One-shot Brotli decompress: convenient for small payloads
 * like a WOFF2 file's combined-tables blob (typically a few
 * hundred KB at most for ad-hoc fonts).
 */
export async function brotliDecompressBytes(
	compressed: Uint8Array,
): Promise<Uint8Array> {
	const [b, wasm] = await Promise.all([getBrotli(), getWasm()]);
	return b.decompressBytes(wasm, compressed);
}
