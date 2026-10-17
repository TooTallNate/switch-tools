# @tootallnate/trinity

## 0.1.0

### Minor Changes

- 7ae4a1b: Added animation support:

  - **`TrinityPose`:** poses a skeleton with a GFBANM (`.tranm`) clip and skins vertices on the CPU through the rig-index mapping.
  - **`parseTracm`:** reads a clip's per-mesh visibility.

- eb77c21: Added material curves, eye highlights and field terrain:

  - **Material curves:** `parseTracm` now reads per-material curves and their initial values, and `sampleTracmMaterials` evaluates them. These drive eye expressions (`UVScaleOffset`), highlights (`UVScaleOffset1`) and colour tints.
  - **`bakeTrinitySurface`:** bakes a material's colour over a region of raw UV space, sampling each map through its own UV transform and wrap mode. It includes the eye highlight (`HighlightMaskMap`) and takes animated parameter overrides.
  - **Field terrain:**
    - `parseTrtrr` and `parseTrins` read terrain tiles and instance placements.
    - `buildTerrainMesh` turns a heightmap into a grid mesh, and `bakeTerrainColor` blends the splat layers into one overview texture.
    - `sniffTrinity` recognizes `.trtrr` and `.trins`, and tiles list the files they name.

- 3b50f1b: New package: parsers for Game Freak's "Trinity" model files from Pokémon Legends: Arceus, all of them FlatBuffers without file magic:

  | File     | Holds                                                |
  | -------- | ---------------------------------------------------- |
  | `.trmdl` | The model: mesh, skeleton and material files         |
  | `.trmsh` | Mesh shapes, vertex layouts and sub-meshes           |
  | `.trmbf` | Vertex and index buffers                             |
  | `.trmtr` | Materials: texture bindings, samplers and parameters |
  | `.trskl` | Skeleton                                             |
  | `.trmmt` | Material table                                       |

  It also provides:

  - **`buildTrinityMesh`:** decodes the vertex streams into flat render buffers.
  - **`sniffTrinity` and `trinityReferencedNames`:** identify a file by its structure, and list the sibling files it names. Archives that store only name hashes can recover those names from this list.
  - **`bakeLayeredAlbedo`:** flattens the game's layered colour (albedo tinted by `BaseColorLayer1`–`4` through `LayerMaskMap`) into one texture.

  Field layouts come from the pkZukan/PokeDocs schemas.

### Patch Changes

- 1d111c2: Honour `UVTransformMode` `T` (translate-only) on Eye materials: `uvScaleOffset` and `bakeTrinitySurface` now ignore the stored UV scale and apply only the offset. Fixes missing pupils on Magnemite, Magikarp, Shinx and Kricketune, whose scales (2, 4), (1, 0) and (1, 2) clamped or collapsed the eye mask. `uvScaleOffset` takes an optional animated value.
- Updated dependencies [0b3c499]
- Updated dependencies [c53ae00]
- Updated dependencies [18f4666]
  - @tootallnate/gfbmdl@0.1.0
