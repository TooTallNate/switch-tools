/**
 * Raw tile / texture graphics explorer (YY-CHR / Texture64 style).
 *
 * Retro console ROMs have no asset index — graphics are just bytes
 * at unknowable offsets. The classic exploration tool renders an
 * arbitrary window of the file as tiles (or as a linear image for
 * N64-style texture formats) and lets the user scrub the offset,
 * pixel format, width, and palette until pictures appear.
 *
 * Supported pixel formats:
 *
 *   Tiled (8×8 tiles, planar/packed per platform):
 *     • nes-2bpp   — 16 B/tile; plane 0 = bytes 0–7, plane 1 = 8–15
 *     • gb-2bpp    — 16 B/tile; per-row interleaved plane pairs
 *     • snes-2bpp  — identical layout to gb-2bpp
 *     • snes-3bpp  — 24 B/tile; planes 0/1 row-interleaved in bytes
 *                    0–15, plane 2 packed one byte per row at 16–23
 *                    (the format Super Mario World uses for most of
 *                    its graphics)
 *     • snes-4bpp  — 32 B/tile; row-interleaved planes 0/1 + 2/3
 *     • snes-8bpp  — 64 B/tile; planes 0–7
 *     • gba-4bpp   — 32 B/tile; packed linear, low nibble first
 *     • gba-8bpp   — 64 B/tile; packed linear, 1 byte/pixel
 *
 *   Linear (raster rows, adjustable width):
 *     • n64-rgba16 — RGBA 5551 big-endian
 *     • n64-rgba32 — RGBA 8888
 *     • n64-ia8    — intensity/alpha 4/4
 *     • n64-ia4    — intensity/alpha 3/1, 2 px per byte
 *     • n64-i8 / n64-i4 — intensity only
 *     • n64-ci8 / n64-ci4 — palette-indexed; rendered as gray
 *       index values (the palette lives elsewhere in the ROM)
 *     • linear-8bpp — plain 1 byte/pixel grayscale
 *
 * Expect garbage outside actual graphics regions (and everywhere on
 * games that compress their tiles) — that's inherent to the
 * platforms, not a bug. Three affordances make the needle-hunting
 * practical:
 *
 *   • An entropy minimap over the whole file: padding renders dark,
 *     structured data (graphics, tables) mid-tone, and
 *     compressed/random data hot — click to seek. Graphics almost
 *     always live in the structured mid-tones.
 *   • Real palettes read from the ROM itself: consoles store
 *     palettes as BGR555 (SNES/GBA), RGBA5551 TLUTs (N64), or NES
 *     master-palette indices, and a heuristic scanner finds
 *     candidate palette blocks to cycle through. Correct colors
 *     make sprites recognizable where grayscale looks like mush.
 *   • ±1-byte nudge: tile data misaligned by a single byte looks
 *     like pure noise, so fine alignment control matters.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { Node } from "~/lib/archive"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { formatBytes } from "~/lib/utils"

export type TileFormat =
  | "nes-2bpp"
  | "gb-2bpp"
  | "snes-2bpp"
  | "snes-3bpp"
  | "snes-4bpp"
  | "snes-8bpp"
  | "gba-4bpp"
  | "gba-8bpp"
  | "n64-rgba16"
  | "n64-rgba32"
  | "n64-ia8"
  | "n64-ia4"
  | "n64-i8"
  | "n64-i4"
  | "n64-ci8"
  | "n64-ci4"
  | "linear-8bpp"

interface FormatDesc {
  label: string
  kind: "tiled" | "linear"
  /** Tiled: bytes per 8×8 tile. */
  bytesPerTile?: number
  /** Tiled: bits per pixel (palette size = 2^bpp). */
  bpp?: number
  /** Linear: bytes per pixel (0.5 for 4-bit formats). */
  bytesPerPixel?: number
}

