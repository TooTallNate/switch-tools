---
"@tootallnate/pbp": minor
---

New package: a parser for PSP `EBOOT.PBP` files.

- `parsePbp` returns the sections, the PARAM.SFO values, and each PlayStation disc as a sector reader with its CD audio track list.
- **Conversions:** single- and multi-disc popstation / PSX2PSP conversions (raw-deflated blocks) are supported.
- **Official PSN releases (PS1 Classics):** the PGD-encrypted disc header and disc map are decrypted, and the LZRC-compressed blocks are unpacked. The game's version key is recovered from the PGD itself, so `KEYS.BIN` is optional and is only used to verify the key when passed as `versionKey`.
- **Exports:** `decryptPgd` and `decompressLzrc` are also exported on their own.
