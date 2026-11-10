# @tootallnate/goldeneye

## 0.1.0

### Minor Changes

- 5a4922b: Levels: `buildGoldeneyeLevel` decompresses each room of a `bg_*_all_p.seg` file (vertices, primary and secondary lists) and draws it at the room position. The display-list runner is shared as `RareListDrawer`.
- 48ff0f1: New package: GoldenEye 007 file resource table (`findGoldeneyeFileTable`: names, ROM offsets, categories) and model files (`buildGoldeneyeModel`: node graph, group-origin matrices, Rare F3D display lists with `G_TRI4`, nearest LOD). Roots are found from the header or structurally when the header lives in code. Layouts from the n64decomp/007 decompilation. Textures (Rare image compression) and animation are not decoded yet.
- cd5be1f: Textures: `findGoldeneyeTextureOffsets` (the `g_Textures` size table → offsets), `findGoldeneyeTextureBank` and `decodeGoldeneyeTexture` / `readGoldeneyeTexture`, a port of Rare's image codec (zlib-paletted, uncompressed, Huffman, per-channel Huffman, RLE, lookup tables and the blur prediction filter). All 2,698 GoldenEye (USA) textures decode. Model primitives now carry `G_SETTEX` wrap modes and `G_TEXTURE` scale.

### Patch Changes

- 1ce0272: Intensity-only (I4 / I8) textures decode opaque, so level rock and concrete no longer render full of holes.
