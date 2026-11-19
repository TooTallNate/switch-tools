# @tootallnate/hedgehog

## 0.1.0

### Minor Changes

- 7302cdd2: New package: Hedgehog Engine formats. Mirage headers (standard and sample chunk, including Frontiers' self-relative offsets), Needle model archives, skeletal (v2/v4/v5/v6) and terrain models with skins and inverse bind matrices, v3 materials, and Needle texture streaming (`NTSI` stubs and `PSTN` packages).
- 610d4f5f: Heightfields carry their material layer: terrain texture ids and the per-cell splat map.
- 54b9c8c7: Sonic Frontiers terrain heightfields (`.heightfield`, `HTFD`): `parseHeightfield`.
- 9c756b17: `parseHhModel` and `primaryModelData` can read the lowest level of detail of a Needle model archive.
- 559e90bd: Point clouds (`.pcmodel` and friends, `CPIC`): `parsePointCloud` and `pointCloudMatrix`. Mirage files now pick their offset encoding by checking every offset-table entry, which fixes Frontiers models whose first offset happened to look big-endian.
- 3e9541fc: Sonic Frontiers skeletons (`.skl.pxd`) and animations (`.anm.pxd`): headers, ACL blobs, uncompressed clip sampling, and posing (`pxdWorldMatrices`, `hhSkinMatrices`) with aligned scale.
- 46a25358: Sonic Frontiers scalable fonts (`.scfnt`): `extractScalableFont` returns the embedded TrueType / OpenType file.
