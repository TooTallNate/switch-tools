---
"nx-archive": minor
---

- **Structural supports in 3D-print exports:** a new "Connect loose parts" option, on by default, finds parts that float free or only touch the rest at an edge or a point (e.g. Red XIII's flame past the tip of his tail, or limbs at their joints). It joins them to the model with struts that extend into both parts and take the colour of the surface they leave. The export dialog says what it found before you export.
- **FF7 PlayStation models animate:** battle and field clips play in the 3D viewer at the game's frame rates (the viewer now supports per-clip playback rates). Exports use the current pose.
- **FF7 field faces:** field characters show their eyes and mouths, read from the `FIELD.TDB` next to them. Standalone `.BCX` files open as models too.
- **Fixes:**
  - Opening a standalone media file (e.g. a single model) and clicking it now opens its preview.
  - Single-frame animation clips no longer count frames forever.
