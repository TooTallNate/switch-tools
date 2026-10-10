# @tootallnate/iso9660

## 0.1.0

### Minor Changes

- a99e02c: New package: an ISO 9660 parser that reads through a sector reader, either raw 2352-byte sectors (`.bin`, PBP disc images) or cooked 2048-byte sectors (`.iso`).

  - **CD-XA attributes:** `readIsoFile` returns raw sectors for Form 2, interleaved and CD-DA files, and plain user data for everything else.
  - **Helpers:** `detectIsoImage` works out an image's sector size, `cddaToWav` wraps CD audio in a WAV header, and `msfToLba` / `bcd` convert CD table-of-contents addresses.
