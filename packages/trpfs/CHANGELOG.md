# @tootallnate/trpfs

## 0.1.0

### Minor Changes

- ed94c56: New package for Game Freak's Trinity virtual file system (Pokémon Scarlet / Violet `arc/data.trpfs` + `data.trpfd`):

  - **Parsers:** `parseTrpfd`, `parseTrpfsIndex`, `packRange` and `parseTrpak` read the FlatBuffer descriptor, the pack index and individual packs.
  - **Hashing:** `gfFnv64` is Game Freak's FNV-1a 64, with its non-standard basis.
  - **Pokémon catalog:** `parsePokemonCatalog` reads `poke_resource_table.trpmcatalog`, which lists every species / form's model paths.
  - **Name recovery:** `TrinityNames` recovers file names by checking candidate paths against the descriptor's hashes.
