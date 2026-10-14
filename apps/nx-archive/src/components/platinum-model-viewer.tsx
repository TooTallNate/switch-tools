/**
 * PlatinumGames WMB3 model viewer (Bayonetta 3): a thin adapter onto
 * the shared {@link MeshViewer}.
 *
 * Animation is CPU-driven: each MOT clip in the model's DAT is parsed
 * when first selected, then every frame poses the skeleton
 * ({@link WmbPose}) and linear-blend skins the bind-pose positions and
 * normals into the mounted geometry. Clips play at 60 fps, the
 * games' animation rate.
 */
import { useMemo } from "react"
import type { Mot } from "@tootallnate/platinum"
import type * as THREE from "three"

import type { Node } from "~/lib/archive"
import type { PlatinumModelView } from "~/lib/platinum"

import { MeshViewer, type MeshViewerAnimationDriver } from "./mesh-viewer"

function makeDriver(view: PlatinumModelView): MeshViewerAnimationDriver {
  const { data, pose, clips } = view
  const loaded = new Map<number, Mot>()
  const loading = new Set<number>()
  let lastGeom: THREE.BufferGeometry | null = null
  let lastIndex = -1
  let lastFrame = 0

  const apply = (geom: THREE.BufferGeometry, index: number, frame: number) => {
    const mot = index >= 0 ? loaded.get(index) ?? null : null
    if (index >= 0 && !mot) return
    pose.setPose(mot, mot ? Math.min(mot.frameCount - 1, frame) : 0)
    const pos = geom.getAttribute("position")
    const nrm = geom.getAttribute("normal")
    pose.skin(
      data.positions,
      nrm ? data.normals : null,
      data.skinBones,
      data.skinWeights,
      pos.array as Float32Array,
      nrm ? (nrm.array as Float32Array) : null,
    )
    pos.needsUpdate = true
    if (nrm) nrm.needsUpdate = true
    geom.computeBoundingSphere()
  }

  return {
    category: "Animation",
    animations: clips.map((c) => ({ name: c.name, frameCount: Math.max(1, c.frameCount), loop: true, fps: 60 })),
    sample(index, frame, ctx) {
      const geom = ctx.geometry
      if (!geom) return
      lastGeom = geom
      lastIndex = index
      lastFrame = frame
      if (index >= 0 && !loaded.has(index) && !loading.has(index)) {
        loading.add(index)
        clips[index]!
          .load()
          .then((mot) => {
            loaded.set(index, mot)
            if (lastGeom && lastIndex === index) apply(lastGeom, index, lastFrame)
          })
          .catch(() => {})
          .finally(() => loading.delete(index))
      }
      apply(geom, index, frame)
    },
  }
}

export function PlatinumModelViewer({ node, view }: { node: Node; view: PlatinumModelView }) {
  const drivers = useMemo(() => (view.clips.length > 0 ? [makeDriver(view)] : undefined), [view])
  const info = useMemo(() => {
    const lod = view.mesh.lods[0]!
    const tris = lod.sections.reduce((n, s) => n + s.numTriangles, 0)
    const parts = [
      `${lod.numVertices.toLocaleString()} vertices`,
      `${tris.toLocaleString()} triangles`,
      `${view.wmb.materials.length} material${view.wmb.materials.length === 1 ? "" : "s"}`,
      `${view.wmb.bones.length} bones`,
    ]
    if (view.texturesWanted > 0) parts.push(`${view.texturesFound}/${view.texturesWanted} textured`)
    if (view.clips.length > 0) parts.push(`${view.clips.length} animation${view.clips.length === 1 ? "" : "s"}`)
    if (view.hidden > 0) parts.push(`${view.hidden} FX section${view.hidden === 1 ? "" : "s"} hidden`)
    return parts.join(" · ")
  }, [view])
  return (
    <MeshViewer
      mesh={view.mesh}
      materialDiffuseTextures={view.textures}
      infoText={info}
      animationDrivers={drivers}
      baseName={node.name.replace(/\.[^.]+$/, "")}
    />
  )
}
