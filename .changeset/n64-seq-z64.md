---
"@tootallnate/n64-seq": minor
---

Zelda 64 music: `findZ64AudioTables` (sequence / soundfont / sample bank / sequence-font tables in `code`), `parseZ64Font`, `z64SampleBanks`, `z64Sequence`, and a `z64` dialect for `runM64` (relocated channel / sequence commands, relative branches, decay-index releases, MM argument differences). Dynamic tables (`setdyntable`, `dyncall`, dynamic layers) now work in both dialects, and layer `0xCB` reads its envelope and release.
