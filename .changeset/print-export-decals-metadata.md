---
"nx-archive": minor
"@tootallnate/ff7-psx-model": patch
---

3D-print export fixes and improvements:

- **Painted-on details print as paint:** decals such as FF7 field characters' eyes and mouths are painted onto the surface beneath instead of being exported as floating sheets. They used to come out as black rectangles.
- **Struts follow the model:** loose parts are joined to their skeletal parent where the skeleton says they attach. Limb-like pieces get struts along their own axis, and blobs such as a flame at a tail tip get the parent piece extended into them. Struts are centred inside the pieces and sized to fit, so they no longer stick out sideways. Parts sunk inside the body count as attached, so fewer struts are added.
- **3MF metadata:** the object and plate are named after the export file (instead of "Untitled"). The file also records the source file, model, pose (animation and frame), scale, export settings and support summary, under an `nx:` metadata namespace.
- `@tootallnate/ff7-psx-model`: meshes expose each transform's parent (`mesh.parents`), and `poseJoints` returns bone origins for a pose.
