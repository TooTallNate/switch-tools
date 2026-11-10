---
"@tootallnate/bffnt": minor
---

Fix v4 scan-type CMAP blocks: their entries are 8 bytes (a u32 code point, a u16 glyph index and padding) after a padded count, so half the entries were being lost and the rest read wrong. Adds `codepointMap()`, and `toBitmapFont()` for converting a decoded BFFNT with `@tootallnate/bitmap-font`.
