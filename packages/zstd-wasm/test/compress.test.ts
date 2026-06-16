import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	ZstdEncoder,
	ZstdCompressStream,
	ZstdDecompressStream,
	compressBytes,
	decompressBytes,
} from '../src/index.js';

/** Decompress with the system `zstd` binary to cross-check our output. */
function decompressWithSystemZstd(input: Uint8Array): Uint8Array {
	const out = execFileSync('zstd', ['-q', '-d', '-c'], {
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

describe('ZstdEncoder', () => {
	it('compresses a small one-shot input that the system zstd can decode', async () => {
		const original = new TextEncoder().encode('Hello, zstd compression from WASM!');
		const enc = await ZstdEncoder.create(wasm);
		try {
			const compressed = enc.encode(original);
			// Cross-check: the system zstd must decode our frame.
			const roundTrip = decompressWithSystemZstd(compressed);
			expect(new TextDecoder().decode(roundTrip)).toBe(
				'Hello, zstd compression from WASM!',
			);
		} finally {
			enc.dispose();
		}
	});

	it('accepts a pre-compiled WebAssembly.Module', async () => {
		const original = new TextEncoder().encode('precompiled module compress');
		const enc = await ZstdEncoder.create(wasmModule);
		try {
			const compressed = enc.encode(original);
			expect(decompressWithSystemZstd(compressed)).toEqual(original);
		} finally {
			enc.dispose();
		}
	});

	it('roundtrips WASM compress -> WASM decompress (in-package, no system zstd)', async () => {
		const original = new TextEncoder().encode(
			'roundtrip entirely inside the wasm module',
		);
		const compressed = await compressBytes(wasm, original);
		const back = await decompressBytes(wasm, compressed);
		expect(back).toEqual(original);
	});

	it('compresses a large input (>1 MB) and roundtrips correctly', async () => {
		const size = 4 * 1024 * 1024;
		const original = new Uint8Array(size);
		// xorshift32 for repeatable but non-trivial bytes.
		let x = 0x9e3779b9;
		for (let i = 0; i < size; i++) {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			original[i] = x & 0xff;
		}
		const compressed = await compressBytes(wasm, original);
		const back = await decompressBytes(wasm, compressed);
		expect(back.length).toBe(size);
		for (let off = 0; off < size; off += 0x10000) {
			expect(back.subarray(off, off + 16)).toEqual(
				original.subarray(off, off + 16),
			);
		}
	});

	it('compresses highly-compressible data to a much smaller frame', async () => {
		const size = 1 * 1024 * 1024;
		const original = new Uint8Array(size); // all zeros
		const compressed = await compressBytes(wasm, original);
		expect(compressed.length).toBeLessThan(size / 100);
		const back = await decompressBytes(wasm, compressed);
		expect(back).toEqual(original);
	});

	it('honors the compression level (higher level => smaller output)', async () => {
		// Semi-compressible data so the level actually matters.
		const size = 512 * 1024;
		const original = new Uint8Array(size);
		for (let i = 0; i < size; i++) original[i] = (i >> 4) & 0x0f;
		const low = await compressBytes(wasm, original, 1);
		const high = await compressBytes(wasm, original, 19);
		expect(high.length).toBeLessThanOrEqual(low.length);
		// Both must still roundtrip.
		expect(await decompressBytes(wasm, low)).toEqual(original);
		expect(await decompressBytes(wasm, high)).toEqual(original);
	});

	it('compresses an empty input into a valid (decodable) frame', async () => {
		const original = new Uint8Array(0);
		const compressed = await compressBytes(wasm, original);
		expect(compressed.length).toBeGreaterThan(0); // frame header + epilogue
		expect(await decompressBytes(wasm, compressed)).toEqual(original);
	});

	it('throws when reused after finish()', async () => {
		const enc = await ZstdEncoder.create(wasm);
		try {
			enc.push(new TextEncoder().encode('abc'), () => {});
			enc.finish(() => {});
			expect(() => enc.finish(() => {})).toThrow(/already finished/);
			expect(() => enc.push(new Uint8Array([1]), () => {})).toThrow(
				/already finished/,
			);
		} finally {
			enc.dispose();
		}
	});
});

describe('ZstdCompressStream', () => {
	it('compresses through a TransformStream chain (pipeThrough)', async () => {
		const size = 256 * 1024;
		const original = new Uint8Array(size);
		for (let i = 0; i < size; i++) original[i] = (i * 7) & 0xff;

		const chunkSize = 4 * 1024;
		const plainStream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let off = 0; off < original.length; off += chunkSize) {
					controller.enqueue(
						original.subarray(off, Math.min(off + chunkSize, original.length)),
					);
				}
				controller.close();
			},
		});

		const compressedStream = plainStream.pipeThrough(new ZstdCompressStream(wasm));
		const reader = compressedStream.getReader();
		const parts: Uint8Array[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			parts.push(value);
		}
		const total = parts.reduce((s, p) => s + p.length, 0);
		const compressed = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			compressed.set(p, off);
			off += p.length;
		}
		// The streamed frame must decode back to the original.
		const back = await decompressBytes(wasm, compressed);
		expect(back).toEqual(original);
	});

	it('round-trips compress-stream -> decompress-stream', async () => {
		const size = 128 * 1024;
		const original = new Uint8Array(size);
		for (let i = 0; i < size; i++) original[i] = (i * 13 + 7) & 0xff;

		const plainStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(original);
				controller.close();
			},
		});

		const outStream = plainStream
			.pipeThrough(new ZstdCompressStream(wasm))
			.pipeThrough(new ZstdDecompressStream(wasm));

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

	it('produces a valid frame for an empty stream', async () => {
		const plainStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const compressedStream = plainStream.pipeThrough(new ZstdCompressStream(wasm));
		const reader = compressedStream.getReader();
		const parts: Uint8Array[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			parts.push(value);
		}
		const total = parts.reduce((s, p) => s + p.length, 0);
		const compressed = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			compressed.set(p, off);
			off += p.length;
		}
		expect(await decompressBytes(wasm, compressed)).toEqual(new Uint8Array(0));
	});
});
