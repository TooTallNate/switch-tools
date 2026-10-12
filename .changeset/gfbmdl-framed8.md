---
"@tootallnate/gfbmdl": patch
---

Fixed bones that never animated in Pokémon Legends: Arceus `.tranm` clips. GFBANM tracks with 8-bit key frames (union tag 4, `Framed8…Track`) are now read; before, they were skipped as missing tracks.
