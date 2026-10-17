# @tootallnate/n64-seq

## 0.1.0

### Minor Changes

- 8f60cac: Zelda 64 music: `findZ64AudioTables` (sequence / soundfont / sample bank / sequence-font tables in `code`), `parseZ64Font`, `z64SampleBanks`, `z64Sequence`, and a `z64` dialect for `runM64` (relocated channel / sequence commands, relative branches, decay-index releases, MM argument differences). Dynamic tables (`setdyntable`, `dyncall`, dynamic layers) now work in both dialects, and layer `0xCB` reads its envelope and release.
- fb8d6ac: New package: N64 sequenced music for the Super Mario 64 / Mario Kart 64 audio library. `findSeqLibrary` locates `sequences.bin` and its bank sets next to the ctl / tbl banks, `parseSeqBank` reads instruments, drums, envelopes and looped VADPCM samples, `runM64` interprets M64 sequence / channel / layer scripts into timed notes, and `renderSeqEvents` / `renderSeqWav` synthesise them (ADSR, release, loops, pan) to 32 kHz stereo WAV.

### Patch Changes

- Updated dependencies [b49ee60]
- Updated dependencies [d3c2b17]
  - @tootallnate/n64-soundbank@0.1.0
  - @tootallnate/vadpcm@0.1.0
