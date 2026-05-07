---
'@tootallnate/bfsar': patch
---

New parser package for **BFSAR** ("Binary caFe Sound ARchive",
internal magic `'FSAR'`), NintendoWare's master sound-archive
format on the Wii U and Switch. It's the modern sibling of BCSAR
(3DS) and BRSAR (Wii) — same shape, slightly different keys and
inner-file flavours — and shows up across most first-party Switch
games (Mario Kart 8 Deluxe, Splatoon, Smash Bros. Ultimate,
Metroid Dread, the system menu's `qlaunch.bfsar`, etc.).

`parseBfsar(blob)` walks the FSAR header, the STRG string table
(skipping the patricia search-tree — only the names matter for
listing purposes), and the seven INFO sub-tables (sound, sound-
group, bank, wave-archive, group, player, file). Each named
internal file comes back with:

  - a resolved `name` taken from whichever info-table references
    it (priority: sound > soundGroup > bank > waveArchive > group);
  - an `innerMagic` sniffed from the first four payload bytes
    (`'FSTM'` / `'FWAV'` / `'FSTP'` / `'FWAR'` / `'FBNK'` /
    `'FSEQ'` / `'FGRP'` / `'FWSD'`) plus a conventional
    `innerExt` extension (`bfstm`, `bfwav`, …);
  - a `location` flag distinguishing files embedded in the FILE
    block from those stored inside a sub-`FGRP`'s payload;
  - a lazy `Blob` slice into the source for inline payloads, ready
    to download or hand off to a decoder.

External file references (e.g. on-disc streamed audio that lives
outside the archive, like BotW's `stream/dummy.dspadpcm.bfstm`) are
exposed as a separate `externalFiles` list with their resolved
paths.

Tolerant of partially-malformed archives in the same style as
`@tootallnate/sarc` and `@tootallnate/bars`: dangling string
indices, missing optional flags, and group-relative file entries
all surface as best-effort entries rather than throwing.

Wired into `apps/nx-archive` as a container that lists each named
internal file as a leaf with the appropriate `.bfstm` / `.bfwav` /
etc. extension (so children pick up the right format badge and
audio icon, and any future BFSTM-aware preview will Just Work),
plus a structured summary preview showing version, item counts,
file breakdown, and a full internal-file table.
