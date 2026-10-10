# AGENTS.md

Orientation for agents working in this repo. Read this first, then the
doc comment at the top of whichever file you're changing — most modules
explain their format / design in detail there.

## What we're building

A pnpm + Turborepo monorepo of small TypeScript packages that parse game
and console file formats, plus a few apps that use them. The flagship is
**`apps/nx-archive`**: a fully client-side web app (Vite + React + Three.js)
that opens game dumps and shows what's inside. Nothing is uploaded;
everything is decoded in the browser.

nx-archive has two views over the same file tree:

- **Files**: the container tree (NSP → NCA → RomFS → SARC → …), with a
  preview for every format we understand (images, audio, video, fonts,
  text, 3D models, layouts, hex fallback).
- **Library** (default): a flat, platform-agnostic media catalogue of 3D
  models, music, sound effects, videos, fonts and images. It has
  thumbnails, a detail panel, batch export, and a **Gaps report** that
  lists everything we couldn't decode as a to-do list.

3D models also export for **3D printing**: STL, a painted 3MF for
OrcaSlicer/Bambu, or a Snapmaker U1 "Full Spectrum" 3MF. On the way out
they get print scale, mesh repair, smoothing and structural supports.

Platforms covered today include:

- **Switch:** NSP, XCI, NCA, NCZ, RomFS, SARC, BFRES, BNTX, Game Freak formats.
- **Nintendo, older:** GameCube / Wii (GCM, RVZ), N64, NES, SNES, GB, GBA.
- **PlayStation:** PBP (including encrypted PS1 Classics), raw BIN, ISO 9660,
  STR video, XA audio, TIM images, FF7 PSX models.
- **Xbox:** XISO, and Halo CE cache files.
- **PC FF7 / FF8:** LGP and friends.
- **Engines:** Unity bundles and Unreal PAKs.

The direction of travel: *open any game, see all of its media,
uniformly.* New work is usually driven by a Gaps report on a real game.

## Principles

- **Format logic lives in `packages/<format>`**: one package per format
  (family), with a narrow API, no app dependencies, and tests built from
  **synthetic fixtures**. Never commit game data or copyrighted assets.
  The app (`apps/nx-archive/src/lib/*`) only wires packages into the node
  tree, previews and the library.
- **Verify on real files**, not just unit tests. Use the headless scan
  CLI and the browser harness (below). Look at decoded output (render
  frames or textures to PNG and view them) before declaring victory.
- **Lazy, streaming, bounded**: game files are multi-GB. Children load on
  demand, sectors and blocks are read on demand, large decoded state
  goes in small LRUs (see `halo.ts`), and slow passes get time budgets
  (see the duplicate folding in `scanner.ts`).
- **Prefer documented sources.** Port from reference implementations
  (FFmpeg in `packages/ffmpeg-wasm/build/ffmpeg`, Q-Gears,
  q-gears_reverse, psxtract, Invader, UEViewer, …) and cite them in the
  module's doc comment.

## Repo layout

```
packages/<format>/        src/index.ts (+ modules), test/*.test.ts, tsconfig, package.json
apps/nx-archive/
  src/lib/archive.ts      Node tree: Node type, CONTAINER_FORMATS registry, sniffMagicCheap,
                          childNodeFor (nested dispatch), buildRootNode (top-level dispatch)
  src/lib/preview.ts      PreviewKind union, previewKindForNode / detectPreviewKind
  src/components/preview-pane.tsx   FilePreview switch: preview kind → component (very large file)
  src/components/mesh-viewer.tsx    shared Three.js viewer (RenderableMesh, animation drivers)
  src/lib/media/          library: scanner (walk + classify + dedupe), classify (kind sets),
                          thumbnails, model-assets (headless model loaders), gaps, batch-export
  src/lib/model-export.ts           print pipeline: scale → decals → supports → repair → STL/3MF
  src/lib/mesh-export*.ts, mesh-repair.ts, mesh-supports.ts, full-spectrum.ts
  src/lib/<platform>.ts   platform glue, e.g. halo.ts, psx.ts, ff7-psx.ts, mk64-karts.ts
  scripts/media-scan.ts   headless library scan + gaps report (Bun)
  test/*.test.ts          app tests (dispatch, library, export, …)
```

## Core concepts (nx-archive)

- **`Node`** (`archive.ts`) has `{ id, name, kind, isContainer, size?, format?, meta?, blob?(), getChildren?() }`.
  - IDs are `/`-joined paths from the root.
  - Containers expand lazily.
  - **Virtual leaves** are common: decoded outputs presented as files, like
    `.png` from Halo bitmaps or `.wav` per XA channel. Their `blob()` decodes
    on demand.
- **Dispatch.** A container format is a `CONTAINER_FORMATS` entry (extension
  and/or sniff key). `sniffMagicCheap` maps leading bytes to a sniff key, and
  `FILE_EXT_FORMATS` aliases the sniff key to its label; `test/dispatch.test.ts`
  checks that these stay consistent. Use sniff-only entries for ambiguous
  extensions (`.map`, `.bin`).
- **Previews.**
  - **Leaves** pick a `PreviewKind` through `previewKindForNode`:
    `meta` flags first, then the file name.
  - **Components:** add a `case` to `FilePreview` in `preview-pane.tsx`.
  - **Containers** with a landing page are matched by `node.kind` in `PreviewContent`.
- **Library.**
  - **Classification:** `classifyNode` maps a preview kind to a media kind
    through the `*_KINDS` sets in `classify.ts`.
  - **Model thumbnails and batch export** need a headless loader: add the kind to
    `HEADLESS_MODEL_KINDS` and a `case` in `loadModelAsset` (`model-assets.ts`).
  - **Image thumbnails:** add a `decodeImage` case in `thumbnails.ts`.
