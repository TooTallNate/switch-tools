# @tootallnate/ncz

## 0.1.0

### Minor Changes

- bb67c6c: Add `parseNczHeader(blob)` which parses an NCZ's metadata header (sections, optional block table, reconstructed NCA size, and compressed-data offset) without decompressing the body. Useful for computing the reconstructed NCA size up front (e.g. to build a PFS0/NSP layout and `Content-Length`) before streaming the decompression. `decompressNcz` now uses this helper internally.

## 0.0.2

### Patch Changes

- 64057ba: Two breaking changes to `decompressNcz` options, plus a stream-mode
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

- 8046f77: Long-running decompression / decryption operations now report
  progress so the consuming UI can render a real progress bar with
  bytes processed and percentage complete.

  `@tootallnate/ncz`

  - `NczOptions.onProgress?: OnProgress` — called periodically (per
    block in block-mode, per flush in stream-mode) during the
    decompression-and-re-encrypt loop. Both the input size (= NCZ
    blob size) and the output size (= decompressed NCA size, derived
    from the NCZ section header up front) are reported, so consumers
    can show a true percentage from the very first event.
  - New types `ProgressEvent` and `OnProgress` exported from the
    package root, mirrored across the other decompressors so
    callers don't have to translate between shapes.

  `@tootallnate/yaz0`

  - `decompressYaz0(blob, { onProgress })` and
    `decompressYaz0ToBytes(blob, { onProgress })` accept the same
    `OnProgress` callback. Yaz0's bit-level inner loop fires every
    256 KiB of output (cheap; doesn't slow the decoder). Output size
    is known up-front from the header; input bytes are estimated
    from the input/output ratio.

  Both decoders are backwards-compatible: callers that don't pass
  `onProgress` see no behavior change.

  In `apps/nx-archive`:

  - `Node.blob` and `Node.getChildren` now accept an optional
    `{ onProgress }` argument that propagates down through any
    intervening lazy-materialisation layers (the NCZ-cached promise,
    in particular). Multiple concurrent subscribers to the same
    in-flight operation all receive every event.
  - The Download button's toast now updates in real time with
    bytes-out / total / percentage instead of the previous opaque
    "Preparing…" message. Throttled via `requestAnimationFrame`
    so a multi-GB NCZ doesn't spam React with hundreds of events
    per second.
  - The file tree's loading row, when expanding a node whose
    `getChildren()` reports progress (= NCZ → NCA right now), shows
    a real progress bar with bytes counter inline instead of the
    generic skeleton placeholders. Falls back to the old skeletons
    when the underlying op is too fast to bother instrumenting.

  Verified end-to-end against a real-world NSZ: a 384 MB NCZ inside
  a 489 MB NSZ shows the tree-row bar climb from 23 % through 99.9 %
  over the ~5 seconds the zstd decompression takes, and the
  Download-button toast tracks the same numbers in lockstep. The
  percentages match `bytesOut / declared_NCA_size` within the
  sub-megabyte resolution of our flush boundaries.

## 0.0.1

### Patch Changes

- 9a59464: Add HFS0, XCI, and NCZ parser/decompressor packages for Nintendo Switch title installation support
