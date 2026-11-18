---
"@tootallnate/f3dex": minor
---

Carry render state between display lists with `initialState` / `F3dexMesh.state` (lights, the loaded texture, combiner, geometry mode), flag `G_TEXTURE_GEN` vertices in `texGen`, and draw untextured when the combiner reads no texel (`f3dexCombineUsesTexture`) or F3D's `G_TEXTURE` is off. `mergeF3dexMeshes` keeps materials with different light colours apart.
