---
"@tootallnate/hedgehog": minor
---

Point clouds (`.pcmodel` and friends, `CPIC`): `parsePointCloud` and `pointCloudMatrix`. Mirage files now pick their offset encoding by checking every offset-table entry, which fixes Frontiers models whose first offset happened to look big-endian.
