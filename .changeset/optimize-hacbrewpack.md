---
"@tootallnate/hacbrewpack": patch
---

Add `aesXtsEncrypt` option for pluggable native AES-XTS encryption. Pass `keyGeneration` to key derivation to skip unnecessary crypto operations. Reduce RomFS buffer copies during IVFC padding.
