---
"@tootallnate/drp": minor
---

New package for Bandai Namco DRP archives (Pokkén Tournament / Pokkén Tournament DX), ported from Sammi-Husky's Pokken-Tools and Smash Forge:

- **Decryption:** `decryptDrp` undoes the xorshift128 word cipher, seeded from the file's own header.
- **Container:** `parseDrp` lists entries and their parts. `readDrpPart` inflates a part, including zlib-in-zlib payloads, and `peekDrpPart` reads just a part's first bytes, so listing doesn't inflate everything.
- **Layout fixes found on real files:** part sizes are running totals, and the compression flag is unreliable (stage models are zlib with flag 0), so each payload is checked for its own zlib header.
