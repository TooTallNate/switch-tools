---
"@tootallnate/goldeneye": minor
---

Textures: `findGoldeneyeTextureOffsets` (the `g_Textures` size table → offsets), `findGoldeneyeTextureBank` and `decodeGoldeneyeTexture` / `readGoldeneyeTexture`, a port of Rare's image codec (zlib-paletted, uncompressed, Huffman, per-channel Huffman, RLE, lookup tables and the blur prediction filter). All 2,698 GoldenEye (USA) textures decode. Model primitives now carry `G_SETTEX` wrap modes and `G_TEXTURE` scale.
