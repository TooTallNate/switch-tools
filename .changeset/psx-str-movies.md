---
"@tootallnate/psx-str": minor
---

New package: decoders for PlayStation STR movies and CD-XA audio.

- **Video:** `StrDecoder` demuxes STR movies and decodes their MDEC frames (versions 1–3) to YUV 4:2:0. It handles Final Fantasy VII's frames, which start with 40 bytes of camera data, and STRs stored as plain 2048-byte data sectors (`cookedStrToRaw`).
- **Audio:** `scanXaStreams` and `decodeXaStream` split interleaved XA ADPCM files into one PCM stream per channel. The 4-bit mode (used by every XA file tested) is decoded from FFmpeg's reference; 8-bit samples are handled too, but untested. `pcm16ToWav` writes the result as WAV.
