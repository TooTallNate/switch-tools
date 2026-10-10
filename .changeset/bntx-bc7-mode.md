---
"@tootallnate/bntx": patch
---

Fix BC7 decoding for most blocks. The block mode was read from `Number()` of the block's low 64 bits, which rounds away the low byte for most blocks. Those blocks then decoded as the wrong mode or as transparent black, so many BC7 textures came out almost entirely black.
