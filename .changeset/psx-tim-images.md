---
"@tootallnate/psx-tim": minor
---

New package: a decoder for PlayStation TIM images.

- `decodeTim` handles 4, 8, 16 and 24 bpp images and any of their CLUT palettes, drawing colour 0x0000 as transparent.
- `findTims` finds valid TIMs embedded inside other files.
