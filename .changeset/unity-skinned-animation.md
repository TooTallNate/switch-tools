---
"@tootallnate/unity-asset": patch
"nx-archive": patch
---

Skinned Unity meshes are posed and animated in the 3D viewer instead of sitting in their T-pose bind pose.

`@tootallnate/unity-asset`:
- `extractUnityMesh` returns skin weights / bone indices (`skin`, from the vertex stream or legacy `m_Skin`) and inverse bind matrices (`bindPoses`).
- New `decodeUnityAnimationClip` decodes Mecanim clips: streamed cubic keys, dense samples, constants, and `genericBindings` to Transform position / rotation / scale / Euler tracks.
- New `unityPathHash` (CRC32 of the binding path).

nx-archive builds the bone hierarchy from the mesh's `SkinnedMeshRenderer` Transforms and matches clips by path hash. The mesh is CPU-skinned each frame, so exports capture the pose. There are two layers: full-body clips (opening on `idle`) plus partial overlays such as eye and mouth clips. `MeshViewer` animation drivers can now set a `defaultIndex`.
