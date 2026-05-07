---
'@tootallnate/dsp-adpcm': patch
---

New shared codec package for **Nintendo DSP-ADPCM** (a.k.a. GC
ADPCM), the 4-bit lossy audio codec used by every first-party
Nintendo audio format from the GameCube onward — BFSTM, BFWAV,
BFSTP, BWAV, BARS-embedded FWAVs, the lot.

Pure-JS / TypeScript implementation, ~200 LOC. Direct port of
vgmstream's `ngc_dsp_decoder.c` decode loop:

  sample = clamp16(
    ((nibble * scale) << 11 + 1024 + coef1*hist1 + coef2*hist2) >> 11
  )

with carefully-chosen `Int16Array`-friendly arithmetic so the JIT
keeps the hot loop branch-free.

Two entry points:

  - `decodeFrames(frames, firstSample, numSamples, state, out, outOff, stride)`
    — decode a slice of nibbles into a pre-allocated `Int16Array`,
    propagating per-channel history (`hist1` / `hist2`) across calls
    so block-interleaved formats like BFSTM can decode each
    channel's blocks one at a time without resetting state at the
    interleave gaps.
  - `decodeChannel(frames, numSamples, state)` — one-shot
    convenience for non-interleaved input (BFWAV, BARS-embedded
    FWAVs).

Also ships a tiny `encodeWav` / `encodeWavBlob` utility that wraps
interleaved PCM16 in a 44-byte RIFF WAVE header — exactly the
format HTML5 `<audio>` and `AudioContext.decodeAudioData()` accept,
which is what `apps/nx-archive` uses to play the decoded streams
in the browser.

Verified end-to-end: BotW BARS-embedded FWAVs, Super Mario Odyssey
BFSTMs (DSP-ADPCM and PCM16), and synthetic round-trip fixtures
all decode to the byte-identical output that vgmstream produces
(spot-checked via Apple `afinfo` on the WAVs).