const FORMATS: Record<TileFormat, FormatDesc> = {
  "nes-2bpp": { label: "NES 2bpp planar", kind: "tiled", bytesPerTile: 16, bpp: 2 },
  "gb-2bpp": { label: "GB 2bpp interleaved", kind: "tiled", bytesPerTile: 16, bpp: 2 },
  "snes-2bpp": { label: "SNES 2bpp", kind: "tiled", bytesPerTile: 16, bpp: 2 },
  "snes-3bpp": { label: "SNES 3bpp planar", kind: "tiled", bytesPerTile: 24, bpp: 3 },
  "snes-4bpp": { label: "SNES 4bpp planar", kind: "tiled", bytesPerTile: 32, bpp: 4 },
  "snes-8bpp": { label: "SNES 8bpp planar", kind: "tiled", bytesPerTile: 64, bpp: 8 },
  "gba-4bpp": { label: "GBA 4bpp linear", kind: "tiled", bytesPerTile: 32, bpp: 4 },
  "gba-8bpp": { label: "GBA 8bpp linear", kind: "tiled", bytesPerTile: 64, bpp: 8 },
  "n64-rgba16": { label: "N64 RGBA16 (5551)", kind: "linear", bytesPerPixel: 2 },
  "n64-rgba32": { label: "N64 RGBA32", kind: "linear", bytesPerPixel: 4 },
  "n64-ia8": { label: "N64 IA8 (4/4)", kind: "linear", bytesPerPixel: 1 },
  "n64-ia4": { label: "N64 IA4 (3/1)", kind: "linear", bytesPerPixel: 0.5 },
  "n64-i8": { label: "N64 I8", kind: "linear", bytesPerPixel: 1 },
  "n64-i4": { label: "N64 I4", kind: "linear", bytesPerPixel: 0.5 },
  "n64-ci8": { label: "N64 CI8 (index as gray)", kind: "linear", bytesPerPixel: 1 },
  "n64-ci4": { label: "N64 CI4 (index as gray)", kind: "linear", bytesPerPixel: 0.5 },
  "linear-8bpp": { label: "Linear 8bpp grayscale", kind: "linear", bytesPerPixel: 1 },
}

type PaletteId = "gray" | "gb-green" | "vivid" | "rom" | "supplied"

const PALETTE_LABELS: Record<PaletteId, string> = {
  gray: "Grayscale",
  "gb-green": "GB green",
  vivid: "Vivid",
  rom: "From ROM…",
  supplied: "Game palettes",
}

/**
 * Palettes handed to the viewer by the caller, sourced from
 * somewhere other than the bytes being viewed. Decompressed
 * graphics carry no palette of their own — the real colors live
 * back in the ROM — so e.g. the SMW node reads the game's palette
 * block at tree-build time and passes it down here.
 */
export interface SuppliedPalettes {
  /** Human label for the group, e.g. "SMW palettes". */
  label: string
  /** Each entry is a list of RGB triples. */
  palettes: number[][][]
  /** Index selected by default. */
  defaultIndex?: number
}

/**
 * How a format's palette is stored in ROM data, if at all.
 *
 *   bgr555   — u16 LE, `0BBBBBGG GGGRRRRR` (SNES CGRAM, GBA PAL RAM)
 *   rgba5551 — u16 BE, `RRRRRGGG GGBBBBBA` (N64 TLUT)
 *   nes      — 1 byte per entry indexing the fixed 64-color 2C02
 *              master palette
 */
type RomPaletteKind = "bgr555" | "rgba5551" | "nes"

function romPaletteKind(format: TileFormat): RomPaletteKind | null {
  switch (format) {
    case "snes-2bpp":
    case "snes-4bpp":
    case "snes-8bpp":
    case "gba-4bpp":
    case "gba-8bpp":
      return "bgr555"
    case "n64-ci8":
    case "n64-ci4":
      return "rgba5551"
    case "nes-2bpp":
      return "nes"
    default:
      return null // gb-2bpp (palette is a register, not ROM data), RGB formats
  }
}

/**
 * The 64-color NES 2C02 master palette (NESdev wiki canonical
 * values). NES "palettes" in ROM are byte sequences indexing this.
 */
