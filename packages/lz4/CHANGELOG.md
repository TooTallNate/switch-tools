# @tootallnate/lz4

## 0.0.2

### Patch Changes

- 8b026c7: New parser package for LZ4 decompression with three Nintendo-relevant
  framings.

  **`@tootallnate/lz4`** — pure-JS LZ4 decoder supporting:

  - **Standard frame format** (`decompressLz4Frame`, magic `0x184D2204`)
    — the canonical self-describing format used by the official `lz4`
    CLI and most third-party tooling. Handles content-size validation,
    uncompressed (high-bit-set) blocks, and skippable frames.
  - **Legacy frame format** (`decompressLz4Legacy`, magic `0x184C2102`)
    — the older 8-MiB-fixed-block format still found in some early
    Nintendo content and the Linux kernel's embedded LZ4 streams.
  - **Switch firmware wrapper** (`decompressLz4Switch`) — Nintendo's
    bespoke `[u32 LE size][raw LZ4 block]` wrapper used for `.lz4`
    files inside firmware NCAs (e.g. WebKit / NetFront NRO blobs in
    the `0x803` data NCA). NO magic bytes, so detection requires
    either the `.lz4` file extension or a successful trial decode.

  A high-level `decompressLz4(blob)` auto-detects the variant by magic
  and dispatches to the right backend, falling back to the Switch
  wrapper for files without a recognized magic. The block decoder
  (`decodeBlock`) is also exported for callers who already have raw
  block bytes and a known output size.

  Verified against retail Firmware 16.0.3, NCA `04d1bca6…` (the
  NetFront/WebKit data NCA): all 10 embedded `.nro.lz4` files
  decompress cleanly to valid NRO0-magic NRO executables.

  Wired into `apps/nx-archive` so `.lz4` files appear in the tree as
  single-child containers — opening a `cairo_wkc.nro.lz4` shows you
  the inner NRO node with `main.nro` / `icon.jpg` / `control.nacp` /
  `romfs/` children, exactly as if you'd downloaded the inner NRO
  directly. Decompression is lazy + memoised (only invoked on first
  expand or download).

  21 unit tests, including a real-world Switch firmware sample test
  that runs only when `/tmp/lz4-samples/` is populated locally.
