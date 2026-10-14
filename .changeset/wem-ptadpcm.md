---
"@tootallnate/wem": minor
---

Decode Platinum PTADPCM (Wwise codec `0x8311`), the ADPCM PlatinumGames added to Wwise for Bayonetta 3 and Astral Chain. `decodeWemToBlob` now returns a PCM WAV for these WEMs, and `decodePtadpcm` is exported. Ported from vgmstream.
