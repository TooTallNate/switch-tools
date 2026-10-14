---
"@tootallnate/idtech3": minor
---

New package for id Tech 3-family formats (Quake III; Star Wars Jedi Knight II / Jedi Academy):

- **Models:** `parseMd3` reads `IDP3` models. `parseGlm` reads Ghoul2 meshes: surface hierarchy, shaders, and 10-bit packed bone weights.
- **Levels:** `parseBsp` reads `IBSP` v46 and Raven `RBSP` v1 levels, including tessellated Bézier patches.
- **Skins:** `parseSkin` reads `.skin` files.
