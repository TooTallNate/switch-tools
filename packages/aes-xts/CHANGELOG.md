# @tootallnate/aes-xts

## 0.0.2

### Patch Changes

- e49c0ff: Optimize AES-XTS by pre-computing all sector tweaks in parallel via `Promise.all`, and reduce minor allocations in ECB decrypt

## 0.0.1

### Patch Changes

- 1baf3af: Set up npm OIDC trusted publishing with provenance
