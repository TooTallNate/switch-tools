---
'@tootallnate/bffnt': patch
---

New parser + renderer package for **BFFNT** ("Cafe Font Format"),
Nintendo's bitmap-font format used across Wii U and Switch first-
party games. Unlike `@tootallnate/bfttf` — which deobfuscates a
TrueType outline that the OS already knows how to render — BFFNT
files are sprite-sheets of pre-rasterised glyphs, so this package
both parses the container *and* implements the full rasterisation
pipeline.

**Container parsing** (`parseBffnt(blob)`): reads the FFNT header,
the FINF font-info section, the TGLP texture-glyph atlas, and the
linked-list chains of CWDH (per-glyph metrics) and CMAP (Unicode
→ glyph-index) blocks. Both the v3 (3DS) `u16` and v4 (Wii U /
Switch) `u32` codepoint encodings are handled, as are
big-endian (Wii U) and little-endian (Switch) byte-order marks.

**Atlas decoding** (`decodeBffnt(parsed)`): unwraps the embedded
**BNTX** texture container that Switch BFFNTs put inside their
TGLP `sheetData`, applies a Tegra X1 GOB block-linear deswizzle
(direct port of `aboood40091/BNTX-Extractor/swizzle.py`), decodes
the underlying texture format (BC4 / R8 / R4G4 / R8G8 / R8G8B8A8),
and Y-flips the result so callers can address pixels in normal
top-left-origin image coordinates. Switch font atlases are stored
upside-down on disk — that's an OpenGL/NVN bottom-left-origin
convention, not a bug in our pipeline.

**Glyph rendering** (`renderText(font, text)`): walks the CMAP /
CWDH chains to look up the right glyph index and per-glyph
metrics for each character of the input string, then composites
the corresponding atlas cells onto a freshly-allocated RGBA8
buffer using straight alpha-over blending. Supports multi-line
text (newlines force a hard break), missing-glyph fallback via
the font's `alterCharIndex`, and surrogate-pair codepoints.

Verified end-to-end against every BFFNT shipped in BotW —
`Ancient_00.bffnt` (BC4 Sheikah glyphs, 32×1024), `Caption_00`,
`Normal_00` (1024×1024 ×2 sheets, full Latin / Greek / Cyrillic /
Katakana / CJK), `NormalS_00` (R4G4 anti-aliased drop-shadow
variant), `Special_00` (ornate display font), `External_00`. Wired
into `apps/nx-archive` as a structured preview that lets the user
type custom sample text and see it rendered live in the actual
font, alongside the full deswizzled atlas.
