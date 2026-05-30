# @tootallnate/bfwar

## 0.0.2

### Patch Changes

- eb528f2: New parser for **BFWAR** (`FWAR` magic), NintendoWare's flat wave-
  archive format — a thin two-block (INFO + FILE) container that
  bundles N inline BFWAVs. BFSARs reference these as the per-sound-
  bank wave pool, and they show up as standalone files inside game
  sound directories on Wii U / Switch.

  `parseBfwar(blob)` reads the header and INFO file table, sniffs
  each entry's inner magic (almost always `FWAV`, but BFWAR is in
  principle a generic file container), and exposes each inner BFWAV
  as a lazy `Blob` slice into the source archive.

  Wired into `apps/nx-archive` as a container node: each inner FWAV
  becomes a numbered `wave_NNN.bfwav` leaf in the tree, which the
  BFWAV preview pane then automatically decodes and plays. The
  nesting works at any depth — e.g. `DummySound.bfsar` →
  `WARC_DUMMY.bfwar` → `wave_000.bfwav` opens a fully-playable
  audio leaf via three layers of NintendoWare containers.
