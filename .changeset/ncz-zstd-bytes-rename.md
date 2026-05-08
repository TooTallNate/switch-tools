---
'@tootallnate/ncz': patch
---

Two breaking changes to `decompressNcz` options, plus a stream-mode
correctness fix.

- `decompressBlob: (blob: Blob) => Promise<Uint8Array>` is renamed to
  `decompressBytes: (compressed: Uint8Array) => Promise<Uint8Array>`.
  The wrapper-around-`Blob.arrayBuffer()` indirection was redundant —
  callers can do that themselves.
- Stream-mode decompression is rewritten to use a single zstd stream
  over the whole compressed body, matching the python-`nsz` reference
  implementation. The previous "decompress one frame, scan compressed
  bytes for the next zstd magic, repeat" approach was incorrect: NCZ
  has exactly one zstd frame for the whole body, and false-positive
  `0xFD2FB528` sequences in the compressed bytes silently produced
  garbage output. `decompressStream` is now invoked exactly once per
  NCZ.
- The intermediate 512 KB accumulator in stream mode was removed;
  decoded chunks (~128 KB from the underlying zstd decoder) are now
  re-encrypted and written directly. Saves two `Uint8Array` copies
  per chunk over the lifetime of a multi-GB NCA.
