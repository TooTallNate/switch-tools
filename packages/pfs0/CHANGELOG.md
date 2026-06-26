# @tootallnate/pfs0

## 0.0.3

### Patch Changes

- 6eb0d6a: Fix ESM resolution under Node: the emitted `dist/index.js` imported `./types` without a `.js` extension, which Node's ESM loader rejects with `ERR_MODULE_NOT_FOUND`. The source relative imports now include the explicit `.js` extension so the published package imports cleanly in Node.

## 0.0.2

### Patch Changes

- 1baf3af: Set up npm OIDC trusted publishing with provenance

## 0.0.1

### Patch Changes

- 4b46f2f: Add initial `@tootallnate/pfs0` package
