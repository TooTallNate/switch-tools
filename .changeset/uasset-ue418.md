---
"@tootallnate/uasset": minor
---

Support assets cooked by older engines (UE 4.18 era):

- **Static meshes:** `parseStaticMesh` reads the pre-4.23 LOD layout (interleaved vertex buffer and legacy index buffer).
- **Materials:** material instance parameters can use a plain `ParameterName`.
- **Textures:** platform data with older mip layouts parses.
