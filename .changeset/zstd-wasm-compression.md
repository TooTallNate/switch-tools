---
'@tootallnate/zstd-wasm': minor
---

Add Zstandard **compression** support alongside the existing decoder.

The vendored WASM is now built from upstream zstd 1.5.7's full
single-file library (encoder + decoder) instead of the decoder-only
amalgamation, still compiled with wasi-sdk and with no WASI imports.
New exports mirror the existing decode-side shape:

- `ZstdCompressStream` — a `TransformStream<Uint8Array, Uint8Array>`
  subclass mirroring the platform's `CompressionStream`. Compose with
  `plain.pipeThrough(new ZstdCompressStream(wasm, level?))`. The
  terminal frame bytes are emitted on stream close, so the output is a
  single complete, decodable zstd frame.
- `ZstdEncoder` — lower-level streaming encoder for callers that want
  direct control over chunk feeding (`push(chunk, onOutput)` then
  `finish(onOutput)`).
- `compressBytes(wasm, plain, level?)` — one-shot helper for buffers
  that comfortably fit in memory.
- `DEFAULT_COMPRESSION_LEVEL` (3) — the default zstd level used when
  none is supplied.

The compression level (1–22) is configurable on `ZstdEncoder.create`,
`ZstdCompressStream`, and `compressBytes`.
