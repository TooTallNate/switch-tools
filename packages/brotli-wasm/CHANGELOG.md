# @tootallnate/brotli-wasm

## 0.1.0

### Minor Changes

- 4fc5d73: Add `@tootallnate/brotli-wasm`, a streaming Brotli decoder
  backed by Google's reference C implementation compiled to
  WebAssembly via wasi-sdk.

  Mirrors the shape of `@tootallnate/zstd-wasm` exactly:

  - `decompressBytes(wasm, compressed)` — one-shot decode for
    inputs that fit comfortably in memory.
  - `BrotliDecompressStream` — a `TransformStream` you can
    `pipeThrough()` for arbitrary-length inputs (mirrors the
    platform's built-in `DecompressionStream`, which doesn't
    support Brotli).
  - `BrotliDecoder.create(wasm)` — low-level interface for
    callers that want to drive the streaming protocol
    themselves.

  The compiled WASM is ~240 KB and ships alongside the JS in
  the package. Caller is responsible for fetching + compiling
  it, same as zstd-wasm — the package stays free of `fetch` /
  `fs` assumptions and lets the host environment decide how to
  source the module (vite asset URL, Node `fs.readFile`, etc.).

  Built from upstream Brotli's `c/dec/` plus `c/common/` source
  files via a `Makefile` that compiles each translation unit
  with `clang --target=wasm32-wasip1` and links them into a
  single freestanding module — no WASI imports.
