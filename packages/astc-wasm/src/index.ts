/**
 * @tootallnate/astc-wasm
 *
 * Pure-Rust ASTC LDR texture decoder compiled to WebAssembly. Wraps
 * the `texture2ddecoder` Rust crate's `decode_astc` so callers can
 * decode 4×4 through 12×12 ASTC blocks to RGBA8 in any JS runtime
 * (browser, Node, workers).
 *
 * Public API:
 *
 *   // Compile / instantiate the WASM module once and reuse the
 *   // decoder for many textures.
 *   const decoder = await AstcDecoder.create(wasm);
 *   try {
 *     const rgba = decoder.decode(width, height, blockW, blockH, src);
 *   } finally {
 *     decoder.dispose();
 *   }
 *
 *   // Or one-shot: spins up + tears down a decoder per call.
 *   const rgba = await decodeAstcBytes(wasm, width, height, blockW, blockH, src);
 *
 * Block dimensions correspond to the ASTC variants:
 *   4x4, 5x4, 5x5, 6x5, 6x6, 8x5, 8x6, 8x8, 10x5, 10x6, 10x8,
 *   10x10, 12x10, 12x12  (the underlying Rust decoder accepts any
 *   `block_w ∈ 4..=12, block_h ∈ 4..=12`).
 *
 * The compiled `astc.wasm` ships alongside this module but the
 * caller is responsible for loading it (see `decodeAstcBytes`'s
 * first argument). This mirrors `@tootallnate/zstd-wasm` /
 * `@tootallnate/brotli-wasm` so switching codecs is uniform.
 */

/**
 * Anything that can be turned into a `WebAssembly.Module`. Pass an
 * already-compiled module to skip the compile step on every
 * `create()` call.
 */
export type AstcWasmSource =
	| WebAssembly.Module
	| BufferSource
	| Promise<WebAssembly.Module | BufferSource>

// Cache compiled modules so repeated `create()` calls don't
// re-compile. Same pattern as `@tootallnate/brotli-wasm`.
const compiledCache = new WeakMap<object, WebAssembly.Module>()

async function compileSource(
	source: AstcWasmSource,
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

interface WasmExports {
	memory: WebAssembly.Memory
	astc_alloc: (n: number) => number
	astc_free: () => void
	astc_decode: (
		blockW: number,
		blockH: number,
		width: number,
		height: number,
		srcPtr: number,
		srcLen: number,
		dstPtr: number,
		dstPixels: number,
	) => number
}

/**
 * ASTC decoder bound to a single WASM instance. Holding onto a
 * decoder across calls amortises the WASM instantiation cost; for
 * one-off decodes use {@link decodeAstcBytes}.
 */
export class AstcDecoder {
	private constructor(private readonly exports: WasmExports) {}

	static async create(source: AstcWasmSource): Promise<AstcDecoder> {
		const compiled = await compileSource(source)
		const inst = await WebAssembly.instantiate(compiled, {})
		return new AstcDecoder(inst.exports as unknown as WasmExports)
	}

	/**
	 * Decode an ASTC block stream to RGBA8.
	 *
	 * Each ASTC block is exactly 16 bytes regardless of block
	 * dimensions. The caller is responsible for ensuring `src`
	 * holds `ceil(width / blockW) × ceil(height / blockH) × 16`
	 * bytes of valid block data.
	 *
	 * Returns a fresh `Uint8Array` of `width * height * 4` bytes
	 * laid out as `R, G, B, A` per pixel, top-down rows.
	 */
	decode(
		width: number,
		height: number,
		blockW: number,
		blockH: number,
		src: Uint8Array,
	): Uint8Array {
		if (width <= 0 || height <= 0) {
			throw new Error(
				`AstcDecoder.decode: width / height must be positive (got ${width}×${height})`,
			)
		}
		if (blockW < 4 || blockW > 12 || blockH < 4 || blockH > 12) {
			throw new Error(
				`AstcDecoder.decode: unsupported block size ${blockW}×${blockH} (allowed 4..=12)`,
			)
		}
		// Validate block-aligned input length (or close enough — the
		// underlying decoder is forgiving about trailing bytes).
		const blocksX = Math.ceil(width / blockW)
		const blocksY = Math.ceil(height / blockH)
		const expectedSrcLen = blocksX * blocksY * 16
		if (src.length < expectedSrcLen) {
			throw new Error(
				`AstcDecoder.decode: source too short (${src.length} bytes; need ${expectedSrcLen} for ${blocksX}×${blocksY} blocks of ${blockW}×${blockH})`,
			)
		}
		const { astc_alloc, astc_free, astc_decode, memory } = this.exports
		const srcPtr = astc_alloc(src.length)
		if (!srcPtr) {
			astc_free()
			throw new Error('AstcDecoder.decode: out of WASM memory (input)')
		}
		new Uint8Array(memory.buffer, srcPtr, src.length).set(src)
		const dstPixels = width * height
		const dstPtr = astc_alloc(dstPixels * 4)
		if (!dstPtr) {
			astc_free()
			throw new Error('AstcDecoder.decode: out of WASM memory (output)')
		}
		const code = astc_decode(
			blockW,
			blockH,
			width,
			height,
			srcPtr,
			src.length,
			dstPtr,
			dstPixels,
		)
		if (code !== 0) {
			astc_free()
			throw new Error(`AstcDecoder.decode: decoder returned error code ${code}`)
		}
		// Copy out so the caller can keep the buffer after we've
		// reset the WASM arena.
		const out = new Uint8Array(memory.buffer, dstPtr, dstPixels * 4).slice()
		astc_free()
		return out
	}

	/** Release the WASM instance's resources. */
	dispose(): void {
		// `WebAssembly.Instance` doesn't expose explicit teardown —
		// dropping references lets V8 / SpiderMonkey GC reclaim the
		// linear memory. Provided for symmetry with `*Decoder`
		// classes in the sibling codec packages.
		void this.exports
	}
}

/**
 * One-shot ASTC decode — instantiates a fresh {@link AstcDecoder},
 * decodes, disposes. Convenient when you only need a single
 * texture; for many decodes prefer reusing an `AstcDecoder` so the
 * WASM module isn't re-instantiated each time.
 */
export async function decodeAstcBytes(
	wasm: AstcWasmSource,
	width: number,
	height: number,
	blockW: number,
	blockH: number,
	src: Uint8Array,
): Promise<Uint8Array> {
	const decoder = await AstcDecoder.create(wasm)
	try {
		return decoder.decode(width, height, blockW, blockH, src)
	} finally {
		decoder.dispose()
	}
}
