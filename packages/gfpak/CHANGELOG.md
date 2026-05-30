# @tootallnate/gfpak

## 0.0.2

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

- Updated dependencies [8b026c7]
  - @tootallnate/lz4@0.0.2
