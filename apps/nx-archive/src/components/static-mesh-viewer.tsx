/**
 * Thin wrapper around the generic {@link MeshViewer} for UE
 * StaticMesh assets. Adapts the parsed `LoadedStaticMesh` shape
 * to the format-neutral `RenderableMesh` interface; the actual
 * viewport plumbing (renderer lifecycle, orbit controls, framing,
 * material slots, wireframe + normals overlays, LOD picker)
 * lives in {@link ./mesh-viewer.tsx}.
 *
 * Kept as a separate export so callers don't need to know about
 * the underlying generic viewer.
 */

import { useMemo } from "react"

import type { LoadedStaticMesh, StaticMeshLOD } from "@tootallnate/uasset"

import type { DecodedTexture } from "~/lib/uasset-material-chain"

import { MeshViewer, type RenderableMesh, type RenderableMeshLOD } from "./mesh-viewer"

interface Props {
  mesh: LoadedStaticMesh
  /**
   * Optional per-section diffuse textures. Index matches
   * `mesh.lods[*].sections[i].materialIndex`; entries may be `null`
   * if the material chain didn't resolve a usable texture (engine
   * default, unsupported pixel format, etc.).
   */
  materialDiffuseTextures?: Array<DecodedTexture | null>
}

/**
 * Convert one parsed UE LOD into the generic `RenderableMeshLOD`.
 * Re-uses the parser's typed arrays (no copies) and exposes the
 * first UV channel for textured rendering.
 */
function adaptLOD(lod: StaticMeshLOD, lodIndex: number): RenderableMeshLOD {
  return {
    numVertices: lod.numVertices,
    positions: lod.positions,
    normals: lod.normals,
    uv: lod.uvs[0],
    indices: lod.indices,
    sections: lod.sections.map((sec) => ({
      materialIndex: sec.materialIndex,
      firstIndex: sec.firstIndex,
      numTriangles: sec.numTriangles,
    })),
    label: `${lodIndex}: ${lod.numVertices.toLocaleString()} verts, ${(lod.indices.length / 3).toLocaleString()} tris`,
  }
}

export function StaticMeshViewer({ mesh, materialDiffuseTextures }: Props) {
  const renderable: RenderableMesh = useMemo(
    () => ({
      lods: mesh.lods.map(adaptLOD),
      // UE uses a left-handed Z-up coordinate system; rotate -90°
      // around X so models stand upright in Y-up world space.
      upAxis: "z-up",
    }),
    [mesh],
  )

  // Top-section info label (mirrors the original viewer's
  // "N sections · vertex colors" line). Driven by the currently
  // selected LOD's first entry — the generic viewer manages LOD
  // selection state internally, so we just show LOD 0's info as
  // a coarse hint.
  const info = useMemo(() => {
    const lod = mesh.lods[0]
    if (!lod) return undefined
    return `${lod.sections.length} section${lod.sections.length === 1 ? "" : "s"}${lod.colors ? " · vertex colors" : ""}`
  }, [mesh])

  return (
    <MeshViewer
      mesh={renderable}
      materialDiffuseTextures={materialDiffuseTextures}
      infoText={info}
    />
  )
}
