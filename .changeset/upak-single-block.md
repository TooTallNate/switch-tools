---
"@tootallnate/upak": patch
---

Fix Oodle-compressed single-block entries in v11 PAKs (the GTA Definitive Editions). The encoded index's block-size field can read 0 or a rounded value for one-block files, which asked the decompressor for the wrong output size. A single block now always decodes to the file's uncompressed size.
