/**
 * Previews for game data formats that have no media in them: config
 * and parameter files, physics, event scripts. Each one renders a
 * header table plus the decoded content as highlighted text.
 *
 *  - AAMP (Nintendo ParameterIO, BotW actor configuration) → YAML-like
 *    text, with name hashes resolved from the title's own executable
 *  - Havok packfiles (physics, navmesh, cloth, ragdoll) → SDK version,
 *    sections, object classes and stored names
 *  - VFXB particle effects (container landing page) → emitter sets and
 *    their emitters, plus the embedded resources
 *  - BotW terrain tiles → rendered height / material / grass / water map,
 *    and the TSCB scene table
 *  - BFEVFL event flowcharts and timelines
 *  - BotW engine tables: STAT and ecosystem maps (rendered), PrOD
 *    placements, RSTB, XLNK, hash lists, sound configs
 *  - GX2 and NVN textures (images), shader archives, Switch tickets
 *  - BotW engine files without a decoder: identified, with their strings
 *    and numbers
 */
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"

import { aampToText, parseAamp } from "@tootallnate/aamp"
import { parseHavok } from "@tootallnate/havok"
import { parseVfxb } from "@tootallnate/vfxb"
import { parseTscb, renderTerrainTile, terrainTileKind } from "@tootallnate/uking-terrain"
import { evflToText, parseEvfl } from "@tootallnate/evfl"
import {
  parseEco,
  parseProd,
  parseRstb,
  parseStat,
  parseXlnk,
  readSortedHashList,
  renderStat,
} from "@tootallnate/uking-data"
import { decodeGx2Surface, parseGx2 } from "@tootallnate/gx2"
import { decodeNvnTexture, parseNvnTexture } from "@tootallnate/nvn-texture"

import type { Node } from "~/lib/archive"
import { highlightCode } from "~/lib/highlight"
import { exefsStringsFor } from "~/lib/title-exefs"
import { ScrollArea } from "~/components/ui/scroll-area"

import {
  ErrorFiller,
  KvBlock,
  KvRow,
  LoadingFiller,
  SectionHeader,
  useAsync,
} from "./preview-pane"

/** Highlighting very large documents stalls the page; show plain text past this. */
const HIGHLIGHT_LIMIT = 400_000

async function nodeBytes(node: Node): Promise<Uint8Array> {
  return new Uint8Array(await (await node.blob!()).arrayBuffer())
}

export interface DataImage {
  label: string
  width: number
  height: number
  pixels: Uint8ClampedArray | Uint8Array
}

export interface DataTextView {
  title: string
  rows: [string, string][]
  text: string
  lang: "yaml" | "json" | "xml"
  /** Rendered maps / textures, shown above the text. */
  images?: DataImage[]
}

/** Header rows plus highlighted text: the shared shape of every data preview. */
export function DataTextPreview({ node, load, label }: {
  node: Node
  load: (node: Node) => Promise<DataTextView>
  label: string
}) {
  const { resolvedTheme } = useTheme()
  const { loading, data, error } = useAsync(() => load(node), [node.id])
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    setHtml(null)
    if (!data || data.text.length > HIGHLIGHT_LIMIT) return
    let cancelled = false
    highlightCode(data.text, data.lang, resolvedTheme === "dark" ? "dark" : "light")
      .then((h) => !cancelled && setHtml(h))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [data, resolvedTheme])
  if (loading) return <LoadingFiller label={label} />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title={v.title} />
        {v.rows.length > 0 && (
          <KvBlock title="Header">
            {v.rows.map(([k, val]) => (
              <KvRow key={k} k={k} v={val} />
            ))}
          </KvBlock>
        )}
        {v.images?.map((img) => (
          <figure key={img.label} className="flex flex-col gap-1">
            <img
              src={pixelsToDataUrl(img.width, img.height, img.pixels)}
              alt={img.label}
              className="w-full max-w-[640px] rounded-md border bg-[repeating-conic-gradient(#8882_0_25%,transparent_0_50%)] bg-[length:16px_16px]"
              style={{ imageRendering: img.width <= 256 ? "pixelated" : "auto" }}
            />
            <figcaption className="text-xs text-muted-foreground">
              {img.label} · {img.width} × {img.height}
            </figcaption>
          </figure>
        ))}
        {!v.text ? null : html ? (
          <div
            className="overflow-x-auto rounded-md border text-xs [&_pre]:p-3"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="overflow-x-auto rounded-md border p-3 text-xs">{v.text}</pre>
        )}
      </div>
    </ScrollArea>
  )
}

