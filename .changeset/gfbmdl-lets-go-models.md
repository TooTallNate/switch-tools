---
"@tootallnate/gfbmdl": minor
"@tootallnate/gfpak": patch
"nx-archive": minor
---

Render Pokémon: Let's Go, Pikachu! / Eevee! models in the 3D viewer.

- New `@tootallnate/gfbmdl` package for Game Freak's GFLX FlatBuffers formats: `.gfbmdl` models (materials, bones, vertex buffers), `.gfbanm` animations (bone tracks with packed quaternions, material and visibility tracks) and `.gfbanmcfg` state tables. Also includes a structural sniffer for these magic-less files, a mesh flattener and CPU skinning.
- `@tootallnate/gfpak` now recovers entry names and folders by hashing candidates against GFPAK's FNV-1a-64 hashes. Game Freak uses offset basis `0xCBF29CE484222645`. Candidates include texture names, the pak's own name, files listed by `.gfbanmcfg`, and `<material>.bnsh_vsh` / `.bnsh_fsh`. It also identifies models and animations inside paks, which previously showed up as `.bin`.
- nx-archive previews `.gfbmdl` models with their textures, finding companion files in the same pak, in nearby folders, or (for field maps) in `archive/field/<area>.gfpak`. It applies the game's UV transforms, which mirror half-textures and swap eye and mouth expressions. Eye irises are baked in from their separate layer texture. Shadow, collision and fire-mask materials are hidden. Every clip plays with skinning, material UV and visibility animation. GFPAKs now open as their real folder tree with real file sizes, and `.gfbanm` / `.gfbanmcfg` files get info panels.
