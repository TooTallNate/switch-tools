---
"nx-archive": patch
---

BotW models find textures kept outside their own folder: event-pack models use their `Model/*.Tex` companion, armour uses Link's textures from `Pack/TitleBG.pack`, and split models (`Foo-00`) share `Foo.Tex`. Terrain-material objects sample their layer of the terrain texture array (`MaterialAlb` in `Terrain.Tex`), with the shader's `_a0` routed through `samplerAssign`. Procedural (calc-colour) materials such as water get an approximate flat colour.
