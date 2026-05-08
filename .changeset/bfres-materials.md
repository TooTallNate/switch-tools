---
'@tootallnate/bfres': minor
---

Add `extractMaterials()` — surfaces each FMAT material's texture
references and sampler bindings. Returns `BfresMaterial[][]` keyed
by `[modelIndex][materialIndex]` so callers can pair geometries
(via `BfresGeometry.materialIndex`) with their material directly.

Each material exposes:
- `name` — material name
- `textureRefs` — array of texture-name strings (matching entries
  inside the BFRES's embedded BNTX bank)
- `samplers` — parallel array of sampler names (`_a0`, `_n0`,
  `_s0`, `_b0`, `_b1`, `_e0`, `_x0`, etc. by Switch convention)
- `bindings` — convenience: `{ samplerName, textureName }[]`

Enough info to wire albedo (or any) textures into a renderer. The
larger FMAT contents (render-info dictionaries, shader-parameter
data, user-data) remain out of scope — we surface only what's
needed for texture binding.

Reference: KillzXGaming/BfresLibrary's `MaterialParser.cs` for the
on-disk layout.
