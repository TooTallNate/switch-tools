---
"@tootallnate/n64-seq": minor
---

New package: N64 sequenced music for the Super Mario 64 / Mario Kart 64 audio library. `findSeqLibrary` locates `sequences.bin` and its bank sets next to the ctl / tbl banks, `parseSeqBank` reads instruments, drums, envelopes and looped VADPCM samples, `runM64` interprets M64 sequence / channel / layer scripts into timed notes, and `renderSeqEvents` / `renderSeqWav` synthesise them (ADSR, release, loops, pan) to 32 kHz stereo WAV.
