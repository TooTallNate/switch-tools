---
"@tootallnate/nu3": minor
---

New package for Bandai Namco NU3-engine formats, ported from Smash Forge:

- **NUT texture packs** (NTWD / NTP3): `parseNut` and `decodeNutTexture` handle BC1–BC5, RGB565 and the 8-bit RGBA layouts. Mips and cubemaps are located; GIDX hash IDs are exposed for material lookups.
- **NUD models** (NDWD / NDP3): `parseNud` reads every vertex layout (float / half normals, tangents, 1–3 byte bone weight formats, byte / half colours), triangle strips and material texture hashes.
- **VBN skeletons**: `parseVbn` and `vbnWorldMatrices` give bones and bind-pose matrices.
