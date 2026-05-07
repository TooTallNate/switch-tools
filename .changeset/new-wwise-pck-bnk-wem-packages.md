---
'@tootallnate/wwise-pck': patch
'@tootallnate/wwise-bnk': patch
'@tootallnate/wem': patch
---

Three new parser packages targeting **Audiokinetic Wwise** — the
audio middleware shipped in essentially every third-party Switch
title (Pokémon Legends Arceus, Doom Eternal, Cuphead, Hollow
Knight, NieR, Spyro, Crash, Ori, etc.). Together they take a
`.pck` or `.bnk` file straight to playable audio in the browser.

- **`@tootallnate/wwise-pck`** — parses AKPK (`.pck`) streaming-
  WEM packages. Walks the language map, soundbank LUT, streamed-
  files LUT, and external table; surfaces every WEM as a lazy
  `Blob` slice keyed by Wwise's FNV-hashed asset id. Handles the
  643 MB `Default.pck` from PLA cleanly (5,471 entries, header
  parsed in milliseconds, payload data resolved on demand).

- **`@tootallnate/wwise-bnk`** — parses Wwise SoundBanks
  (BKHD / DIDX / DATA / HIRC chunks). Returns the full chunk list
  plus a flat array of embedded WEMs (DIDX entries pointing into
  DATA). HIRC is exposed as a raw `Blob` for callers that want
  the event/sound-graph; we don't decode it (50+ object types,
  not needed for actual playback).

- **`@tootallnate/wem`** — full WEM parser + codec dispatch.
  Identifies all 17 known Wwise codec ids (Vorbis, OPUSNX, OPUSWW,
  PCM, IMA, DSP, XMA, ATRAC9, etc.) and converts the playable
  ones to browser-friendly Blobs:

    - **PCM 16-bit LE → WAV** (44-byte header + raw samples)
    - **Switch-Opus (0x3039) → Ogg-Opus** via a from-scratch
      pure-JS Ogg muxer. Strips the per-frame `(u32 size + u32
      final_range)` Wwise framing, derives sample-counts from
      Opus TOC bytes (RFC 6716 §3.1), wraps everything in
      RFC-7845-compliant Ogg pages with proper CRC-32, granule
      positions, BOS/EOS flags, and segment-table lacing.
    - **Standard Ogg-Opus (0x3040) → passthrough** (data chunk
      *is* a `.ogg`).
    - **Wwise Vorbis (0xFFFF)** + everything else surfaces a
      clear "not supported yet" error. Vorbis specifically needs
      a ww2ogg-style codebook reconstruction (~1500–2000 lines,
      multi-version detection logic) which is its own substantial
      undertaking.

  No dependencies — fully pure-JS, ~750 lines of source.

Wired into `apps/nx-archive`:

  - `.pck` (AKPK) and `.bnk` (BKHD) files, both as top-level
    archives and as nested children, expand into their constituent
    WEMs in the file tree. Each WEM gets the music-note icon and
    a `wem_<id>.wem` synthetic filename (the original asset name
    isn't stored — Wwise hashes it at build time).
  - `.wem` files render with a dedicated audio preview pane:
    - Successful decode → embedded `<audio>` player + "Save .ogg"
      / "Save .wav" download link, plus a label explaining the
      decode path ("Re-muxed Switch-Opus → Ogg-Opus" / "PCM →
      WAV").
    - Unsupported codec → friendly explanation + raw-WEM download.
    - Always: structured codec metadata (codec id + name, sample
      rate, channels, avg bytes/sec) and the RIFF chunk table
      (id / offset / size).

Verified end-to-end against PLA's `Default.pck`: an 8.6 MB
Switch-Opus music track is re-muxed to a 749-page Ogg-Opus stream
with all CRCs validating, monotonically increasing granule
positions matching `num_samples + pre_skip`, and the browser
reports `audio.duration === 373.34s` (matching the WEM's claimed
17,920,000 samples @ 48 kHz exactly). `audio.play()` advances
`currentTime` correctly with no decode error — this is full,
end-to-end Pokémon Legends Arceus background music playing in
Chrome via nothing but the built-in Opus decoder.
