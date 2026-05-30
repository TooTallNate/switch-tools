# @tootallnate/bfres

## 0.1.0

### Minor Changes

- b09f89a: Add `extractAnimations()` and skinning attribute decoding so
  viewers can drive linear-blend-skinning deformation from the FSKA
  (skeletal) animation tracks embedded in a BFRES.

  `extractAnimations(blob)` returns one bucket per animation kind:
  `{ skeletal, material, boneVis, shape, scene }`. FSKA is fully
  decoded (per-bone curves for scale / rotate / translate, with
  optional `BakedCurve` constant base values); FMAA / FVIS / FSHU /
  FSCN currently surface header metadata (name, frame count, loop
  flag) only — curve decoding for those will land in a follow-up.

  `evaluateCurve(curve, t)` samples a single `BfresAnimCurve` with
  the right interpolation (cubic / linear / step / baked) and the
  right pre-/post-wrap mode (clamp / repeat / mirror). Tracks
  expose `startFrame` / `endFrame` so callers can scrub or loop
  without guessing.

  `BfresGeometry` now also exposes the per-vertex skin attributes:

  - `skinIndices` — per-vertex bone-list indices, decoded from the
    `_i0` attribute (1 / 2 / 4 × u8 or u16).
  - `skinWeights` — per-vertex weights (UNorm), decoded from `_w0`
    when present, synthesised as `(1, 0, 0, 0)` for `vertexSkinCount
=== 1` shapes that omit the attribute.

  Both are bounded to `vertexSkinCount` channels: any storage slots
  beyond that count are zeroed out, so weights always sum to 1.0.
  This sidesteps a real authoring quirk in MK8 — Peach's body has
  `vertexSkinCount === 3` but storage is 4 × u8 with the 4th slot
  left uninitialised — without this clamp the bogus 4th weight pulls
  verts toward random bones.

  Per-vertex `_i0` values are indices into the FSKL's
  `matrixToBoneList` (returns a bone index), **not** into the
  shape's sparse `skinBoneIndexList`. The new types document this
  explicitly so renderers don't conflate the two.

  `extractSkeletons()` additionally surfaces:

  - `inverseBindMatrix` per bone (col-major 4×4) — read directly
    from the FSKL's `InverseModelMatrices` (Matrix3×4 row-major on
    disk) for smooth-skinned bones, computed as the inverse of the
    bind-pose `worldMatrix` for bones that don't have one stored.
  - `numSmoothMatrices` / `numRigidMatrices` and the full
    `matrixToBoneList`, so renderers can build a `THREE.Skeleton`
    aligned with the GPU's matrix-palette indexing.

  Adds the FVF formats needed for skin-index / skin-weight
  attributes (8-bit, 16-bit, signed and unsigned, 1 / 2 / 4 channel)
  to the `Format` enum and decoder.

- 7efc255: Add `extractGeometry()` — pulls vertex / normal / UV / color buffers
  and triangle indices for every shape in every model in the BFRES.
  Returns `BfresGeometry[]` with `Float32Array` / `Uint16Array` /
  `Uint32Array` fields ready to drop into Three.js `BufferGeometry`,
  glTF, or any other 3D toolchain.

  Supports the common Switch attribute formats:

  - Float32: `Format_32_*`
  - Half-float: `Format_16_*_Single`
  - SNorm: `Format_8_*_SNorm`, `Format_16_*_SNorm`, `Format_10_10_10_2_SNorm`
  - UNorm: `Format_8_*_UNorm`, `Format_16_*_UNorm`

  Reads from BFRES v5+. Walks `BufferInfo.bufferOffset` to locate the
  shared geometry blob at the end of the file, then iterates each
  FMDL → FSHP → (FVTX, Mesh[0]) and decodes each attribute slot
  according to its format. First LOD only; skeletal weights, FMAT
  materials, and animations remain out of scope.

  Reference: KillzXGaming/BfresLibrary's Switch parsers
  (VertexBufferParser.cs, ShapeParser.cs, VertexAttrib.cs).

