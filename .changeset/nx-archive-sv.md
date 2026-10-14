---
"nx-archive": minor
---

Pokémon Scarlet / Violet: `arc/data.trpfs` opens. Every catalogued Pokémon gets a model folder under its real path (`pokemon/data/pm0025/pm0025_00_00/`):

- **Names:** files are named from the game's own references: the model's meshes, LOD buffers, skeleton, materials (including shiny) and textures. The existing Trinity viewer then shows the Pokémon textured, with its animation clips (named by hash).
- **Packs:** all packs stay browsable by hash under `packs/`. The automatic Library scan skips them.
