# @tootallnate/nca

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
