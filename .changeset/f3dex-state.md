---
"@tootallnate/f3dex": minor
---

- Fix F3DEX2 `G_MTX`: params are in the low byte of w0 (load / push were misread, so loads multiplied).
- Materials take their texel format, size and dimensions from the render tile (tile 0), so colour-indexed textures loaded as 16-bit blocks decode as CI4 / CI8.
- Materials record `primColor`, `envColor` and `combine`; `f3dexMaterialTint` returns the constant colour the combiner multiplies in.
- New options: `resolveMatrix` (supply matrices such as Zelda 64 segment 0x0D) and `trustSegments` (resolve every mapped segment).
