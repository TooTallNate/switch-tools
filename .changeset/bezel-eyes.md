---
"@tootallnate/bfres": patch
"nx-archive": patch
---

Render eyes on Bezel Engine (Mario Party Superstars) models.

`@tootallnate/bfres` now exposes each material's shader assign (attribute/sampler routing and shader options) and shader params (with decoded texture SRTs), every UV set on a shape (`uvSets`), and each bone's bind-pose `visible` flag.

The BFRES viewer uses these for Bezel materials: albedo is sampled through the shader's UV routing and texture SRTs, and eye/brow layers (pupils masked by the eyelid atlas) are baked into the shape's texture, so they also show up in STL/3MF export. Shapes on hidden bones (alternate facial expressions) start hidden.
