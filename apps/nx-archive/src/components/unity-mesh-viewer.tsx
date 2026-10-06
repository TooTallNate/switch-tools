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

import type { RigClip, UnityPosePlayer } from "~/lib/unity-rig"

import {
  MeshViewer,
  type MeshViewerAnimationDriver,
  type RenderableMesh,
} from "./mesh-viewer"

/** Skinning + clips for a `SkinnedMeshRenderer`'s mesh. */
export interface UnityMeshAnimation {
  player: UnityPosePlayer
  /** Full-body clips (one plays at a time). */
  bodyClips: RigClip[]
  /** Partial overlays (face, hands, …) layered on top of the body clip. */
  overlayClips: RigClip[]
}

/** Clip-local time for viewer frame `frame` (60 fps), looping or clamping. */
function clipTime(clip: RigClip, frame: number): number {
  const t = frame / 60
  const d = clip.clip.duration
  if (d <= 0) return 0
  return clip.clip.loop ? t % d : Math.min(t, d)
}

function defaultClip(clips: RigClip[], names: string[]): number {
  for (const n of names) {
    const i = clips.findIndex((c) => c.clip.name.toLowerCase() === n)
    if (i >= 0) return i
  }
  return -1
}

/**
 * One viewer driver per animation layer. Both drivers feed the same
 * pose player; skinning runs once per tick (coalesced in a microtask)
 * after every layer has been updated.
 */
function makeDrivers(anim: UnityMeshAnimation): MeshViewerAnimationDriver[] {
  let scheduled = false
  let target: import("three").BufferGeometry | null = null
  const flush = () => {
    scheduled = false
    const geom = target
    if (!geom) return
    const pos = geom.getAttribute("position")
    const nrm = geom.getAttribute("normal")
    anim.player.apply(pos.array as Float32Array, nrm ? (nrm.array as Float32Array) : null)
    pos.needsUpdate = true
    if (nrm) nrm.needsUpdate = true
  }
  const layerDriver = (
    layer: number,
    category: string,
    clips: RigClip[],
    defaultIndex: number,
  ): MeshViewerAnimationDriver => ({
    category,
    defaultIndex,
    animations: clips.map((c) => ({
      name: c.clip.name,
      frameCount: Math.max(1, Math.round(c.clip.duration * 60) + 1),
      loop: c.clip.loop,
    })),
    sample(index, frame, ctx) {
      const clip = clips[index] ?? null
      anim.player.setLayer(layer, clip, clip ? clipTime(clip, frame) : 0)
      target = ctx.geometry
      if (!scheduled) {
        scheduled = true
        queueMicrotask(flush)
      }
    },
  })
  const drivers = [
    layerDriver(0, "body", anim.bodyClips, defaultClip(anim.bodyClips, ["idle", "wait", "stand"]) ),
  ]
  if (anim.overlayClips.length > 0) {
    // Overlays start off: face clips like `eye` are blink / expression
    // poses, and the body clip already carries the neutral face.
    drivers.push(layerDriver(1, "overlay", anim.overlayClips, -1))
  }
  // Open posed even when no clip is called "idle".
  if (drivers[0]!.defaultIndex === -1 && anim.bodyClips.length > 0) drivers[0]!.defaultIndex = 0
  return drivers
}

export function UnityMeshViewer({
  node,
  geometry,
  textures,
  baseColors,
  animation,
}: {
  node: Node
  geometry: UnityMeshGeometry
  /** One entry per material slot (sub-mesh index). */
  textures: Array<DecodedTexture | null>
  /** Material base colours (sRGB 0–1) for slots without a texture. */
  baseColors?: Array<[number, number, number] | null>
  /** Skinning + animation clips, when the mesh is drawn by a SkinnedMeshRenderer. */
  animation?: UnityMeshAnimation | null
}) {
  const drivers = useMemo(() => (animation ? makeDrivers(animation) : undefined), [animation])
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
      materialBaseColors={baseColors}
      animationDrivers={drivers}
    />
  )
}
