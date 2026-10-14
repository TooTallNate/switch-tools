---
"@tootallnate/uasset": minor
---

Decode cooked SkeletalMesh assets (UE 4.24–4.27), and read material parameters cooked as native structs:

- **SkeletalMesh:** `parseSkeletalMesh` reads LOD 0 positions, normals, UVs, colours, sections, bone-mapped skin weights and the reference skeleton. Cooked packages carry no custom versions, so the version-dependent fields are probed and each variant is validated.
- **Material parameters:** material instance parameters that a cook writes as bare native structs (GTA Definitive Editions) now decode, so their texture, scalar and vector parameters are found.
