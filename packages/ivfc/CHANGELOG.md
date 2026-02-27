# @tootallnate/ivfc

## 0.0.2

### Patch Changes

- e49c0ff: Optimize IVFC hash tree building by batching all per-level SHA-256 block hashes via `Promise.all` instead of sequential awaits, and skip redundant zero-fill for full blocks

## 0.0.1

### Patch Changes

- 1baf3af: Set up npm OIDC trusted publishing with provenance