export async function loadAampView(node: Node): Promise<DataTextView> {
  const [bytes, names] = await Promise.all([nodeBytes(node), exefsStringsFor(node.id)])
  const parsed = parseAamp(bytes, names)
  const text = aampToText(parsed)
  const unresolved = (text.match(/\b0x[0-9a-f]{8}\b/g) ?? []).length
  return {
    title: "AAMP — Nintendo parameter file",
    rows: [
      ["Data type", parsed.dataType],
      ["Version", String(parsed.pioVersion)],
      ["Lists / objects / parameters", `${parsed.counts.lists} / ${parsed.counts.objects} / ${parsed.counts.params}`],
      ["Unresolved names", unresolved ? `${unresolved} (shown as hashes)` : "none"],
    ],
    text,
    lang: "yaml",
  }
}

export function AampPreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadAampView} label="Decoding AAMP…" />
}

export async function loadHavokView(node: Node): Promise<DataTextView> {
  const p = parseHavok(await nodeBytes(node))
  const objects = p.classCounts.reduce((n, [, c]) => n + c, 0)
  const lines = [
    "classes:",
    ...p.classCounts.map(([name, count]) => `  ${name}: ${count}`),
    "sections:",
    ...p.sections.map((s) => `  ${s.tag}: { size: ${s.dataSize}, objects: ${s.objects.length} }`),
  ]
  if (p.names.length) lines.push("names:", ...p.names.map((n) => `  - ${JSON.stringify(n)}`))
  return {
    title: "Havok packfile",
    rows: [
      ["SDK version", p.contentsVersion],
      ["File version", String(p.fileVersion)],
      ["Root object", p.contentsClass ?? "?"],
      ["Objects", `${objects} in ${p.classCounts.length} classes`],
    ],
    text: lines.join("\n"),
    lang: "yaml",
  }
}

export function HavokPreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadHavokView} label="Reading Havok packfile…" />
}

export async function loadVfxbView(node: Node): Promise<DataTextView> {
  const p = parseVfxb(await nodeBytes(node))
  const emitters = p.emitterSets.reduce((n, s) => n + s.emitters.length, 0)
  const lines = ["emitter_sets:"]
  for (const set of p.emitterSets) {
    lines.push(`  ${JSON.stringify(set.name)}:`)
    for (const e of set.emitters) lines.push(`    - ${JSON.stringify(e)}`)
  }
  lines.push("resources:")
  for (const r of p.resources) lines.push(`  - { section: ${r.section}, kind: ${r.kind}, size: ${r.size} }`)
  return {
    title: "VFXB — NintendoWare particle effects",
    rows: [
      ["Name", p.name || "—"],
      ["VFX version", String(p.vfxVersion)],
      ["Emitter sets", `${p.emitterSets.length} (${emitters} emitters)`],
      ["Embedded", p.resources.map((r) => r.kind).join(", ") || "none"],
    ],
    text: lines.join("\n"),
    lang: "yaml",
  }
}

export function VfxbPreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadVfxbView} label="Reading VFXB…" />
}

const TILE_TITLES = {
  hght: "Height map",
  mate: "Material map",
  grass: "Grass map",
  water: "Water map",
} as const

/** Encode RGBA pixels as a PNG data URL through a canvas. */
function pixelsToDataUrl(width: number, height: number, pixels: Uint8ClampedArray | Uint8Array): string {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")!
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)
  return canvas.toDataURL("image/png")
}