const NES_MASTER_PALETTE = [
  0x626262, 0x001fb2, 0x2404c8, 0x5200b2, 0x730076, 0x800024, 0x730b00, 0x522800,
  0x244400, 0x005700, 0x005c00, 0x005324, 0x003c76, 0x000000, 0x000000, 0x000000,
  0xababab, 0x0d57ff, 0x4b30ff, 0x8a13ff, 0xbc08d6, 0xd21269, 0xc72e00, 0x9d5400,
  0x607b00, 0x209800, 0x00a300, 0x009942, 0x007db4, 0x000000, 0x000000, 0x000000,
  0xffffff, 0x53aeff, 0x9085ff, 0xd365ff, 0xff57ff, 0xff5dcf, 0xff7757, 0xfa9e00,
  0xbdc700, 0x7ae700, 0x43f611, 0x26ef7e, 0x2cd5f6, 0x4e4e4e, 0x000000, 0x000000,
  0xffffff, 0xb6e1ff, 0xced1ff, 0xe9c3ff, 0xffbcff, 0xffbdf4, 0xffc6c3, 0xffd59a,
  0xe9e681, 0xcef481, 0xb6fb9a, 0xa9fac3, 0xa9f0f4, 0xb8b8b8, 0x000000, 0x000000,
]

/** Read a `count`-entry palette from ROM bytes at `offset`. */
function readRomPalette(
  bytes: Uint8Array,
  offset: number,
  count: number,
  kind: RomPaletteKind,
): number[][] {
  const out: number[][] = []
  for (let i = 0; i < count; i++) {
    if (kind === "nes") {
      const idx = (bytes[offset + i] ?? 0x0f) & 0x3f
      const rgb = NES_MASTER_PALETTE[idx]
      out.push([(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff])
      continue
    }
    const o = offset + i * 2
    const b0 = bytes[o] ?? 0
    const b1 = bytes[o + 1] ?? 0
    if (kind === "bgr555") {
      const v = b0 | (b1 << 8) // little-endian
      const r = v & 31
      const g = (v >> 5) & 31
      const b = (v >> 10) & 31
      out.push([(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)])
    } else {
      const v = (b0 << 8) | b1 // big-endian RGBA5551
      const r = (v >> 11) & 31
      const g = (v >> 6) & 31
      const b = (v >> 1) & 31
      out.push([(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)])
    }
  }
  return out
}

/**
 * Heuristic scan for candidate palette blocks.
 *
 * BGR555: 16 consecutive u16 LE values with the unused top bit
 * clear and ≥ 10 distinct colors. Random data clears 16 top bits
 * with probability 2^-16, so this alone is highly selective.
 *
 * RGBA5551: 16 consecutive u16 BE values where ≥ 12 have the alpha
 * bit set (TLUT entries are overwhelmingly opaque) and ≥ 10 are
 * distinct.
 *
 * NES: 4+ consecutive bytes all ≤ 0x3F is far too weak a signal to
 * scan for — manual offset entry only.
 */
function scanPalettes(bytes: Uint8Array, kind: RomPaletteKind): number[] {
  if (kind === "nes") return []
  const out: number[] = []
  const N = 16
  const limit = bytes.length - N * 2
  for (let o = 0; o + 4 <= limit; o += 4) {
    let ok = true
    let alphaSet = 0
    const seen = new Set<number>()
    for (let i = 0; i < N; i++) {
      const b0 = bytes[o + i * 2]
      const b1 = bytes[o + i * 2 + 1]
      if (kind === "bgr555") {
        if (b1 & 0x80) {
          ok = false
          break
        }
        seen.add(b0 | (b1 << 8))
      } else {
        const v = (b0 << 8) | b1
        if (v & 1) alphaSet++
        seen.add(v)
      }
    }
    if (!ok) continue
    if (kind === "rgba5551" && alphaSet < 12) continue
    if (seen.size < 10) continue
    out.push(o)
    if (out.length >= 2048) break
    o += N * 2 - 4 // skip past this palette (next loop step adds 4)
  }
  return out
}

/** DMG LCD shades, darkest first (index 3..0 in GB convention is
 * inverted per-game via BGP — we just pick the classic ramp). */
const GB_GREEN = [
  [0x9b, 0xbc, 0x0f],
  [0x8b, 0xac, 0x0f],
  [0x30, 0x62, 0x30],
  [0x0f, 0x38, 0x0f],
]

/** Build an RGB palette (2^bpp entries) for an indexed tile format. */
function buildPalette(bpp: number, id: PaletteId): number[][] {
  const n = 1 << bpp
  if (id === "gb-green" && n === 4) return GB_GREEN
  if (id === "vivid") {
    // Index 0 stays black (usually "transparent"), the rest walk
    // the hue wheel so adjacent indices are visually distinct.
    const out: number[][] = [[0, 0, 0]]
    for (let i = 1; i < n; i++) {
      const h = ((i - 1) * 360) / (n - 1)
      out.push(hslToRgb(h, 0.85, 0.55))
    }
    return out
  }
  // Grayscale ramp.
  const out: number[][] = []
  for (let i = 0; i < n; i++) {
    const v = Math.round((i * 255) / (n - 1))
    out.push([v, v, v])
  }
  return out
}

function hslToRgb(h: number, s: number, l: number): number[] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ]
}

