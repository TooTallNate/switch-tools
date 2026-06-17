/**
 * Benchmark: Node.js native gzip vs. native zstd vs. @tootallnate/zstd-wasm.
 *
 * Goal: decide whether using zstd-wasm is justifiable on older Node.js
 * versions that lack native zstd support, versus falling back to the
 * always-available native gzip.
 *
 * It measures, per data shape / size / codec / level:
 *   - compression ratio (original / compressed)
 *   - compression throughput (MB/s over the ORIGINAL bytes)
 *   - decompression throughput (MB/s over the ORIGINAL bytes)
 *
 * The three native zstd columns are included as a reference point: they
 * use the exact same zstd algorithm as the WASM build, so the gap
 * between "native zstd" and "zstd-wasm" is the WASM overhead, while the
 * gap between "gzip" and "native zstd" is the algorithm difference.
 *
 * Run with:  node bench/compression-bench.mjs
 * Options (env):
 *   BENCH_ITERS=5     iterations per measurement (default 5)
 *   BENCH_WARMUP=2    warmup iterations (default 2)
 *   BENCH_JSON=1      also emit machine-readable JSON to stdout
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { compressBytes, decompressBytes } from '../dist/index.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const ITERS = Number(process.env.BENCH_ITERS ?? 5);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);
const EMIT_JSON = process.env.BENCH_JSON === '1';

// ---------------------------------------------------------------------------
// Native zstd availability (Node 22.15+/23.8+/24+). If absent we skip those
// rows — which is itself the scenario this benchmark is about.
// ---------------------------------------------------------------------------
const HAS_NATIVE_ZSTD =
	typeof zlib.zstdCompress === 'function' &&
	typeof zlib.zstdDecompress === 'function';
const zstdCompress = HAS_NATIVE_ZSTD ? promisify(zlib.zstdCompress) : null;
const zstdDecompress = HAS_NATIVE_ZSTD ? promisify(zlib.zstdDecompress) : null;
const ZSTD_LEVEL_PARAM = HAS_NATIVE_ZSTD
	? zlib.constants.ZSTD_c_compressionLevel
	: null;

// ---------------------------------------------------------------------------
// Pre-compile the WASM module once. An app reuses the compiled module across
// calls, so compiling per-iteration would be unrepresentative. We pass the
// `WebAssembly.Module` straight through to the package.
// ---------------------------------------------------------------------------
const wasmBytes = readFileSync(
	fileURLToPath(new URL('../dist/zstd.wasm', import.meta.url)),
);
const wasmModule = await WebAssembly.compile(wasmBytes);

// ---------------------------------------------------------------------------
// Corpus generation — deterministic so results are repeatable.
// ---------------------------------------------------------------------------
function xorshift32(seed) {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		return x >>> 0;
	};
}

/** Highly compressible: long runs + a small repeating phrase. */
function makeRepetitive(size) {
	const phrase = Buffer.from(
		'The quick brown fox jumps over the lazy dog. ',
	);
	const out = Buffer.alloc(size);
	for (let i = 0; i < size; i++) out[i] = phrase[i % phrase.length];
	return out;
}

/** Realistic structured text: JSON-ish records (typical app payload). */
function makeJsonLike(size) {
	const rng = xorshift32(0xc0ffee);
	const cities = ['London', 'Paris', 'Tokyo', 'Austin', 'Berlin', 'Lima'];
	const tags = ['alpha', 'beta', 'gamma', 'delta', 'prod', 'staging'];
	let s = '';
	let id = 1000;
	while (Buffer.byteLength(s) < size) {
		const rec = {
			id: id++,
			user: `user_${rng() % 100000}`,
			city: cities[rng() % cities.length],
			active: (rng() & 1) === 0,
			score: (rng() % 10000) / 100,
			tags: [tags[rng() % tags.length], tags[rng() % tags.length]],
			ts: 1700000000 + (rng() % 10000000),
			note: 'event recorded successfully without errors',
		};
		s += JSON.stringify(rec) + '\n';
	}
	return Buffer.from(s.slice(0, size));
}

/** Incompressible: uniform random bytes (worst case for any codec). */
function makeRandom(size) {
	const rng = xorshift32(0x12345678);
	const out = Buffer.alloc(size);
	for (let i = 0; i < size; i++) out[i] = rng() & 0xff;
	return out;
}

const KB = 1024;
const MB = 1024 * 1024;

