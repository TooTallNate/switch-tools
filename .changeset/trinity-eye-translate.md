---
"@tootallnate/trinity": patch
---

Honour `UVTransformMode` `T` (translate-only) on Eye materials: `uvScaleOffset` and `bakeTrinitySurface` now ignore the stored UV scale and apply only the offset. Fixes missing pupils on Magnemite, Magikarp, Shinx and Kricketune, whose scales (2, 4), (1, 0) and (1, 2) clamped or collapsed the eye mask. `uvScaleOffset` takes an optional animated value.