/** Extract the palette index of pixel (x, y) inside one tile. */
function tilePixel(
  bytes: Uint8Array,
  tileOffset: number,
  x: number,
  y: number,
  format: TileFormat,
): number {
  const b = (i: number) => bytes[tileOffset + i] ?? 0
  switch (format) {
    case "nes-2bpp": {
      const p0 = (b(y) >> (7 - x)) & 1
      const p1 = (b(8 + y) >> (7 - x)) & 1
      return p0 | (p1 << 1)
    }
    case "gb-2bpp":
    case "snes-2bpp": {
      const p0 = (b(2 * y) >> (7 - x)) & 1
      const p1 = (b(2 * y + 1) >> (7 - x)) & 1
      return p0 | (p1 << 1)
    }
    case "snes-3bpp": {
      // Planes 0/1 row-interleaved (bytes 0-15), plane 2 packed one
      // byte per row (bytes 16-23).
      const p0 = (b(2 * y) >> (7 - x)) & 1
      const p1 = (b(2 * y + 1) >> (7 - x)) & 1
      const p2 = (b(16 + y) >> (7 - x)) & 1
      return p0 | (p1 << 1) | (p2 << 2)
    }
    case "snes-4bpp": {
      const p0 = (b(2 * y) >> (7 - x)) & 1
      const p1 = (b(2 * y + 1) >> (7 - x)) & 1
      const p2 = (b(16 + 2 * y) >> (7 - x)) & 1
      const p3 = (b(16 + 2 * y + 1) >> (7 - x)) & 1
      return p0 | (p1 << 1) | (p2 << 2) | (p3 << 3)
    }
    case "snes-8bpp": {
      let px = 0
      for (let plane = 0; plane < 8; plane++) {
        const base = (plane >> 1) * 16 + (plane & 1)
        px |= ((b(base + 2 * y) >> (7 - x)) & 1) << plane
      }
      return px
    }
    case "gba-4bpp": {
      const byte = b(y * 4 + (x >> 1))
      return x & 1 ? byte >> 4 : byte & 0xf
    }
    case "gba-8bpp":
      return b(y * 8 + x)
    default:
      return 0
  }
}

/**
 * SNES 8bpp planar note: planes are stored as four row-interleaved
 * pairs (0/1 at +0, 2/3 at +16, 4/5 at +32, 6/7 at +48) — the
 * `(plane >> 1) * 16 + (plane & 1)` addressing above encodes that.
 */

/**
 * Decode a linear-format pixel at index `i` (in pixels). Returns
 * RGBA. `pal` supplies colors for the CI (palette-indexed) formats;
 * without it, indices render as grayscale.
 */
