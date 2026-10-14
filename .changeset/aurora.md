---
"@tootallnate/aurora": minor
---

New package for BioWare Aurora formats, as used by Star Wars: Knights of the Old Republic I / II. Ported from xoreos:

- **Archives:** `parseKey` and `parseBif` (named through `nameBifEntries`) read KEY / BIF; `parseErf` reads ERF / MOD / SAV / RIM.
- **Textures:** `decodeTpc` decodes TPC (DXT1 / DXT5 or raw).
- **Models:** `parseKotorMdl` reads binary MDL / MDX models: the node tree with controller-driven transforms, and mesh geometry with textures. KotOR II's longer mesh header is detected automatically.
