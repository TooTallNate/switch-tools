---
"@tootallnate/trinity": minor
---

New package: parsers for Game Freak's "Trinity" model files from Pokémon Legends: Arceus, all of them FlatBuffers without file magic:

| File | Holds |
|---|---|
| `.trmdl` | The model: mesh, skeleton and material files |
| `.trmsh` | Mesh shapes, vertex layouts and sub-meshes |
| `.trmbf` | Vertex and index buffers |
| `.trmtr` | Materials: texture bindings, samplers and parameters |
| `.trskl` | Skeleton |
| `.trmmt` | Material table |

It also provides:

- **`buildTrinityMesh`:** decodes the vertex streams into flat render buffers.
- **`sniffTrinity` and `trinityReferencedNames`:** identify a file by its structure, and list the sibling files it names. Archives that store only name hashes can recover those names from this list.
- **`bakeLayeredAlbedo`:** flattens the game's layered colour (albedo tinted by `BaseColorLayer1`–`4` through `LayerMaskMap`) into one texture.

Field layouts come from the pkZukan/PokeDocs schemas.
