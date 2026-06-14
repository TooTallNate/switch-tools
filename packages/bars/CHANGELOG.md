# @tootallnate/bars

## 0.0.2

### Patch Changes

- 80567aa: New parser package for **BARS** ("Binary Audio Resource System"),
  Nintendo's flat audio archive used heavily on the Wii U and Switch —
  notably in _The Legend of Zelda: Breath of the Wild_ and
  _Tears of the Kingdom_, where every animal vocalisation, weapon
  swing, ambient effect, and short BGM cue lives in a `.bars` file
  under `Sound/Resource/` or inside one of the Yaz0+SARC `.pack`
  bundles.

  `parseBars(blob)` walks the file's hash and offset tables, decodes
  each track's AMTA block (with its `DATA`, `MARK`, `EXT_`, `STRG`
  sub-sections), and exposes the audio payload as a lazy `Blob` slice
  ready to hand off to a BFWAV / BFSTP decoder, `vgmstream-web`, or
  just download. Tolerant of "stub" archives whose offset table
  points past EOF (a common pattern in BotW where shared-asset
  archives ship with metadata but no audio bytes), surfacing those
  tracks with `audio === null` so callers can still display the AMTA
  metadata.

  Each entry comes back with a friendly track name (decoded from the
  AMTA `STRG` block — e.g. `Bear_Vo_Hearing02`,
  `Bgm_Spot_AkkareAncientLabo`), a sniffed audio kind (`'fwav' |
'fstp' | null`), and a decoded `AmtaData` view giving channel
  count, loop range, sample-format hint, and gain. Big-endian (Wii U)
  and little-endian (Switch) BARS files are both handled.

  Wired into `apps/nx-archive` as a container that expands into a
  named `.bfwav` / `.bfstp` per track (so children get the right
  format badge and audio icon in the tree), plus a structured summary
  preview pane showing track counts, audio totals, and a per-track
  table with channels, loop range, volume, and size.
