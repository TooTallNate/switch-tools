import { describe, expect, it } from 'vitest';
import {
	OodleDecoder,
	OodleDecompressError,
	decompressBytes,
} from '../src/index.js';

/**
 * Unit tests for the OodleDecoder JS wrapper.
 *
 * Without `oodle.wasm` (which the user must build themselves from
 * RAD's source — see this package's README), we can't exercise an
 * end-to-end decode here. So the tests verify only the wrapper's
 * own behaviour by replacing the WebAssembly compile + instantiate
 * pair with a JS-side mock that has the same export surface as the
 * real WASM module. The mock can be configured per-test to simulate
 * success / failure / partial decode.
 *
 * What this covers:
 *
 *   - oodle_init result handling
 *   - input/output buffer-copy roundtrip
 *   - per-call buffer grow-on-demand (no realloc on shrink)
 *   - dispose() lifecycle
 *   - error path when oodle_decompress returns 0
 *   - "wrote fewer bytes than expected" failure
 *
 * The real Oodle decoder lives behind that same export surface, so
 * a passing mock-test means the wrapper is correct; whatever the
 * WASM actually computes inside is RAD's responsibility.
 */

/** The bump-allocator starting offset in the mock's linear memory. */
const HEAP_BASE = 16;

/**
 * Inject mock WASM exports into the wrapper by patching
 * `WebAssembly.instantiate` for the duration of one test. We
 * provide a fake instance whose `exports` are JS functions
 * implementing the contract our TypeScript wrapper expects.
 *
 * This is more robust than trying to hand-encode a real wasm
 * module: we test the wrapper's behaviour, not WebAssembly's.
 */
async function withMockedWasm<T>(
	memorySize: number,
	exportsBuilder: (memory: WebAssembly.Memory) => Record<string, unknown>,
	test: () => Promise<T>,
): Promise<T> {
	const origCompile = WebAssembly.compile;
	const origInstantiate = WebAssembly.instantiate;
	const fakeModule = Object.create(WebAssembly.Module.prototype);
	(WebAssembly as { compile: typeof WebAssembly.compile }).compile = async () =>
		fakeModule as WebAssembly.Module;
	(WebAssembly as { instantiate: typeof WebAssembly.instantiate }).instantiate = (async (
		moduleOrBytes: unknown,
	) => {
		void moduleOrBytes;
		const memory = new WebAssembly.Memory({ initial: memorySize });
		return {
			exports: {
				memory,
				...exportsBuilder(memory),
			},
		} as unknown;
	}) as typeof WebAssembly.instantiate;
	try {
		return await test();
	} finally {
		WebAssembly.compile = origCompile;
		WebAssembly.instantiate = origInstantiate;
	}
}

/**
 * Build the four function exports our wrapper expects, against a
 * given memory. The `decompress` argument lets a test override the
 * decompression behaviour (success / failure / partial write).
 */
function makeMockExports(opts: {
	decompress?: (src: number, srcSz: number, dst: number, dstSz: number, mem8: Uint8Array) => number;
} = {}) {
	return (memory: WebAssembly.Memory) => {
		let heap = HEAP_BASE;
		const mem8 = () => new Uint8Array(memory.buffer);
		const decompress = opts.decompress ?? ((src, srcSz, dst, dstSz, m8) => {
			const n = Math.min(srcSz, dstSz);
			m8.copyWithin(dst, src, src + n);
			return dstSz;
		});
		return {
			oodle_init: () => 0,
			oodle_malloc: (n: number) => {
				const p = heap;
				heap = (heap + n + 7) & ~7;
				return p;
			},
			oodle_free: () => {},
			oodle_decompress: (src: number, srcSz: number, dst: number, dstSz: number) =>
				decompress(src, srcSz, dst, dstSz, mem8()),
		};
	};
}

describe('OodleDecoder.create', () => {
	it('calls oodle_init and surfaces non-zero return as an error', async () => {
		await withMockedWasm(1, () => ({
			oodle_init: () => 42,
			oodle_malloc: () => 0,
			oodle_free: () => {},
			oodle_decompress: () => 0,
		}), async () => {
			await expect(OodleDecoder.create(new Uint8Array(0))).rejects.toThrow(/oodle_init returned 42/);
		});
	});
});

