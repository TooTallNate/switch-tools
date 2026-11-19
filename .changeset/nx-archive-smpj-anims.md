---
"nx-archive": patch
---

Super Mario Party Jamboree players:

- **Animations:** their skeletal clips, kept in the `chara~pcMot_*.nx.bea` archives next to the character, load into the viewer (common and board clips first), and models open (and get thumbnails) on the common idle, which also opens the eyes and tucks the hair under Mario's cap.
- **Pupils:** both eyes get one. Jamboree draws both pupils from one UV set, the second eye shifted by +2 in U.
- **No floor:** the fluid-simulation quads under a player (no render info at all in Jamboree) stay hidden.
