# Compression benchmark: native gzip vs. native zstd vs. `zstd-wasm`

This benchmark exists to answer one question:

> On older Node.js versions that **don't** support zstd natively, is it
> justifiable to use `@tootallnate/zstd-wasm`, or should the application
> fall back to the always-available native **gzip**?

It compares three codecs across several data shapes, sizes, and levels:

- **gzip (native)** — `zlib.gzip` at levels 1, 6 (default), 9
- **zstd (native)** — `zlib.zstdCompress` at levels 1, 3 (default), 19
  _(only on Node ≥ 22.15 / 24; included as a reference baseline)_
- **zstd-wasm** — `@tootallnate/zstd-wasm` at levels 1, 3 (default), 19

The native-zstd column matters: it uses the **same algorithm** as the WASM
build, so the gap between _native zstd_ and _zstd-wasm_ is the **WASM
overhead**, while the gap between _gzip_ and _native zstd_ is the
**algorithm difference**.

## Running it

```sh
# From packages/zstd-wasm (requires a built dist/)
npm run build
node bench/compression-bench.mjs
```

Environment knobs:

| Var            | Default | Meaning                              |
| -------------- | ------- | ------------------------------------ |
| `BENCH_ITERS`  | `5`     | timed iterations per measurement     |
| `BENCH_WARMUP` | `2`     | warmup iterations (discarded)        |
| `BENCH_JSON`   | unset   | also emit machine-readable JSON      |

Throughput is reported in MB/s over the **original** byte count (so all
codecs share the same axis). Each measurement is the **median** of N
iterations after warmup. Every roundtrip is verified for correctness.

## Methodology notes

- The WASM module is compiled **once** and reused across all calls (passed
  as a `WebAssembly.Module`), matching how a real app uses the package.
  Per-call compile time is therefore **not** included.
- Datasets are generated deterministically (seeded xorshift32) so runs are
  repeatable:
  - **repetitive** — a short repeating phrase (highly compressible best case)
  - **json-like** — seeded JSON records (realistic app payload)
  - **random** — uniform random bytes (incompressible worst case)
- Sizes: 64 KB, 1 MB, 8 MB.

## Results

Measured on **Node v24.14.1**, Apple Silicon (`darwin/arm64`), `iters=5`.
Numbers are indicative — absolute throughput varies by machine, but the
**relative** ordering is stable. Reproduce locally for your own hardware.

### Realistic data (`json-like`, 1 MB)

| codec         | lvl | ratio | comp MB/s | decomp MB/s |
| ------------- | --: | ----: | --------: | ----------: |
| gzip (native) |   1 |  6.84 |     495.6 |       657.3 |
| gzip (native) |   6 |  8.80 |     179.0 |       812.8 |
| gzip (native) |   9 |  9.20 |      81.1 |       808.5 |
| zstd (native) |   1 |  7.67 |     877.6 |       921.5 |
| zstd (native) |   3 |  7.55 |     735.0 |       977.3 |
| zstd (native) |  19 | 11.18 |       6.3 |      1078.7 |
| zstd-wasm     |   1 |  7.67 |     681.1 |      1194.7 |
| zstd-wasm     |   3 |  7.55 |     579.4 |      1219.0 |
| zstd-wasm     |  19 | 11.18 |       4.9 |      1531.6 |

### Highly compressible data (`repetitive`, 8 MB)

| codec         | lvl |     ratio | comp MB/s | decomp MB/s |
| ------------- | --: | --------: | --------: | ----------: |
| gzip (native) |   1 |    171.65 |    2484.8 |      1433.7 |
| gzip (native) |   6 |    342.69 |     669.1 |      1520.6 |
| gzip (native) |   9 |    342.69 |     662.7 |      2025.1 |
| zstd (native) |   1 |  10192.72 |   13968.7 |      1827.3 |
| zstd (native) |   3 |  10192.72 |    9161.2 |      1572.1 |
| zstd (native) |  19 |  11008.67 |    1477.4 |      1824.3 |
| zstd-wasm     |   1 |  10192.72 |    6761.0 |      3804.5 |
| zstd-wasm     |   3 |  10192.72 |    4088.0 |      2754.0 |
| zstd-wasm     |  19 |  11008.67 |     659.2 |      4186.8 |

### Incompressible data (`random`, 8 MB)

| codec         | lvl | ratio | comp MB/s | decomp MB/s |
| ------------- | --: | ----: | --------: | ----------: |
| gzip (native) |   6 |  1.00 |      65.7 |      1714.1 |
| zstd (native) |   3 |  1.00 |    1241.8 |      1780.3 |
| zstd-wasm     |   3 |  1.00 |    2527.6 |      6581.4 |

(Run the script for the full matrix — all datasets × all sizes × all levels.)

## What the numbers say

1. **On realistic JSON data, zstd-wasm at its default level (3) compresses
   _worse_ than gzip's default (7.55× vs 8.80×).** zstd only wins on ratio
   once you raise it to **level 19** (11.18× vs gzip-9's 9.20×) — and that
   level is **~15× slower to compress** than gzip-9.
2. **Compression speed at comparable ratios favors zstd-wasm.** zstd-wasm L3
   (~580 MB/s) is roughly **3× faster than gzip-6** (~180 MB/s). zstd-wasm
   L1 is faster still.
3. **Decompression is where zstd-wasm shines unconditionally** — it
   decompresses **faster than native gzip** in nearly every case (often
   1.5–2× faster), and is competitive with (sometimes faster than) native
   zstd on these sizes.
4. **The WASM tax** is modest: zstd-wasm compresses at ~0.5–0.9× the speed
   of native zstd, and decompresses at parity-or-better here.
5. **On incompressible data**, no codec helps (ratio 1.0×); zstd is merely
   much faster at confirming "this won't compress."

## Recommendation

**For the fallback decision: prefer native gzip on Node versions without
native zstd — _unless_ your workload specifically matches zstd's strengths.**

Rationale:

- On typical text/JSON, **gzip (level 6–9) matches or beats zstd-wasm's
  default on ratio**, with zero extra dependencies or payload. Getting a
  ratio win out of zstd requires high levels that are dramatically slower to
  compress.
- zstd-wasm adds a **~546 KB WASM payload** plus load/instantiate cost for a
  result gzip already achieves on common data.

**Use `zstd-wasm` as the fallback instead when one of these holds:**

- **Format compatibility** — newer nodes emit/read zstd and older nodes must
  produce/consume the **same** zstd format (shared cache, on-disk format, or
  wire protocol where gzip isn't an option). This is the strongest case.
- **Decompression-dominated** workloads — you read far more than you write
  and want the higher decompress throughput.
- **Highly compressible / repetitive** data, where zstd's ratio advantage is
  large.
- You can accept **level 19** compression cost in exchange for the best
  ratio.

In short: if the choice is purely "smaller output for generic text," gzip is
the pragmatic fallback. If the choice is "be byte-compatible with zstd
everywhere" or "decompress fast," zstd-wasm earns its place.
