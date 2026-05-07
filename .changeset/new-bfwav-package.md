---
'@tootallnate/bfwav': patch
---

New parser + audio decoder for **BFWAV** (`FWAV` magic), Nintendo's
single-shot audio container — the format BARS archives embed
(`Bear_Vo_Hearing02`, `BombArrow_A`, etc. in BotW) and the format
BFWARs bundle by the dozen.

`parseBfwav(blob)` reads the FWAV header, INFO block, and per-
channel metadata: sample-rate, codec, loop range, plus the 16-entry
DSP-ADPCM coefficient table per channel (when the codec is
DSP-ADPCM). The DATA block stays as a lazy `Blob` slice.

`decodeBfwavToPcm16(parsed)` walks each channel's contiguous
sample bytes, dispatches by codec (DSP-ADPCM via
`@tootallnate/dsp-adpcm`, PCM16 / PCM8 inline), and returns
frame-interleaved PCM16 ready to wrap in a RIFF WAVE blob via
`encodeWav` from `@tootallnate/dsp-adpcm`.

Wired into `apps/nx-archive` as a structured preview that decodes
the audio to PCM16, wraps it in `audio/wav`, and hands the
resulting object URL to a plain `<audio controls>`. Browser handles
play / pause / scrub / volume natively. Also surfaces the parsed
metadata (codec, sample rate, channel count, duration, loop range,
container endian / version / file size) in a sidebar table.

Verified against real BotW BARS-embedded FWAVs (mono DSP-ADPCM
sound effects at 48 kHz) and the BFWARs nested inside Super Mario
Odyssey's BFSAR (PCM16).
