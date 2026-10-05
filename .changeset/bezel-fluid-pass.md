---
"@tootallnate/bfres": patch
"nx-archive": patch
---

`@tootallnate/bfres` now parses each material's render info (`renderInfo`). The BFRES viewer uses it to hide shapes the engine doesn't draw in its colour pass. Bezel Engine players have `forward_plus_fluid` height/velocity quads under their feet and body that only feed the ground-fluid simulation; these rendered as white squares. They're still listed and can be toggled on.
