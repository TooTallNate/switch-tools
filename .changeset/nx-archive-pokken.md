---
"nx-archive": minor
---

Pokkén Tournament DX support, and a fix for video thumbnails.

- **DRP archives** decrypt and expand. NUT texture packs show as images, and NUD models open textured in the 3D viewer (characters, stages, effects), with alternative facial expressions hidden.
- **NUS3BANK sound banks** expand to playable WAVs (music, sound effects, voices).
- **Video thumbnails** no longer fail with "URL.createObjectURL: Argument 1 could not be converted". Videos inside NCA RomFS sections come back as lazy Blob facades, which are now streamed through the VFS service worker (or materialised) by a shared `object-url` helper, also used by the preview pane.
