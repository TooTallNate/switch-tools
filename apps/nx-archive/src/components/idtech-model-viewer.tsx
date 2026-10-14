/**
 * DOOM 3 BFG model viewer: static models, map render worlds and MD5
 * skinned meshes on the shared {@link MeshViewer}.
 *
 * MD5 meshes get one animation driver over the `.bmd5anim` clips in
 * their folder: a clip is parsed when first picked, then each frame
 * poses the skeleton and CPU-skins positions and normals into the
 * mounted geometry. Clips play at their own frame rate (24 fps for
 * most of DOOM 3); the viewer opens on an idle clip when there is one.
 */
import { useMemo } from "react"
import type { IdMd5Anim } from "@tootallnate/idtech-models"
import type * as THREE from "three"

import type { Node } from "~/lib/archive"
import { poseIdTechView, type IdTechModelView } from "~/lib/idtech"

import { MeshViewer, type MeshViewerAnimationDriver } from "./mesh-viewer"

function makeDriver(view: IdTechModelView): MeshViewerAnimationDriver {
  const loaded = new Map<number, IdMd5Anim>()
  const loading = new Set<number>()
  let last: { geom: THREE.BufferGeometry; index: number; frame: number } | null = null

  const apply = (geom: THREE.BufferGeometry, index: number, frame: number) => {
    const anim = index >= 0 ? loaded.get(index) ?? null : null
    if (index >= 0 && !anim) return
    const pos = geom.getAttribute("position")
    const nrm = geom.getAttribute("normal")
    poseIdTechView(view, anim, frame, pos.array as Float32Array, nrm ? (nrm.array as Float32Array) : null)
    pos.needsUpdate = true
    if (nrm) nrm.needsUpdate = true
    geom.computeBoundingSphere()
  }

  return {
    category: "Animation",
    defaultIndex: view.defaultClip,
    animations: view.clips.map((c) => ({ name: c.name, frameCount: c.frameCount, loop: true, fps: c.fps })),
    sample(index, frame, ctx) {
      const geom = ctx.geometry
      if (!geom) return
      last = { geom, index, frame }
      if (index >= 0 && !loaded.has(index) && !loading.has(index)) {
        loading.add(index)
        view.clips[index]!
          .load()
          .then((a) => {
            loaded.set(index, a)
            if (last && last.index === index) apply(last.geom, index, last.frame)
          })
          .catch(() => {})
          .finally(() => loading.delete(index))
      }
      apply(geom, index, frame)
    },
  }
}

export function IdTechModelViewer({ node, view }: { node: Node; view: IdTechModelView }) {
  const drivers = useMemo(() => (view.md5 && view.clips.length > 0 ? [makeDriver(view)] : undefined), [view])
  const info = useMemo(() => {
    const parts = [
      `${view.mesh.lods[0]!.numVertices.toLocaleString()} vertices`,
      `${view.triangles.toLocaleString()} triangles`,
      `${view.texturesFound}/${view.texturesWanted} textured`,
    ]
    if (view.areas) parts.push(`${view.areas} areas`)
    if (view.md5) parts.push(`${view.md5.model.joints.length} joints`)
    if (view.clips.length > 0) parts.push(`${view.clips.length} animation${view.clips.length === 1 ? "" : "s"}`)
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
