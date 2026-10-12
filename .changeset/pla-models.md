---
"nx-archive": minor
---

Added Pokémon Legends: Arceus models to the viewer and the library.

- **Oodle GFPAKs:** these now open with the `oodle.wasm` loaded from the header's Oodle button. Without it, reading an Oodle entry prompts for the decoder. `media-scan` gains `--oodle`.
- **Trinity models (`.trmdl`):**
  - Rendered with their layered colours baked into the texture, and each material's UV transform and UV tile applied.
  - A Shiny toggle appears when the model has a shiny material set.
  - Skeleton data is passed to print supports.
  - Models classify as 3D models with thumbnails and export.
- **Other Trinity files:** mesh, buffer, material, skeleton and material-table files get summary previews.
- **Fixes:**
  - PNG thumbnails of archive entries no longer fail in `createImageBitmap`.
  - NROs without an asset section open as just their executable instead of failing.
