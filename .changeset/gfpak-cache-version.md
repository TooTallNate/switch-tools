---
"nx-archive": patch
---

Fixed Legends: Arceus Pokémon staying in bind pose with no animations for anyone who had opened the game before. The persistent cache of GFPAK sniff and name results now includes `GFPAK_INFO_VERSION` in its key. Results cached by older versions, which predate clip-name recovery, were being reused, so no clips were found. They are now recomputed. Light-probe and other HDR or float textures now decode and get thumbnails.