- 169a9bf: Add `extractMaterials()` — surfaces each FMAT material's texture
  references and sampler bindings. Returns `BfresMaterial[][]` keyed
  by `[modelIndex][materialIndex]` so callers can pair geometries
  (via `BfresGeometry.materialIndex`) with their material directly.

  Each material exposes:

  - `name` — material name
  - `textureRefs` — array of texture-name strings (matching entries
    inside the BFRES's embedded BNTX bank)
  - `samplers` — parallel array of sampler names (`_a0`, `_n0`,
    `_s0`, `_b0`, `_b1`, `_e0`, `_x0`, etc. by Switch convention)
  - `bindings` — convenience: `{ samplerName, textureName }[]`

  Enough info to wire albedo (or any) textures into a renderer. The
  larger FMAT contents (render-info dictionaries, shader-parameter
  data, user-data) remain out of scope — we surface only what's
  needed for texture binding.

  Reference: KillzXGaming/BfresLibrary's `MaterialParser.cs` for the
  on-disk layout.

- e5fc660: Add `extractSkeletons()` and surface per-shape bone bindings on
  `BfresGeometry`, so renderers can place rigid- and single-bone-
  skinned shapes in their correct world position.

  `extractSkeletons(blob)` returns one `BfresSkeleton` per FMDL with
  a flat array of `BfresBone`s (name, parent index, local SRT,
  rotation mode, plus pre-composed `localMatrix` and `worldMatrix`
  as 4×4 column-major `Float32Array`s ready for Three.js / glTF /
  WebGL). The world matrices are computed via the parent chain so
  bone-attached geometry can be hoisted from bone-local to model
  space with a single multiply.

  `BfresGeometry` now also exposes `boneIndex`, `vertexSkinCount`,
  and `skinBoneIndexList` from the FSHP record. With these:

  - `vertexSkinCount === 0` → vertices live in
    `bones[boneIndex]`'s local space (rigid skin).
  - `vertexSkinCount === 1` → vertices live in
    `bones[skinBoneIndexList[0]]`'s local space.
  - `vertexSkinCount >= 2` → vertices already in model bind-pose
    (smooth skin); leave at identity for static rendering.

  Fixes Yoshi's "eye on the floor" bug: in MK8 Yoshi.bfres the eye
  shape has `vertexSkinCount === 1` bound to the `Head` bone and
  its vertices are stored in Head-local space. Multiplying by the
  Head bone's world matrix now lifts the eye to actual head height.

  Supports BFRES v5–v10 (Switch). Reads bone rotation mode from the
  skeleton-level `FlagsRotation` (mask 0x7000) and the per-bone
  flag override.

### Patch Changes

- 34cf625: Two new parser packages for Nintendo / Game Freak's master 3D
  content containers, capping off the format-survey push:

  - **`@tootallnate/bfres`** — Nintendo's "Binary Cafe Resource"
    format (`FRES    ` magic with the trailing spaces). The master
    container for 3D content used across every NintendoWare-based
    game from BotW and Mario Kart 8 Deluxe through Splatoon and
    Smash Bros. Ultimate. Walks the per-version (v5–v10) header,
    decodes the Switch ResDict patricia-trie pattern (skipping the
    trie traversal in favour of linear iteration, which is exactly
    what BfresLibrary does), and surfaces:

    - `models[]` with `name`, `numVertexBuffer`, `numShape`,
      `numMaterial`, and `numBone` (resolved by following the
      FMDL → FSKL chain).
    - `animationGroups[]` for FSKA / FMAA / FVIS / FSHU / FSCN.
    - `externalFiles[]`, including the embedded BNTX texture
      bank (typically `textures.bntx`) exposed as a lazy `Blob`
      slice, ready to feed to `@tootallnate/bntx` for actual
      texture decoding.

    Scope is deliberately metadata-only — full FVTX / FSHP geometry
    parsing requires hundreds of additional struct fields and
    matters mainly when you have a 3D viewer to render the result,
    which the browser pane doesn't.

  - **`@tootallnate/gfpak`** — Game Freak's archive format
    (`GFLXPACK` magic). Bundles game assets (BNTX textures,
    .gfbmdl models, .gfbanm animations, shaders) under FNV-1a
    64-bit hashed paths in every Switch Pokémon title. Walks the
    header / folder table / hash array / file-info block, and
    exposes per-entry:

    - The folder + path FNV hashes (the actual paths aren't
      stored — Game Freak strips them on packing).
    - Sniffed inner-file magic + extension, plus an "embedded
      name" extracted from BNTX / BFRES / BNSH / BFSHA payloads
      (those formats store their original filename inside the
      payload).
    - A lazy `getData()` that decompresses on demand. **LZ4** and
      uncompressed entries decompress cleanly; **Oodle**-
      compressed entries (the default in modern Pokémon games —
      Legends Arceus, Scarlet/Violet) surface a clear error
      because Oodle is proprietary and we don't ship a WASM
      decoder.

  Both are wired into `apps/nx-archive` as expandable container
  nodes:

  - BFRES expands into its external files (`textures.bntx`,
    `*.bfsha` shader bank), each routed through `childNodeFor`
    so the BNTX texture preview Just Works one level deep.
  - BFRES root gets a structured metadata preview pane: header
    version, models table, animation list (with per-kind name
    chips), and an external-files table.
  - GFPAK expands into its (hash-named) entries, each labeled
    with the sniffed inner extension. Entries with embedded
    names (BNTX, BFRES) get their real filenames; the rest get
    `0x{path-hash}.{ext}`.
  - GFPAK root gets the standard "Container archive" pane.

  Verified end-to-end: BFRES → embedded BNTX → texture decoded as
  PNG, all in one click chain. The MK8D `APCBelt.bfres` sample
  shows 1 model "APCBelt" with 1 vertex buffer, 1 shape, 1
  material, and a 256×256 BC1_SRGB texture rendered in-browser as
  the conveyor-belt pattern.
