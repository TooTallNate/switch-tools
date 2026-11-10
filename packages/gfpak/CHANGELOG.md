# @tootallnate/gfpak

## 0.1.0

### Minor Changes

- f0ec368: Added `GFPAK_INFO_VERSION`, the version of the sniff and name-recovery results that `gfpakEntryInfo` returns. Callers that persist those results should include it in their cache key, so results from older versions get recomputed instead of reused.
- f2404c0: Added Oodle-compressed entry support, plus Legends: Arceus names:

  - **Oodle:** the `oodle` option takes a decoder for compression type 3, the default in Pokémon Legends: Arceus. Entries are read and sniffed through it, and `GfpakOodleUnavailableError` is thrown when an Oodle entry is read without a decoder. `sniffOodle: false` skips decoding while listing.
  - **Trinity files:** Trinity model files are now sniffed, and the file names they reference recover their siblings' names.
  - **Folder names:** Arceus-style folders (`bin/pokemon/pm0025/pm0025_00_00/mdl/`) are now recovered.

### Patch Changes

- c53ae00: Render Pokémon: Let's Go, Pikachu! / Eevee! models in the 3D viewer.

  - New `@tootallnate/gfbmdl` package for Game Freak's GFLX FlatBuffers formats: `.gfbmdl` models (materials, bones, vertex buffers), `.gfbanm` animations (bone tracks with packed quaternions, material and visibility tracks) and `.gfbanmcfg` state tables. Also includes a structural sniffer for these magic-less files, a mesh flattener and CPU skinning.
  - `@tootallnate/gfpak` now recovers entry names and folders by hashing candidates against GFPAK's FNV-1a-64 hashes. Game Freak uses offset basis `0xCBF29CE484222645`. Candidates include texture names, the pak's own name, files listed by `.gfbanmcfg`, and `<material>.bnsh_vsh` / `.bnsh_fsh`. It also identifies models and animations inside paks, which previously showed up as `.bin`.
  - nx-archive previews `.gfbmdl` models with their textures, finding companion files in the same pak, in nearby folders, or (for field maps) in `archive/field/<area>.gfpak`. It applies the game's UV transforms, which mirror half-textures and swap eye and mouth expressions. Eye irises are baked in from their separate layer texture. Shadow, collision and fire-mask materials are hidden. Every clip plays with skinning, material UV and visibility animation. GFPAKs now open as their real folder tree with real file sizes, and `.gfbanm` / `.gfbanmcfg` files get info panels.

- f89a4aa: Recovered the names of animation clip files. Identifier strings in a pak's unnamed FlatBuffers (Legends: Arceus animation graphs list every clip) are tried as `<pak stem>_<name>.<clip ext>`, so clips get their real names (e.g. `pm0094_00_00_00000_defaultwait01_loop.tranm` / `.tracm`).
- f9a5d64: Recovered the file names in Legends: Arceus terrain paks: tiles (`.trtrr`), instance placements (`.trins`) and detail maps (`.trtbf`).
- 0cc07b5: `@tootallnate/nca` now caches the imported AES-CTR key for each section instead of re-importing it on every read. Each re-import was a WebCrypto round trip, which dominated reading thousands of small files out of a RomFS in browsers. `parseGfpak` accepts `known` entry info from a previous `gfpakEntryInfo()` call, which skips sniffing, the step that decompresses every entry.
- Updated dependencies [0b3c499]
- Updated dependencies [c53ae00]
- Updated dependencies [18f4666]
- Updated dependencies [7ae4a1b]
- Updated dependencies [eb77c21]
- Updated dependencies [1d111c2]
- Updated dependencies [3b50f1b]
  - @tootallnate/gfbmdl@0.1.0
  - @tootallnate/trinity@0.1.0

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
