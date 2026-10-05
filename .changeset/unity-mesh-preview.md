---
"@tootallnate/unity-asset": patch
"nx-archive": patch
---

3D preview for Unity `Mesh` objects.

`@tootallnate/unity-asset` adds `extractUnityMesh`, which decodes a TypeTree-parsed Mesh into positions / normals / UVs / colours / indices / sub-meshes. It handles multi-stream vertex data, both vertex-format enums (2017–2018 and 2019+), inline or `.resS`-streamed vertex bytes (`unityMeshStreamRef`), and 16/32-bit indices. `toRightHanded` converts to Three.js handedness. `ClassId` gains `MeshRenderer`, `MeshFilter` and `SkinnedMeshRenderer`.

nx-archive renders Mesh objects in the shared 3D viewer, with STL/3MF export. Per-sub-mesh textures are resolved through the `SkinnedMeshRenderer` (or `MeshFilter` + `MeshRenderer`) that draws the mesh. The albedo is picked by conventional property name, or for Shader Graph materials with generated property names, by the texture's own name and colour space.
