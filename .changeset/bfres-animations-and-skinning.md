---
'@tootallnate/bfres': minor
---

Add `extractAnimations()` and skinning attribute decoding so
viewers can drive linear-blend-skinning deformation from the FSKA
(skeletal) animation tracks embedded in a BFRES.

`extractAnimations(blob)` returns one bucket per animation kind:
`{ skeletal, material, boneVis, shape, scene }`. FSKA is fully
decoded (per-bone curves for scale / rotate / translate, with
optional `BakedCurve` constant base values); FMAA / FVIS / FSHU /
FSCN currently surface header metadata (name, frame count, loop
flag) only — curve decoding for those will land in a follow-up.

`evaluateCurve(curve, t)` samples a single `BfresAnimCurve` with
the right interpolation (cubic / linear / step / baked) and the
right pre-/post-wrap mode (clamp / repeat / mirror). Tracks
expose `startFrame` / `endFrame` so callers can scrub or loop
without guessing.

`BfresGeometry` now also exposes the per-vertex skin attributes:

  - `skinIndices` — per-vertex bone-list indices, decoded from the
    `_i0` attribute (1 / 2 / 4 × u8 or u16).
  - `skinWeights` — per-vertex weights (UNorm), decoded from `_w0`
    when present, synthesised as `(1, 0, 0, 0)` for `vertexSkinCount
    === 1` shapes that omit the attribute.

Both are bounded to `vertexSkinCount` channels: any storage slots
beyond that count are zeroed out, so weights always sum to 1.0.
This sidesteps a real authoring quirk in MK8 — Peach's body has
`vertexSkinCount === 3` but storage is 4 × u8 with the 4th slot
left uninitialised — without this clamp the bogus 4th weight pulls
verts toward random bones.

Per-vertex `_i0` values are indices into the FSKL's
`matrixToBoneList` (returns a bone index), **not** into the
shape's sparse `skinBoneIndexList`. The new types document this
explicitly so renderers don't conflate the two.

`extractSkeletons()` additionally surfaces:

  - `inverseBindMatrix` per bone (col-major 4×4) — read directly
    from the FSKL's `InverseModelMatrices` (Matrix3×4 row-major on
    disk) for smooth-skinned bones, computed as the inverse of the
    bind-pose `worldMatrix` for bones that don't have one stored.
  - `numSmoothMatrices` / `numRigidMatrices` and the full
    `matrixToBoneList`, so renderers can build a `THREE.Skeleton`
    aligned with the GPU's matrix-palette indexing.

Adds the FVF formats needed for skin-index / skin-weight
attributes (8-bit, 16-bit, signed and unsigned, 1 / 2 / 4 channel)
to the `Format` enum and decoder.
