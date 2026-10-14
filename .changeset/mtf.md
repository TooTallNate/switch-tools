---
"@tootallnate/mtf": minor
---

New package for Capcom MT Framework formats, as used by the Switch Resident Evil 0 / 1 HD remasters. Ported from RevilLib:

- **Archives:** `parseMtArc` reads ARC archives, v7–v9 (the class-hash → extension table is built with `mtHash`).
- **Textures:** `parseMtTex` and `decodeMtTex` handle TEX v0xA0+. Block-linear Switch surfaces decode through `@tootallnate/bntx`, covering BC1–BC7, RGBA8 and R8.
