/**
 * Previews for Pokémon: Let's Go (Game Freak) formats and NintendoWare
 * layouts:
 *
 *  - `.gfbmdl` models → {@link GfbmdlModelViewer}
 *  - `.gfbanm` / `.gfbanmcfg` → track summary / state table
 *  - message `.dat` (+ sibling `.tbl` labels) → text table
 *  - `.tbl` (AHTB) → hash / name table
 *  - `.bflyt` / `.bflan` → layout pane tree / animation targets
 */
import { useMemo, useState } from "react"

import { parseBflan, parseBflyt, ANIM_TAG_NAMES, type LayoutPane } from "@tootallnate/bflyt"
import { parseGfbanm, parseGfbanmcfg } from "@tootallnate/gfbmdl"
import { parseAhtb, parseGfMessage } from "@tootallnate/gfmsg"

import type { Node } from "~/lib/archive"
import { parseGfbmdlForView } from "~/lib/gfbmdl-view"
import { findNodeById } from "~/lib/unity-external"
import { Input } from "~/components/ui/input"
import { ScrollArea } from "~/components/ui/scroll-area"

import { GfbmdlModelViewer } from "./gfbmdl-model-viewer"
import {
  ErrorFiller,
  KvBlock,
  KvRow,
  LoadingFiller,
  SectionHeader,
  useAsync,
} from "./preview-pane"

async function nodeBytes(node: Node): Promise<Uint8Array> {
  return new Uint8Array(await (await node.blob!()).arrayBuffer())
}

const TABLE = "w-full text-sm"
const THEAD =
  "bg-muted/40 text-xs font-medium uppercase tracking-wider text-muted-foreground"

// ---------------------------------------------------------------- GFBMDL

export function GfbmdlModelPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  const { loading, data, error } = useAsync(
    () => parseGfbmdlForView(node, root),
    [node.id],
  )
  if (loading) return <LoadingFiller label="Loading Game Freak model…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-2">
        <h2 className="font-heading text-sm font-medium">
          Game Freak GFBMDL model
        </h2>
        <p className="text-xs text-muted-foreground">
          {v.model.meshes.length} mesh{v.model.meshes.length === 1 ? "" : "es"} ·{" "}
          {v.mesh.numVertices.toLocaleString()} vertices ·{" "}
          {(v.indices.length / 3).toLocaleString()} triangles
          {v.clips.length > 0 ? ` · ${v.clips.length} animations` : ""}
          {" · drag to orbit, scroll to zoom"}
        </p>
      </div>
      <div className="flex-1 p-3">
        <GfbmdlModelViewer node={node} view={v} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- GFBANM

