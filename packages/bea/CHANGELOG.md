# @tootallnate/bea

## 0.1.0

### Minor Changes

- 10a11120: BEA version 6 (Super Mario Party Jamboree): the asset pointer array moved to header 0x30 and ASST blocks grew to 0x48 bytes (asset type, content hash), with the data and name offsets at 0x38 / 0x40.

## 0.0.2

### Patch Changes

- bed0eb0: Add `@tootallnate/bea`, a parser for Bezel Engine Archives (`.bea`, magic `SCNE`): a flat bundle of individually zstd-compressed assets per actor.

  nx-archive now browses `.bea` files (lazily decompressing each asset), treats the Bezel BFRES extensions (`.fmdb`, `.fskb`, `.fmab`, `.fvbb`) as BFRES, shows `.ftxb` texture-pointer stubs as text, and the BFRES 3D viewer pulls the model's texture bank and animations from elsewhere in the enclosing archive.
