---
"nx-archive": patch
---

Let's Go models honour the game's back-face culling (`CullMode 0`) in the viewer and in Library thumbnails. Paras', Venomoth's and other Pokémon's pupils sit behind an eye-white shell whose outside is a back face. The game culls it, but the viewer drew everything double-sided, so the eyes showed as blank discs. Other engines' models stay double-sided.
