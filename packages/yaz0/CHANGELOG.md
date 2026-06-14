# @tootallnate/yaz0

## 0.0.2

### Patch Changes

- 6605c3f: Two new parser packages for Nintendo's first-party archive formats.

  **`@tootallnate/yaz0`** — decoder for Yaz0, the LZ-style compression
  scheme Nintendo uses across Wii / Wii U / Switch first-party titles
  (most commonly as the wrapper around SARC archives in `.szs` files).
  `decompressYaz0(blob)` returns a `Blob` of the decompressed payload;
  `decompressYaz0ToBytes(blob)` returns the raw `Uint8Array`. Internally
  streams the compressed input chunk-by-chunk so very large `.szs`
  files don't need to be `arrayBuffer()`'d up front. `isYaz0(blob)` and
  `readYaz0Header(blob)` provide cheap (4–16 byte) detection /
  inspection. Handles all three Yaz0 reference encodings — short
  (2-byte) back-refs, long (3-byte) back-refs ≥ 0x12, and overlapping
  RLE-style copies.

  **`@tootallnate/sarc`** — parser for SARC ("Sead Archive"), the
  standard archive format used across Wii U, 3DS, and Switch
  first-party games (BotW, Splatoon, Mario Odyssey, etc.). `parseSarc(blob)`
  reads the SARC + SFAT + SFNT header chain, parses every node, and
  returns each entry as a _lazy_ `Blob.slice` view into the source —
  matching the PFS0/HFS0 pattern elsewhere in this monorepo so that
  multi-hundred-MB packs can be browsed without ever materializing
  file data. Both BE (Wii U) and LE (Switch) byte-order marks are
  handled. `isSarc(blob)` is a 4-byte magic check.

  Combined with the existing tooling, the two packages let
  `apps/nx-archive` browse `.zip`, `.sarc`, `.pack`, `.szs`, and the
  common Yaz0-prefixed `s*pack` / `s*beventpack` / `s*bactorpack`
  extensions used by 1st-party Switch titles. Total of 21 unit tests
  across the two packages.

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
