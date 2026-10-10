---
"@tootallnate/ff7-psx-model": minor
---

FF7 PSX models can now be animated, and field characters get their faces.

- **Animation:** `BattleAnimator` decodes the delta-coded battle animation streams, and `FieldAnimator` samples the field keyframe tables. Meshes carry each vertex's bone and bone-local position (`mesh.skin`), and `applyPose` re-poses them for any clip and frame.
- **Faces:** `buildFieldMesh` takes the decompressed `FIELD.TDB` and a face id (see `FIELD_CHARACTER_FACES`) and textures the eye and mouth polygons, nudged just off the coplanar skin so they don't z-fight.
