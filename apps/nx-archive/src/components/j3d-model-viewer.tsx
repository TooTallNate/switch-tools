/**
 * Nintendo J3D (BMD / BDL) model viewer.
 *
 * A thin adapter, in the same spirit as {@link ./n64-model-viewer.tsx}:
 * `@tootallnate/j3d` walks the SHP1 display lists, de-duplicates
 * attribute tuples into unique vertices, and hands back flat typed
 * arrays already grouped into material-bounded sections. All this does
 * is rename the fields onto {@link RenderableMesh} and let the shared
 * {@link MeshViewer} own the renderer, orbit controls, framing,
 * overlays and STL export.
 *
 * Three J3D-specific notes:
 *
 *  • Shading source. Roughly half of Wind Waker's models ship no
 *    normals at all — they're toon-shaded, so lighting was never going
 *    to be evaluated. We forward normals only when present and let
 *    MeshViewer compute flat-shaded ones otherwise. Vertex colours are
 *    a *separate* attribute here (unlike N64, where the normal and
 *    colour share the same bytes), so both can legitimately be set.
 *
 *  • Coordinates. J3D model space is Y-up like Three.js. Positions are
 *    frequently fixed-point s16 scaled by a per-array exponent, so room
 *    geometry can reach hundreds of thousands of units while a
 *    character sits at a few hundred. MeshViewer frames off the
 *    bounding sphere, so no rescaling is needed.
 *
 *  • Materials. A J3D material can bind eight textures across sixteen
 *    programmable TEV stages. We only preview the first bound texture
 *    per material, which is why a model can look flatter here than in
 *    game — the multi-texture blend isn't being reproduced.
 */
import { useMemo } from "react"

import type { Node } from "~/lib/archive"
import type { J3dModelView } from "~/lib/preview"
import {
  MeshViewer,
  type RenderableMesh,
  type RenderableMeshLOD,
  type RenderableMeshSection,
} from "./mesh-viewer"

/** Map a flattened J3D mesh onto the shared mesh shape. */
function adaptMesh(view: J3dModelView): RenderableMeshLOD {
  const { mesh } = view
  const sections: RenderableMeshSection[] = mesh.sections.map((s) => ({
    materialIndex: s.materialIndex,
    firstIndex: s.firstIndex,
    numTriangles: s.numTriangles,
  }))
  return {
    numVertices: mesh.numVertices,
    positions: mesh.positions,
    normals: mesh.normals,
    colors: mesh.colors,
    uv: mesh.uv,
    indices: mesh.indices,
    sections,
    label: `${mesh.numVertices.toLocaleString()} verts, ${view.triangleCount.toLocaleString()} tris`,
  }
}

export function J3dModelViewer({
  node,
  view,
}: {
  node: Node
  view: J3dModelView
}) {
  const renderable: RenderableMesh = useMemo(
    () => ({
      lods: [adaptMesh(view)],
      // J3D model space is Y-up, matching Three.js.
      upAxis: "y-up",
    }),
    [view],
  )

  const infoText = useMemo(() => {
    const parts = [
      view.version,
      `${view.triangleCount.toLocaleString()} triangles`,
      `${view.shapeCount} shape${view.shapeCount === 1 ? "" : "s"}`,
    ]
    if (view.materialNames.length > 0) {
      parts.push(
        `${view.materialNames.length} material${view.materialNames.length === 1 ? "" : "s"}`,
      )
    }
    if (view.textureCount > 0) {
      parts.push(
        `${view.texturedMaterials}/${view.textureCount} textured`,
      )
    }
    if (view.jointCount > 0) {
      parts.push(`${view.jointCount} joints`)
    }
    // Worth stating: a model with no normals is toon-shaded by design,
    // not broken, and the viewer is deriving face normals for it.
    parts.push(view.hasNormals ? "lit" : "no normals (flat-shaded)")
    if (view.hasColors) parts.push("vertex-coloured")
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
