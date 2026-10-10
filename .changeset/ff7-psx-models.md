---
"@tootallnate/ff7-psx-model": minor
"@tootallnate/psx-tim": patch
---

New package `@tootallnate/ff7-psx-model`: decoders for Final Fantasy VII PlayStation 3D models.

- **Battle models** (`.LZS` in ENEMY / MAGIC): enemies, bosses and party characters, including single-mesh models. They are posed in frame 0 of their first animation and textured from the embedded TIM, with one texture per CLUT palette.
- **Field characters** (`FIELD/*.BCX`): posed and vertex-coloured.
- `parseBsx` reads the per-field NPC model sets.
- `decompressLzs` is re-exported for convenience.

`@tootallnate/psx-tim`: `timLayout` now reports the VRAM position of the image and CLUT blocks, and `pixelWidth` is exported.
