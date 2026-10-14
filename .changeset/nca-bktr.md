---
"@tootallnate/nca": minor
---

Decode BKTR patch sections (the RomFS of Update NCAs). Pass the parsed base-game NCA as `parseNca(blob, { …, base })` and each BKTR section's `data` / `romfsData` becomes the patched view: the indirect table maps each range to the base section or the update's own data, which is decrypted per run with the AES-CTR-EX generation counter. `createPatchedSectionReader`, `readPatchInfo` and `rangeBlob` are exported for lower-level use.
