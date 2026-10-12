---
"@tootallnate/gfbmdl": patch
---

Fixed where Pokémon eye textures sample from. `applyUvTransform` now adds the material's UV base before scaling, `scale · (uv + translate + base)`; it was added after scaling. Mirrored left and right eyes now line up on the same texture cell, so both eyes get their pupils. Also added `invertUvTransform`.
