---
"nx-archive": patch
---

One-shot zstd decompression reuses a single decoder instead of a new WebAssembly instance per frame, which ran out of memory on Super Mario Party Jamboree (196 `.bea` archives failed to open).