function linearPixel(
  bytes: Uint8Array,
  byteBase: number,
  i: number,
  format: TileFormat,
  pal?: number[][],
): [number, number, number, number] {
  const b = (o: number) => bytes[byteBase + o] ?? 0
  switch (format) {
    case "n64-rgba16": {
      const v = (b(i * 2) << 8) | b(i * 2 + 1)
      const r = (v >> 11) & 31
      const g = (v >> 6) & 31
      const bb = (v >> 1) & 31
      return [
        (r << 3) | (r >> 2),
        (g << 3) | (g >> 2),
        (bb << 3) | (bb >> 2),
        (v & 1) * 255,
      ]
    }
    case "n64-rgba32":
      return [b(i * 4), b(i * 4 + 1), b(i * 4 + 2), b(i * 4 + 3)]
    case "n64-ia8": {
      const v = b(i)
      const int = (v >> 4) * 17
      return [int, int, int, (v & 0xf) * 17]
    }
    case "n64-ia4": {
      const byte = b(i >> 1)
      const n = i & 1 ? byte & 0xf : byte >> 4
      const int = Math.round((((n >> 1) & 7) * 255) / 7)
      return [int, int, int, (n & 1) * 255]
    }
    case "n64-ci8": {
      const idx = b(i)
      const c = pal?.[idx]
      if (c) return [c[0], c[1], c[2], 255]
      return [idx, idx, idx, 255]
    }
    case "n64-ci4": {
      const byte = b(i >> 1)
      const idx = i & 1 ? byte & 0xf : byte >> 4
      const c = pal?.[idx]
      if (c) return [c[0], c[1], c[2], 255]
      const v = idx * 17
      return [v, v, v, 255]
    }
    case "n64-i8":
    case "linear-8bpp": {
      const v = b(i)
      return [v, v, v, 255]
    }
    case "n64-i4": {
      const byte = b(i >> 1)
      const n = i & 1 ? byte & 0xf : byte >> 4
      const v = n * 17
      return [v, v, v, 255]
    }
    default:
      return [0, 0, 0, 255]
  }
}

/** Rows of tiles (tiled) / pixel rows (linear) rendered per page. */
const TILED_PAGE_ROWS = 32
const LINEAR_PAGE_ROWS = 256

