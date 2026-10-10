/**
 * Melee HSDArchive model viewer.
 *
 * A thin adapter, in the same spirit as {@link ./j3d-model-viewer.tsx}:
 * `@tootallnate/hsd` walks the joint hierarchy, flattens the GX display lists
 * hanging off it into typed arrays, and this hands them to the shared
 * {@link MeshViewer}.
 *
 * Two notes specific to this format:
 *
 *  • Normals. HSD stores them as signed bytes with a fixed-point fraction, and
 *    they decode to unit length — so they're forwarded rather than recomputed.
 *
 *  • Materials. The chain from a drawable to an image is
 *    `DObj -> MObj -> TObj -> ImageDesc`, resolved in the same walk that
 *    builds the geometry so section and slot indices stay in step. The first
 *    texture object that yields a decodable image is taken as the diffuse
 *    layer; multi-stage TEV blending isn't reproduced.
 *
 *  • Coordinates. HSD model space is Y-up like Three.js. Positions are
 *    fixed-point s16, and the scale varies a lot between characters; MeshViewer
 *    frames off the bounding sphere, so nothing needs normalising.
 */
import { useMemo } from "react"

import type { Node } from "~/lib/archive"
import { hsdLod } from "~/lib/media/model-assets"
import type { HsdModelView } from "~/lib/preview"
import {
  MeshViewer,
  type RenderableMesh,
  type RenderableMeshLOD,
} from "./mesh-viewer"

/** Shared with the media library's headless loader (`~/lib/media/model-assets`). */
function adaptMesh(view: HsdModelView): RenderableMeshLOD {
  const { mesh } = view
  return { ...hsdLod(view), label: `${mesh.numVertices.toLocaleString()} verts, ${view.triangleCount.toLocaleString()} tris` }
}

export function HsdModelViewer({
  node,
  view,
}: {
  node: Node
  view: HsdModelView
}) {
  const renderable: RenderableMesh = useMemo(
    () => ({ lods: [adaptMesh(view)], upAxis: "y-up" }),
    [view],
  )
  const infoText = useMemo(() => {
    const parts = [
      `${view.triangleCount.toLocaleString()} triangles`,
      `${view.jointCount} joints`,
    ]
    parts.push(view.hasNormals ? "lit" : "no normals (flat-shaded)")
    const slots = view.textures.filter((t) => t !== null).length
    if (slots > 0) {
      parts.push(
        `${slots} texture${slots === 1 ? "" : "s"}`,
        `${view.texturedSections}/${view.mesh.sections.length} sections textured`,
      )
    } else if (view.hasUv) {
      parts.push("textured UVs")
    }
    return parts.join(" · ")
  }, [view])

  return (
    <MeshViewer
      mesh={renderable}
      infoText={infoText}
      baseName={node.name}
      materialDiffuseTextures={view.textures}
    />
  )
}
