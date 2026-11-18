---
"@tootallnate/dds": minor
---

More pixel formats: luminance (L8, A8L8, L16), legacy numeric fourCCs (R16F, G16R16F, A16B16G16R16F, the 32-bit float ones), plain DX10 channel formats (R8, R8G8, R16, float and unorm 16-bit, 32-bit float), and B8G8R8A8 / B8G8R8X8 now swap their channels. Float data is clamped to 0..1.
