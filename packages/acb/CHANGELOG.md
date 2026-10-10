# @tootallnate/acb

## 0.0.2

### Patch Changes

- 0475288: CRI audio banks from Super Mario RPG (and other titles) now open and play:

  - `@tootallnate/awb` supports 4-byte track ids (AFS2 `idSize` 4) and sizes its header read from the header itself (`readAwbHeader` / `awbHeaderSize`) instead of assuming 64 KiB.
  - `@tootallnate/acb` resolves cues through synths and sequences (sequence → track event noteOn → synth `ReferenceItems` → waveform), not just direct waveform references. Each cue lists every waveform it reaches in `waveforms`.
  - `@tootallnate/wem` adds `nintendoOpusToOggOpus` / `parseNintendoOpus` / `isNintendoOpus` for standalone Nintendo Opus (`0x80000001`) streams, sharing the Ogg muxer with the Wwise OPUSNX path (`framedOpusToOggOpus`).
  - nx-archive names AWB tracks by their real codec (`.lopus` for Nintendo Opus, `.hca`, `.adx`), labels the embedded `memory.awb` with the ACB's memory cues and streamed AWBs with their own port's cues, and plays `.lopus` tracks in the browser.
