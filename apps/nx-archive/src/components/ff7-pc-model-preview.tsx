/**
 * Preview components for FF7 PC's 3D model file formats:
 *
 *   - `.hrc` skeleton hierarchy (text)
 *   - `.rsd` resource reference (text)
 *   - `.p` binary mesh
 *   - `.tex` texture
 *
 * The HRC preview is the showcase: it follows each bone's RSD
 * reference to its `.p` mesh + `.tex` textures, scans sibling
 * `.a` animation files for matching bone counts, and renders
 * the assembled character through the shared {@link MeshViewer}.
 * Picks a 1-frame `.a` as the default bind pose; switching to
 * a multi-frame `.a` enables real-time skeletal playback via
 * the viewer's animation transport.
 *
 * Without any sibling animation, the preview falls back to a
 * by-name heuristic that puts each bone in a reasonable
 * anatomical direction (spine up, arms sideways, legs down).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import type { Node } from "~/lib/archive"
import {
  parseFf7HrcForView,
  parseFf7PForView,
  parseFf7RsdForView,
  parseFf7TexForView,
  ff7ExtractTriangles,
  type Ff7HrcView,
} from "~/lib/preview"
import { formatBytes } from "~/lib/utils"
import { parseAnim, type ParsedAnim } from "@tootallnate/ff7-pc-model"
import {
  applyFrameToGeometry,
  applyMatricesToTypedArrays,
  assembleHrcCharacter,
  buildCompositeRig,
  computeBoneMatrices,
  sampleAnimFrame,
  type AssembledHrcView,
} from "~/lib/ff7-field-rig"

import {
  MeshViewer,
  type MeshViewerAnimation,
  type MeshViewerAnimationDriver,
  type RenderableMesh,
  type RenderableMeshLOD,
  type RenderableMeshSection,
} from "./mesh-viewer"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"

// ===========================================================================
// React components
// ===========================================================================

export function Ff7HrcPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  const { loading, data: hrc, error } = useAsync(async () => {
    return parseFf7HrcForView(await node.blob!())
  }, [node.id])

  const {
    loading: assembling,
    data: assembled,
    error: assembleError,
  } = useAsync(async () => {
    if (!hrc) return null
    return assembleHrcCharacter(hrc, root, node)
  }, [hrc, node.id, root])

  const [mode, setMode] = useState<"3d" | "tree">("3d")

  if (loading) return <LoadingFiller label="Parsing skeleton…" />
  if (error) return <ErrorFiller error={error} />
  const v = hrc!

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-medium">{node.name}</h2>
          <p className="text-xs text-muted-foreground">
            FF7 skeleton: <code className="font-mono">{v.skeletonName}</code> ·{" "}
            {v.boneCount} bone{v.boneCount === 1 ? "" : "s"}
            {assembled?.availableAnims.length
              ? ` · ${assembled.availableAnims.length} matching animation${assembled.availableAnims.length === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            className={`rounded-md border px-2 py-1 ${mode === "3d" ? "bg-accent" : "bg-card"}`}
            onClick={() => setMode("3d")}
          >
            3D
          </button>
          <button
            type="button"
            className={`rounded-md border px-2 py-1 ${mode === "tree" ? "bg-accent" : "bg-card"}`}
            onClick={() => setMode("tree")}
          >
            Skeleton
          </button>
        </div>
      </div>

      {mode === "3d" && (
        <CompositeMeshSection
          assembling={assembling}
          assembled={assembled ?? null}
          assembleError={assembleError ?? null}
          node={node}
        />
      )}
      {mode === "tree" && <BoneTree view={v} />}
    </div>
  )
}

function CompositeMeshSection({
  assembling,
  assembled,
  assembleError,
  node,
}: {
  assembling: boolean
  assembled: AssembledHrcView | null
  assembleError: Error | null
  node: Node
}) {
  // Build the static rig once per assembled-character; per-frame
  // mutations happen inside the animation driver.
  const rig = useMemo(() => {
    if (!assembled || !assembled.hasGeometry) return null
    return buildCompositeRig(assembled)
  }, [assembled])

  // Cache of fully-parsed `.a` animations, lazily loaded on
  // first selection.
  const animCacheRef = useRef<Map<string, ParsedAnim>>(new Map())
  // The driver re-creates if the available-anims list changes
  // (different HRC opened or new siblings discovered). The
  // viewer's animation transport uses the FIRST animation as
  // the default "selected" entry.
  const driver = useMemo<MeshViewerAnimationDriver | null>(() => {
    if (!assembled || !rig) return null
    const animations: MeshViewerAnimation[] = assembled.availableAnims.map(
      (a) => ({
        name: `${a.name} (${a.framesCount}f)`,
        frameCount: Math.max(1, a.framesCount),
        loop: a.framesCount > 1,
      }),
    )
    return {
      category: "animation",
      animations,
      // Open on the first stored bind pose (1-frame `.a` files sort
      // first), matching the media library's rest pose.
      defaultIndex: animations.length > 0 ? 0 : -1,
      sample(index, frame, ctx) {
        if (!ctx.geometry) return
        const animDescriptor =
          index >= 0 && index < assembled.availableAnims.length
            ? assembled.availableAnims[index]
            : null
        let parsed: ParsedAnim | null = null
        if (animDescriptor) {
          parsed = animCacheRef.current.get(animDescriptor.name) ?? null
          if (!parsed) {
            // Schedule a lazy load; the next sample call will
            // pick it up. For the very first sample call after
            // selection we render the fallback bind pose.
            void (async () => {
              try {
                const blob = await animDescriptor.node.blob!()
                const bytes = new Uint8Array(await blob.arrayBuffer())
                animCacheRef.current.set(animDescriptor.name, parseAnim(bytes))
                // Force a re-sample by mutating the geometry now
                // that the data is available. The viewer's rAF
                // loop will pick up the updated geometry on its
                // next tick.
                const pa = animCacheRef.current.get(animDescriptor.name)
                if (pa) {
                  const matrices = computeBoneMatrices(
                    assembled.bones,
                    pa.frames[
                      Math.min(Math.floor(frame), pa.frames.length - 1)
                    ] ?? null,
                    pa.rotationOrder,
                  )
                  applyFrameToGeometry(ctx.geometry!, rig.pieces, matrices)
                }
              } catch {
                /* drop unparseable animations silently */
              }
            })()
            return
          }
        }
        // Interpolate frame index between integer frames. The
        // driver receives a floating-point `frame` value
        // (rAF-driven), so for visual smoothness we lerp Euler
        // rotations between the bracketing keyframes. FF7
        // animations were authored at 15 fps but the viewer
        // ticks at 60 fps — without this we'd see judder.
        const fr = parsed
          ? sampleAnimFrame(parsed, frame)
          : null
        const matrices = computeBoneMatrices(
          assembled.bones,
          fr,
          parsed?.rotationOrder ?? null,
        )
        applyFrameToGeometry(ctx.geometry, rig.pieces, matrices)
      },
    }
  }, [assembled, rig])

  // First render of the geometry: apply the bind pose (either
  // the first available 1-frame `.a` or the fallback heuristic).
  // We watch for the FIRST geometry handoff via a ref + an
  // effect that runs after the viewer has constructed it.
  useEffect(() => {
    if (!rig || !assembled || !driver) return
    // The driver's `sample` will be called by the viewer
    // automatically when an animation is selected. Until then,
    // we want the rig in its bind pose so the model isn't a
    // collapsed dot at the origin. The viewer's animation
    // dropdown defaults to "no animation" — but we want the
    // FIRST one selected. The viewer doesn't currently support
    // a pre-selected index, so we apply the bind pose directly
    // via the rig's underlying typed arrays. This runs before
    // the WebGL renderer is attached, so no `needsUpdate`
    // needed.
    const matrices = computeBoneMatrices(assembled.bones, null, null)
    applyMatricesToTypedArrays(rig, matrices)
  }, [rig, assembled, driver])

  if (assembling) return <LoadingFiller label="Assembling character…" />
  if (assembleError) return <ErrorFiller error={assembleError} />
  if (!assembled) return null

  if (!assembled.hasGeometry) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4 text-xs">
        <p className="text-sm">No assembled geometry.</p>
        <p className="text-muted-foreground">
          The HRC's bone chain references RSD / P / TEX files that aren't in
          the surrounding archive — open this file from inside an LGP (e.g.
          <code className="ml-1 font-mono">char.lgp</code>) to get the full
          textured 3D character.
        </p>
        {assembled.warnings.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground">
              Missing references ({assembled.warnings.length})
            </summary>
            <ul className="mt-1 ml-4 list-disc font-mono">
              {assembled.warnings.slice(0, 50).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    )
  }

  const lod = rig!.mesh.lods[0]!
  return (
    <section className="flex flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {
            assembled.bones.filter((b) => b.meshes.some((m) => m.mesh))
              .length
          }{" "}
          rendered bone
          {assembled.bones.filter((b) => b.meshes.some((m) => m.mesh))
            .length === 1
            ? ""
            : "s"}{" "}
          · {lod.numVertices.toLocaleString()} verts ·{" "}
          {(lod.indices.length / 3).toLocaleString()} triangles
          {assembled.availableAnims.length > 0 ? (
            <> · {assembled.availableAnims.length} animation
              {assembled.availableAnims.length === 1 ? "" : "s"}
            </>
          ) : null}
        </span>
        {assembled.warnings.length > 0 && (
          <details className="ml-auto">
            <summary className="cursor-pointer">
              {assembled.warnings.length} warning
              {assembled.warnings.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1 ml-4 list-disc font-mono">
              {assembled.warnings.slice(0, 30).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {assembled.warnings.length > 30 && (
                <li>… and {assembled.warnings.length - 30} more</li>
              )}
            </ul>
          </details>
        )}
      </div>
      <div className="min-h-[480px] flex-1">
        <MeshViewer
          mesh={rig!.mesh}
          materialDiffuseTextures={rig!.textures}
          animationDrivers={driver ? [driver] : undefined}
          baseName={node.name}
        />
      </div>
    </section>
  )
}

function BoneTree({ view }: { view: Ff7HrcView }) {
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

export function Ff7RsdPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  void root
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
    let totalVerts = 0
    let totalTris = 0
    for (const g of view.groups) {
      totalVerts += g.numPolygons * 3
      totalTris += g.numPolygons
    }
    const positions = new Float32Array(totalVerts * 3)
    const normals = new Float32Array(totalVerts * 3)
    const uvs = new Float32Array(totalVerts * 2)
    const colors = new Float32Array(totalVerts * 3)
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
      colors.set(tris.colors, vertCursor * 3)
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
      colors,
      indices,
      sections,
      label: `${vertCursor.toLocaleString()} verts, ${(idxCursor / 3).toLocaleString()} tris`,
    }
    const renderable: RenderableMesh = {
      lods: [lod],
      // Single-bone preview of a raw .p file — these meshes are
      // authored in FF7's source -Y-up coords, so use `y-down`
      // (the viewer applies a 180° X-rotation to bring them to
      // +Y-up). No flipYDefault needed.
      upAxis: "y-down",
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
