---
"nx-archive": patch
---

Downloads of lazily decompressed files (GFPAK entries, PSX disc files) no longer come out as 0 bytes: Blob facades are branded and materialised before `createObjectURL`, and `LazyDecompressBlob` now implements `stream` / `bytes` / `text`. Legends: Arceus translate-only eyes get their pupils (thumbnails re-render).
