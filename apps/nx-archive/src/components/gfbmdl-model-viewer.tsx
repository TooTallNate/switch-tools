/**
 * Game Freak GFBMDL (Pokémon: Let's Go) model viewer — a thin adapter
 * onto the shared {@link MeshViewer}.
 *
 * The view's mesh gives every polygon its own vertices with UVs already
 * transformed into the game's sample space, so materials map 1:1 onto
 * viewer sections. Animation is CPU-driven through one
 * {@link MeshViewerAnimationDriver}: each frame poses the skeleton,
 * linear-blend skins positions + normals into the mounted geometry,
 * re-bakes UVs for materials whose UV parameters are animated (that's
 * how eye / mouth expressions switch), and collapses groups hidden by
 * visibility tracks.
 */
import { useMemo } from "react"
import {
  GfbmdlPose,
  colorUvTransform,
  groupVisibility,
  materialValues,
  type GfbmdlUvTransform,
} from "@tootallnate/gfbmdl"

import type { Node } from "~/lib/archive"
import { bakeSectionUvs, type GfbmdlModelView } from "~/lib/gfbmdl-view"

import {
  MeshViewer,
  type MeshViewerAnimationDriver,
  type RenderableMesh,
} from "./mesh-viewer"

/** Viewer ticks at 60 fps; clips are authored at `anim.fps`. */
const VIEWER_FPS = 60

const sameTransform = (a: GfbmdlUvTransform, b: GfbmdlUvTransform) =>
  a.scaleU === b.scaleU &&
  a.scaleV === b.scaleV &&
  a.translateU === b.translateU &&
  a.translateV === b.translateV &&
  a.baseU === b.baseU &&
  a.baseV === b.baseV

function makeDriver(view: GfbmdlModelView): MeshViewerAnimationDriver {
  const { model, mesh, clips } = view
  const pose = new GfbmdlPose(model, mesh)
  // UV transforms currently baked into the geometry, per material.
  let applied = view.uvTransforms.slice()
  return {
    category: "Animation",
    defaultIndex: view.defaultClip,
    animations: clips.map((c) => ({
      name: c.name,
      frameCount: Math.max(
        1,
        Math.round(((c.anim.frameCount - 1) * VIEWER_FPS) / c.anim.fps) + 1,
      ),
      loop: true,
    })),
    sample(index, frame, ctx) {
      const geom = ctx.geometry
      if (!geom) return
      const clip = clips[index] ?? null
      const anim = clip?.anim ?? null
      const f = anim
        ? Math.min(anim.frameCount - 1, (frame * anim.fps) / VIEWER_FPS)
        : 0

      pose.setPose(anim, f)
      const pos = geom.getAttribute("position")
      const nrm = geom.getAttribute("normal")
      pose.skin(
        pos.array as Float32Array,
        nrm && mesh.normals ? (nrm.array as Float32Array) : null,
        groupVisibility(model, anim, f) ?? undefined,
      )
      pos.needsUpdate = true
      if (nrm) nrm.needsUpdate = true

      // Material UV animation (expressions).
      const uvAttr = geom.getAttribute("uv")
      if (uvAttr && mesh.uv0) {
        const animated = materialValues(anim, f)
        let dirty = false
        const next = model.materials.map((m, i) => {
          const over = animated.get(m.name)
          return over
            ? colorUvTransform({ ...m, values: { ...m.values, ...over } })
            : view.uvTransforms[i]!
        })
        next.forEach((t, i) => {
          if (!sameTransform(t, applied[i]!)) {
            bakeSectionUvs(mesh, next, uvAttr.array as Float32Array, i)
            dirty = true
          }
        })
        applied = next
        if (dirty) uvAttr.needsUpdate = true
      }
    },
  }
}

export function GfbmdlModelViewer({
  node,
  view,
}: {
  node: Node
  view: GfbmdlModelView
}) {
  const renderable: RenderableMesh = useMemo(
    () => ({
      lods: [
        {
          numVertices: view.mesh.numVertices,
          // Copies: the animation driver skins into these in place,
          // while the view keeps the bind pose.
          positions: Float32Array.from(view.mesh.positions),
          normals: view.mesh.normals
            ? Float32Array.from(view.mesh.normals)
            : undefined,
          uv: view.uv ? Float32Array.from(view.uv) : undefined,
          indices: view.indices,
          sections: view.sections,
          label: `${view.mesh.numVertices.toLocaleString()} verts, ${(view.indices.length / 3).toLocaleString()} tris`,
        },
      ],
      // GFLX model space is Y-up, like Three.js.
      upAxis: "y-up",
    }),
    [view],
  )

  const drivers = useMemo(
    () => (view.clips.length > 0 ? [makeDriver(view)] : undefined),
    [view],
  )

  const infoText = useMemo(() => {
    const m = view.model
    const parts = [
      `${(view.indices.length / 3).toLocaleString()} triangles`,
      `${m.materials.length} material${m.materials.length === 1 ? "" : "s"}`,
      `${m.bones.length} bones`,
    ]
    if (view.textureNamesWanted > 0) {
      parts.push(`${view.textureNamesFound}/${view.textureNamesWanted} textured`)
    }
    if (view.clips.length > 0) {
      parts.push(`${view.clips.length} animation${view.clips.length === 1 ? "" : "s"}`)
    }
    if (view.hiddenMaterials > 0) {
      parts.push(`${view.hiddenMaterials} FX/shadow material${view.hiddenMaterials === 1 ? "" : "s"} hidden`)
    }
    return parts.join(" · ")
  }, [view])

  return (
    <MeshViewer
      mesh={renderable}
      materialDiffuseTextures={view.textures}
      materialBaseColors={view.baseColors}
      infoText={infoText}
      animationDrivers={drivers}
      baseName={node.name.replace(/\.[^.]+$/, "")}
    />
  )
}