describe('OodleDecoder.decompress', () => {
	it('copies input → output via the WASM linear memory', async () => {
		await withMockedWasm(1, makeMockExports(), async () => {
			const decoder = await OodleDecoder.create(new Uint8Array(0));
			const input = new Uint8Array([1, 2, 3, 4, 5]);
			const out = decoder.decompress(input, 5);
			expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
			decoder.dispose();
		});
	});

	it('throws OodleDecompressError when oodle_decompress returns 0', async () => {
		await withMockedWasm(1, makeMockExports({
			decompress: () => 0,
		}), async () => {
			const decoder = await OodleDecoder.create(new Uint8Array(0));
			try {
				decoder.decompress(new Uint8Array([1, 2, 3]), 10);
				throw new Error('expected decompress() to throw');
			} catch (err) {
				expect(err).toBeInstanceOf(OodleDecompressError);
				const e = err as OodleDecompressError;
				expect(e.compressedSize).toBe(3);
				expect(e.expectedRawSize).toBe(10);
			}
			decoder.dispose();
		});
	});

	it('throws when the decoder writes fewer bytes than expected', async () => {
		await withMockedWasm(1, makeMockExports({
			decompress: (src, srcSz, dst, dstSz, m8) => {
				// Pretend we wrote half the expected output.
				m8.copyWithin(dst, src, src + Math.min(srcSz, dstSz));
				return Math.floor(dstSz / 2);
			},
		}), async () => {
			const decoder = await OodleDecoder.create(new Uint8Array(0));
			expect(() => decoder.decompress(new Uint8Array(8), 8))
				.toThrowError(/wrote \d+ bytes, expected 8/);
			decoder.dispose();
		});
	});

	it('grows the input buffer when called with larger blobs (no realloc on shrink)', async () => {
		let mallocCalls = 0;
		await withMockedWasm(2, (memory: WebAssembly.Memory) => {
			let heap = HEAP_BASE;
			const base = makeMockExports()(memory);
			return {
				...base,
				oodle_malloc: (n: number) => {
					mallocCalls++;
					const p = heap;
					heap = (heap + n + 7) & ~7;
					return p;
				},
			};
		}, async () => {
			const decoder = await OodleDecoder.create(new Uint8Array(0));
			// First call: 8 bytes in, 8 bytes out → 2 mallocs (src + dst).
			decoder.decompress(new Uint8Array(8), 8);
			expect(mallocCalls).toBe(2);
			// Second call with same sizes: no growth, no new mallocs.
			decoder.decompress(new Uint8Array(8), 8);
			expect(mallocCalls).toBe(2);
			// Third call with smaller input/output: still no new mallocs.
			decoder.decompress(new Uint8Array(4), 4);
			expect(mallocCalls).toBe(2);
			// Fourth call with bigger input: src grows. Output unchanged.
			decoder.decompress(new Uint8Array(32), 4);
			expect(mallocCalls).toBe(3);
			// Fifth call with bigger output: dst grows.
			decoder.decompress(new Uint8Array(32), 64);
			expect(mallocCalls).toBe(4);
			decoder.dispose();
		});
	});

	it('refuses use after dispose()', async () => {
		await withMockedWasm(1, makeMockExports(), async () => {
			const decoder = await OodleDecoder.create(new Uint8Array(0));
			decoder.dispose();
			expect(() => decoder.decompress(new Uint8Array(4), 4))
				.toThrowError(/after dispose/);
		});
	});
});

describe('decompressBytes', () => {
	it('disposes the decoder even when the call succeeds', async () => {
		let freeCalls = 0;
		await withMockedWasm(1, (memory: WebAssembly.Memory) => {
			const base = makeMockExports()(memory);
			return {
				...base,
				oodle_free: () => { freeCalls++; },
			};
		}, async () => {
			const out = await decompressBytes(new Uint8Array(0), new Uint8Array([7, 8, 9]), 3);
			expect(Array.from(out)).toEqual([7, 8, 9]);
			// dispose() should have called oodle_free for both src and dst.
			expect(freeCalls).toBe(2);
		});
	});

	it('disposes the decoder when the call throws', async () => {
		let freeCalls = 0;
		await withMockedWasm(1, (memory: WebAssembly.Memory) => {
			const base = makeMockExports({ decompress: () => 0 })(memory);
			return {
				...base,
				oodle_free: () => { freeCalls++; },
			};
		}, async () => {
			await expect(decompressBytes(new Uint8Array(0), new Uint8Array(3), 3))
				.rejects.toBeInstanceOf(OodleDecompressError);
			expect(freeCalls).toBe(2);
		});
	});
});
