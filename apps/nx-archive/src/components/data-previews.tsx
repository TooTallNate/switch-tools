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
 */
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"

import { aampToText, parseAamp } from "@tootallnate/aamp"
import { parseHavok } from "@tootallnate/havok"
import { parseVfxb } from "@tootallnate/vfxb"
import { parseTscb, renderTerrainTile, terrainTileKind } from "@tootallnate/uking-terrain"

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

export interface DataTextView {
  title: string
  rows: [string, string][]
  text: string
  lang: "yaml" | "json" | "xml"
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
        {html ? (
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
function pixelsToDataUrl(width: number, height: number, pixels: Uint8ClampedArray): string {
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