export function GfbanmInfoPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseGfbanm(await nodeBytes(node))
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing GFBANM…" />
  if (error) return <ErrorFiller error={error} />
  const a = data!
  const kinds = (t: { kind: string } | null) => t?.kind ?? "—"
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="GFBANM — Game Freak animation" />
        <KvBlock title="Clip">
          <KvRow k="Frames" v={a.frameCount.toLocaleString()} />
          <KvRow k="FPS" v={String(a.fps)} />
          <KvRow k="Duration" v={`${(a.frameCount / a.fps).toFixed(2)} s`} />
          <KvRow k="Bone tracks" v={String(a.bones.length)} />
          <KvRow k="Material tracks" v={String(a.materials.length)} />
          <KvRow k="Visibility tracks" v={String(a.visibility.length)} />
          <KvRow k="Triggers" v={String(a.triggers.length)} />
        </KvBlock>
        <p className="text-xs text-muted-foreground">
          Select the model in the same archive to play this clip on it.
        </p>
        {a.bones.length > 0 && (
          <section className="overflow-hidden rounded-md border bg-card">
            <table className={TABLE}>
              <thead className={THEAD}>
                <tr>
                  <th className="px-3 py-2 text-left">Bone</th>
                  <th className="px-3 py-2 text-left">Scale</th>
                  <th className="px-3 py-2 text-left">Rotation</th>
                  <th className="px-3 py-2 text-left">Translation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {a.bones.map((b, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1 font-mono text-xs">{b.name}</td>
                    <td className="px-3 py-1 text-xs">{kinds(b.scale)}</td>
                    <td className="px-3 py-1 text-xs">{kinds(b.rotation)}</td>
                    <td className="px-3 py-1 text-xs">{kinds(b.translation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {a.materials.length > 0 && (
          <KvBlock title="Material tracks">
            {a.materials.map((m, i) => (
              <KvRow
                key={i}
                k={m.name}
                v={
                  [
                    ...m.values.filter((x) => x.track.kind !== "fixed").map((x) => x.name),
                    ...m.switches.filter((x) => x.track.kind !== "fixed").map((x) => x.name),
                  ].join(", ") || "(constant)"
                }
              />
            ))}
          </KvBlock>
        )}
        {a.triggers.length > 0 && (
          <KvBlock title="Triggers">
            {a.triggers.map((t, i) => (
              <KvRow
                key={i}
                k={t.name}
                v={`frames ${t.start}–${t.end}`}
                hint={t.params.map((p) => `${p.name}=${p.value}`).join(", ") || undefined}
              />
            ))}
          </KvBlock>
        )}
      </div>
    </ScrollArea>
  )
}

export function GfbanmcfgPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseGfbanmcfg(await nodeBytes(node))
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing GFBANMCFG…" />
  if (error) return <ErrorFiller error={error} />
  const c = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="GFBANMCFG — Game Freak animation states" />
        <section className="overflow-hidden rounded-md border bg-card">
          <table className={TABLE}>
            <thead className={THEAD}>
              <tr>
                <th className="px-3 py-2 text-left">State</th>
                <th className="px-3 py-2 text-left">File</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {c.animations.map((a, i) => (
                <tr key={i}>
                  <td className="px-3 py-1 font-mono text-xs">{a.name}</td>
                  <td className="px-3 py-1 font-mono text-xs">{a.file}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </ScrollArea>
  )
}

// ---------------------------------------------------------------- Text

/** Sibling `<stem>.tbl` of a message `.dat`, if present. */
async function findSiblingTable(root: Node | null, node: Node): Promise<Node | null> {
  if (!root) return null
  const slash = node.id.lastIndexOf("/")
  if (slash <= 0) return null
  const parent = await findNodeById(root, node.id.slice(0, slash))
  if (!parent) return null
  const want = node.name.replace(/\.dat$/i, ".tbl")
  let kids = parent._children
  if (!kids && parent.getChildren) {
    kids = await parent.getChildren()
    parent._children = kids
  }
  return kids?.find((k) => k.name === want) ?? null
}

function FilterableTable({
  rows,
  columns,
}: {
  rows: string[][]
  columns: string[]
}) {
  const [q, setQ] = useState("")
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? rows.filter((r) => r.some((c) => c.toLowerCase().includes(needle))) : rows
  }, [rows, q])
  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder={`Filter ${rows.length.toLocaleString()} rows…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="h-8 max-w-sm"
      />
      <section className="overflow-hidden rounded-md border bg-card">
        <table className={TABLE}>
          <thead className={THEAD}>
            <tr>
              {columns.map((c) => (
                <th key={c} className="px-3 py-2 text-left">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.slice(0, 5000).map((r, i) => (
              <tr key={i} className="hover:bg-accent/40">
                {r.map((c, j) => (
                  <td
                    key={j}
                    className={
                      j === r.length - 1
                        ? "whitespace-pre-wrap px-3 py-1.5 align-top"
                        : "px-3 py-1.5 align-top font-mono text-xs"
                    }
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {shown.length > 5000 && (
        <p className="text-xs text-muted-foreground">
          Showing the first 5,000 of {shown.length.toLocaleString()} rows.
        </p>
      )}
    </div>
  )
}

export function GfMessagePreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  const { loading, data, error } = useAsync(async () => {
    const file = parseGfMessage(await nodeBytes(node))
    const tbl = await findSiblingTable(root, node)
    let labels: string[] = []
    if (tbl) {
      try {
        labels = parseAhtb(await nodeBytes(tbl)).map((e) => e.name)
      } catch {
        // labels are optional
      }
    }
    return { file, labels, tableName: tbl?.name ?? null }
  }, [node.id])
  if (loading) return <LoadingFiller label="Decrypting message text…" />
  if (error) return <ErrorFiller error={error} />
  const { file, labels, tableName } = data!
  const rows = file.lines.map((l, i) => [String(i), labels[i] ?? "", l.text])
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="Game Freak message text" />
        <KvBlock title="File">
          <KvRow k="Lines" v={file.lines.length.toLocaleString()} />
          <KvRow k="Labels" v={tableName ? `${tableName} (${labels.length - 1} labels)` : "no sibling .tbl"} />
        </KvBlock>
        <FilterableTable columns={["#", "Label", "Text"]} rows={rows} />
      </div>
    </ScrollArea>
  )
}

export function AhtbPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseAhtb(await nodeBytes(node))
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing AHTB…" />
  if (error) return <ErrorFiller error={error} />
  const rows = data!.map((e, i) => [String(i), `0x${e.hash.toString(16).padStart(16, "0")}`, e.name])
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="AHTB — Game Freak label hash table" />
        <p className="text-xs text-muted-foreground">
          FNV-1a-64 hashes and the names they stand for — message labels, flag / work
          names, zone and trainer identifiers.
        </p>
        <FilterableTable columns={["#", "Hash", "Name"]} rows={rows} />
      </div>
    </ScrollArea>
  )
}

// ---------------------------------------------------------------- Layout

type Pane = LayoutPane

const PANE_LABEL: Record<string, string> = {
  pan1: "null",
  pic1: "picture",
  txt1: "text",
  wnd1: "window",
  bnd1: "bounding",
  prt1: "part",
  scr1: "scissor",
  ali1: "alignment",
}

function PaneTree({ panes, depth = 0 }: { panes: Pane[]; depth?: number }) {
  return (
    <>
      {panes.map((p, i) => (
        <div key={`${depth}-${i}`}>
          <div
            className="flex items-baseline gap-2 border-b border-border/40 py-1 text-xs"
            style={{ paddingLeft: depth * 16 }}
          >
            <span className="w-16 shrink-0 text-muted-foreground">{PANE_LABEL[p.kind] ?? p.kind}</span>
            <span className={p.visible ? "font-mono" : "font-mono text-muted-foreground line-through"}>
              {p.name}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {Math.round(p.width)}×{Math.round(p.height)} @ {Math.round(p.translate[0])},{Math.round(p.translate[1])}
            </span>
            {p.material && <span className="text-muted-foreground">mat {p.material}</span>}
            {p.font && <span className="text-muted-foreground">font {p.font}</span>}
            {p.textId && <span className="text-muted-foreground">id {p.textId}</span>}
            {p.partLayout && <span className="text-muted-foreground">→ {p.partLayout}</span>}
            {p.text && <span className="truncate">“{p.text}”</span>}
          </div>
          {p.children.length > 0 && <PaneTree panes={p.children} depth={depth + 1} />}
        </div>
      ))}
    </>
  )
}

export function BflytPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseBflyt(await nodeBytes(node))
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing BFLYT…" />
  if (error) return <ErrorFiller error={error} />
  const l = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BFLYT — NintendoWare layout" />
        <KvBlock title="Layout">
          <KvRow k="Name" v={l.name || "—"} />
          <KvRow k="Canvas" v={`${l.width} × ${l.height}`} />
          <KvRow k="Version" v={l.header.version} />
          <KvRow k="Panes" v={l.paneCount.toLocaleString()} />
          <KvRow k="Textures" v={l.textures.join(", ") || "—"} mono />
          <KvRow k="Fonts" v={l.fonts.join(", ") || "—"} mono />
          <KvRow k="Materials" v={String(l.materials.length)} />
          <KvRow k="Groups" v={l.groups.map((g) => g.name).join(", ") || "—"} mono />
        </KvBlock>
        <KvBlock title="Pane tree">
          <PaneTree panes={l.panes} />
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

export function BflanPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return { a: parseBflan(await nodeBytes(node)), names: ANIM_TAG_NAMES }
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing BFLAN…" />
  if (error) return <ErrorFiller error={error} />
  const { a, names } = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BFLAN — NintendoWare layout animation" />
        <KvBlock title="Animation">
          {a.tag && <KvRow k="Tag" v={a.tag.name} />}
          {a.tag && <KvRow k="Frames" v={`${a.tag.startFrame}–${a.tag.endFrame}`} />}
          <KvRow k="Frame size" v={String(a.frameSize)} />
          <KvRow k="Loop" v={a.loop ? "yes" : "no"} />
          {a.tag && <KvRow k="Groups" v={a.tag.groups.join(", ") || "—"} mono />}
          <KvRow k="Textures" v={a.textures.join(", ") || "—"} mono />
          <KvRow k="Version" v={a.header.version} />
        </KvBlock>
        {a.entries.length > 0 && (
          <section className="overflow-hidden rounded-md border bg-card">
            <table className={TABLE}>
              <thead className={THEAD}>
                <tr>
                  <th className="px-3 py-2 text-left">Target</th>
                  <th className="px-3 py-2 text-left">Kind</th>
                  <th className="px-3 py-2 text-left">Curves</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {a.entries.map((e, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1 font-mono text-xs">{e.name}</td>
                    <td className="px-3 py-1 text-xs">{["pane", "material", "user data"][e.target] ?? e.target}</td>
                    <td className="px-3 py-1 text-xs">
                      {e.tags
                        .map((t) => `${names[t.tag] ?? t.tag} (${t.curves} curves, ${t.keys} keys)`)
                        .join("; ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
