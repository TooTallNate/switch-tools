import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
	BrotliDecoder,
	BrotliDecompressStream,
	decompressBytes,
} from '../src/index.js'

// We test against Node's `zlib.brotliCompressSync` — that's the
// same Brotli implementation we just compiled, so any decoder
// bug surfaces clearly. Round-tripping through our wrapper
// confirms the WASM exports + the JS bindings agree on the
// streaming protocol.

const wasmPath = fileURLToPath(new URL('../src/brotli.wasm', import.meta.url))
async function loadWasm(): Promise<Uint8Array> {
	return new Uint8Array(await readFile(wasmPath))
}

describe('decompressBytes', () => {
	it('decodes a small Brotli-compressed buffer', async () => {
		const original = new TextEncoder().encode(
			'Hello, Brotli! This is a small string that compresses nicely.',
		)
		const compressed = new Uint8Array(zlib.brotliCompressSync(original))
		const wasm = await loadWasm()
		const out = await decompressBytes(wasm, compressed)
		expect(new TextDecoder().decode(out)).toBe(
			new TextDecoder().decode(original),
		)
	})

	it('decodes a buffer larger than the internal I/O window', async () => {
		// 1 MB of pseudo-random ASCII compresses well and forces
		// multiple chunks through the streaming loop (default
		// I/O buffer is 64 KB).
		const lines: string[] = []
		for (let i = 0; i < 20000; i++) lines.push(`line ${i}: lorem ipsum dolor sit amet`)
		const original = new TextEncoder().encode(lines.join('\n'))
		const compressed = new Uint8Array(zlib.brotliCompressSync(original))
		const wasm = await loadWasm()
		const out = await decompressBytes(wasm, compressed)
		expect(out.length).toBe(original.length)
		// Spot-check the first / middle / last 32 bytes — full
		// equality is checked but expensive to display on diff.
		expect(out[0]).toBe(original[0])
		expect(out[out.length - 1]).toBe(original[original.length - 1])
		expect(Buffer.from(out).equals(Buffer.from(original))).toBe(true)
	})

	it('throws on corrupted input', async () => {
		// We mangle a real Brotli frame past its first few bytes
		// — that gets the decoder past the header and into the
		// bitstream, where corrupted Huffman data triggers a
		// hard error rather than a "needs more input" stall.
		const original = new TextEncoder().encode('test data for corruption test')
		const compressed = new Uint8Array(zlib.brotliCompressSync(original))
		// Flip a chunk of bytes in the middle of the bitstream.
		for (let i = 8; i < Math.min(compressed.length, 24); i++) {
			compressed[i] = compressed[i] ^ 0xff
		}
		const wasm = await loadWasm()
		await expect(decompressBytes(wasm, compressed)).rejects.toThrow(/brotli/i)
	})
})

describe('BrotliDecompressStream', () => {
	it('decompresses through the TransformStream API', async () => {
		const original = new TextEncoder().encode('streaming test payload\n'.repeat(500))
		const compressed = new Uint8Array(zlib.brotliCompressSync(original))
		const wasm = await loadWasm()
		// Split into multiple small chunks to exercise the
		// transform path's NEEDS_MORE_INPUT loop.
		const sourceStream = new ReadableStream<Uint8Array>({
			start(controller) {
				const CHUNK = 32
				for (let off = 0; off < compressed.length; off += CHUNK) {
					controller.enqueue(
						compressed.subarray(off, Math.min(off + CHUNK, compressed.length)),
					)
				}
				controller.close()
			},
		})
		const decompressed = sourceStream.pipeThrough(
			new BrotliDecompressStream(wasm),
		)
		const out = new Uint8Array(await new Response(decompressed).arrayBuffer())
		expect(out.length).toBe(original.length)
		expect(Buffer.from(out).equals(Buffer.from(original))).toBe(true)
	})
})

describe('BrotliDecoder', () => {
	it('decodes a single frame end-to-end through the low-level API', async () => {
		const wasm = await loadWasm()
		const dec = await BrotliDecoder.create(wasm)
		try {
			const original = new TextEncoder().encode('low-level decoder test')
			const compressed = new Uint8Array(zlib.brotliCompressSync(original))
			const out = dec.decode(compressed)
			expect(new TextDecoder().decode(out)).toBe(
				new TextDecoder().decode(original),
			)
		} finally {
			dec.dispose()
		}
	})
})
