# @tootallnate/nca

## 0.1.0

### Minor Changes

- b01f06f: Add full NCA _parsing_ capabilities (was build-only before).

  - New `parseNca(blob, { keys, encryptedTitleKey?, plaintext? })` returns
    a `ParsedNca` with the decrypted header fields and a `sections[]`
    array. Each section exposes the FS header, decoded PFS0 / RomFS
    offsets, and a `data: Blob` whose reads transparently AES-CTR
    decrypt the section on demand — random-access slicing only fetches
    - decrypts the requested range, so multi-gigabyte sections stay off
      the heap.
  - Supports rights-id (titlekey) NCAs via the new `encryptedTitleKey`
    option. The KeySet now exposes `titlekeks` so the section key can
    be derived as `AES-ECB-Decrypt(titlekek, encryptedTitleKey)`.
  - Adds `Data = 4` and `PublicData = 5` to `NcaContentType`. Without
    these, system-data NCAs (firmware fonts, IDBE, …) were silently
    miscategorized.
  - New `missingKey` field on the parsed result. When the user's
    prod.keys is missing the master key for the NCA's generation, we
    surface a clear "update your prod.keys" message; reads from a
    section's `data` blob throw the same message instead of silently
    returning AES-CTR-of-garbage bytes.
  - Fixed an int32 overflow in the lazy decryption path: AES-block
    alignment now uses `value - (value % 16)` instead of `value & ~0xf`.
    JS bitwise ops coerce to signed int32 and silently produced
    negative offsets for any value above 2^31 (≈ 2.15 GB) — which
    affected basically every retail Program NCA.
  - Round-trip tests added for the parser, including titlekey path
    and offsets above 2 GB.

### Patch Changes

- Updated dependencies [8b026c7]
  - @tootallnate/lz4@0.0.2

## 0.0.2

### Patch Changes

- e49c0ff: Add pluggable `aesXtsEncrypt` option to all NCA creation functions, allowing callers to provide a native AES-XTS implementation (e.g. nx.js). Batch PFS0 hash table SHA-256 operations via `Promise.all`. Optimize key derivation to skip unused key generations when `keyGeneration` is specified.
- Updated dependencies [e49c0ff]
- Updated dependencies [e49c0ff]
  - @tootallnate/aes-xts@0.0.2
  - @tootallnate/ivfc@0.0.2

## 0.0.1

### Patch Changes

- 1baf3af: Set up npm OIDC trusted publishing with provenance
- Updated dependencies [1baf3af]
  - @tootallnate/aes-xts@0.0.1
  - @tootallnate/cnmt@0.0.1
  - @tootallnate/ivfc@0.0.1
