/**
 * Unity `Mesh` viewer: a thin adapter from
 * `@tootallnate/unity-asset`'s {@link UnityMeshGeometry} to the shared
 * {@link MeshViewer}. Each Unity sub-mesh becomes one section bound
 * to the material slot of the same index. That matches how
 * `Renderer.m_Materials[i]` shades sub-mesh `i`.
 *
 * The geometry is expected to be right-handed already (see
 * `toRightHanded`). Unity is Y-up like Three.js, so no axis
 * rotation is needed.
 */
import { useMemo } from "react"
import type { UnityMeshGeometry } from "@tootallnate/unity-asset"

import type { Node } from "~/lib/archive"
import type { DecodedTexture } from "~/lib/uasset-material-chain"

import { MeshViewer, type RenderableMesh } from "./mesh-viewer"

export function UnityMeshViewer({
  node,
  geometry,
  textures,
}: {
  node: Node
  geometry: UnityMeshGeometry
  /** One entry per material slot (sub-mesh index). */
  textures: Array<DecodedTexture | null>
}) {
  const renderable: RenderableMesh = useMemo(() => {
    const triangles = geometry.indices.length / 3
    return {
      upAxis: "y-up",
      lods: [
        {
          numVertices: geometry.vertexCount,
          positions: geometry.positions,
          normals: geometry.normals ?? undefined,
          uv: geometry.uv0 ?? undefined,
          indices: geometry.indices,
          sections: geometry.subMeshes.map((sm, i) => ({
            materialIndex: i,
            firstIndex: sm.firstIndex,
            numTriangles: sm.indexCount / 3,
          })),
          label: `${geometry.vertexCount.toLocaleString()} verts, ${triangles.toLocaleString()} tris`,
        },
      ],
    }
  }, [geometry])

  const infoText = useMemo(() => {
    const parts = [
      `${(geometry.indices.length / 3).toLocaleString()} triangles`,
      `${geometry.subMeshes.length} sub-mesh${geometry.subMeshes.length === 1 ? "" : "es"}`,
    ]
    const textured = textures.filter((t) => t !== null).length
    if (textured > 0) parts.push(`${textured}/${geometry.subMeshes.length} textured`)
    return parts.join(" · ")
  }, [geometry, textures])

  return (
    <MeshViewer
      mesh={renderable}
      infoText={infoText}
      baseName={node.name.replace(/\.mesh\.bin$/i, "")}
      materialDiffuseTextures={textures}
    />
  )
}
