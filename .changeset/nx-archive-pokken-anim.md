---
"nx-archive": minor
---

Pokkén Tournament DX: animated models and fonts.

- **Animations:** NUD models play their OMO clips. Characters find their skeleton and 200+ clips in the matching `chrind` DRP, and stage elements in their own DRP. Clips play in place, and models open (and thumbnail) on an idle or stance clip.
- **Version 5 DRPs** (`NX/font/font.drp`, `NX/resource/*.drp`) now open. Their decompression table is read from the title's own exefs `main` (`title-exefs.ts`).
- **Fonts:** the six NUF bitmap fonts (FOT-NewRodin, the button icon font, …) show in the Library's Fonts category, with sample text and the glyph atlas.
- **Gaps report:** OMO and VBN files inside DRPs are no longer listed as unrecognized.
