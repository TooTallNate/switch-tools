---
"nx-archive": patch
---

Let's Go models now respect alpha-blended materials (`BlendMode` ≠ 0). This fixes Paras' and Venomoth's eyes:

- **Effect shells:** blended layers whose texture is fully transparent (the `ParasMask` shells over their eyes) are hidden instead of drawn opaque over the eye.
- **Highlights:** blended cut-outs (eye highlights) keep their alpha. When they're small shells hugging other geometry, they become decals, so 3D-print exports paint them onto the eye instead of printing a disc.
- **Translucent layers** (Beedrill's and Butterfree's wings) are unchanged.

The 3MF palette's noise floor also drops from 0.1% to 0.02% of the surface, so tiny features on big models still count.
