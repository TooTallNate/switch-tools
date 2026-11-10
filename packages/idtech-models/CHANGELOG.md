# @tootallnate/idtech-models

## 0.1.0

### Minor Changes

- 94a08fa: New package for DOOM 3 BFG Edition's compiled models, ported from id Software's GPL DOOM-3-BFG source:

  - **Static models:** `parseBrm` reads `BRMl` static models (`.blwo`, `.base`, `.bma`, …).
  - **Skinned models:** `parseBmd5mesh` reads `.bmd5mesh` skinned models: joints, default pose, inverse bind matrices, and per-mesh skinned vertices.
  - **Animations:** `parseBmd5anim` and `sampleBmd5anim` read and sample `.bmd5anim` clips.
  - **Levels:** `parseBproc` reads a map's `.bproc` render world (every area, skipping portals and BSP nodes).
  - **Posing:** `Md5Pose` poses and CPU-skins MD5 meshes. Its quaternion convention is checked against the files' stored inverse binds.
