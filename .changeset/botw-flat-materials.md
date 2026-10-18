---
"nx-archive": patch
---

BotW models: untextured `uking_mat` materials (like the Korok face shadow) now draw their constant shader colour, darkened by AO, instead of the normal-vector preview. They no longer count as missing textures, so Korok NPCs and faces aren't reported as partial.
