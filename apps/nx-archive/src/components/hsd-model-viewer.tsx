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
import type { HsdModelView } from "~/lib/preview"
import {
  MeshViewer,
  type RenderableMesh,
  type RenderableMeshLOD,
} from "./mesh-viewer"

function adaptMesh(view: HsdModelView): RenderableMeshLOD {
  const { mesh } = view
  return {
    numVertices: mesh.numVertices,
    positions: mesh.positions,
    normals: mesh.normals,
    uv: mesh.uv,
    indices: mesh.indices,
    // One section per display object, each carrying the material slot its
    // MObj/TObj chain resolved to. A section whose chain didn't resolve keeps
    // materialIndex -1 and renders untextured rather than borrowing a
    // neighbour's texture.
    sections: mesh.sections.length
      ? mesh.sections.map((s) => ({
          materialIndex: s.materialIndex,
          firstIndex: s.indexOffset,
          numTriangles: s.indexCount / 3,
        }))
      : [
          {
            materialIndex: -1,
            firstIndex: 0,
            numTriangles: mesh.indices.length / 3,
          },
        ],
    label: `${mesh.numVertices.toLocaleString()} verts, ${view.triangleCount.toLocaleString()} tris`,
  }
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
