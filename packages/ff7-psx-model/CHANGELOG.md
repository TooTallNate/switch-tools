# @tootallnate/ff7-psx-model

## 0.1.0

### Minor Changes

- 4b0ecdc: FF7 PSX models can now be animated, and field characters get their faces.

  - **Animation:** `BattleAnimator` decodes the delta-coded battle animation streams, and `FieldAnimator` samples the field keyframe tables. Meshes carry each vertex's bone and bone-local position (`mesh.skin`), and `applyPose` re-poses them for any clip and frame.
  - **Faces:** `buildFieldMesh` takes the decompressed `FIELD.TDB` and a face id (see `FIELD_CHARACTER_FACES`) and textures the eye and mouth polygons, nudged just off the coplanar skin so they don't z-fight.

- eaa9ae6: New package `@tootallnate/ff7-psx-model`: decoders for Final Fantasy VII PlayStation 3D models.

  - **Battle models** (`.LZS` in ENEMY / MAGIC): enemies, bosses and party characters, including single-mesh models. They are posed in frame 0 of their first animation and textured from the embedded TIM, with one texture per CLUT palette.
  - **Field characters** (`FIELD/*.BCX`): posed and vertex-coloured.
  - `parseBsx` reads the per-field NPC model sets.
  - `decompressLzs` is re-exported for convenience.

  `@tootallnate/psx-tim`: `timLayout` now reports the VRAM position of the image and CLUT blocks, and `pixelWidth` is exported.

### Patch Changes

- 151afc7: 3D-print export fixes and improvements:

  - **Painted-on details print as paint:** decals such as FF7 field characters' eyes and mouths are painted onto the surface beneath instead of being exported as floating sheets. They used to come out as black rectangles.
  - **Struts follow the model:** loose parts are joined to their skeletal parent where the skeleton says they attach. Limb-like pieces get struts along their own axis, and blobs such as a flame at a tail tip get the parent piece extended into them. Struts are centred inside the pieces and sized to fit, so they no longer stick out sideways. Parts sunk inside the body count as attached, so fewer struts are added.
  - **3MF metadata:** the object and plate are named after the export file (instead of "Untitled"). The file also records the source file, model, pose (animation and frame), scale, export settings and support summary, under an `nx:` metadata namespace.
  - `@tootallnate/ff7-psx-model`: meshes expose each transform's parent (`mesh.parents`), and `poseJoints` returns bone origins for a pose.

- Updated dependencies [eaa9ae6]
- Updated dependencies [d2a7a1d]
  - @tootallnate/psx-tim@0.1.0