export function TileViewer({
  getBlob,
  defaultFormat = "nes-2bpp",
  supplied,
  className,
}: {
  getBlob: () => Promise<Blob>
  defaultFormat?: TileFormat
  supplied?: SuppliedPalettes
  className?: string
}) {
  const { loading, data: bytes, error } = useAsync(async () => {
    return new Uint8Array(await (await getBlob()).arrayBuffer())
  }, [])
  const [format, setFormat] = useState<TileFormat>(defaultFormat)
  const [palette, setPalette] = useState<PaletteId>(
    supplied ? "supplied" : "gray",
  )
  const [suppliedIndex, setSuppliedIndex] = useState(
    supplied?.defaultIndex ?? 0,
  )
  const [offset, setOffset] = useState(0)
  const [offsetText, setOffsetText] = useState("0x0")
  /** Tiled: tiles per row. Linear: width in pixels. */
  const [width, setWidth] = useState<number>(
    FORMATS[defaultFormat].kind === "tiled" ? 16 : 64,
  )
  const [scale, setScale] = useState(3)
  /** ROM-palette state (used when `palette === 'rom'`). */
  const [palOffset, setPalOffset] = useState(0)
  const [palOffsetText, setPalOffsetText] = useState("0x0")
  const [palCandidates, setPalCandidates] = useState<number[] | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const entropyRef = useRef<HTMLCanvasElement>(null)

  const desc = FORMATS[format]
  const palKind = romPaletteKind(format)

  // Bytes covered by one rendered page (also the page-step size).
  const pageBytes = useMemo(() => {
    if (desc.kind === "tiled") {
      return desc.bytesPerTile! * width * TILED_PAGE_ROWS
    }
    return Math.ceil(desc.bytesPerPixel! * width * LINEAR_PAGE_ROWS)
  }, [desc, width])

  // Per-bucket Shannon entropy over the whole file, for the minimap.
  const entropyMap = useMemo(() => {
    if (!bytes || bytes.length === 0) return null
    const buckets = Math.min(512, bytes.length)
    const bucketSize = Math.ceil(bytes.length / buckets)
    const entropies = new Float32Array(Math.ceil(bytes.length / bucketSize))
    const hist = new Uint32Array(256)
    for (let b = 0; b < entropies.length; b++) {
      hist.fill(0)
      const start = b * bucketSize
      const end = Math.min(bytes.length, start + bucketSize)
      for (let i = start; i < end; i++) hist[bytes[i]]++
      const n = end - start
      let h = 0
      for (let k = 0; k < 256; k++) {
        if (hist[k]) {
          const p = hist[k] / n
          h -= p * Math.log2(p)
        }
      }
      entropies[b] = h
    }
    return { entropies, bucketSize }
  }, [bytes])

  // Step for fine scrubbing: one row of tiles / 16 pixel rows.
  const rowBytes = useMemo(() => {
    if (desc.kind === "tiled") return desc.bytesPerTile! * width
    return Math.ceil(desc.bytesPerPixel! * width * 16)
  }, [desc, width])

  const setOffsetClamped = (v: number) => {
    const max = bytes ? Math.max(0, bytes.length - 1) : 0
    const clamped = Math.max(0, Math.min(max, v))
    setOffset(clamped)
    setOffsetText("0x" + clamped.toString(16).toUpperCase())
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bytes) return
    let w: number
    let h: number
    if (desc.kind === "tiled") {
      w = width * 8
      h = TILED_PAGE_ROWS * 8
    } else {
      w = width
      h = LINEAR_PAGE_ROWS
    }
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const img = ctx.createImageData(w, h)
    const rgba = img.data
    // Resolve the active palette. "Game palettes" come from the
    // caller (read out of the parent ROM); "From ROM" reads console
    // palette data out of the bytes being viewed; otherwise a
    // synthetic ramp.
    const useRomPal = palette === "rom" && palKind !== null
    const suppliedPal =
      palette === "supplied" ? supplied?.palettes[suppliedIndex] : undefined
    if (desc.kind === "tiled") {
      const count = 1 << desc.bpp!
      const pal = suppliedPal
        ? suppliedPal
        : useRomPal
          ? readRomPalette(bytes, palOffset, count, palKind!)
          : buildPalette(desc.bpp!, palette === "rom" ? "gray" : palette)
      const bpt = desc.bytesPerTile!
      for (let ty = 0; ty < TILED_PAGE_ROWS; ty++) {
        for (let tx = 0; tx < width; tx++) {
          const tileOffset = offset + (ty * width + tx) * bpt
          if (tileOffset >= bytes.length) continue
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              const px = tilePixel(bytes, tileOffset, x, y, format)
              const c = pal[px] ?? [255, 0, 255]
              const di = ((ty * 8 + y) * w + tx * 8 + x) * 4
              rgba[di] = c[0]
              rgba[di + 1] = c[1]
              rgba[di + 2] = c[2]
              rgba[di + 3] = 255
            }
          }
        }
      }
    } else {
      const ciCount = format === "n64-ci8" ? 256 : 16
      const pal = suppliedPal
        ? suppliedPal
        : useRomPal
          ? readRomPalette(bytes, palOffset, ciCount, palKind!)
          : undefined
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const [r, g, b, a] = linearPixel(
            bytes,
            offset,
            y * w + x,
            format,
            pal,
          )
          const di = (y * w + x) * 4
          rgba[di] = r
          rgba[di + 1] = g
          rgba[di + 2] = b
          rgba[di + 3] = a
        }
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [
    bytes,
    offset,
    format,
    palette,
    width,
    desc,
    palKind,
    palOffset,
    supplied,
    suppliedIndex,
  ])

  // Entropy minimap: dark = padding, mid greens = structured data
  // (graphics usually live here), hot orange = compressed/random.
  useEffect(() => {
    const canvas = entropyRef.current
    if (!canvas || !bytes || !entropyMap) return
    const { entropies } = entropyMap
    const w = entropies.length
    const h = 14
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const img = ctx.createImageData(w, h)
    const d = img.data
    for (let x = 0; x < w; x++) {
      const H = entropies[x]
      let r: number
      let g: number
      let b: number
      if (H >= 7.4) {
        // compressed / encrypted / random
        r = 235
        g = 120
        b = 40
      } else {
        // 0 (empty) → dark, mid → green
        const t = H / 7.4
        r = Math.round(18 + 30 * t)
        g = Math.round(18 + 170 * t)
        b = Math.round(22 + 90 * t)
      }
      for (let y = 0; y < h; y++) {
        const di = (y * w + x) * 4
        d[di] = r
        d[di + 1] = g
        d[di + 2] = b
        d[di + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    // Current-position marker.
    const mx = Math.min(
      w - 1,
      Math.floor(offset / entropyMap.bucketSize),
    )
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(mx, 0, Math.max(1, w / 200), h)
  }, [bytes, entropyMap, offset])

  if (loading) return <LoadingFiller label="Loading bytes…" />
  if (error) return <ErrorFiller error={error} />
  if (!bytes) return null

  const isTiled = desc.kind === "tiled"
  const selectCls =
    "h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"

  return (
    <div className={"flex min-h-0 flex-col gap-2 " + (className ?? "")}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className={selectCls}
          value={format}
          onChange={(e) => {
            const f = e.target.value as TileFormat
            setFormat(f)
            const k = FORMATS[f].kind
            if (k !== desc.kind) setWidth(k === "tiled" ? 16 : 64)
            // Palette candidates are encoding-specific; a format
            // switch can change the encoding (BGR555 ↔ RGBA5551).
            if (romPaletteKind(f) !== palKind) setPalCandidates(null)
            if (palette === "rom" && romPaletteKind(f) === null) {
              setPalette("gray")
            }
          }}
        >
          {(Object.keys(FORMATS) as TileFormat[]).map((f) => (
            <option key={f} value={f}>
              {FORMATS[f].label}
            </option>
          ))}
        </select>
        {(isTiled || palKind !== null || supplied) && (
          <select
            className={selectCls}
            value={palette}
            onChange={(e) => setPalette(e.target.value as PaletteId)}
          >
            {(Object.keys(PALETTE_LABELS) as PaletteId[])
              .filter((p) => {
                // "Game palettes" only when the caller supplied
                // some; "From ROM" only for formats with a known
                // ROM palette encoding; synthetic ramps only for
                // tiled (linear CI formats render indices as gray).
                if (p === "supplied") return supplied !== undefined
                if (p === "rom") return palKind !== null
                if (!isTiled) return p === "gray"
                return true
              })
              .map((p) => (
                <option key={p} value={p}>
                  {p === "supplied" && supplied
                    ? supplied.label
                    : PALETTE_LABELS[p]}
                </option>
              ))}
          </select>
        )}
        {palette === "supplied" && supplied && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              onClick={() =>
                setSuppliedIndex(
                  (suppliedIndex + supplied.palettes.length - 1) %
                    supplied.palettes.length,
                )
              }
            >
              ‹
            </Button>
            <span className="w-16 text-center font-mono text-muted-foreground">
              {suppliedIndex + 1}/{supplied.palettes.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              onClick={() =>
                setSuppliedIndex((suppliedIndex + 1) % supplied.palettes.length)
              }
            >
              ›
            </Button>
            <div className="ml-1 flex overflow-hidden rounded-sm border">
              {supplied.palettes[suppliedIndex]
                ?.slice(0, 1 << (desc.bpp ?? 4))
                .map((c, i) => (
                  <div
                    key={i}
                    className="h-5 w-2.5"
                    style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }}
                  />
                ))}
            </div>
          </div>
        )}
        {palette === "rom" && palKind !== null && (
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Pal @</span>
            <Input
              className="h-8 w-24 font-mono text-xs"
              value={palOffsetText}
              onChange={(e) => setPalOffsetText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = parseInt(palOffsetText, 16)
                  if (!Number.isNaN(v)) setPalOffset(v)
                }
              }}
              onBlur={() => {
                const v = parseInt(palOffsetText, 16)
                if (!Number.isNaN(v)) setPalOffset(v)
              }}
            />
            {palKind !== "nes" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  title="Scan the file for candidate palette blocks"
                  onClick={() => {
                    const found =
                      palCandidates ?? scanPalettes(bytes, palKind)
                    setPalCandidates(found)
                    if (found.length > 0) {
                      // Jump to the candidate after the current
                      // offset (wrapping) so repeated clicks cycle.
                      const next =
                        found.find((o) => o > palOffset) ?? found[0]
                      setPalOffset(next)
                      setPalOffsetText(
                        "0x" + next.toString(16).toUpperCase(),
                      )
                    }
                  }}
                >
                  {palCandidates
                    ? `Next (${
                        palCandidates.length
                      }${palCandidates.length >= 2048 ? "+" : ""})`
                    : "Scan"}
                </Button>
                {palCandidates && palCandidates.length === 0 && (
                  <span className="text-muted-foreground">none found</span>
                )}
              </>
            )}
          </div>
        )}
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">
            {isTiled ? "Tiles/row" : "Width"}
          </span>
          <select
            className={selectCls}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          >
            {(isTiled
              ? [8, 16, 32, 64]
              : [16, 32, 64, 128, 256, 320, 512]
            ).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">Zoom</span>
          <select
            className={selectCls}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 6, 8].map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => setOffsetClamped(offset - pageBytes)}
        >
          ⏮ Page
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => setOffsetClamped(offset - rowBytes)}
        >
          − Row
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          title="Nudge one byte back — tile data misaligned by a single byte looks like noise"
          onClick={() => setOffsetClamped(offset - 1)}
        >
          −1
        </Button>
        <Input
          className="h-8 w-28 font-mono text-xs"
          value={offsetText}
          onChange={(e) => setOffsetText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = parseInt(offsetText, 16)
              if (!Number.isNaN(v)) setOffsetClamped(v)
            }
          }}
          onBlur={() => {
            const v = parseInt(offsetText, 16)
            if (!Number.isNaN(v)) setOffsetClamped(v)
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          title="Nudge one byte forward"
          onClick={() => setOffsetClamped(offset + 1)}
        >
          +1
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => setOffsetClamped(offset + rowBytes)}
        >
          + Row
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => setOffsetClamped(offset + pageBytes)}
        >
          Page ⏭
        </Button>
        <span className="text-muted-foreground">
          of {formatBytes(bytes.length)}
        </span>
      </div>
      <canvas
        ref={entropyRef}
        className="h-3.5 w-full cursor-pointer rounded-sm"
        style={{ imageRendering: "pixelated" }}
        title="Entropy map — dark: padding · green: structured data (graphics live here) · orange: compressed/random. Click to seek."
        onClick={(e) => {
          if (!entropyMap) return
          const rect = e.currentTarget.getBoundingClientRect()
          const frac = (e.clientX - rect.left) / rect.width
          const bucket = Math.floor(frac * entropyMap.entropies.length)
          setOffsetClamped(bucket * entropyMap.bucketSize)
        }}
      />
      <input
        type="range"
        min={0}
        max={Math.max(0, bytes.length - 1)}
        step={rowBytes}
        value={offset}
        onChange={(e) => setOffsetClamped(Number(e.target.value))}
        className="w-full"
      />
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-[repeating-conic-gradient(#80808022_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        <canvas
          ref={canvasRef}
          style={{
            imageRendering: "pixelated",
            width: `${(isTiled ? width * 8 : width) * scale}px`,
          }}
        />
      </div>
    </div>
  )
}

