import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	ZstdDecoder,
	ZstdDecompressStream,
	decompressBytes,
} from '../src/index.js';

function compressWithSystemZstd(input: Uint8Array): Uint8Array {
	const out = execFileSync('zstd', ['-q', '-c', '-3'], {
		input: Buffer.from(input),
		maxBuffer: 256 * 1024 * 1024,
	});
	return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

let wasm: Uint8Array;
let wasmModule: WebAssembly.Module;
beforeAll(async () => {
	wasm = readFileSync(fileURLToPath(new URL('../src/zstd.wasm', import.meta.url)));
	wasmModule = await WebAssembly.compile(wasm);
});

describe('ZstdDecoder', () => {
	it('decodes a small one-shot input', async () => {
		const original = new TextEncoder().encode('Hello, zstd from WASM!');
		const compressed = compressWithSystemZstd(original);
		const dec = await ZstdDecoder.create(wasm);
		try {
			const out = dec.decode(compressed);
			expect(new TextDecoder().decode(out)).toBe('Hello, zstd from WASM!');
		} finally {
			dec.dispose();
		}
	});

	it('accepts a pre-compiled WebAssembly.Module', async () => {
		const original = new TextEncoder().encode('precompiled module');
		const compressed = compressWithSystemZstd(original);
		const dec = await ZstdDecoder.create(wasmModule);
		try {
			expect(new TextDecoder().decode(dec.decode(compressed))).toBe(
				'precompiled module',
			);
		} finally {
			dec.dispose();
		}
	});

	it('decodes a large input larger than fzstd would mishandle (>1 MB)', async () => {
		// 4 MB of pseudo-random data — well past the 128 KB fzstd boundary.
		const size = 4 * 1024 * 1024;
		const original = new Uint8Array(size);
		// xorshift32 to get repeatable but non-trivial bytes
		let x = 0x12345678;
		for (let i = 0; i < size; i++) {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			original[i] = x & 0xff;
		}
		const compressed = compressWithSystemZstd(original);
		const out = await decompressBytes(wasm, compressed);
		expect(out.length).toBe(size);
		// Compare in chunks for a clearer error if mismatched.
		for (let off = 0; off < size; off += 0x10000) {
			expect(out.subarray(off, off + 16)).toEqual(
				original.subarray(off, off + 16),
			);
		}
	});

	it('decompresses through a TransformStream chain (pipeThrough)', async () => {
		// 256 KB input split into 4 KB compressed chunks fed via a
		// ReadableStream, then piped through ZstdDecompressStream.
		const size = 256 * 1024;
		const original = new Uint8Array(size);
		for (let i = 0; i < size; i++) original[i] = (i * 7) & 0xff;
		const compressed = compressWithSystemZstd(original);

		const chunkSize = 4 * 1024;
		const compressedStream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let off = 0; off < compressed.length; off += chunkSize) {
					controller.enqueue(
						compressed.subarray(off, Math.min(off + chunkSize, compressed.length)),
					);
				}
				controller.close();
			},
		});

		const outStream = compressedStream.pipeThrough(new ZstdDecompressStream(wasm));
		const reader = outStream.getReader();
		const parts: Uint8Array[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			parts.push(value);
		}
		const total = parts.reduce((s, p) => s + p.length, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			out.set(p, off);
			off += p.length;
		}
		expect(out).toEqual(original);
	});

	it('decompressBytes one-shot helper works', async () => {
		const original = new TextEncoder().encode(
			'one shot helper takes raw bytes',
		);
		const compressed = compressWithSystemZstd(original);
		const out = await decompressBytes(wasm, compressed);
		expect(out).toEqual(original);
	});
});
