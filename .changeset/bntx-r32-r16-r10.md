---
"@tootallnate/bntx": minor
---

Decode three more texture formats, used by Legends: Arceus terrain:

- **`R32_FLOAT` and `R16_FLOAT`** (terrain heightmaps) decode to a normalized greyscale image.
- **`R10_G10_B10_A2_UNORM`** (terrain normal maps) is supported.
- **`deswizzleBntxLayer`:** new, returns a layer's raw texels so callers can read heights as numbers.
