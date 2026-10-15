/**
 * Bandai Namco NUD model viewer (Pokkén Tournament DX): a thin adapter
 * onto the shared {@link MeshViewer}.
 *
 * Animation is CPU-driven: each OMO clip is parsed when first selected,
 * then every frame poses the VBN skeleton and linear-blend skins the
 * bind-pose positions and normals into the mounted geometry. Clips play
 * at 60 fps; characters open on their idle clip.
 */
import { useMemo } from "react"
import type { Omo } from "@tootallnate/nu3"
import type * as THREE from "three"

import type { Node } from "~/lib/archive"
import { nu3PoseMatrices, skinNu3, type Nu3ModelView, type Nu3Skin } from "~/lib/pokken"

import { MeshViewer, type MeshViewerAnimationDriver } from "./mesh-viewer"

function makeDriver(skin: Nu3Skin): MeshViewerAnimationDriver {
  const { skeleton } = skin
  const loaded = new Map<number, Omo>()
  const loading = new Set<number>()
  let lastGeom: THREE.BufferGeometry | null = null
  let lastIndex = -1
  let lastFrame = 0

  const apply = (geom: THREE.BufferGeometry, index: number, frame: number) => {
    const omo = index >= 0 ? loaded.get(index) ?? null : null
    if (index >= 0 && !omo) return
    const pos = geom.getAttribute("position")
    const nrm = geom.getAttribute("normal")
    skinNu3(skin, nu3PoseMatrices(skeleton, omo, frame), pos.array as Float32Array, nrm ? (nrm.array as Float32Array) : null)
    pos.needsUpdate = true
    if (nrm) nrm.needsUpdate = true
    geom.computeBoundingSphere()
  }

  return {
    category: "Animation",
    animations: skeleton.clips.map((c) => ({ name: c.name, frameCount: Math.max(1, c.frameCount), loop: true, fps: 60 })),
    defaultIndex: skin.defaultClip,
    sample(index, frame, ctx) {
      const geom = ctx.geometry
      if (!geom) return
      lastGeom = geom
      lastIndex = index
      lastFrame = frame
      if (index >= 0 && !loaded.has(index) && !loading.has(index)) {
        loading.add(index)
        skeleton.clips[index]!
          .load()
          .then((omo) => {
            loaded.set(index, omo)
            if (lastGeom && lastIndex === index) apply(lastGeom, index, lastFrame)
          })
          .catch(() => {})
          .finally(() => loading.delete(index))
      }
      apply(geom, index, frame)
    },
  }
}

export function Nu3ModelViewer({ node, view }: { node: Node; view: Nu3ModelView }) {
  const drivers = useMemo(() => (view.skin && view.skin.skeleton.clips.length > 0 ? [makeDriver(view.skin)] : undefined), [view])
  return (
    <MeshViewer
      mesh={view.mesh}
      materialDiffuseTextures={view.textures}
      baseName={node.name.replace(/\.[^.]+$/, "")}
      animationDrivers={drivers}
    />
  )
}