- **Duplicates.** The scanner folds identical copies; the kept item lists the
  others in `MediaItem.duplicates`. Virtual leaves that are expensive to
  decode must set `meta.contentKey` (a cheap stable identity) or
  `meta.decoded: true` (never hashed).
- **Blob facades.** `SectorFileBlob` (psx.ts) and `LazyDecompressBlob` read on
  demand, but browser APIs can't see their bytes. Hand
  `materialize()`d, real Blobs to `URL.createObjectURL` and `new Blob([...])`.
- **3D.**
  - **Viewer meshes:** `RenderableMesh` / `RenderableMeshLOD`, with optional
    `skeleton` hints for supports. Textures are `DecodedTexture`; `flipY: false`
    means top-down pixels with V=0 at the top, and `decal: true` marks a
    painted-on overlay.
  - **Animation:** animation drivers mutate the mounted geometry each frame.
    Rigid formats re-pose on the CPU (see the FF7 PSX driver).
  - **Export:** exports bake to `ExportMesh` (materials, `decal`, `skeleton`).
  - **Video:** `bink-encode.ts` streams decoded frames to MP4 through WebCodecs
    and MediaSource; non-FFmpeg codecs plug in via `source: () => VideoFrameSource`
    (see `psx-str-source.ts`).

## Adding a format (checklist)

1. `packages/<name>`: copy `package.json` / `tsconfig.json` from a sibling
   (for example `packages/xiso`), write the parser, and add
   `test/<name>.test.ts` with synthetic data. `npx tsc -p . && npx vitest run`.
2. Add it as a `workspace:*` dependency of `apps/nx-archive`, then `pnpm install`.
3. Wire it: a container entry or `childNodeFor` case; a preview kind and
   component; classification; a headless loader or thumbnail case if it's media.
4. Run `bun scripts/media-scan.ts <file>` on a real file: check the counts,
   container errors and gaps.
5. Check it in the browser (harness below), including thumbnails and the
   preview.
6. Tests, type-check and build: `npx tsc --noEmit -p .`, `npx vitest run`,
   `npx vite build` in `apps/nx-archive`, plus the package tests.
7. Add a changeset in `.changeset/` per package and one for `nx-archive`.
   Commit packages separately from the app: `feat(<pkg>): …`, then
   `feat(nx-archive): …`.

## Verifying

- **Headless scan:** run `bun scripts/media-scan.ts <file> [--md out.md] [--json out.json] [--deep]`
  from `apps/nx-archive`.
  - It runs the same scanner as the Library and prints a summary line plus
    the gaps report.
  - Switch content needs keys at `~/.switch/prod.keys`.
  - Bun runs app modules directly, e.g. `bun -e 'await import("./src/lib/…")'`.
- **Browser:**
  - `npx vite --port 5199 --strictPort` in `apps/nx-archive`.
  - Drive it with Playwright (`playwright-core` + the system Chrome, headless,
    `--use-angle=swiftshader`).
  - Load files with `page.setInputFiles('#nx-archive-file-input', path)`.
  - The Switch keys go in `localStorage['nx-archive:prod.keys']`.
  - Use a **persistent profile** (`launchPersistentContext`) for multi-GB files:
    incognito contexts hit Chrome's in-memory Blob quota and later reads fail
    with `NotReadableError`.
- **Rendered checks:** for models, a tiny software rasterizer that writes
  PNGs is often quicker than the browser for iterating on parsing.

## Conventions

- **Style:** match the surrounding file. `src/lib/**` and packages use
  tabs and semicolons; most `src/components/**` files use 2 spaces and no
  semicolons.
- **Comments:** keep doc comments explanatory (what the format is, where
  facts came from). Never write `*/` inside a comment; a path like
  `ENEMY*/*.LZS` ends it.
- **Scratch work:** keep throwaway scripts out of the repo (use the system
  temp dir) or delete them before committing (`*.tmp.ts`, `.tmp-e2e/`).
- **Caches:** cached library indexes are keyed by `MEDIA_INDEX_VERSION`, and
  thumbnails by `THUMB_VERSION`. Bump them when classification or rendering
  changes.

## Gotchas we've already paid for

- **Chrome's `DecompressionStream`** rejects trailing bytes ("Junk found after
  end of compressed data") and drops the remaining output. Trim the padding,
  or stop once the known output size is reached (see `halo-map`).
- **Bun's file-backed streams** piped through `DecompressionStream` can stall
  near the end. Again, stop at the known size.
- **`fs.openAsBlob`** truncates files over 4 GiB on Node 26; use Bun for the CLI.
- **WebCodecs AAC** accepts odd sample rates (37 800 Hz XA audio) that MSE then
  can't play. Resample to 44.1 kHz.
- **PSX coordinates** are Y-down. Convert with (x, −y, −z), a rotation;
  negating only Y mirrors the model.
- **FF7 PSX skeletons:**
  - Field bones sit at their *own* length from the parent, battle bones at the
    *parent's* length.
  - Support/joint code picks whichever bone origin is nearest both pieces
    rather than assuming a convention.
- **Decals:** FF7 field faces are coplanar decals. The viewer uses
  `polygonOffset`; exports paint them onto the surface beneath
  (`splitDecals` + the painter's decal sampling).
- **Official PS1 Classics EBOOTs** are PGD-encrypted with LZRC-compressed
  blocks. The version key is recovered from the PGD MAC, so KEYS.BIN isn't
  required (`packages/pbp`).
- **Duplicate folding** must never decode virtual leaves just to hash them.
  Use `meta.contentKey` or `meta.decoded`; the pass also has a 20 s budget.
