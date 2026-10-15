---
"@tootallnate/nu3": minor
---

- **Animations:** `parseOmo` and `sampleOmo` read OMO skeletal clips (interpolated, constant, keyframed and compressed tracks; ported from Smash Forge `OMOOld` via pokken-blender). `vbnPoseMatrices` and `skinMatrices` pose a VBN skeleton.
- **Bitmap fonts:** `parseNuf` and `renderNufText` read NUF fonts and draw text from their NUT glyph atlas, in coverage or colour (icon font) mode.
- **NUT:** format 47 decodes as BC4, and surfaces of exactly w × h × 4 bytes decode as RGBA8 whatever their format code.
- **Fix:** VBN bones start at 0x1C (the header has four per-type counts), not 0x18, so names, parents and bone IDs were misread.
