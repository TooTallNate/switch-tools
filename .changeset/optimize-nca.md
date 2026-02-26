---
"@tootallnate/nca": patch
---

Add pluggable `aesXtsEncrypt` option to all NCA creation functions, allowing callers to provide a native AES-XTS implementation (e.g. nx.js). Batch PFS0 hash table SHA-256 operations via `Promise.all`. Optimize key derivation to skip unused key generations when `keyGeneration` is specified.
