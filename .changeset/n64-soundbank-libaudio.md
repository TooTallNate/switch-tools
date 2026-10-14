---
"@tootallnate/n64-soundbank": minor
---

Read classic libultra `ALBankFile` sound banks (`B1` ctl + header-less tbl): `parseAlBankFile`, `findAlBankFiles` (locates each tbl after its ctl by decoding) and `decodeAlSample` (VADPCM and RAW16). GoldenEye 007 (USA) yields its `sfx` and `instruments` banks: 292 samples.
