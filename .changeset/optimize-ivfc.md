---
"@tootallnate/ivfc": patch
---

Optimize IVFC hash tree building by batching all per-level SHA-256 block hashes via `Promise.all` instead of sequential awaits, and skip redundant zero-fill for full blocks
