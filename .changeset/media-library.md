---
"nx-archive": minor
---

Add a media library view, a high-level alternative to the file tree. After opening a game it shows only the game's media, with the same interface for every platform: 3D models, music, sound effects, videos, fonts and images.

- **Merged models:** assets that span several files become one item. An FF7 field character is its `.hrc` skeleton plus the RSD → `.p` meshes and `.tex` textures. An FF7 battle model is the `<id>aa` skeleton plus its `<id>xx` siblings. Game Freak, BFRES, BEA and HSD models include their textures. Merged parts are hidden unless "Show parts" is on.
- **Thumbnails:** models are drawn by one shared offscreen renderer, in the same rest / idle pose their viewer opens in. Images get downscaled previews, audio a waveform plus its duration, fonts a type sample, and browser-playable video a frame.
- **Detail panel:** opens the existing preview for the item, export button included, and has a "Show in files" jump to the source files.
- **Batch export:** exports every model in the current view to a ZIP of STL or painted 3MF files, all at the file's shared print scale.
- **Gaps report:** lists unrecognised files grouped by extension, with their leading bytes and example paths, plus failed or partial media, containers that failed to open, and containers skipped as too expensive to scan. The report can be copied or downloaded as a Markdown brief for implementing the missing formats.
- **Scanning:** the library scans automatically in the background with progress, and can be cancelled. Multi-GB NCZ decompression waits until you ask for it. The results are cached in IndexedDB, keyed by a fingerprint of the file, so reopening a game shows its library instantly. Expensive container parses such as GFPAK sniffing are cached too.
- **Command line:** `bun scripts/media-scan.ts <file>` runs the same scan and prints the gaps report.
- **Default view:** Library is now the default view; the Library / Files toggle in the header remembers your choice.
- **FF7:** the FF7 HRC preview now opens in the stored bind pose, and its `.a` animation headers are read once per archive instead of once per character.
