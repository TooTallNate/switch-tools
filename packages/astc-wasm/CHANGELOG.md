# @tootallnate/astc-wasm

## 0.0.2

### Patch Changes

- 1a08cd5: Unity mesh previews resolve far more textures (measured on Super Mario RPG, the share of sub-meshes resolving a texture went from about 40% to 86%):

  - Materials and textures referenced from other AssetBundles (`m_FileID` → `externals`) are now followed. A CAB → bundle index is built once per archive from UnityFS headers only, and only the bundle that holds the referenced CAB gets opened.
  - When a renderer keeps Unity's empty FBX-import material (e.g. `p0001_mdl_mario_new_p0001_base`), the textured material in the same file whose name it ends with (`p0001_base`) is used instead.
  - Texture names like `d17c_mtl02` ("material 02") are no longer mistaken for metallic maps.
  - Untextured slots render in the material's `_BaseColor` / `_Color`, or neutral grey when other slots are textured, instead of a rainbow normal-shaded patch.

  `@tootallnate/astc-wasm` decodes images larger than its 32 MiB WASM arena (e.g. 2048×4096 map atlases) in strips of block rows instead of failing with "out of WASM memory".
