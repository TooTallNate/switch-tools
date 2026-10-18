---
"nx-archive": patch
---

BARS prefetch tracks (`.bfstp`) now play the full `.bfstm` of the same name from the title's RomFS (BotW: `Sound/Resource/Stream/`), falling back to the decoded prefetch. New `title-romfs` registry lets nested files find other files of their title by path.
