# @tootallnate/hacbrewpack

## 0.0.2

### Patch Changes

- e49c0ff: Add `aesXtsEncrypt` option for pluggable native AES-XTS encryption. Pass `keyGeneration` to key derivation to skip unnecessary crypto operations. Reduce RomFS buffer copies during IVFC padding.
- Updated dependencies [e49c0ff]
  - @tootallnate/nca@0.0.2

## 0.0.1

### Patch Changes

- 1baf3af: Set up npm OIDC trusted publishing with provenance
- Updated dependencies [1baf3af]
  - @tootallnate/cnmt@0.0.1
  - @tootallnate/nca@0.0.1
  - @tootallnate/romfs@0.1.1
