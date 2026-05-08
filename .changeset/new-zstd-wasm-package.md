---
'@tootallnate/zstd-wasm': patch
---

New package: WebAssembly-backed Zstandard decoder for browser and
Node.js with a streaming `TransformStream` API.

**`@tootallnate/zstd-wasm`** wraps a build of upstream zstd's
single-file decoder (compiled with wasi-sdk, no WASI imports) in a
small TypeScript shim. Exports:

- `ZstdDecompressStream` — a `TransformStream<Uint8Array, Uint8Array>`
  subclass mirroring the platform's `DecompressionStream` shape.
  Compose with `compressed.pipeThrough(new ZstdDecompressStream(wasm))`.
- `ZstdDecoder` — lower-level streaming decoder for callers that want
  direct control over chunk feeding (`push(chunk, onOutput)`).
- `decompressBytes(wasm, compressed)` — one-shot helper for buffers
  that comfortably fit in memory.

The caller is responsible for sourcing the WASM bytes (or a
pre-compiled `WebAssembly.Module`). The module is published with no
`fetch` / `fs` assumptions so it works equally well in browsers,
bundlers (vite `?url`, webpack asset modules), Node ESM, Deno, etc.
The compiled WASM is exported at `@tootallnate/zstd-wasm/zstd.wasm`.

This package was created to replace `fzstd`, which has a known
streaming-decoder correctness bug at large input sizes
(https://github.com/101arrowz/fzstd/issues/19) that produced
scattered byte corruption in NCZ → NCA pipelines for multi-GB games.
