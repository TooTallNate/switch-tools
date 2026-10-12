---
"nx-archive": patch
---

Fixed missing textures on Let's Go field maps whose model is packed in its own pak. In `bin/archive/field/area01/road023_00.gfpak`, for example, the model is in its own pak but its textures live in the area pak next to it (`bin/archive/field/area01.gfpak`). That pak is now searched too, so the 28 maps the gaps report listed as having no textures are fully textured. All 178 field models now find every texture.
