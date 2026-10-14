---
"@tootallnate/platinum": minor
---

New package for PlatinumGames formats, as used by Bayonetta 3 (and largely shared with Astral Chain and NieR:Automata):

- **Packages and archives:** `parsePkz` reads `.pkz` packages (per-file Oodle Kraken or zstd streams). `parseDat` reads `DAT\0` archives (`.dat`, `.dtt`, `.eff`, `.evn`).
- **Textures:** `parseWta` reads `WTB\0` texture banks (`.wta` + `.wtp`, or `.wtb`) with Switch XT1 surface infos. `decodeWtaTexture` maps NVN format codes onto `@tootallnate/bntx` to deswizzle and decode BCn, ASTC and the uncompressed formats.
- **Models:** `parseWmb` and `buildWmbMesh` read WMB3 models: bones, the bone-id translate table, the vertex layouts, batches, LODs, bone sets and materials with their texture ids. Bayonetta 3 streams its highest LODs from `.wme` files; the inline LODs are used.
- **Animation:** `parseMot` reads MOT clips (all eight interpolation types, including pghalf-quantized Hermite keys). `WmbPose` poses the skeleton and linear-blend skins on the CPU.

Ported from Kerilk's bayonetta_tools templates and the `pgtools` gem.
