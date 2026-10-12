---
"@tootallnate/gfpak": patch
---

Recovered the names of animation clip files. Identifier strings in a pak's unnamed FlatBuffers (Legends: Arceus animation graphs list every clip) are tried as `<pak stem>_<name>.<clip ext>`, so clips get their real names (e.g. `pm0094_00_00_00000_defaultwait01_loop.tranm` / `.tracm`).
