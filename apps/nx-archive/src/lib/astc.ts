/**
 * Lazy-loaded ASTC LDR decoder.
 *
 * Backed by `@tootallnate/astc-wasm`. We use it as a fallback when
 * the browser's `WEBGL_compressed_texture_astc` extension isn't
 * available (most macOS desktop GPUs don't expose it) so that ASTC
 * textures from Switch / mobile bundles still decode end-to-end.
 *
 * The WASM blob is ~33 KB and only fetched on first use — most
 * preview sessions don't touch ASTC textures, so we keep the
 * cold-start cost off the main bundle.
 */
import astcWasmUrl from '@tootallnate/astc-wasm/astc.wasm?url';

let wasmPromise: Promise<WebAssembly.Module> | null = null;
function getWasm(): Promise<WebAssembly.Module> {
	if (!wasmPromise) {
		wasmPromise =
			typeof WebAssembly.compileStreaming === 'function'
				? WebAssembly.compileStreaming(fetch(astcWasmUrl))
				: fetch(astcWasmUrl)
						.then((r) => r.arrayBuffer())
						.then((b) => WebAssembly.compile(b));
	}
	return wasmPromise;
}

let astcMod: typeof import('@tootallnate/astc-wasm') | null = null;
async function getAstc() {
	if (!astcMod) {
		astcMod = await import('@tootallnate/astc-wasm');
	}
	return astcMod;
}

/**
 * Decode an ASTC LDR block stream to RGBA8.
 *
 * `blockW` × `blockH` are the ASTC block dimensions (each
 * 4..=12). The compressed source is exactly
 * `ceil(width/blockW) * ceil(height/blockH) * 16` bytes.
 *
 * Output is `width * height * 4` RGBA8 bytes, top-down rows.
 */
export async function decodeAstc(
	width: number,
	height: number,
	blockW: number,
	blockH: number,
	src: Uint8Array,
): Promise<Uint8Array> {
	const [a, wasm] = await Promise.all([getAstc(), getWasm()]);
	return a.decodeAstcBytes(wasm, width, height, blockW, blockH, src);
}
