# @tootallnate/upak

## 0.1.0

### Minor Changes

- 250f019: Read legacy PAK files (versions 3–9, UE 4.0–4.24), such as Octopath Traveler's v4 PAKs. `isUpak` detects any supported footer, and `parseUpak` falls back to the legacy index format when the file isn't v11.

### Patch Changes

- 278ed00: Fix Oodle-compressed single-block entries in v11 PAKs (the GTA Definitive Editions). The encoded index's block-size field can read 0 or a rounded value for one-block files, which asked the decompressor for the wrong output size. A single block now always decodes to the file's uncompressed size.
