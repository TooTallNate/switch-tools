---
"@tootallnate/trinity": minor
---

Added material curves, eye highlights and field terrain:

- **Material curves:** `parseTracm` now reads per-material curves and their initial values, and `sampleTracmMaterials` evaluates them. These drive eye expressions (`UVScaleOffset`), highlights (`UVScaleOffset1`) and colour tints.
- **`bakeTrinitySurface`:** bakes a material's colour over a region of raw UV space, sampling each map through its own UV transform and wrap mode. It includes the eye highlight (`HighlightMaskMap`) and takes animated parameter overrides.
- **Field terrain:**
  - `parseTrtrr` and `parseTrins` read terrain tiles and instance placements.
  - `buildTerrainMesh` turns a heightmap into a grid mesh, and `bakeTerrainColor` blends the splat layers into one overview texture.
  - `sniffTrinity` recognizes `.trtrr` and `.trins`, and tiles list the files they name.
