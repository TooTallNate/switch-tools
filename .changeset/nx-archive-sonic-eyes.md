---
"nx-archive": patch
---

Sonic Frontiers eyes: textures use their material's sampler addressing, so the iris is clamped instead of tiled into several pupils across the eyeball, and the `ChrEye` pupil (the iris texture's alpha) is drawn black instead of see-through.
