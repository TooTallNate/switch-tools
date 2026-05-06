---
'@tootallnate/xci': patch
---

Fix XCI magic byte-order check so trimmed dumps actually parse.

The `"HEAD"` magic at the start of the CardHeader is laid out as the
bytes `48 45 41 44` on disk, but the parser was reading them as
little-endian and comparing against the constant `0x48454144` (which
is the BE numeric encoding). The mismatch caused every XCI to fail
with `Not an XCI file (expected magic 0x48454144, got 0x44414548)`.

Now reads the magic in the natural BE byte order and probes both
known header offsets — `0x100` (trimmed XCI, the common distribution
form with the `CardKeyArea` stripped) and `0x1100` (full raw cartridge
dump) — picking the corresponding HFS0 root offset (`0xF000` or
`0x10000`) for whichever location the magic was found at.

Adds a small test suite (5 cases) covering trimmed XCI, full XCI,
non-XCI input, undersized blob, and a "no secure partition" failure
path.
