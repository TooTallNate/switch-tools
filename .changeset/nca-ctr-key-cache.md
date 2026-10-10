---
"@tootallnate/nca": patch
"@tootallnate/gfpak": patch
---

`@tootallnate/nca` now caches the imported AES-CTR key for each section instead of re-importing it on every read. Each re-import was a WebCrypto round trip, which dominated reading thousands of small files out of a RomFS in browsers. `parseGfpak` accepts `known` entry info from a previous `gfpakEntryInfo()` call, which skips sniffing, the step that decompresses every entry.
