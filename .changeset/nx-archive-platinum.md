---
"nx-archive": minor
---

Open Bayonetta 3. Before, 0 models and 0 sounds came out of its `.pkz` packages; now the Library finds 2,905 3D models, 2,209 music tracks, 10,238 sound effects and 43,428 images:

- **Packages and archives:** PKZ packages (Oodle Kraken, or zstd for Astral Chain) and PlatinumGames DAT / DTT archives (`.dat`, `.dtt`, `.eff`, `.evn`) open as folders. Decompressed entries are kept in a bounded LRU, not pinned on nodes.
- **Textures:** `.wta` / `.wtb` texture banks list their textures as PNGs, with pixels from the paired `.dtt`.
- **Models:** WMB3 models open in the mesh viewer, textured with their albedo maps. Every MOT clip in the model's own DAT plays through CPU skinning. Models also export and get Library thumbnails.
- **Sound:** Wwise PTADPCM sounds play.
- **Headless:** ASTC and zstd WASM now load under Bun, so the headless scan decodes ASTC textures too.
