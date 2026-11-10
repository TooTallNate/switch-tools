# @tootallnate/psx-tim

## 0.1.0

### Minor Changes

- d2a7a1d: New package: a decoder for PlayStation TIM images.

  - `decodeTim` handles 4, 8, 16 and 24 bpp images and any of their CLUT palettes, drawing colour 0x0000 as transparent.
  - `findTims` finds valid TIMs embedded inside other files.

### Patch Changes

- eaa9ae6: New package `@tootallnate/ff7-psx-model`: decoders for Final Fantasy VII PlayStation 3D models.

  - **Battle models** (`.LZS` in ENEMY / MAGIC): enemies, bosses and party characters, including single-mesh models. They are posed in frame 0 of their first animation and textured from the embedded TIM, with one texture per CLUT palette.
  - **Field characters** (`FIELD/*.BCX`): posed and vertex-coloured.
  - `parseBsx` reads the per-field NPC model sets.
  - `decompressLzs` is re-exported for convenience.

  `@tootallnate/psx-tim`: `timLayout` now reports the VRAM position of the image and CLUT blocks, and `pixelWidth` is exported.
