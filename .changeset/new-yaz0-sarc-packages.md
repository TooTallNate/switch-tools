---
'@tootallnate/yaz0': patch
'@tootallnate/sarc': patch
---

Two new parser packages for Nintendo's first-party archive formats.

**`@tootallnate/yaz0`** — decoder for Yaz0, the LZ-style compression
scheme Nintendo uses across Wii / Wii U / Switch first-party titles
(most commonly as the wrapper around SARC archives in `.szs` files).
`decompressYaz0(blob)` returns a `Blob` of the decompressed payload;
`decompressYaz0ToBytes(blob)` returns the raw `Uint8Array`. Internally
streams the compressed input chunk-by-chunk so very large `.szs`
files don't need to be `arrayBuffer()`'d up front. `isYaz0(blob)` and
`readYaz0Header(blob)` provide cheap (4–16 byte) detection /
inspection. Handles all three Yaz0 reference encodings — short
(2-byte) back-refs, long (3-byte) back-refs ≥ 0x12, and overlapping
RLE-style copies.

**`@tootallnate/sarc`** — parser for SARC ("Sead Archive"), the
standard archive format used across Wii U, 3DS, and Switch
first-party games (BotW, Splatoon, Mario Odyssey, etc.). `parseSarc(blob)`
reads the SARC + SFAT + SFNT header chain, parses every node, and
returns each entry as a *lazy* `Blob.slice` view into the source —
matching the PFS0/HFS0 pattern elsewhere in this monorepo so that
multi-hundred-MB packs can be browsed without ever materializing
file data. Both BE (Wii U) and LE (Switch) byte-order marks are
handled. `isSarc(blob)` is a 4-byte magic check.

Combined with the existing tooling, the two packages let
`apps/nx-archive` browse `.zip`, `.sarc`, `.pack`, `.szs`, and the
common Yaz0-prefixed `s*pack` / `s*beventpack` / `s*bactorpack`
extensions used by 1st-party Switch titles. Total of 21 unit tests
across the two packages.
