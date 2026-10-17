# @tootallnate/pokestadium

## 0.1.0

### Minor Changes

- 7b7cf8d: New package: Pokémon Stadium 2 asset archives (cattbl tables, PERS-SZP/Yay0), FRAGMENT modules (loaded image, model and arena roots) and models. `buildStadiumModel` walks the geo layout and F3DEX2 display lists into bind-posed, textured primitives (joint hierarchy, persistent vertex cache, tile palettes / wrap / shifts, normal-vs-colour vertices). `findStadiumTables` validates the US model (282) and arena (30) tables; `stadium2ModelName` labels records (species, Substitute, Egg, Unown B–Z). Ported from gen1recomp-mod-stadium2-importer and pret/pokestadiumgs.
