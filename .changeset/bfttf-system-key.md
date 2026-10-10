---
"@tootallnate/bfttf": patch
---

Fix decoding of `.bfttf` / `.bfotf` files using the system-font variant (tag `0x1E1AF836`, e.g. Pokémon Let's Go). The body key was byte-swapped (`0x06186249` instead of `0x49621806`), so these fonts came out as garbage. Keys are now derived directly from the scrambled magic, which also corrects the third-party variant key and lets uncatalogued variants decode when they produce a valid sfnt. The header size check now compares against the payload length (file size − 8), which is what the field actually holds.
