/**
 * Preview components for FF7 PC's 3D model file formats:
 *
 *   - `.hrc` skeleton hierarchy (text)
 *   - `.rsd` resource reference (text)
 *   - `.p` binary mesh
 *   - `.tex` texture
 *
 * The HRC and RSD previews show their parsed contents as
 * structured tables. The P preview renders the mesh in the
 * shared {@link MeshViewer} (one group flattened into a flat
 * triangle list, normals computed if absent). The TEX preview
 * shows the decoded image on a transparency-checkerboarded
 * canvas.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type { Node } from "~/lib/archive"
import {
  parseFf7HrcForView,
  parseFf7PForView,
  parseFf7RsdForView,
  parseFf7TexForView,
  ff7ExtractTriangles,
  type Ff7HrcView,
  type Ff7PView,
  type Ff7RsdView,
  type Ff7TexView,
} from "~/lib/preview"
import { formatBytes } from "~/lib/utils"

import {
  MeshViewer,
  type RenderableMesh,
  type RenderableMeshLOD,
  type RenderableMeshSection,
} from "./mesh-viewer"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"

// ===========================================================================
// HRC (skeleton)
// ===========================================================================

export function Ff7HrcPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseFf7HrcForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing skeleton…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div>
        <h2 className="font-heading text-base font-medium">{node.name}</h2>
        <p className="text-xs text-muted-foreground">
          FF7 skeleton: <code className="font-mono">{v.skeletonName}</code> ·{" "}
          {v.boneCount} bone{v.boneCount === 1 ? "" : "s"}
        </p>
      </div>
      <BoneTree view={v} />
    </div>
  )
}

function BoneTree({ view }: { view: Ff7HrcView }) {
  // Build parent → children map for indented display.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, typeof view.bones>()
    for (const b of view.bones) {
      const list = map.get(b.parent) ?? []
      list.push(b)
      map.set(b.parent, list)
    }
    return map
  }, [view])

  const renderBone = (parentName: string, depth: number): ReactNode[] => {
    const bones = childrenByParent.get(parentName) ?? []
    return bones.flatMap((b) => [
      <div
        key={b.name}
        className="flex flex-col gap-0.5 border-l py-1 pl-3 text-xs"
        style={{ marginLeft: depth * 12 }}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">{b.name}</span>
          <span className="text-muted-foreground">
            length {b.length.toFixed(2)}
          </span>
          {b.rsds.length > 0 && (
            <span className="text-muted-foreground">
              · {b.rsds.length} mesh ref{b.rsds.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {b.rsds.length > 0 && (
          <div className="text-muted-foreground font-mono">
            RSDs: {b.rsds.join(", ")}
          </div>
        )}
      </div>,
      ...renderBone(b.name, depth + 1),
    ])
  }

  return (
    <section className="flex flex-col gap-1 rounded-md border bg-card p-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Bone hierarchy
      </h3>
      <div className="flex flex-col">{renderBone("root", 0)}</div>
    </section>
  )
}

// ===========================================================================
// RSD (resource reference)
// ===========================================================================

export function Ff7RsdPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseFf7RsdForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing resource…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div>
        <h2 className="font-heading text-base font-medium">{node.name}</h2>
        <p className="text-xs text-muted-foreground">
          FF7 resource reference · version{" "}
          <code className="font-mono">{v.version}</code>
        </p>
      </div>
      <section className="flex flex-col gap-1 rounded-md border bg-card p-3 text-xs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">P mesh</dt>
          <dd className="font-mono">
            {v.ply ? `${v.ply.toLowerCase()}.p` : "—"}
          </dd>
          <dt className="text-muted-foreground">Materials</dt>
          <dd className="font-mono">
            {v.mat ? `${v.mat.toLowerCase()}.mat` : "—"}
          </dd>
          <dt className="text-muted-foreground">Groups</dt>
          <dd className="font-mono">
            {v.grp ? `${v.grp.toLowerCase()}.grp` : "—"}
          </dd>
          <dt className="text-muted-foreground">Textures</dt>
          <dd className="font-mono">
            {v.textures.length === 0
              ? "—"
              : v.textures.map((t) => `${t.toLowerCase()}.tex`).join(", ")}
          </dd>
        </dl>
      </section>
    </div>
  )
}

// ===========================================================================
// P (binary mesh)
// ===========================================================================

export function Ff7PMeshPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    const view = await parseFf7PForView(await node.blob!())
    // Flatten all groups into one renderable LOD with per-group
    // sections. Each section gets its own material slot so
    // future texture wiring works the same way as UE / Phyre.
    let totalVerts = 0
    let totalTris = 0
    for (const g of view.groups) {
      totalVerts += g.numPolygons * 3
      totalTris += g.numPolygons
    }
    const positions = new Float32Array(totalVerts * 3)
    const normals = new Float32Array(totalVerts * 3)
    const uvs = new Float32Array(totalVerts * 2)
    const indices = new Uint32Array(totalTris * 3)
    const sections: RenderableMeshSection[] = []
    let vertCursor = 0
    let idxCursor = 0
    let hasAnyUv = false
    for (let gi = 0; gi < view.groups.length; gi++) {
      const g = view.groups[gi]!
      const tris = ff7ExtractTriangles(view, g)
      positions.set(tris.positions, vertCursor * 3)
      normals.set(tris.normals, vertCursor * 3)
      if (tris.texCoords) {
        uvs.set(tris.texCoords, vertCursor * 2)
        hasAnyUv = true
      }
      for (let i = 0; i < tris.indices.length; i++) {
        indices[idxCursor + i] = tris.indices[i]! + vertCursor
      }
      sections.push({
        materialIndex: g.areTexturesUsed ? g.textureNumber : 0,
        firstIndex: idxCursor,
        numTriangles: Math.floor(tris.indices.length / 3),
      })
      vertCursor += tris.positions.length / 3
      idxCursor += tris.indices.length
    }
    const lod: RenderableMeshLOD = {
      numVertices: vertCursor,
      positions,
      normals,
      uv: hasAnyUv ? uvs : undefined,
      indices,
      sections,
      label: `${vertCursor.toLocaleString()} verts, ${(idxCursor / 3).toLocaleString()} tris`,
    }
    const renderable: RenderableMesh = {
      lods: [lod],
      // FF7 PC stores bones along +Z (head at -Z when bones
      // extend downward); the bind pose is more readable with
      // Z-up reinterpreted as Y-up.
      upAxis: "z-up",
    }
    return { view, renderable }
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing P mesh…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const totalVerts = v.view.positions.length / 3
  const totalTris = v.view.polygons.length
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-2">
        <h2 className="font-heading text-sm font-medium">{node.name}</h2>
        <p className="text-xs text-muted-foreground">
          FF7 P-format mesh · {v.view.groups.length} group
          {v.view.groups.length === 1 ? "" : "s"} ·{" "}
          {totalVerts.toLocaleString()} vertices ·{" "}
          {totalTris.toLocaleString()} triangles · drag to orbit, scroll to zoom
        </p>
      </div>
      <div className="flex-1 p-3">
        <MeshViewer
          mesh={v.renderable}
          baseName={node.name}
          infoText={`${v.view.groups.length} group${v.view.groups.length === 1 ? "" : "s"}`}
        />
      </div>
    </div>
  )
}

// ===========================================================================
// TEX (texture)
// ===========================================================================

export function Ff7TexPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseFf7TexForView(await node.blob!())
  }, [node.id])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pngUrl, setPngUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = data.width
    canvas.height = data.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const imageData = ctx.createImageData(data.width, data.height)
    imageData.data.set(data.pixels)
    ctx.putImageData(imageData, 0, 0)
    canvas.toBlob((b) => {
      if (b) setPngUrl(URL.createObjectURL(b))
    }, "image/png")
    return () => {
      setPngUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding TEX…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const baseName = node.name.replace(/\.tex$/i, "")
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div>
        <h2 className="font-heading text-base font-medium">{node.name}</h2>
        <p className="text-xs text-muted-foreground">
          FF7 TEX · {v.width} × {v.height} · {v.bitsPerPixel}-bit{" "}
          {v.paletted
            ? `palette-indexed (${v.colorsPerPalette} colors${v.paletteCount > 1 ? ` × ${v.paletteCount} palettes` : ""})`
            : "direct color"}
        </p>
      </div>
      <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
        <div
          className="overflow-auto rounded-md border"
          style={{
            background:
              "repeating-conic-gradient(rgb(36, 36, 36) 0% 25%, rgb(20, 20, 20) 0% 50%) 50% / 16px 16px",
            maxHeight: "70vh",
          }}
        >
          <canvas
            ref={canvasRef}
            className="block max-w-full"
            style={{
              imageRendering:
                v.width <= 256 && v.height <= 256 ? "pixelated" : "auto",
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            Decoded → 8-bit RGBA ({v.width} × {v.height},{" "}
            {formatBytes(v.pixels.byteLength)})
          </span>
          {pngUrl && (
            <a
              href={pngUrl}
              download={`${baseName}.png`}
              className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
            >
              Save .png
            </a>
          )}
        </div>
      </section>
    </div>
  )
}
