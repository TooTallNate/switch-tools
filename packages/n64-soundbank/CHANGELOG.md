# @tootallnate/n64-soundbank

## 0.1.0

### Minor Changes

- b49ee60: Read classic libultra `ALBankFile` sound banks (`B1` ctl + header-less tbl): `parseAlBankFile`, `findAlBankFiles` (locates each tbl after its ctl by decoding) and `decodeAlSample` (VADPCM and RAW16). GoldenEye 007 (USA) yields its `sfx` and `instruments` banks: 292 samples.

### Patch Changes

- Updated dependencies [d3c2b17]
  - @tootallnate/vadpcm@0.1.0