export function TerrainTilePreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    const kind = terrainTileKind(node.name)
    if (!kind) throw new Error(`Not a terrain tile: ${node.name}`)
    const img = renderTerrainTile(kind, await nodeBytes(node))
    return { kind, img, url: pixelsToDataUrl(img.width, img.height, img.pixels) }
  }, [node.id])
  if (loading) return <LoadingFiller label="Rendering terrain tile…" />
  if (error) return <ErrorFiller error={error} />
  const { kind, img, url } = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title={`BotW terrain — ${TILE_TITLES[kind]}`} />
        <KvBlock title="Tile">
          <KvRow k="Area" v={node.name.split(".")[0]!} />
          <KvRow k="Size" v={`${img.width} × ${img.height}`} />
          {Object.entries(img.stats).map(([k, v]) => (
            <KvRow key={k} k={k} v={String(v)} />
          ))}
        </KvBlock>
        <img
          src={url}
          alt={node.name}
          className="w-full max-w-[512px] rounded-md border bg-[repeating-conic-gradient(#8882_0_25%,transparent_0_50%)] bg-[length:16px_16px]"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
    </ScrollArea>
  )
}

export async function loadTscbView(node: Node): Promise<DataTextView> {
  const t = parseTscb(await nodeBytes(node))
  const lines = ["materials:"]
  for (const m of t.materials) {
    lines.push(`  - { index: ${m.index}, uv_scale: [${m.uScale.toPrecision(3)}, ${m.vScale.toPrecision(3)}], params: [${m.params.map((x) => x.toPrecision(3)).join(", ")}] }`)
  }
  lines.push("areas:")
  for (const a of t.areas) {
    lines.push(`  - { name: ${a.name}, x: ${a.x}, z: ${a.z}, edge: ${a.edge}, height: [${a.minHeight.toPrecision(4)}, ${a.maxHeight.toPrecision(4)}] }`)
  }
  return {
    title: "TSCB — BotW terrain scene",
    rows: [
      ["World scale", String(t.worldScale)],
      ["Max height", String(t.maxHeight)],
      ["Tile size", String(t.tileSize)],
      ["Materials", String(t.materials.length)],
      ["Areas", String(t.areas.length)],
    ],
    text: lines.join("\n"),
    lang: "yaml",
  }
}

export function TscbPreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadTscbView} label="Reading terrain scene…" />
}

// ---------------------------------------------------------------- event flows

export async function loadEvflView(node: Node): Promise<DataTextView> {
  const p = parseEvfl(await nodeBytes(node))
  const events = p.flowcharts.reduce((n, f) => n + f.events.length, 0)
  return {
    title: p.timelines.length && !p.flowcharts.length ? "BFEVFL — event timeline" : "BFEVFL — event flowchart",
    rows: [
      ["Name", p.fileName || "—"],
      ["Flowcharts", `${p.flowcharts.length} (${events} events)`],
      ["Entry points", String(p.flowcharts.reduce((n, f) => n + f.entryPoints.length, 0))],
      ["Timelines", String(p.timelines.length)],
    ],
    text: evflToText(p),
    lang: "yaml",
  }
}

export function EvflPreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadEvflView} label="Reading event flow…" />
}

// ---------------------------------------------------------------- maps

export async function loadDataMapView(node: Node): Promise<DataTextView> {
  const bytes = await nodeBytes(node)
  if (node.meta?.leafFormat === "eco") {
    const e = parseEco(bytes)
    const scale = Math.max(1, Math.ceil(e.width / 1000))
    const img = e.render(scale)
    return {
      title: "BotW ecosystem area map",
      rows: [
        ["Size", `${e.width} × ${e.rows}`],
        ["Areas", String(e.areas.length)],
      ],
      text: ["areas:", ...e.areas.map(([id, cells]) => `  ${id}: ${cells}`)].join("\n"),
      lang: "yaml",
      images: [{ label: `Areas (1:${scale})`, ...img }],
    }
  }
  const stat = parseStat(bytes)
  const img = renderStat(stat)
  return {
    title: `BotW area statistics — ${stat.name}`,
    rows: [
      ["Grid", `${stat.width} × ${stat.height} (${stat.bytesPerCell * 8}-bit cells)`],
      ["Origin", `${stat.originX}, ${stat.originZ}`],
      ["Values", `${img.min} – ${img.max} (${img.distinct}${img.distinct >= 4096 ? "+" : ""} distinct)`],
    ],
    text: "",
    lang: "yaml",
    images: [{ label: stat.bytesPerCell >= 4 ? "Values (by category)" : "Values (low → high)", ...img }],
  }
}

