---
"@tootallnate/bfstm": minor
---

Decode BFSTP prefetch streams, whose audio sits in a `PDAT` block rather than `DATA`. New `prefetchOnly` / `streamTotalSamples` fields describe truncated prefetches. Also fix the offset of the final interleave block, which garbled the last moments of every multi-block stream. Decoding is now bit-exact with vgmstream.