const DATASETS = [
	{ name: 'repetitive', make: makeRepetitive },
	{ name: 'json-like', make: makeJsonLike },
	{ name: 'random', make: makeRandom },
];

const SIZES = [
	{ label: '64 KB', bytes: 64 * KB },
	{ label: '1 MB', bytes: 1 * MB },
	{ label: '8 MB', bytes: 8 * MB },
];

// ---------------------------------------------------------------------------
// Codecs under test. Each exposes async compress(buf)->Buffer/Uint8Array and
// decompress(buf)->Buffer/Uint8Array, plus metadata for the report.
// ---------------------------------------------------------------------------
const codecs = [];

for (const level of [1, 6, 9]) {
	codecs.push({
		group: 'gzip (native)',
		level,
		compress: (buf) => gzip(buf, { level }),
		decompress: (buf) => gunzip(buf),
	});
}

if (HAS_NATIVE_ZSTD) {
	for (const level of [1, 3, 19]) {
		codecs.push({
			group: 'zstd (native)',
			level,
			compress: (buf) =>
				zstdCompress(buf, { params: { [ZSTD_LEVEL_PARAM]: level } }),
			decompress: (buf) => zstdDecompress(buf),
		});
	}
}

for (const level of [1, 3, 19]) {
	codecs.push({
		group: 'zstd-wasm',
		level,
		compress: (buf) => compressBytes(wasmModule, buf, level),
		decompress: (buf) => decompressBytes(wasmModule, buf),
	});
}

// ---------------------------------------------------------------------------
// Timing helpers. We time the median of N iterations (after warmup) to damp
// GC / JIT noise. Throughput is reported over the ORIGINAL byte count so all
// codecs are directly comparable on the same axis.
// ---------------------------------------------------------------------------
async function timeMedian(fn, iters, warmup) {
	for (let i = 0; i < warmup; i++) await fn();
	const samples = [];
	for (let i = 0; i < iters; i++) {
		const t0 = performance.now();
		await fn();
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)];
}

function mbPerSec(bytes, ms) {
	if (ms <= 0) return Infinity;
	return bytes / MB / (ms / 1000);
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
console.log(
	`Node ${process.version} — iters=${ITERS}, warmup=${WARMUP}, native zstd: ${
		HAS_NATIVE_ZSTD ? 'yes' : 'NO (the scenario in question)'
	}\n`,
);

const jsonResults = [];

for (const ds of DATASETS) {
	for (const size of SIZES) {
		const input = ds.make(size.bytes);
		const original = input.length;

		const rows = [];
		for (const codec of codecs) {
			// Correctness + ratio (single compress to get the bytes).
			const compressed = await codec.compress(input);
			const compressedLen = compressed.length;
			const restored = await codec.decompress(compressed);
			const ok =
				restored.length === original &&
				Buffer.compare(Buffer.from(restored), input) === 0;
			if (!ok) {
				throw new Error(
					`Roundtrip FAILED for ${codec.group} L${codec.level} on ${ds.name}/${size.label}`,
				);
			}

			const cMs = await timeMedian(
				() => codec.compress(input),
				ITERS,
				WARMUP,
			);
			const dMs = await timeMedian(
				() => codec.decompress(compressed),
				ITERS,
				WARMUP,
			);

			const row = {
				dataset: ds.name,
				size: size.label,
				codec: codec.group,
				level: codec.level,
				ratio: original / compressedLen,
				compressedBytes: compressedLen,
				compressMBs: mbPerSec(original, cMs),
				decompressMBs: mbPerSec(original, dMs),
			};
			rows.push(row);
			jsonResults.push(row);
		}

		printTable(`${ds.name}  —  ${size.label} (${original.toLocaleString()} bytes)`, rows);
	}
}

if (EMIT_JSON) {
	console.log('\n===JSON===');
	console.log(JSON.stringify(jsonResults));
}

function printTable(title, rows) {
	console.log(`\n### ${title}`);
	const header = [
		'codec'.padEnd(15),
		'lvl'.padStart(3),
		'ratio'.padStart(7),
		'comp MB/s'.padStart(10),
		'decomp MB/s'.padStart(12),
	].join('  ');
	console.log(header);
	console.log('-'.repeat(header.length));
	for (const r of rows) {
		console.log(
			[
				r.codec.padEnd(15),
				String(r.level).padStart(3),
				r.ratio.toFixed(2).padStart(7),
				r.compressMBs.toFixed(1).padStart(10),
				r.decompressMBs.toFixed(1).padStart(12),
			].join('  '),
		);
	}
}
