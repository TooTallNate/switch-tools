# @tootallnate/sm64

## 0.2.0

### Minor Changes

- ae506b04: Parse geo layouts into a scene graph (`parseSm64Geo`) and pose it the way the game does (`poseSm64Geo`): billboards face forward at scale 1, only the nearest render range draws, switches draw a chosen case, and only drawn parts read animation channels. `buildSm64Geo` carries render state between display lists and returns an animator that re-poses the mesh for any animation frame. Finds an actor's animation table (`findSm64ActorAnimations`) and all of Mario's animations, picks Mario's looks (`sm64MarioPoseOptions`: cap, no cap, wing cap, metal), and names models by actor group and level (`sm64ModelName`).

### Patch Changes

- 12e570ff: Map environment-mapped surfaces onto the part of the texture the game uses: the power star is gold all over instead of half black.
- Updated dependencies [0838bf0a]
- Updated dependencies [b1afa166]
  - @tootallnate/f3dex@0.2.0

## 0.1.0

### Minor Changes

- 352b960: New package: Super Mario 64 level scripts walked statically from `level_script_entry` (segment loads, models, areas, per-level dispatch), geo layouts flattened to meshes, and animations (actor banks matched by part count and proximity; Mario's DMA table) to pose animated parts.

### Patch Changes

- 7b58d15: `SM64_SEQUENCE_NAMES` from the decomp's `sound/sequences.json`.
- Updated dependencies [857b16d]
- Updated dependencies [ba49759]
  - @tootallnate/f3dex@0.1.0
