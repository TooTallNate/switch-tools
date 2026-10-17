# @tootallnate/bea

## 0.0.2

### Patch Changes

- bed0eb0: Add `@tootallnate/bea`, a parser for Bezel Engine Archives (`.bea`, magic `SCNE`): a flat bundle of individually zstd-compressed assets per actor.

  nx-archive now browses `.bea` files (lazily decompressing each asset), treats the Bezel BFRES extensions (`.fmdb`, `.fskb`, `.fmab`, `.fvbb`) as BFRES, shows `.ftxb` texture-pointer stubs as text, and the BFRES 3D viewer pulls the model's texture bank and animations from elsewhere in the enclosing archive.
