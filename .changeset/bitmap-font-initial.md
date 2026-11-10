---
"@tootallnate/bitmap-font": minor
---

New package: converts bitmap fonts to TrueType and to AngelCode BMFont. For TrueType, glyph bitmaps are traced into outlines: smooth quadratic curves with sharp corners for anti-aliased glyphs, and exact pixel edges for small or 1-bit ones. BMFont export packs the glyphs into PNG atlas pages and writes a text `.fnt`, optionally zipped. It also reads BMFont back (binary, text or XML descriptor; PNG or TGA pages; from files or a `.zip`), so any BMFont can become a TrueType font.
