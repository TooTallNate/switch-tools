---
"@tootallnate/drp": minor
---

Decode version 5 DRPs (Pokkén Tournament DX's `font.drp` and system files), reverse-engineered from the game's executable:

- **Second cipher layer:** past the first 0x80 bytes, files are XORed with xoroshiro128+, seeded through splitmix64 from a key in the file's 0x20-byte stub. Entries start after the stub.
- **Modified zlib:** each literal byte is adjusted by a 256-byte table (`out = lit - table[key++]`, with the key starting at the decompressed size mod 255). `inflateLiterals` implements this; every part is checked against its Adler-32.
- **The table** is game data, so it isn't shipped. `findLiteralTable(image)` locates it in the title's own `main` NSO by its instruction pattern, and `readDrpPart` takes it as `literalTable`.
- **Also new:** `encryptDrp`, `drpVersion` and `DrpLiteralTableError`.
