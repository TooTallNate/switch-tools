/**
 * Previews for Game Freak Trinity files (Pokémon Legends: Arceus):
 * `.trmdl` models in the mesh viewer (with a shiny toggle when a
 * `_rare.trmtr` exists), and a summary for the other model parts.
 */
import { useState } from "react"
import {
  parseTrmbf,
  parseTrmdl,
  parseTrmmt,
  parseTrmsh,
  parseTrmtr,
  parseTrskl,
  TrinityAttribute,
  TrinityFormat,
} from "@tootallnate/trinity"

import type { Node } from "~/lib/archive"
import { loadTrinityModelView } from "~/lib/trinity-view"
import { ScrollArea } from "~/components/ui/scroll-area"
import { Switch } from "~/components/ui/switch"

import { MeshViewer } from "./mesh-viewer"
import { ErrorFiller, KvBlock, KvRow, LoadingFiller, SectionHeader, useAsync } from "./preview-pane"

async function nodeBytes(node: Node): Promise<Uint8Array> {
  return new Uint8Array(await (await node.blob!()).arrayBuffer())
}

const TABLE = "w-full text-sm"
const THEAD = "bg-muted/40 text-xs font-medium uppercase tracking-wider text-muted-foreground"

export function TrinityModelPreview({ node, root }: { node: Node; root: Node | null }) {
  const [rare, setRare] = useState(false)
  const { loading, data, error } = useAsync(() => loadTrinityModelView(node, root, { rare }), [node.id, rare])
  if (loading) return <LoadingFiller label="Decoding model…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-2">
        <div>
          <h2 className="font-heading text-sm font-medium">Game Freak Trinity model</h2>
          <p className="text-xs text-muted-foreground">
            {v.vertices.toLocaleString()} vertices · {v.triangles.toLocaleString()} triangles · {v.materials.length} materials
            {v.bones ? ` · ${v.bones} bones` : ""}
            {v.texturesWanted ? ` · ${v.texturesFound}/${v.texturesWanted} textured` : ""}
            {" · drag to orbit, scroll to zoom"}
          </p>
        </div>
        {v.hasRare && (
          <label className="flex shrink-0 items-center gap-2 text-xs">
            <Switch checked={rare} onCheckedChange={setRare} />
            Shiny
          </label>
        )}
      </div>
      <div className="flex-1 p-3">
        <MeshViewer mesh={v.mesh} materialDiffuseTextures={v.textures} baseName={node.name} />
      </div>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  trmsh: "mesh shapes",
  trmbf: "mesh buffers",
  trmtr: "materials",
  trskl: "skeleton",
  trmmt: "material table",
}

export function TrinityFilePreview({ node }: { node: Node }) {
  const ext = node.name.split(".").pop()!.toLowerCase()
  const { loading, data, error } = useAsync(async () => {
    const b = await nodeBytes(node)
    switch (ext) {
      case "trmsh":
        return { kind: ext, value: parseTrmsh(b) } as const
      case "trmbf":
        return { kind: ext, value: parseTrmbf(b) } as const
      case "trmtr":
        return { kind: ext, value: parseTrmtr(b) } as const
      case "trskl":
        return { kind: ext, value: parseTrskl(b) } as const
      case "trmmt":
        return { kind: ext, value: parseTrmmt(b) } as const
      default:
        return { kind: "trmdl", value: parseTrmdl(b) } as const
    }
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing…" />
  if (error) return <ErrorFiller error={error} />
  const d = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title={`Trinity ${KIND_LABEL[d.kind] ?? d.kind} (.${d.kind})`} />
        <p className="text-xs text-muted-foreground">
          Part of a Game Freak Trinity model; open the <code>.trmdl</code> next to it to view the model.
        </p>
        {d.kind === "trmsh" && (
          <>
            <KvBlock title="Mesh">
              <KvRow k="Buffer file" v={d.value.bufferFile} />
              <KvRow k="Shapes" v={String(d.value.shapes.length)} />
            </KvBlock>
            <Table
              head={["Shape", "Vertex layout", "Sub-meshes (material: indices)"]}
              rows={d.value.shapes.map((s) => [
                s.name,
                s.streams
                  .map((st) => `${st.stride} B: ${st.elements.map((e) => `${TrinityAttribute[e.semantic]}${e.semanticIndex} ${TrinityFormat[e.format]}`).join(", ")}`)
                  .join(" | "),
                s.subMeshes.map((m) => `${m.material}: ${m.indexCount}`).join(", "),
              ])}
            />
          </>
        )}
        {d.kind === "trmbf" && (
          <Table
            head={["Shape", "Index buffers", "Vertex buffers"]}
            rows={d.value.buffers.map((b, i) => [
              String(i),
              b.indices.map((x) => `${x.length.toLocaleString()} B`).join(", "),
              b.vertices.map((x) => `${x.length.toLocaleString()} B`).join(", "),
            ])}
          />
        )}
        {d.kind === "trmtr" && (
          <Table
            head={["Material", "Shader", "Textures", "Colours"]}
            rows={d.value.materials.map((m) => [
              m.name,
              m.shader ?? "",
              m.textures.map((t) => `${t.binding}: ${t.file}`).join("\n"),
              Object.entries(m.float4s)
                .filter(([k]) => /^BaseColor/.test(k))
                .map(([k, c]) => `${k}: ${c.slice(0, 3).map((x) => x.toFixed(3)).join(", ")}`)
                .join("\n"),
            ])}
          />
        )}
        {d.kind === "trskl" && (
          <>
            <KvBlock title="Skeleton">
              <KvRow k="Nodes" v={String(d.value.nodes.length)} />
              <KvRow k="Skinning bones" v={String(d.value.boneCount)} />
            </KvBlock>
            <Table
              head={["Node", "Parent", "Rig index", "Translation"]}
              rows={d.value.nodes.map((n) => [
                n.name,
                n.parent >= 0 ? (d.value.nodes[n.parent]?.name ?? String(n.parent)) : "—",
                n.rigIndex >= 0 ? String(n.rigIndex) : "—",
                n.translation.map((x) => x.toFixed(3)).join(", "),
              ])}
            />
          </>
        )}
        {d.kind === "trmmt" && (
          <Table head={["Table", "Material files"]} rows={d.value.tables.map((t) => [t.name, t.files.join(", ")])} />
        )}
        {d.kind === "trmdl" && (
          <KvBlock title="Model">
            <KvRow k="Meshes (LODs)" v={d.value.meshes.join(", ")} />
            <KvRow k="Skeleton" v={d.value.skeleton ?? "—"} />
            <KvRow k="Materials" v={d.value.materials.join(", ")} />
          </KvBlock>
        )}
      </div>
    </ScrollArea>
  )
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <section className="overflow-hidden rounded-md border bg-card">
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="whitespace-pre-line px-3 py-1 align-top font-mono text-xs">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
