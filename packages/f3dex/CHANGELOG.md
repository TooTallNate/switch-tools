# @tootallnate/f3dex

## 0.2.0

### Minor Changes

- 0838bf0a: Carry render state between display lists with `initialState` / `F3dexMesh.state` (lights, the loaded texture, combiner, geometry mode), flag `G_TEXTURE_GEN` vertices in `texGen`, and draw untextured when the combiner reads no texel (`f3dexCombineUsesTexture`) or F3D's `G_TEXTURE` is off. `mergeF3dexMeshes` keeps materials with different light colours apart.

### Patch Changes

- b1afa166: `texGen` now gives, per environment-mapped vertex, the share of the texture `gSPTexture`'s scale covers, so callers map normals onto the right part of it.

## 0.1.0

### Minor Changes

- 857b16d: Materials record `lightColor` (light 1 diffuse + ambient, from `G_MOVEMEM`) for lit geometry; new `initialGeometryMode` option; `mergeF3dexMeshes` (moved here from z64-object).
- ba49759: - Fix F3DEX2 `G_MTX`: params are in the low byte of w0 (load / push were misread, so loads multiplied).
  - Materials take their texel format, size and dimensions from the render tile (tile 0), so colour-indexed textures loaded as 16-bit blocks decode as CI4 / CI8.
  - Materials record `primColor`, `envColor` and `combine`; `f3dexMaterialTint` returns the constant colour the combiner multiplies in.
  - New options: `resolveMatrix` (supply matrices such as Zelda 64 segment 0x0D) and `trustSegments` (resolve every mapped segment).
