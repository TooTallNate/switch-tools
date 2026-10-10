---
"nx-archive": minor
---

Open PlayStation games:

- **Disc images:** PSP / PS1 `.pbp` files, raw `.bin` CD images (detected by the sector sync pattern) and ISO 9660 `.iso` images all open as their disc's file tree.
  - Official PSN EBOOTs (PS1 Classics, e.g. Final Fantasy VII) are decrypted, so no `KEYS.BIN` is needed.
  - A PBP's icons and background art show up as images.
- **Video:** STR movies (MDEC video with XA audio, including Final Fantasy VII's variants) play in the video preview and get library thumbnails. They're decoded in TypeScript and streamed through the same WebCodecs → MP4 pipeline as Bink.
- **Audio:**
  - XA audio files (interleaved voice / music channels) open as folders with one `.wav` per channel.
  - CD-DA tracks and `.DA` entries play as WAV.
- **Images:** `.TIM` images get a preview (with each palette for indexed images) and library thumbnails.
- **Library:** PlayStation boot files (SYSTEM.CNF, PS-X executables, PARAM.SFO) are no longer reported as unrecognised.
