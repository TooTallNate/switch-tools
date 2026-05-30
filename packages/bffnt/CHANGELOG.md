# @tootallnate/bffnt

## 0.0.2

### Patch Changes

- 3014057: New parser + renderer package for **BFFNT** ("Cafe Font Format"),
  Nintendo's bitmap-font format used across Wii U and Switch first-
  party games. Unlike `@tootallnate/bfttf` — which deobfuscates a
  TrueType outline that the OS already knows how to render — BFFNT
  files are sprite-sheets of pre-rasterised glyphs, so this package
  both parses the container _and_ implements the full rasterisation
  pipeline.

  **Container parsing** (`parseBffnt(blob)`): reads the FFNT header,
  the FINF font-info section, the TGLP texture-glyph atlas, and the
  linked-list chains of CWDH (per-glyph metrics) and CMAP (Unicode
  → glyph-index) blocks. Both the v3 (3DS) `u16` and v4 (Wii U /
  Switch) `u32` codepoint encodings are handled, as are
  big-endian (Wii U) and little-endian (Switch) byte-order marks.

  **Atlas decoding** (`decodeBffnt(parsed)`): unwraps the embedded
  **BNTX** texture container that Switch BFFNTs put inside their
  TGLP `sheetData`, applies a Tegra X1 GOB block-linear deswizzle
  (direct port of `aboood40091/BNTX-Extractor/swizzle.py`), decodes
  the underlying texture format (BC4 / R8 / R4G4 / R8G8 / R8G8B8A8),
  and Y-flips the result so callers can address pixels in normal
  top-left-origin image coordinates. Switch font atlases are stored
  upside-down on disk — that's an OpenGL/NVN bottom-left-origin
  convention, not a bug in our pipeline.

  **Glyph rendering** (`renderText(font, text)`): walks the CMAP /
  CWDH chains to look up the right glyph index and per-glyph
  metrics for each character of the input string, then composites
  the corresponding atlas cells onto a freshly-allocated RGBA8
  buffer using straight alpha-over blending. Supports multi-line
  text (newlines force a hard break), missing-glyph fallback via
  the font's `alterCharIndex`, and surrogate-pair codepoints.

  Verified end-to-end against every BFFNT shipped in BotW —
  `Ancient_00.bffnt` (BC4 Sheikah glyphs, 32×1024), `Caption_00`,
  `Normal_00` (1024×1024 ×2 sheets, full Latin / Greek / Cyrillic /
  Katakana / CJK), `NormalS_00` (R4G4 anti-aliased drop-shadow
  variant), `Special_00` (ornate display font), `External_00`. Wired
  into `apps/nx-archive` as a structured preview that lets the user
  type custom sample text and see it rendered live in the actual
  font, alongside the full deswizzled atlas.

- 5330e53: New parser + decoder for **BNTX** ("Binary NinTeXture"), Nintendo's
  standard texture format on Switch / Wii U. BNTX shows up by the
  thousands in every NintendoWare-based game — Mario Kart 8 Deluxe
  alone ships ~3,300 of them, covering UI atlases, course textures,
  character albedos, normal maps, and effect sprites.

  Where the existing `@tootallnate/bffnt` package had a tiny inlined
  BNTX parser that only knew the four formats Switch fonts use
  (BC4, R8, R8G8, R8G8B8A8), `@tootallnate/bntx` is the canonical
  home for BNTX support across the workspace. It implements:

  - **Container parsing** (`parseBntx(bytes)`): walks the BNTX
    header, every BRTI texture-info block, and the per-texture
    string-dictionary entry. Returns each texture's name, format,
    dimensions, mip count, array length, GOB block-height
    exponent, and absolute mip-0 offset.

  - **Format decoding** (`decodeBntxLayer(bytes, tex, layer)`):
    combines Tegra X1 GOB block-linear deswizzle with the right
    format decoder for the texture's pixel format. Output is row-
    major RGBA8 ready for `<canvas>` / `Image`.

    Supported formats: BC1 / BC2 / BC3 (DXT1/3/5), BC4 (single
    channel), BC5 (normal-map dual-channel with auto-Z-reconstruction),
    BC7 (modern high-quality, full 8-mode decoder), plus the
    uncompressed lineup: R8, R8G8, R4G4, R5G6B5, B5G6R5, R4G4B4A4,
    R5G5B5A1, RGBA8 (UNORM/SRGB), and BGRA8 (UNORM/SRGB).

    ASTC and BC6 (HDR-float) formats are not yet supported and
    surface a clear error.

  The BC7 decoder is implemented from scratch against the Microsoft
  DXT/BPTC spec — all 8 modes, P-bit handling, partition tables,
  anchor-index swapping, component rotation. Not the fastest BC7
  decoder around, but tested against real Pokémon Legends Arceus
  and Mario Kart 8 Deluxe textures with bit-accurate output.

  Wired into `apps/nx-archive` as a structured image preview that
  renders the decoded RGBA8 to an offscreen `<canvas>`, encodes a
  PNG via `toBlob()`, and exposes a "Save .png" link. Transparent
  regions render against a checkerboard background so alpha is
  visually obvious. Also surfaces the parsed metadata (texture
  name, format, dimensions, mip count, sRGB flag, container
  endian / target / texture count) in a sidebar table.

  Verified end-to-end against representative samples from BotW /
  MK8D / Pokémon Legends Arceus — BC1 SRGB Wuhu Town award
  backgrounds, BC3 SRGB course-map decals, BC4 UNORM single-
  channel masks, BC5 UNORM normal maps with reconstructed Z,
  BC7 SRGB item albedos, plus uncompressed RGBA8 box icons.
