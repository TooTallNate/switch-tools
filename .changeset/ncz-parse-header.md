---
'@tootallnate/ncz': minor
---

Add `parseNczHeader(blob)` which parses an NCZ's metadata header (sections, optional block table, reconstructed NCA size, and compressed-data offset) without decompressing the body. Useful for computing the reconstructed NCA size up front (e.g. to build a PFS0/NSP layout and `Content-Length`) before streaming the decompression. `decompressNcz` now uses this helper internally.