export function DataMapPreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadDataMapView} label="Rendering map…" />
}

// ---------------------------------------------------------------- textures

export async function loadTextureView(node: Node): Promise<DataTextView> {
  const bytes = await nodeBytes(node)
  if (node.meta?.leafFormat === "nvn-texture") {
    const t = parseNvnTexture(bytes)
    return {
      title: "NVN texture",
      rows: [
        ["Size", `${t.width} × ${t.height}`],
        ["Format", t.formatName],
        ["Layers", String(t.layers)],
      ],
      text: "",
      lang: "yaml",
      images: Array.from({ length: t.layers }, (_, i) => ({
        label: `Layer ${i}`,
        width: t.width,
        height: t.height,
        pixels: decodeNvnTexture(bytes, t, i),
      })),
    }
  }
  const g = parseGx2(bytes)
  const images: DataImage[] = []
  const rows: [string, string][] = [["Version", String(g.major)]]
  g.surfaces.forEach((s, i) => {
    rows.push([`Surface ${i}`, `${s.width} × ${s.height}, ${s.formatName}, tile mode ${s.tileMode}`])
    try {
      images.push({ label: `Surface ${i}`, ...decodeGx2Surface(s) })
    } catch {
      // Shown in the rows; nothing to draw.
    }
  })
  return { title: "GX2 texture", rows, text: "", lang: "yaml", images }
}

export function TexturePreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadTextureView} label="Decoding texture…" />
}

// ---------------------------------------------------------------- text tables

/** NUL-terminated printable strings of at least `min` characters. */
function printableStrings(bytes: Uint8Array, min = 4, limit = 400): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let start = -1
  for (let i = 0; i <= bytes.length; i++) {
    const c = bytes[i] ?? 0
    if (c >= 0x20 && c < 0x7f) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0 && i - start >= min) {
      const s = String.fromCharCode(...bytes.subarray(start, i))
      if (/[A-Za-z]{2}/.test(s) && !seen.has(s)) {
        seen.add(s)
        out.push(s)
        if (out.length >= limit) break
      }
    }
    start = -1
  }
  return out
}

const hex32 = (n: number) => `0x${n.toString(16).padStart(8, "0")}`

/** What each BotW engine file without a decoder is, for its identification page. */
const UKING_MISC: [RegExp, string, string][] = [
  [/\.brtcamera$/i, "BotW cutscene camera track", "Keyframes of a demo camera animation: the camera name, then frame data."],
  [/\.skybin$/i, "BotW sky data", "Precomputed sky lookup data loaded by KSys."],
  [/\.bushvt$/i, "Layout shader variation table", "Shader variation indices for the layout (UI) archive shader."],
  [/\.raw$/i, "agl raw resource", "Raw pixel data for an agl debug resource (no header)."],
  [/^nvn_font.*_tbl\.bin$/i, "NVN font glyph table", "UTF-16 code points of the glyphs in the matching .ntx font sheet, in sheet order."],
  [/^nvn_font_shader.*\.bin$/i, "NVN font shader", "Compiled NVN shader program that draws the SDK debug font."],
  [/\.bin$/i, "BotW animation-driven speed table", "Per-animation movement speeds keyed by name hash (AnimationDrivenSpeed)."],
]

const SOUND_CONFIG: Record<string, string> = {
  AATN: "Attenuation settings (volume / filter by distance)",
  AROC: "Attenuation roll-off curve",
  AACL: "Attenuation curve limits",
  AGST: "Sound group settings tree",
  BLAL: "Loop asset list (hashes of looping sound assets)",
}

