---
"@tootallnate/rare-1172": patch
---

Inflate with fflate instead of `DecompressionStream`. Chrome rejects bytes after a DEFLATE stream ("Junk found after end of compressed data") and drops the output, so in the browser every padded GoldenEye 007 / Perfect Dark file failed and the ROM showed nothing. fflate stops at the final block, and is much faster for thousands of small files.
