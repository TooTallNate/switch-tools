---
'@tootallnate/bfstm': patch
---

New parser + audio decoder for **BFSTM** (`FSTM` magic), Nintendo's
streamed-audio format used for BGM and long voice clips on the
Wii U / Switch — and its prefetch-stream sibling **BFSTP**
(`FSTP` magic), which uses the same INFO layout for the chunk that
*is* present.

`parseBfstm(blob)` reads the file header, walks the block table,
decodes the INFO block (codec, sample rate, channel count, total
samples, loop range, plus the per-channel DSP-ADPCM coefficient
tables), and captures the block-interleave geometry — interleave
block size, count, samples-per-block, and the last-block
padded / valid / sample geometry — so callers can implement
custom seeking later.

`decodeBfstmToPcm16(parsed)` is the heart of the audio pipeline:
it walks the block-interleaved DATA region per the StreamInfo
geometry, calls `@tootallnate/dsp-adpcm`'s `decodeFrames` per
(block × channel) slice, and **carries DSP history (`hist1` /
`hist2`) seamlessly across the inter-channel gaps** — exactly
what vgmstream does in `bfstm.c`. Also handles PCM16 and PCM8
codecs inline (no DSP detour needed).

Wired into `apps/nx-archive` as a structured audio preview, the
same way BFWAV is — decodes to a `audio/wav` blob, hands it to
HTML5 `<audio>`, and shows the stream-layout metadata (interleave
geometry + last-block valid/padded byte counts) in a dedicated
sidebar block so the user can see what's actually being walked.

Verified end-to-end against real Super Mario Odyssey BFSTMs:

  - `RsBgmBossHaikai_A.nk.48.dspadpcm.bfstm` — 5 s stereo
    DSP-ADPCM at 48 kHz, 17 interleave blocks; decodes to a 960 KB
    WAV that plays cleanly in `<audio>`.
  - `RsBgmCityScenario01.nk.48.pcm16.bfstm` — 53 s stereo PCM16,
    627 interleave blocks, full 5.13 M sample stream walked through
    the block-interleaved layout without dropping a frame.
