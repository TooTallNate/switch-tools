# @tootallnate/uasset

## 0.1.0

### Minor Changes

- 1ef2296: Decode cooked SkeletalMesh assets (UE 4.24–4.27), and read material parameters cooked as native structs:

  - **SkeletalMesh:** `parseSkeletalMesh` reads LOD 0 positions, normals, UVs, colours, sections, bone-mapped skin weights and the reference skeleton. Cooked packages carry no custom versions, so the version-dependent fields are probed and each variant is validated.
  - **Material parameters:** material instance parameters that a cook writes as bare native structs (GTA Definitive Editions) now decode, so their texture, scalar and vector parameters are found.

- c5f20b3: Support assets cooked by older engines (UE 4.18 era):

  - **Static meshes:** `parseStaticMesh` reads the pre-4.23 LOD layout (interleaved vertex buffer and legacy index buffer).
  - **Materials:** material instance parameters can use a plain `ParameterName`.
  - **Textures:** platform data with older mip layouts parses.
