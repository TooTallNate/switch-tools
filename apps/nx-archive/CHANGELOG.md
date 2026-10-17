# nx-archive

## 0.1.0

### Minor Changes

- c53ae00: New `@tootallnate/bflyt` package with a structural parser for NintendoWare layouts (`.bflyt`) and layout animations (`.bflan`). nx-archive shows a layout's canvas, textures, fonts, materials, groups and pane tree, and an animation's frames, groups and animated targets. `.flyt` / `.flan` / `.fcpx` LayoutEditor sources open as text, and BNTX banks with several textures (such as a layout's `__Combined.bntx`) get a texture picker.
- 4fc4ea9: Final Fantasy VII (PlayStation) models open in the 3D viewer and appear in the media library with thumbnails: every battle model (enemies, bosses, party members) and the field characters (Cloud, Barret, Tifa, Aerith, Red XIII, Yuffie, Cait Sith, Vincent, Cid). `.LZS` / `.BCX` files on PlayStation discs are recognised by parsing them, so other games' `.LZS` files are unaffected.
- c53ae00: Render Pokémon: Let's Go, Pikachu! / Eevee! models in the 3D viewer.

  - New `@tootallnate/gfbmdl` package for Game Freak's GFLX FlatBuffers formats: `.gfbmdl` models (materials, bones, vertex buffers), `.gfbanm` animations (bone tracks with packed quaternions, material and visibility tracks) and `.gfbanmcfg` state tables. Also includes a structural sniffer for these magic-less files, a mesh flattener and CPU skinning.
  - `@tootallnate/gfpak` now recovers entry names and folders by hashing candidates against GFPAK's FNV-1a-64 hashes. Game Freak uses offset basis `0xCBF29CE484222645`. Candidates include texture names, the pak's own name, files listed by `.gfbanmcfg`, and `<material>.bnsh_vsh` / `.bnsh_fsh`. It also identifies models and animations inside paks, which previously showed up as `.bin`.
  - nx-archive previews `.gfbmdl` models with their textures, finding companion files in the same pak, in nearby folders, or (for field maps) in `archive/field/<area>.gfpak`. It applies the game's UV transforms, which mirror half-textures and swap eye and mouth expressions. Eye irises are baked in from their separate layer texture. Shadow, collision and fire-mask materials are hidden. Every clip plays with skinning, material UV and visibility animation. GFPAKs now open as their real folder tree with real file sizes, and `.gfbanm` / `.gfbanmcfg` files get info panels.

- c53ae00: New `@tootallnate/gfmsg` package for Game Freak's encrypted message text (`.dat`) and AHTB label hash tables (`.tbl`). nx-archive now shows a game's text as a searchable table, with each line labelled from the matching `.tbl`, and previews other AHTB tables such as flag, zone and trainer names.
- c28dc02: The media library folds duplicate files. Identical copies (same kind, name, size and content), such as the same model on each disc of a multi-disc game or the same asset embedded in several Halo maps, appear once.

  - **Where the copies are:** the card shows how many copies exist, and the detail panel lists every location, each linking to the file in the tree.
  - **Speed:** files that are decoded on demand are compared by a cheap content key instead of being decoded, and the pass has a time budget, so scans stay fast.
  - **Reports:** the gaps report and `media-scan` show how many copies were folded.

- 6b24e29: Add a media library view, a high-level alternative to the file tree. After opening a game it shows only the game's media, with the same interface for every platform: 3D models, music, sound effects, videos, fonts and images.

  - **Merged models:** assets that span several files become one item. An FF7 field character is its `.hrc` skeleton plus the RSD → `.p` meshes and `.tex` textures. An FF7 battle model is the `<id>aa` skeleton plus its `<id>xx` siblings. Game Freak, BFRES, BEA and HSD models include their textures. Merged parts are hidden unless "Show parts" is on.
  - **Thumbnails:** models are drawn by one shared offscreen renderer, in the same rest / idle pose their viewer opens in. Images get downscaled previews, audio a waveform plus its duration, fonts a type sample, and browser-playable video a frame.
  - **Detail panel:** opens the existing preview for the item, export button included, and has a "Show in files" jump to the source files.
  - **Batch export:** exports every model in the current view to a ZIP of STL or painted 3MF files, all at the file's shared print scale.
  - **Gaps report:** lists unrecognised files grouped by extension, with their leading bytes and example paths, plus failed or partial media, containers that failed to open, and containers skipped as too expensive to scan. The report can be copied or downloaded as a Markdown brief for implementing the missing formats.
  - **Scanning:** the library scans automatically in the background with progress, and can be cancelled. Multi-GB NCZ decompression waits until you ask for it. The results are cached in IndexedDB, keyed by a fingerprint of the file, so reopening a game shows its library instantly. Expensive container parses such as GFPAK sniffing are cached too.
  - **Command line:** `bun scripts/media-scan.ts <file>` runs the same scan and prints the gaps report.
  - **Default view:** Library is now the default view; the Library / Files toggle in the header remembers your choice.
  - **FF7:** the FF7 HRC preview now opens in the stored bind pose, and its `.a` animation headers are read once per archive instead of once per character.

- 24ce75d: - **Structural supports in 3D-print exports:** a new "Connect loose parts" option, on by default, finds parts that float free or only touch the rest at an edge or a point (e.g. Red XIII's flame past the tip of his tail, or limbs at their joints). It joins them to the model with struts that extend into both parts and take the colour of the surface they leave. The export dialog says what it found before you export.
  - **FF7 PlayStation models animate:** battle and field clips play in the 3D viewer at the game's frame rates (the viewer now supports per-clip playback rates). Exports use the current pose.
  - **FF7 field faces:** field characters show their eyes and mouths, read from the `FIELD.TDB` next to them. Standalone `.BCX` files open as models too.
  - **Fixes:**
    - Opening a standalone media file (e.g. a single model) and clicking it now opens its preview.
    - Single-frame animation clips no longer count frames forever.
- 33c26f2: Switch updates now open together with their base game. When an update NCA's RomFS is a BKTR patch, the app looks for the matching base NCA in the NSP / NSZ / XCI / XCZ files opened alongside it (for example, in a selected folder) and shows the merged RomFS. `media-scan.ts` also accepts a folder.
- d9f3736: DOOM 3 (BFG Edition): before, the Library found no models and no sounds; now it lists 5,023 3D models, 92 music tracks and 9,596 sound effects:

  - **Models:** static models, MD5 characters and full map levels open in the mesh viewer, textured.
  - **Textures:** materials resolve through the `.mtr` declarations to `.bimage` diffuse maps.
  - **Animation:** MD5 characters play their `.bmd5anim` clips and open on an idle clip.
  - **Images:** `.bimage` images get Library thumbnails, and YCoCg-compressed images now show true colour.
  - **Sound:** bare `.fsb` FMOD sample banks play.

- 965b582: GoldenEye 007 levels (`levels/`) render as textured models: every room of Dam, Facility, Frigate, Silo, … in one mesh.
- b1f6788: GoldenEye 007 models are textured, and its 2,698-image texture bank is listed under `textures/` (PNG, in the Library).
- 6a6e8bd: Jedi Knight II / Jedi Academy (and other id Tech 3 games): `.md3` models, Ghoul2 `.glm` characters and `.bsp` levels open in the mesh viewer and export:

  - **Textures:** shaders resolve through the `.shader` scripts and the game's `.pk3` archives or unpacked asset folders.
  - **Characters:** take their per-surface textures from `model_default.skin`.
  - **Levels:** have patches tessellated and tool shaders hidden.

- e126a1f: Knights of the Old Republic:

  - **Archives:** `chitin.key` names the `data/*.bif` archives. ERF / RIM / MOD archives open.
  - **Textures:** `.tpc` textures preview and get thumbnails.
  - **Models:** `.mdl` models (characters, props, area pieces) open in the mesh viewer and export, textured from `override/` and the high-quality texture pack.

- 864c298: Resident Evil 0 / 1 HD:

  - **Archives:** MT Framework `.arc` archives now open. Before, the Nintendo RARC handler claimed them and listed nothing.
  - **Textures:** their `.tex` textures preview and get thumbnails. Resident Evil 0's Library goes from 738 to 15,432 images.

- 141d094: N64 music: SM64-family games get a `music/` folder of rendered sequences (34 tracks in Super Mario 64, named; 29 in Mario Kart 64).
- ef0be61: N64 pass:

  - **Pokémon Stadium 2:** `pokemon/` (all 278 species / forms, named) and `arenas/` (30) model folders with textured models, replacing display-list guesses that came out as gibberish.
  - **GoldenEye 007:** the named file tree (characters, guns, props, levels, setups, …) with 512 models, plus 292 sound effects from its libaudio banks. Previously nothing showed up in the browser (DecompressionStream rejected padded files).
  - **libaudio sound banks** are now found in any ROM that uses them.

- d59e958: Open Bayonetta 3. Before, 0 models and 0 sounds came out of its `.pkz` packages; now the Library finds 2,905 3D models, 2,209 music tracks, 10,238 sound effects and 43,428 images:

  - **Packages and archives:** PKZ packages (Oodle Kraken, or zstd for Astral Chain) and PlatinumGames DAT / DTT archives (`.dat`, `.dtt`, `.eff`, `.evn`) open as folders. Decompressed entries are kept in a bounded LRU, not pinned on nodes.
  - **Textures:** `.wta` / `.wtb` texture banks list their textures as PNGs, with pixels from the paired `.dtt`.
  - **Models:** WMB3 models open in the mesh viewer, textured with their albedo maps. Every MOT clip in the model's own DAT plays through CPU skinning. Models also export and get Library thumbnails.
  - **Sound:** Wwise PTADPCM sounds play.
  - **Headless:** ASTC and zstd WASM now load under Bun, so the headless scan decodes ASTC textures too.

- eeb94cf: Pokkén Tournament DX: animated models and fonts.

  - **Animations:** NUD models play their OMO clips. Characters find their skeleton and 200+ clips in the matching `chrind` DRP, and stage elements in their own DRP. Clips play in place, and models open (and thumbnail) on an idle or stance clip.
  - **Version 5 DRPs** (`NX/font/font.drp`, `NX/resource/*.drp`) now open. Their decompression table is read from the title's own exefs `main` (`title-exefs.ts`).
  - **Fonts:** the six NUF bitmap fonts (FOT-NewRodin, the button icon font, …) show in the Library's Fonts category, with sample text and the glyph atlas.
  - **Gaps report:** OMO and VBN files inside DRPs are no longer listed as unrecognized.

- c46af7d: Pokkén Tournament DX support, and a fix for video thumbnails.

  - **DRP archives** decrypt and expand. NUT texture packs show as images, and NUD models open textured in the 3D viewer (characters, stages, effects), with alternative facial expressions hidden.
  - **NUS3BANK sound banks** expand to playable WAVs (music, sound effects, voices).
  - **Video thumbnails** no longer fail with "URL.createObjectURL: Argument 1 could not be converted". Videos inside NCA RomFS sections come back as lazy Blob facades, which are now streamed through the VFS service worker (or materialised) by a shared `object-url` helper, also used by the preview pane.

- e3b9546: Run the library scan in a Web Worker so the UI (and 3D animation playback) stays responsive while large dumps are indexed, falling back to the main thread when workers are unavailable (`localStorage["nx-archive:scan-worker"] = "0"` forces it). Also cuts main-thread work during scans: items arrive pre-sorted, thumbnail updates are coalesced, 2D thumbnail canvases are CPU-backed, and the thumbnail renderer skips synchronous shader checks.
- 76b2e19: 3D-print exports paint the pupils that Let's Go eyes show through their eye-white lids. The game draws an eye as a bowl with the pupil at the bottom, under a lid whose front faces inward and which the game culls; a solid print would cover the pupil. The exporter now finds such lids and paints each with what's visible behind it, viewed along the eye's axis, so Paras and Venomoth print with their pupils (and highlights). A lid is a back-face-culled patch (24+ triangles) whose back side sees the outside and whose front closes a small cavity facing back at it. Wings, fins and models without such eyes are unaffected.
- bf15fa9: Super Mario 64: `levels/` (every area, textured) and `models/` (499 actors grouped by level, posed from their animations, lit with their light colours) replace the MIO0 display-list scan.
- d0a0f14: Pokémon Scarlet / Violet: `arc/data.trpfs` opens. Every catalogued Pokémon gets a model folder under its real path (`pokemon/data/pm0025/pm0025_00_00/`):

  - **Names:** files are named from the game's own references: the model's meshes, LOD buffers, skeleton, materials (including shiny) and textures. The existing Trinity viewer then shows the Pokémon textured, with its animation clips (named by hash).
  - **Packs:** all packs stay browsable by hash under `packs/`. The automatic Library scan skips them.

- 294fbf2: `.tga` images now preview, get Library thumbnails and export as PNG. Before, they fell back to the hex view: 510 files in Jedi Outcast alone, more in Jedi Academy and KOTOR.
- 81f3123: Unreal SkeletalMesh assets now open in the mesh viewer and export, textured, in their bind pose; the reference skeleton feeds 3D-print supports. Material textures cooked inside the material's own package (GTA Definitive Editions) now resolve, so GTA's static and skeletal meshes are textured.
- c19d475: Zelda 64 music: `music/` with every Ocarina of Time (108) and Majora's Mask (122) sequence, rendered on demand and named from the decomps.
- bfba2c6: Zelda 64: `objects/` with posed, textured character models (165 in OoT, 186 in MM), `scenes/` with every level (101 / 102), and `backgrounds/` with OoT's pre-rendered JPEG rooms. Combiner colours tint N64 materials.
- 6439f76: Legends: Arceus models now animate.

  - **Animations:** the viewer plays a model's clips and opens on its idle clip. Library thumbnails and exports use the idle pose.
  - **Mesh visibility:** each clip's mesh visibility is applied, including in the bind pose, so alternative meshes stay hidden. Gengar's long tongue no longer sticks out through its stomach.
  - **Previews:** `.tranm` clips open in the animation preview and `.tracm` files show their visibility tables.

- 39b2967: More of Legends: Arceus now renders:

  - **Expressions and colour animation:** Trinity clips animate the eye materials. Pupils follow the clip, highlights move, and clips that animate colours update them. Textures that change are re-baked as the clip plays.
  - **Eye highlights:** eyes show their white highlight.
  - **Field terrain:** each `.trtrr` tile opens as a 3D model built from its heightmap, coloured by its ground layers, with thumbnails and export. All 11 tiles load.
  - **Mesh viewer:** animation drivers now also receive the mesh's materials.

- 4723f5d: Added Pokémon Legends: Arceus models to the viewer and the library.

  - **Oodle GFPAKs:** these now open with the `oodle.wasm` loaded from the header's Oodle button. Without it, reading an Oodle entry prompts for the decoder. `media-scan` gains `--oodle`.
  - **Trinity models (`.trmdl`):**
    - Rendered with their layered colours baked into the texture, and each material's UV transform and UV tile applied.
    - A Shiny toggle appears when the model has a shiny material set.
    - Skeleton data is passed to print supports.
    - Models classify as 3D models with thumbnails and export.
  - **Other Trinity files:** mesh, buffer, material, skeleton and material-table files get summary previews.
  - **Fixes:**
    - PNG thumbnails of archive entries no longer fail in `createImageBitmap`.
    - NROs without an asset section open as just their executable instead of failing.

- 3daf09d: Open PlayStation games:

  - **Disc images:** PSP / PS1 `.pbp` files, raw `.bin` CD images (detected by the sector sync pattern) and ISO 9660 `.iso` images all open as their disc's file tree.
    - Official PSN EBOOTs (PS1 Classics, e.g. Final Fantasy VII) are decrypted, so no `KEYS.BIN` is needed.
    - A PBP's icons and background art show up as images.
  - **Video:** STR movies (MDEC video with XA audio, including Final Fantasy VII's variants) play in the video preview and get library thumbnails. They're decoded in TypeScript and streamed through the same WebCodecs → MP4 pipeline as Bink.
  - **Audio:**
    - XA audio files (interleaved voice / music channels) open as folders with one `.wav` per channel.
    - CD-DA tracks and `.DA` entries play as WAV.
  - **Images:** `.TIM` images get a preview (with each palette for indexed images) and library thumbnails.
  - **Library:** PlayStation boot files (SYSTEM.CNF, PS-X executables, PARAM.SFO) are no longer reported as unrecognised.

- 151afc7: 3D-print export fixes and improvements:

  - **Painted-on details print as paint:** decals such as FF7 field characters' eyes and mouths are painted onto the surface beneath instead of being exported as floating sheets. They used to come out as black rectangles.
  - **Struts follow the model:** loose parts are joined to their skeletal parent where the skeleton says they attach. Limb-like pieces get struts along their own axis, and blobs such as a flame at a tail tip get the parent piece extended into them. Struts are centred inside the pieces and sized to fit, so they no longer stick out sideways. Parts sunk inside the body count as attached, so fewer struts are added.
  - **3MF metadata:** the object and plate are named after the export file (instead of "Untitled"). The file also records the source file, model, pose (animation and frame), scale, export settings and support summary, under an `nx:` metadata namespace.
  - `@tootallnate/ff7-psx-model`: meshes expose each transform's parent (`mesh.parents`), and `poseJoints` returns bone origins for a pose.

- c92c72f: Added a textured GLB export to the model Export dialog and the library's batch export, and removed the Snapmaker "Full Spectrum" 3MF. Slicers' own colour matching does that job better.

  - **Format:** the GLB is a single binary glTF file for Blender and other 3D apps, and OrcaSlicer nightly builds can import it.
  - **Pipeline:** the same scale, supports, repair and smoothing as STL and 3MF.
  - **Colour:**
    - Original textures are kept at full resolution.
    - Vertex colours, flat colours and painted-on details (eyes) are baked into an extra texture, so slicers that only read textures see them too.
  - **Units:** one unit is one millimetre, as in STL and 3MF.

  Fixed support struts aiming at bone joints that weren't scaled to print size. At most scales this sent a strut far outside the model.

- c143b41: Expand the media library to more platforms and engines:

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

### Patch Changes

- 1edcbb5: BFRES viewer: Bezel Engine materials with `use_base_color_value` now render their `baseColor` (multiplied into the albedo texture, or on its own for untextured shapes like a Bob-omb's body) instead of falling back to the normal-map debug material.
- bed0eb0: Add `@tootallnate/bea`, a parser for Bezel Engine Archives (`.bea`, magic `SCNE`): a flat bundle of individually zstd-compressed assets per actor.

  nx-archive now browses `.bea` files (lazily decompressing each asset), treats the Bezel BFRES extensions (`.fmdb`, `.fskb`, `.fmab`, `.fvbb`) as BFRES, shows `.ftxb` texture-pointer stubs as text, and the BFRES 3D viewer pulls the model's texture bank and animations from elsewhere in the enclosing archive.

- 7ec7172: Render eyes on Bezel Engine (Mario Party Superstars) models.

  `@tootallnate/bfres` now exposes each material's shader assign (attribute/sampler routing and shader options) and shader params (with decoded texture SRTs), every UV set on a shape (`uvSets`), and each bone's bind-pose `visible` flag.

  The BFRES viewer uses these for Bezel materials: albedo is sampled through the shader's UV routing and texture SRTs, and eye/brow layers (pupils masked by the eyelid atlas) are baked into the shape's texture, so they also show up in STL/3MF export. Shapes on hidden bones (alternate facial expressions) start hidden.

- c2441b6: `@tootallnate/bfres` now parses each material's render info (`renderInfo`). The BFRES viewer uses it to hide shapes the engine doesn't draw in its colour pass. Bezel Engine players have `forward_plus_fluid` height/velocity quads under their feet and body that only feed the ground-fluid simulation; these rendered as white squares. They're still listed and can be toggled on.
- 8f43a26: Textures for Super Mario Party (`.nxonnx32.bea`) models. In this earlier Bezel Engine build each `.ftxb` is a standalone single-texture BNTX, not the path stub later titles use. Such `.ftxb` entries now open in the BNTX texture preview, and the BFRES viewer loads them as texture banks from the enclosing BEA. Materials compiled against the older `forward_plus_char` shader (no `texture_srt_enable*` options) are now recognised as Bezel materials, so their UV routing and texture SRTs (e.g. the 8-frame eye atlas) apply.
- 6ecc23e: Yoshi's pupils now render in Bezel Engine models.

  - Super Mario Party's eye shader has no `_u2` input. The second eye's pupil is sampled at the raw UV1 (alongside the `texsrt1`-shifted UV1 for the first eye), so both eyes get a pupil.
  - When a shape's UV islands overlap in the base texture (Yoshi's two eyes reuse one region of the body atlas), each island is baked into its own tile of a side-by-side copy of the base. That way each eye keeps its own pupil instead of the first-baked island hiding the other's. This also fixes Mario Party Superstars Yoshi, whose eyes previously shared one bake.

- 0475288: CRI audio banks from Super Mario RPG (and other titles) now open and play:

  - `@tootallnate/awb` supports 4-byte track ids (AFS2 `idSize` 4) and sizes its header read from the header itself (`readAwbHeader` / `awbHeaderSize`) instead of assuming 64 KiB.
  - `@tootallnate/acb` resolves cues through synths and sequences (sequence → track event noteOn → synth `ReferenceItems` → waveform), not just direct waveform references. Each cue lists every waveform it reaches in `waveforms`.
  - `@tootallnate/wem` adds `nintendoOpusToOggOpus` / `parseNintendoOpus` / `isNintendoOpus` for standalone Nintendo Opus (`0x80000001`) streams, sharing the Ogg muxer with the Wwise OPUSNX path (`framedOpusToOggOpus`).
  - nx-archive names AWB tracks by their real codec (`.lopus` for Nintendo Opus, `.hca`, `.adx`), labels the embedded `memory.awb` with the ACB's memory cues and streamed AWBs with their own port's cues, and plays `.lopus` tracks in the browser.

- dc093f5: Fixed how faces are drawn on FF7 PSX battle models. A face texture (eyes, brows, mouth) is cut-out art layered on top of an untextured copy of the skin, and is now treated as a decal over it:

  - **Viewer:** the face no longer flickers against the skin beneath it.
  - **Print exports:** the face's visible parts are painted onto the skin. Previously the exports either lost the face or cut holes where its transparent parts were.

- f29f98f: Fixed missing textures on Let's Go field maps whose model is packed in its own pak. In `bin/archive/field/area01/road023_00.gfpak`, for example, the model is in its own pak but its textures live in the area pak next to it (`bin/archive/field/area01.gfpak`). That pak is now searched too, so the 28 maps the gaps report listed as having no textures are fully textured. All 178 field models now find every texture.
- 48e747c: Let's Go models: only treat blended cut-out materials as decals when they hug the surface. Bulging eye caps (Psyduck) stay geometry, so they no longer vanish from 3D-print exports.
- 37ff13a: Fixed missing pupils in Pokémon: Let's Go models. The pupil is composited into the eye texture, and that bake now uses the corrected UV transform, so both eyes show their pupil, both in the viewer and in 3D-print exports (Mew, Bulbasaur, Gastly and others). Library thumbnails regenerate to pick up the fix.
- b79022d: Fixed Legends: Arceus Pokémon staying in bind pose with no animations for anyone who had opened the game before. The persistent cache of GFPAK sniff and name results now includes `GFPAK_INFO_VERSION` in its key. Results cached by older versions, which predate clip-name recovery, were being reused, so no clips were found. They are now recomputed. Light-probe and other HDR or float textures now decode and get thumbnails.
- f0ce946: Multi-colour 3MF export picks _distinct_ colours instead of the largest areas. The palette now groups the surface into perceptual colour families, ignores filtering noise, and greedily adds the family farthest from every chosen colour (and from every blend of two chosen colours). A small red eye or black stripe no longer loses its filament to a third shade of white. Spare filaments still go to the farthest remaining shades. For example, Let's Go's Beedrill at 4 colours is now white, yellow, black and red (it was white, yellow and two greys).
- e9be569: Downloads of lazily decompressed files (GFPAK entries, PSX disc files) no longer come out as 0 bytes: Blob facades are branded and materialised before `createObjectURL`, and `LazyDecompressBlob` now implements `stream` / `bytes` / `text`. Legends: Arceus translate-only eyes get their pupils (thumbnails re-render).
- faf88a4: Let's Go models now respect alpha-blended materials (`BlendMode` ≠ 0). This fixes Paras' and Venomoth's eyes:

  - **Effect shells:** blended layers whose texture is fully transparent (the `ParasMask` shells over their eyes) are hidden instead of drawn opaque over the eye.
  - **Highlights:** blended cut-outs (eye highlights) keep their alpha. When they're small shells hugging other geometry, they become decals, so 3D-print exports paint them onto the eye instead of printing a disc.
  - **Translucent layers** (Beedrill's and Butterfree's wings) are unchanged.

  The 3MF palette's noise floor also drops from 0.1% to 0.02% of the surface, so tiny features on big models still count.

- f114da4: Let's Go models honour the game's back-face culling (`CullMode 0`) in the viewer and in Library thumbnails. Paras', Venomoth's and other Pokémon's pupils sit behind an eye-white shell whose outside is a back face. The game culls it, but the viewer drew everything double-sided, so the eyes showed as blank discs. Other engines' models stay double-sided.
- 7bd250a: `.sab` files without the Square Enix SEAD magic, such as Jedi Academy's saber definitions, are now plain files instead of failed audio containers.
- da7570c: Exports from the 3D viewer (the "Export for 3D printing" button, including posed exports) now carry back-face culling over from the mounted scene. Before, only headless exports did, so the eye lids of Paras and Venomoth stayed blank white when exported from the viewer.
- a9570f2: Unreal Engine games:

  - **GTA Definitive Editions:** with the `@tootallnate/upak` fix, San Andreas lists 9,687 static meshes and 6,000+ textures, up from 5 models and 314 images.
  - **`.ubulk` classification:** mesh, texture and animation `.ubulk` payloads (named `SM_…`, `T_…`, …) are no longer listed as sound effects.

- f65e1dc: Fixed Let's Go trainer models that showed only their bind pose because their pak has no animations of their own.

  - **Trainer variants** (for example `tr0029_01`, `tr0031_02`, `tr0032_02`) now play their base trainer's animations, which live in the base variant's pak.
  - **Reskins** that reuse another trainer's rig (for example `tr0087_00`) now play that trainer's animations, found through their texture names.

  Clips are still only applied when their bone names match the model. Library thumbnails and the cached library index regenerate.

- ff99ae6: 3D preview for Unity `Mesh` objects.

  `@tootallnate/unity-asset` adds `extractUnityMesh`, which decodes a TypeTree-parsed Mesh into positions / normals / UVs / colours / indices / sub-meshes. It handles multi-stream vertex data, both vertex-format enums (2017–2018 and 2019+), inline or `.resS`-streamed vertex bytes (`unityMeshStreamRef`), and 16/32-bit indices. `toRightHanded` converts to Three.js handedness. `ClassId` gains `MeshRenderer`, `MeshFilter` and `SkinnedMeshRenderer`.

  nx-archive renders Mesh objects in the shared 3D viewer, with STL/3MF export. Per-sub-mesh textures are resolved through the `SkinnedMeshRenderer` (or `MeshFilter` + `MeshRenderer`) that draws the mesh. The albedo is picked by conventional property name, or for Shader Graph materials with generated property names, by the texture's own name and colour space.

- 1a08cd5: Unity mesh previews resolve far more textures (measured on Super Mario RPG, the share of sub-meshes resolving a texture went from about 40% to 86%):

  - Materials and textures referenced from other AssetBundles (`m_FileID` → `externals`) are now followed. A CAB → bundle index is built once per archive from UnityFS headers only, and only the bundle that holds the referenced CAB gets opened.
  - When a renderer keeps Unity's empty FBX-import material (e.g. `p0001_mdl_mario_new_p0001_base`), the textured material in the same file whose name it ends with (`p0001_base`) is used instead.
  - Texture names like `d17c_mtl02` ("material 02") are no longer mistaken for metallic maps.
  - Untextured slots render in the material's `_BaseColor` / `_Color`, or neutral grey when other slots are textured, instead of a rainbow normal-shaded patch.

  `@tootallnate/astc-wasm` decodes images larger than its 32 MiB WASM arena (e.g. 2048×4096 map atlases) in strips of block rows instead of failing with "out of WASM memory".

- 817db87: Skinned Unity meshes are posed and animated in the 3D viewer instead of sitting in their T-pose bind pose.

  `@tootallnate/unity-asset`:

  - `extractUnityMesh` returns skin weights / bone indices (`skin`, from the vertex stream or legacy `m_Skin`) and inverse bind matrices (`bindPoses`).
  - New `decodeUnityAnimationClip` decodes Mecanim clips: streamed cubic keys, dense samples, constants, and `genericBindings` to Transform position / rotation / scale / Euler tracks.
  - New `unityPathHash` (CRC32 of the binding path).

  nx-archive builds the bone hierarchy from the mesh's `SkinnedMeshRenderer` Transforms and matches clips by path hash. The mesh is CPU-skinned each frame, so exports capture the pose. There are two layers: full-body clips (opening on `idle`) plus partial overlays such as eye and mouth clips. `MeshViewer` animation drivers can now set a `defaultIndex`.

- 20c01c9: UnityFS bundles are now read with random access. An entry read decompresses only the storage blocks it overlaps, through a shared 96 MiB block cache, instead of materialising the bundle's whole block stream and copying each entry into a new `Blob`. Searching the tree of a large Unity game (which expands every bundle) previously exhausted the browser's blob storage, after which bundles failed to open with `NotReadableError`.
- Updated dependencies [42efd93]
- Updated dependencies [bed0eb0]
- Updated dependencies [7ec7172]
- Updated dependencies [c2441b6]
- Updated dependencies [c53ae00]
- Updated dependencies [8f1eda3]
- Updated dependencies [e5029bb]
- Updated dependencies [8f52079]
- Updated dependencies [9d0a351]
- Updated dependencies [5a61a3c]
- Updated dependencies [0475288]
- Updated dependencies [b68d1be]
- Updated dependencies [d78bab7]
- Updated dependencies [857b16d]
- Updated dependencies [ba49759]
- Updated dependencies [4b0ecdc]
- Updated dependencies [eaa9ae6]
- Updated dependencies [0b3c499]
- Updated dependencies [c53ae00]
- Updated dependencies [18f4666]
- Updated dependencies [c53ae00]
- Updated dependencies [f89a4aa]
- Updated dependencies [f0ec368]
- Updated dependencies [f2404c0]
- Updated dependencies [f9a5d64]
- Updated dependencies [1ce0272]
- Updated dependencies [5a4922b]
- Updated dependencies [48ff0f1]
- Updated dependencies [cd5be1f]
- Updated dependencies [e5d686a]
- Updated dependencies [94a08fa]
- Updated dependencies [ba8c9dc]
- Updated dependencies [a99e02c]
- Updated dependencies [cdaff79]
- Updated dependencies [2eaf52b]
- Updated dependencies [8f60cac]
- Updated dependencies [fb8d6ac]
- Updated dependencies [b49ee60]
- Updated dependencies [109bffe]
- Updated dependencies [0cc07b5]
- Updated dependencies [e48de31]
- Updated dependencies [dcd5674]
- Updated dependencies [d47881d]
- Updated dependencies [a5c0f10]
- Updated dependencies [e1057ae]
- Updated dependencies [7b7cf8d]
- Updated dependencies [151afc7]
- Updated dependencies [ecba46c]
- Updated dependencies [d2a7a1d]
- Updated dependencies [0157e87]
- Updated dependencies [7b58d15]
- Updated dependencies [352b960]
- Updated dependencies [618a89a]
- Updated dependencies [7ae4a1b]
- Updated dependencies [eb77c21]
- Updated dependencies [1d111c2]
- Updated dependencies [3b50f1b]
- Updated dependencies [ed94c56]
- Updated dependencies [1ef2296]
- Updated dependencies [c5f20b3]
- Updated dependencies [ff99ae6]
- Updated dependencies [1a08cd5]
- Updated dependencies [817db87]
- Updated dependencies [250f019]
- Updated dependencies [278ed00]
- Updated dependencies [d3c2b17]
- Updated dependencies [3336b53]
- Updated dependencies [d4434cc]
- Updated dependencies [165dfef]
- Updated dependencies [2368ced]
  - @tootallnate/aurora@0.1.0
  - @tootallnate/bea@0.0.2
  - @tootallnate/bfres@0.1.1
  - @tootallnate/bflyt@0.1.0
  - @tootallnate/bfttf@0.0.3
  - @tootallnate/bntx@0.1.0
  - @tootallnate/awb@0.0.2
  - @tootallnate/acb@0.0.2
  - @tootallnate/wem@0.1.0
  - @tootallnate/drp@0.1.0
  - @tootallnate/f3dex@0.1.0
  - @tootallnate/ff7-psx-model@0.1.0
  - @tootallnate/psx-tim@0.1.0
  - @tootallnate/gfbmdl@0.1.0
  - @tootallnate/gfpak@0.1.0
  - @tootallnate/gfmsg@0.1.0
  - @tootallnate/goldeneye@0.1.0
  - @tootallnate/halo-map@0.1.0
  - @tootallnate/idtech-models@0.1.0
  - @tootallnate/idtech3@0.1.0
  - @tootallnate/iso9660@0.1.0
  - @tootallnate/lzma@0.1.0
  - @tootallnate/mtf@0.1.0
  - @tootallnate/n64-seq@0.1.0
  - @tootallnate/n64-soundbank@0.1.0
  - @tootallnate/nca@0.2.0
  - @tootallnate/nu3@0.1.0
  - @tootallnate/nus3@0.1.0
  - @tootallnate/pbp@0.1.0
  - @tootallnate/platinum@0.1.0
  - @tootallnate/pokestadium@0.1.0
  - @tootallnate/psx-str@0.1.0
  - @tootallnate/rare-1172@0.0.2
  - @tootallnate/sm64@0.1.0
  - @tootallnate/tga@0.1.0
  - @tootallnate/trinity@0.1.0
  - @tootallnate/trpfs@0.1.0
  - @tootallnate/uasset@0.1.0
  - @tootallnate/unity-asset@0.1.1
  - @tootallnate/astc-wasm@0.0.2
  - @tootallnate/upak@0.1.0
  - @tootallnate/vadpcm@0.1.0
  - @tootallnate/xiso@0.1.0
  - @tootallnate/z64-object@0.1.0
  - @tootallnate/phyre@0.0.3
  - @tootallnate/z64-audio@0.0.2

## 0.0.5

### Patch Changes

- Updated dependencies [6eb0d6a]
  - @tootallnate/pfs0@0.0.3
  - @tootallnate/nca@0.1.0

## 0.0.4

### Patch Changes

- Updated dependencies [bb67c6c]
  - @tootallnate/ncz@0.1.0

## 0.0.3

### Patch Changes

- Updated dependencies [9359d23]
  - @tootallnate/zstd-wasm@0.1.0

## 0.0.2

### Patch Changes

- Updated dependencies [b09f89a]
- Updated dependencies [7efc255]
- Updated dependencies [169a9bf]
- Updated dependencies [e5fc660]
- Updated dependencies [8b026c7]
- Updated dependencies [b01f06f]
- Updated dependencies [64057ba]
- Updated dependencies [80567aa]
- Updated dependencies [4e0ffef]
- Updated dependencies [3014057]
- Updated dependencies [34cf625]
- Updated dependencies [80567aa]
- Updated dependencies [eb528f2]
- Updated dependencies [b01f06f]
- Updated dependencies [eb528f2]
- Updated dependencies [eb528f2]
- Updated dependencies [5330e53]
- Updated dependencies [4fc5d73]
- Updated dependencies [eb528f2]
- Updated dependencies [46507c6]
- Updated dependencies [37826a3]
- Updated dependencies [9e3a6a9]
- Updated dependencies [913c6f4]
- Updated dependencies [90e7be9]
- Updated dependencies [03add67]
- Updated dependencies [6605c3f]
- Updated dependencies [64057ba]
- Updated dependencies [8046f77]
- Updated dependencies [b01f06f]
  - @tootallnate/bfres@0.1.0
  - @tootallnate/lz4@0.0.2
  - @tootallnate/nca@0.1.0
  - @tootallnate/ncz@0.0.2
  - @tootallnate/bars@0.0.2
  - @tootallnate/barslist@0.0.2
  - @tootallnate/bnvib@0.0.2
  - @tootallnate/byaml@0.0.2
  - @tootallnate/bffnt@0.0.2
  - @tootallnate/gfpak@0.0.2
  - @tootallnate/bfsar@0.0.2
  - @tootallnate/bfstm@0.0.2
  - @tootallnate/bfttf@0.0.2
  - @tootallnate/npdm@0.0.2
  - @tootallnate/nso@0.0.2
  - @tootallnate/bfwar@0.0.2
  - @tootallnate/bfwav@0.0.2
  - @tootallnate/bntx@0.0.2
  - @tootallnate/brotli-wasm@0.1.0
  - @tootallnate/dsp-adpcm@0.0.2
  - @tootallnate/fmod-bank@0.0.2
  - @tootallnate/fsb5@0.0.2
  - @tootallnate/iostore@0.0.2
  - @tootallnate/unity-asset@0.1.0
  - @tootallnate/usm@0.1.0
  - @tootallnate/wem-vorbis@0.0.2
  - @tootallnate/wem@0.0.2
  - @tootallnate/wwise-pck@0.0.2
  - @tootallnate/wwise-bnk@0.0.2
  - @tootallnate/yaz0@0.0.2
  - @tootallnate/sarc@0.0.2
  - @tootallnate/zstd-wasm@0.0.2
  - @tootallnate/xci@0.0.2
  - @tootallnate/ff8-fs@0.0.2
  - @tootallnate/phyre@0.0.2
  - @tootallnate/square-wd@0.0.2
