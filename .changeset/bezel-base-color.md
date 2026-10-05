---
"nx-archive": patch
---

BFRES viewer: Bezel Engine materials with `use_base_color_value` now render their `baseColor` (multiplied into the albedo texture, or on its own for untextured shapes like a Bob-omb's body) instead of falling back to the normal-map debug material.
