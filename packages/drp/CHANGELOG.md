# @tootallnate/drp

## 0.1.0

### Minor Changes

- b68d1be: Decode version 5 DRPs (Pokkén Tournament DX's `font.drp` and system files), reverse-engineered from the game's executable:

  - **Second cipher layer:** past the first 0x80 bytes, files are XORed with xoroshiro128+, seeded through splitmix64 from a key in the file's 0x20-byte stub. Entries start after the stub.
  - **Modified zlib:** each literal byte is adjusted by a 256-byte table (`out = lit - table[key++]`, with the key starting at the decompressed size mod 255). `inflateLiterals` implements this; every part is checked against its Adler-32.
  - **The table** is game data, so it isn't shipped. `findLiteralTable(image)` locates it in the title's own `main` NSO by its instruction pattern, and `readDrpPart` takes it as `literalTable`.
  - **Also new:** `encryptDrp`, `drpVersion` and `DrpLiteralTableError`.

- d78bab7: New package for Bandai Namco DRP archives (Pokkén Tournament / Pokkén Tournament DX), ported from Sammi-Husky's Pokken-Tools and Smash Forge:

  - **Decryption:** `decryptDrp` undoes the xorshift128 word cipher, seeded from the file's own header.
  - **Container:** `parseDrp` lists entries and their parts. `readDrpPart` inflates a part, including zlib-in-zlib payloads, and `peekDrpPart` reads just a part's first bytes, so listing doesn't inflate everything.
  - **Layout fixes found on real files:** part sizes are running totals, and the compression flag is unreliable (stage models are zlib with flag 0), so each payload is checked for its own zlib header.
