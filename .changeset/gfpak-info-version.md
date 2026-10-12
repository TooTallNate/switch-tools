---
"@tootallnate/gfpak": minor
---

Added `GFPAK_INFO_VERSION`, the version of the sniff and name-recovery results that `gfpakEntryInfo` returns. Callers that persist those results should include it in their cache key, so results from older versions get recomputed instead of reused.
