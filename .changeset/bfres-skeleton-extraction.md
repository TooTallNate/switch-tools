---
'@tootallnate/bfres': minor
---

Add `extractSkeletons()` and surface per-shape bone bindings on
`BfresGeometry`, so renderers can place rigid- and single-bone-
skinned shapes in their correct world position.

`extractSkeletons(blob)` returns one `BfresSkeleton` per FMDL with
a flat array of `BfresBone`s (name, parent index, local SRT,
rotation mode, plus pre-composed `localMatrix` and `worldMatrix`
as 4×4 column-major `Float32Array`s ready for Three.js / glTF /
WebGL). The world matrices are computed via the parent chain so
bone-attached geometry can be hoisted from bone-local to model
space with a single multiply.

`BfresGeometry` now also exposes `boneIndex`, `vertexSkinCount`,
and `skinBoneIndexList` from the FSHP record. With these:

  - `vertexSkinCount === 0` → vertices live in
    `bones[boneIndex]`'s local space (rigid skin).
  - `vertexSkinCount === 1` → vertices live in
    `bones[skinBoneIndexList[0]]`'s local space.
  - `vertexSkinCount >= 2` → vertices already in model bind-pose
    (smooth skin); leave at identity for static rendering.

Fixes Yoshi's "eye on the floor" bug: in MK8 Yoshi.bfres the eye
shape has `vertexSkinCount === 1` bound to the `Head` bone and
its vertices are stored in Head-local space. Multiplying by the
Head bone's world matrix now lifts the eye to actual head height.

Supports BFRES v5–v10 (Switch). Reads bone rotation mode from the
skeleton-level `FlagsRotation` (mask 0x7000) and the per-bone
flag override.
