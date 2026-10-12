---
"@tootallnate/bntx": minor
---

Decode BC6H (HDR) textures, and more float formats. Used for Legends: Arceus light probes and terrain:

- **BC6H:** `decodeBC6H` and `decodeBC6HBlock`, ported from bcdec (MIT / Unlicense). The port matches bcdec exactly on 159,744 blocks from real game textures, for both signed and unsigned formats.
- **Images:** `decodeBntxLayer` now decodes BC6H, `R16_G16_B16_A16_FLOAT` and `R32_G32_B32_A32_FLOAT`, tone-mapped for display. `R16_FLOAT` and `R16_UNORM` decode to greyscale.
