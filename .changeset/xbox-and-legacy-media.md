---
"nx-archive": minor
---

Expand the media library to more platforms and engines:

- **Xbox:** opens Xbox disc images (`.iso` / `.xiso`, extract-xiso and redump layouts). Halo: Combat Evolved maps are recognised by their header, so FF7/FF8 `.map` files are unaffected, and open as folders of their media: bitmaps as PNGs, Xbox ADPCM sounds as WAVs (music sorted into `music/`), and textured models in the mesh viewer and the library. Xbox ADPCM `.wav` files, including DirectMusic waves, now play.
- **BFRES, Unity and Unreal models in the library:** they get thumbnails and batch export like the other model types.
  - Texture-only BFRES files drop out of the library.
  - Skinned Unity meshes pose in their idle clip with vertex colours, and get readable titles from their AssetBundle paths.
  - Unreal static meshes resolve textures from their own PAK mount.
- **Engine support:**
  - LZMA-compressed Unity bundles.
  - Legacy (v3–v9) Unreal PAKs and UE 4.18 static meshes, materials and textures.
  - Switch-cooked Unreal textures stored in Tegra block-linear layout are detected and deswizzled.
- **Mario Kart 64:** the racers' pre-rendered sprites are shown as one 21-column sprite sheet per character, with the correct palettes.
- **Fixes:** vertex-coloured models without textures are no longer marked partial. Unreal mesh previews now find their textures the same way the library does.
