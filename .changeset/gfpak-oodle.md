---
"@tootallnate/gfpak": minor
---

Added Oodle-compressed entry support, plus Legends: Arceus names:

- **Oodle:** the `oodle` option takes a decoder for compression type 3, the default in Pokémon Legends: Arceus. Entries are read and sniffed through it, and `GfpakOodleUnavailableError` is thrown when an Oodle entry is read without a decoder. `sniffOodle: false` skips decoding while listing.
- **Trinity files:** Trinity model files are now sniffed, and the file names they reference recover their siblings' names.
- **Folder names:** Arceus-style folders (`bin/pokemon/pm0025/pm0025_00_00/mdl/`) are now recovered.
