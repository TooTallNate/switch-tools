# @tootallnate/dds

## 0.1.0

### Minor Changes

- 095f9e0f: BC6H decoding (tone-mapped to 8-bit sRGB): `decodeBC6H` in bcn, and DX10 BC6H (DXGI 95/96) DDS files in dds.
- 8a00672b: BC7 decoding: `decodeBC7` in bcn, and DX10 BC7 (DXGI 98/99) DDS files in dds.
- cadf420d: More pixel formats: luminance (L8, A8L8, L16), legacy numeric fourCCs (R16F, G16R16F, A16B16G16R16F, the 32-bit float ones), plain DX10 channel formats (R8, R8G8, R16, float and unorm 16-bit, 32-bit float), and B8G8R8A8 / B8G8R8X8 now swap their channels. Float data is clamped to 0..1.

### Patch Changes

- Updated dependencies [095f9e0f]
- Updated dependencies [8a00672b]
  - @tootallnate/bcn@0.1.0