/**
 * Collapsible "Graphics explorer" section embedded in the ROM info
 * previews. Lazy: the file bytes aren't loaded until expanded.
 */
export function TileExplorerSection({
  node,
  defaultFormat,
  supplied,
}: {
  node: Node
  defaultFormat: TileFormat
  supplied?: SuppliedPalettes
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Graphics explorer
        </h3>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && (
        <div className="h-[480px]">
          <TileViewer
            getBlob={() => node.blob!()}
            defaultFormat={defaultFormat}
            supplied={supplied}
          />
        </div>
      )}
    </section>
  )
}

/**
 * Full-pane tile viewer for leaf nodes tagged with `meta.tileData`
 * (NES CHR-ROM, decompressed GBA / N64 blocks).
 */
export function TileViewerPreview({ node }: { node: Node }) {
  const defaultFormat = (node.meta?.tileData as TileFormat) ?? "nes-2bpp"
  // Nodes produced by a game-specific extractor (e.g. SMW GFX
  // files) carry the game's real palettes, read from the ROM at
  // tree-build time — decompressed graphics have none of their own.
  const supplied = node.meta?.palettes as SuppliedPalettes | undefined
  return (
    <div className="h-full p-4">
      <TileViewer
        getBlob={() => node.blob!()}
        defaultFormat={defaultFormat}
        supplied={supplied}
        className="h-full"
      />
    </div>
  )
}
