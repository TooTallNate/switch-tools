---
'@tootallnate/ncz': patch
'@tootallnate/yaz0': patch
---

Long-running decompression / decryption operations now report
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
