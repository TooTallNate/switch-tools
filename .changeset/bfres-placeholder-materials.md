---
"nx-archive": patch
---

BFRES materials that need no texture of their own no longer count as missing textures. That covers placeholder `dummy` textures (BotW particle primitives) and materials whose shader computes the colour, which are drawn white or neutral grey. Geometry-less BFRES files (locators) are dropped from the library like texture-only ones.
