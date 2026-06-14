# @tootallnate/iostore

## 0.0.2

### Patch Changes

- 37826a3: New package: parser for Unreal Engine 4/5 IoStore (`.utoc` + `.ucas`)
  containers.

  **`@tootallnate/iostore`** parses the Table of Contents (`.utoc`)
  side of an IoStore container and exposes:

  - `parseIoStoreToc(blob)` — read the `.utoc` and return header,
    mount point, compression-block table, and a path → chunk-entry
    map walked from the directory index.
  - Per-chunk `offset` / `length` / `chunkId` — enough to reconstruct
    any entry's bytes from the matching `.ucas` (caller picks
    decompression).
  - Detection of unsupported containers: encrypted, on-demand
    (HTTP-streamed), and version-too-old TOCs all surface clear
    errors.

  Limitations (intentional, to keep the package small):

  - Decompression of `.ucas` blocks is NOT performed. Only
    uncompressed (`None`) blocks are reconstructable; Oodle / Zlib /
    Zstd blocks need a caller-supplied decoder. Most retail UE4/UE5
    Switch builds use Oodle, which has no open-source decoder.
  - UAsset / UExp / UBulk _payload_ parsing is out of scope. We list
    files, not their contents.

  Reference (canonical): CUE4Parse — IoStoreReader.cs and the
  FIoStore* / FIoDirectoryIndex* / FIoFileIndex\* structs in
  CUE4Parse/UE4/IO/Objects/.
