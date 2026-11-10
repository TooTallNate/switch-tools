---
"nx-archive": patch
---

Export BFFNT bitmap fonts as a TrueType font (outlines traced from the glyphs, for CSS, canvas and design tools) or as an AngelCode BMFont (.fnt + PNG pages, zipped). BMFont fonts can be exported as TrueType too, and their text and XML descriptors now open as well as binary ones. Fixes BFFNT fonts with scan-type character maps missing most of their accented and CJK characters, and the preview's code point count.
