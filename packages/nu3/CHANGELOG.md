# @tootallnate/nu3

## 0.1.0

### Minor Changes

- e48de31: - **Animations:** `parseOmo` and `sampleOmo` read OMO skeletal clips (interpolated, constant, keyframed and compressed tracks; ported from Smash Forge `OMOOld` via pokken-blender). `vbnPoseMatrices` and `skinMatrices` pose a VBN skeleton.
  - **Bitmap fonts:** `parseNuf` and `renderNufText` read NUF fonts and draw text from their NUT glyph atlas, in coverage or colour (icon font) mode.
  - **NUT:** format 47 decodes as BC4, and surfaces of exactly w × h × 4 bytes decode as RGBA8 whatever their format code.
  - **Fix:** VBN bones start at 0x1C (the header has four per-type counts), not 0x18, so names, parents and bone IDs were misread.
- dcd5674: New package for Bandai Namco NU3-engine formats, ported from Smash Forge:

  - **NUT texture packs** (NTWD / NTP3): `parseNut` and `decodeNutTexture` handle BC1–BC5, RGB565 and the 8-bit RGBA layouts. Mips and cubemaps are located; GIDX hash IDs are exposed for material lookups.
  - **NUD models** (NDWD / NDP3): `parseNud` reads every vertex layout (float / half normals, tangents, 1–3 byte bone weight formats, byte / half colours), triangle strips and material texture hashes.
  - **VBN skeletons**: `parseVbn` and `vbnWorldMatrices` give bones and bind-pose matrices.