export async function loadDataTextView(node: Node): Promise<DataTextView> {
  const bytes = await nodeBytes(node)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fmt = String(node.meta?.leafFormat ?? "")
  const magic = String.fromCharCode(...bytes.subarray(0, 4))
  const stringsBlock = (title = "strings") => {
    const s = printableStrings(bytes)
    return s.length ? [`${title}:`, ...s.map((x) => `  - ${JSON.stringify(x)}`)] : []
  }
  switch (fmt) {
    case "prod": {
      const p = parseProd(bytes)
      const total = p.meshes.reduce((n, m) => n + m.instances.length, 0)
      const lines = ["meshes:"]
      for (const m of p.meshes) {
        lines.push(`  ${m.name}:`)
        for (const i of m.instances.slice(0, 200)) {
          lines.push(`    - { pos: [${i.position.map((x) => x.toFixed(1)).join(", ")}], rot: [${i.rotation.map((x) => x.toFixed(2)).join(", ")}], scale: ${i.scale.toFixed(2)} }`)
        }
        if (m.instances.length > 200) lines.push(`    # … ${m.instances.length - 200} more`)
      }
      return {
        title: "PrOD — BotW instanced placements",
        rows: [["Meshes", String(p.meshes.length)], ["Instances", String(total)]],
        text: lines.join("\n"),
        lang: "yaml",
      }
    }
    case "rstb": {
      const r = parseRstb(bytes)
      const lines = ["named:", ...r.nameEntries.map((e) => `  ${JSON.stringify(e.name)}: ${e.size}`), "by_crc32:"]
      for (const e of r.crcEntries.slice(0, 2000)) lines.push(`  ${hex32(e.crc)}: ${e.size}`)
      if (r.crcEntries.length > 2000) lines.push(`  # … ${r.crcEntries.length - 2000} more`)
      return {
        title: "RSTB — resource size table",
        rows: [["CRC32 entries", String(r.crcEntries.length)], ["Named entries", String(r.nameEntries.length)]],
        text: lines.join("\n"),
        lang: "yaml",
      }
    }
    case "xlnk": {
      const x = parseXlnk(bytes)
      return {
        title: `XLNK — ${node.name.toLowerCase().includes("slink") ? "sound" : node.name.toLowerCase().includes("elink") ? "effect" : ""} link database`,
        rows: [
          ["Version", String(x.version)],
          ["Users", String(x.users)],
          ["Resource / asset params", `${x.resourceParams} / ${x.assetParams}`],
          ["Names", String(x.names.length)],
        ],
        text: ["names:", ...x.names.map((n) => `  - ${JSON.stringify(n)}`)].join("\n"),
        lang: "yaml",
      }
    }
    case "hash-list": {
      // `.sfmc`: u32 version, then a count and ascending hashes.
      const hashes = readSortedHashList(bytes, 4, true) ?? []
      return {
        title: "BotW far-model culling area",
        rows: [["Version", String(v.getUint32(0, true))], ["Actors (by hash)", String(hashes.length)]],
        text: ["hashes:", ...hashes.slice(0, 4000).map((h) => `  - ${hex32(h)}`)].join("\n"),
        lang: "yaml",
      }
    }
    case "uking-sound": {
      const rows: [string, string][] = [["Kind", SOUND_CONFIG[magic] ?? magic]]
      let lines: string[]
      if (magic === "BLAL") {
        const hashes = readSortedHashList(bytes, 8, false) ?? []
        rows.push(["Assets", String(hashes.length)])
        lines = ["hashes:", ...hashes.map((h) => `  - ${hex32(h)}`)]
      } else {
        const floats: string[] = []
        for (let o = 8; o + 4 <= Math.min(bytes.length, 0x40); o += 4) floats.push(v.getFloat32(o, true).toPrecision(4))
        lines = [`values: [${floats.join(", ")}]`, ...stringsBlock("names")]
      }
      return { title: `BotW sound config (${magic})`, rows, text: lines.join("\n"), lang: "yaml" }
    }
    case "nw-binary": {
      const isCafe = magic === "FWSD" || magic === "FGRP"
      const titles: Record<string, string> = {
        FSHA: "BFSHA — shader archive",
        BAHS: "agl shader archive (SHARCB)",
        FWSD: "BFWSD — wave sound data",
        FGRP: "BFGRP — sound group",
      }
      const rows: [string, string][] = [["Size", `${bytes.length} bytes`]]
      if (isCafe) {
        const blocks: string[] = []
        const n = v.getUint16(0x10, true)
        for (let i = 0; i < n && 0x14 + i * 12 + 12 <= bytes.length; i++) {
          const off = v.getUint32(0x18 + i * 12, true)
          blocks.push(off + 4 <= bytes.length ? String.fromCharCode(...bytes.subarray(off, off + 4)) : "?")
        }
        rows.push(["Blocks", blocks.join(", ") || "none"])
      }
      return { title: titles[magic] ?? "NintendoWare binary", rows, text: stringsBlock("names").join("\n"), lang: "yaml" }
    }
    case "switch-ticket": {
      if (node.name.toLowerCase().endsWith(".tik")) {
        // Ticket: u32 signature type, signature, then the body at 0x140.
        const body = 0x140
        const cstr = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n)).replace(/\0.*$/, "")
        const rights = Array.from(bytes.subarray(body + 0x160, body + 0x170), (b) => b.toString(16).padStart(2, "0")).join("")
        return {
          title: "Switch ticket",
          rows: [
            ["Signature type", hex32(v.getUint32(0, true))],
            ["Issuer", cstr(body, 0x40)],
            ["Title key type", bytes[body + 0x141] === 1 ? "personalized" : "common"],
            ["Key generation", String(bytes[body + 0x145])],
            ["Rights ID", rights],
          ],
          text: "",
          lang: "yaml",
        }
      }
      // Certificate chain: big-endian signature type, signature, issuer, key type, name.
      const certs: string[] = []
      let o = 0
      const sigSizes: Record<number, number> = { 0x10000: 0x200, 0x10001: 0x100, 0x10002: 0x3c, 0x10003: 0x200, 0x10004: 0x100, 0x10005: 0x3c }
      while (o + 4 <= bytes.length && certs.length < 16) {
        const sig = sigSizes[v.getUint32(o, false)]
        if (!sig) break
        const head = o + 4 + sig + ((0x40 - ((4 + sig) % 0x40)) % 0x40)
        const issuer = String.fromCharCode(...bytes.subarray(head, head + 0x40)).replace(/\0.*$/, "")
        const keyType = v.getUint32(head + 0x40, false)
        const name = String.fromCharCode(...bytes.subarray(head + 0x44, head + 0x84)).replace(/\0.*$/, "")
        certs.push(`  - { name: ${name}, issuer: ${issuer} }`)
        const keySize = keyType === 0 ? 0x238 : keyType === 1 ? 0x138 : 0x78
        o = head + 0x88 + keySize
      }
      return { title: "Switch certificate chain", rows: [["Certificates", String(certs.length)]], text: ["certificates:", ...certs].join("\n"), lang: "yaml" }
    }
    case "uking-misc": {
      const entry = UKING_MISC.find(([re]) => re.test(node.name))
      if (/^nvn_font.*_tbl\.bin$/i.test(node.name)) {
        const chars: string[] = []
        for (let o = 0; o + 2 <= bytes.length; o += 2) chars.push(String.fromCharCode(v.getUint16(o, true)))
        const lines: string[] = []
        for (let i = 0; i < chars.length; i += 64) lines.push(`  - ${JSON.stringify(chars.slice(i, i + 64).join(""))}`)
        return {
          title: entry![1],
          rows: [["What it is", entry![2]], ["Glyphs", String(chars.length)]],
          text: ["glyphs:", ...lines].join("\n"),
          lang: "yaml",
        }
      }
      const words: string[] = []
      for (let o = 0; o + 4 <= Math.min(bytes.length, 0x80); o += 4) words.push(hex32(v.getUint32(o, true)))
      return {
        title: entry?.[1] ?? "BotW engine data",
        rows: [["What it is", entry?.[2] ?? "BotW engine data file."], ["Size", `${bytes.length} bytes`]],
        text: [...stringsBlock(), `first_words: [${words.join(", ")}]`].join("\n"),
        lang: "yaml",
      }
    }
    case "gx2": {
      const g = parseGx2(bytes)
      return {
        title: "GX2 shader",
        rows: [
          ["Vertex / pixel / geometry shaders", `${g.shaders.vertex} / ${g.shaders.pixel} / ${g.shaders.geometry}`],
          ["Blocks", String(g.blocks.length)],
        ],
        text: stringsBlock("symbols").join("\n"),
        lang: "yaml",
      }
    }
  }
  throw new Error(`No data view for ${fmt || node.name}`)
}

export function DataTextLeafPreview({ node }: { node: Node }) {
  return <DataTextPreview node={node} load={loadDataTextView} label="Reading data…" />
}
