---
"nx-archive": patch
---

UnityFS bundles are now read with random access. An entry read decompresses only the storage blocks it overlaps, through a shared 96 MiB block cache, instead of materialising the bundle's whole block stream and copying each entry into a new `Blob`. Searching the tree of a large Unity game (which expands every bundle) previously exhausted the browser's blob storage, after which bundles failed to open with `NotReadableError`.
