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
import type { AstcDecoder } from '@tootallnate/astc-wasm';
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

/**
 * Lazy-singleton `AstcDecoder` instance — created on first use and
 * reused thereafter. The underlying WASM instance is reusable; we
 * avoid spinning up a fresh one per texture.
 */
let decoderPromise: Promise<AstcDecoder> | null = null;
async function getDecoder(): Promise<AstcDecoder> {
	if (!decoderPromise) {
		decoderPromise = (async () => {
			const [a, wasm] = await Promise.all([getAstc(), getWasm()]);
			return a.AstcDecoder.create(wasm);
		})();
	}
	return decoderPromise;
}

/**
 * Resolve a synchronous ASTC decode function for callers that need
 * to hand it to a sync API (notably `@tootallnate/bntx`'s
 * `decodeBntxLayer`, which keeps its BCn path sync and accepts an
 * optional `astcDecoder` callback for ASTC formats).
 *
 * The returned function captures the lazy-instantiated `AstcDecoder`
 * so each call is a synchronous WASM invocation — no further async
 * wait per-decode after the first.
 */
export async function getAstcBlockDecoder(): Promise<
	(width: number, height: number, blockW: number, blockH: number, src: Uint8Array) => Uint8Array
> {
	const decoder = await getDecoder();
	return (width, height, blockW, blockH, src) =>
		decoder.decode(width, height, blockW, blockH, src);
}
