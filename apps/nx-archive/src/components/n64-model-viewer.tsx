/**
 * Nintendo 64 model viewer.
 *
 * A thin adapter: `@tootallnate/f3dex` turns a display list into
 * flat vertex/index arrays grouped by texture state, and this maps
 * those onto the shared {@link RenderableMesh} shape and hands them
 * to the canonical {@link MeshViewer}. Camera framing, orbit
 * controls, the wireframe / normals overlays, and STL export all
 * come from there — same as the PhyreEngine and Unreal viewers.
 *
 * Two N64-specific mappings are worth noting:
 *
 *  • Shading source. A display list either lights its geometry
 *    (`G_LIGHTING` on, so the vertex's last three bytes are a
 *    normal) or shades it with per-vertex colours. We forward
 *    whichever the source used and leave the other undefined, which
 *    is exactly how `MeshViewer` picks between a lit material and
 *    unlit `vertexColors`.
 *
 *  • Coordinates. N64 model space is Y-up like Three.js, and vertex
 *    positions are s16 so they can run to thousands of units.
 *    `MeshViewer` frames the camera off the bounding sphere, so no
 *    rescaling is needed.
 */
import { useMemo } from "react"
import type { Node } from "~/lib/archive"
import { n64Lod } from "~/lib/media/model-assets"
import type { N64ModelView } from "~/lib/preview"
import {
  MeshViewer,
  type RenderableMesh,
  type RenderableMeshLOD,
  type RenderableMeshSection,
} from "./mesh-viewer"

/** Shared with the media library's headless loader (`~/lib/media/model-assets`). */
function adaptMesh(view: N64ModelView): RenderableMeshLOD {
  const { mesh } = view
  return { ...n64Lod(view), label: `${(mesh.positions.length / 3).toLocaleString()} verts, ${(mesh.indices.length / 3).toLocaleString()} tris` }
}

export function N64ModelViewer({
  node,
  view,
}: {
  node: Node
  view: N64ModelView
}) {
  const renderable: RenderableMesh = useMemo(
    () => ({
      lods: [adaptMesh(view)],
      // N64 model space is Y-up, matching Three.js.
      upAxis: "y-up",
    }),
    [view],
  )

  const infoText = useMemo(() => {
    const parts = [
      `${view.microcode.toUpperCase()}`,
      `${view.triangleCount.toLocaleString()} triangles`,
      `${view.mesh.materials.length} material${view.mesh.materials.length === 1 ? "" : "s"}`,
    ]
    if (view.texturedMaterials > 0) {
      parts.push(`${view.texturedMaterials} textured`)
    }
    if (view.externalTextures > 0) {
      // Worth stating explicitly: an untextured N64 model usually
      // means the texture lives in a runtime-bound segment, not
      // that decoding failed.
      parts.push(`${view.externalTextures} texture(s) in another segment`)
    }
    if (view.mesh.usesLighting) parts.push("lit")
    else parts.push("vertex-coloured")
    if (view.mesh.displayListCount > 0) {
      parts.push(`${view.mesh.displayListCount} nested DL`)
    }
    if (view.mesh.truncated) parts.push(`truncated: ${view.mesh.truncationReason}`)
    return parts.join(" · ")
  }, [view])

  return (
    <MeshViewer
      mesh={renderable}
      materialDiffuseTextures={
        view.texturedMaterials > 0 ? view.textures : undefined
      }
      infoText={infoText}
      baseName={node.name}
    />
  )
}
