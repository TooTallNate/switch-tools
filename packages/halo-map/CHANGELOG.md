# @tootallnate/halo-map

## 0.1.0

### Minor Changes

- e5d686a: New package: a parser for Halo: Combat Evolved cache files (`.map`).

  - `readHaloMap` reads a map into memory, inflating the zlib body of Xbox maps. It tolerates the trailing sector padding that browsers' `DecompressionStream` rejects.
  - `parseHaloMap` reads the tag index (class, path, ID and data offset of every tag).
  - `parseBitmapTag` / `decodeBitmap` decode bitmaps to RGBA: DXT1/3/5, the 8-, 16- and 32-bit formats, and Xbox (NV2A) swizzling.
  - `parseSoundTag` / `decodeSoundClip` decode sounds to WAV, including Xbox ADPCM and chained permutations. `decodeXboxAdpcm` is exported on its own.
  - `parseModelTag` decodes Xbox `mode` geometry (compressed vertices, triangle strips) for the highest LOD of each region, plus each shader's base map.
