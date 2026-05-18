/**
 * Thin wrapper around the generic {@link MeshViewer} for
 * PhyreEngine `.dae.phyre` 3D models. Adapts the parsed phyre
 * mesh into the format-neutral `RenderableMesh` interface used
 * by the shared viewer, then resolves sibling `.dds.phyre`
 * textures referenced by the model's `PAssetReferenceImport`
 * instances and hands them off as material slots.
 *
 * Phyre meshes (as of the FFX HD Remaster decoding):
 *   - One implicit "LOD 0"; the in-file PMesh has no LOD chain
 *     (LODs are tracked separately by `PLODLevel` / `PLODGroup`
 *     instances we don't currently surface).
 *   - One segment per material; each segment carries its own
 *     vertex buffer pool (no shared vertex pool across segments
 *     except in the multi-material-on-one-vertex-buffer case
 *     we haven't specialised for yet).
 *   - We don't yet decode the normal / UV / tangent streams —
 *     the generic viewer auto-computes flat normals from face
 *     geometry via {@link THREE.BufferGeometry#computeVertexNormals}.
 *     Without UVs we can't sample the textures we've resolved
 *     yet; that's the next step.
 *
 * # Texture resolution
 *
 * The model file embeds references like
 * `PS3Data/chr/npc/n142/tex/n142.dds`; the actual asset on disk
 * is `…/n142/tex/nvn/n142.dds.phyre`. We walk up to the model's
 * grand-parent (`mdl/` → `n142/`) and then search the sibling
 * `tex/nvn/` directory by stem match. Multiple texture refs map
 * to one material slot per `PMaterial`, in declaration order.
 *
 * # Orientation
 *
 * FFX HD Remaster phyre meshes are authored with `+Y = down`
 * (head ends up at `-Y`, feet at `+Y`). Verified empirically by
 * rendering m199 with texturing applied — the body parts
 * appeared rotated 180° around the Z axis when displayed under
 * Three.js's default `+Y = up` convention.
 *
 * The viewer defaults to **Flip Y enabled** for phyre meshes;
 * the toolbar checkbox lets the user toggle if a different
 * PhyreEngine title turns out to use the opposite convention.
 */

import { useEffect, useMemo, useState } from "react"

import type { Node } from "~/lib/archive"
import {
  decodePhyreTextureForMaterial,
  type PhyreMeshView,
} from "~/lib/preview"
import type { DecodedTexture } from "~/lib/uasset-material-chain"

import {
  MeshViewer,
  type RenderableMesh,
  type RenderableMeshLOD,
  type RenderableMeshSection,
} from "./mesh-viewer"

interface Props {
  node: Node
  /**
   * Archive root, used for sibling-texture discovery. When
   * omitted, the viewer still renders geometry but skips
   * texture resolution and falls back to normal shading.
   */
  root?: Node | null
  view: PhyreMeshView
}

/**
 * Convert a {@link PhyreMeshView} into a single `RenderableMeshLOD`
 * by concatenating per-segment vertex buffers into one flat array.
 *
 * Each phyre segment has its own (potentially overlapping) vertex
 * pool, so we rebase each segment's indices into a global pool
 * via a per-segment vertex offset. Sections retain their original
 * `materialIndex` from the phyre file so the toolbar / future
 * material-resolve step can correlate back to `PMaterialSet`.
 */
function adaptMesh(view: PhyreMeshView): RenderableMeshLOD {
  let totalVerts = 0
  let totalIndices = 0
  let hasAnyUVs = false
  let hasAnyNormals = false
  for (const seg of view.segments) {
    totalVerts += seg.positions.length / 3
    totalIndices += seg.indices.length
    if (seg.uvs) hasAnyUVs = true
    if (seg.normals) hasAnyNormals = true
  }

  const positions = new Float32Array(totalVerts * 3)
  // Allocate UV/normal buffers only when at least one segment
  // has them; segments without UVs/normals fall back to zero
  // (= flat-shaded face normals computed by Three.js for the
  // missing-normals case).
  const uv = hasAnyUVs ? new Float32Array(totalVerts * 2) : undefined
  const normals = hasAnyNormals ? new Float32Array(totalVerts * 3) : undefined
  const indices = new Uint32Array(totalIndices)
  const sections: RenderableMeshSection[] = []

  let vertCursor = 0
  let idxCursor = 0
  for (const seg of view.segments) {
    const segVertCount = seg.positions.length / 3
    positions.set(seg.positions, vertCursor * 3)
    if (uv && seg.uvs) uv.set(seg.uvs, vertCursor * 2)
    if (normals && seg.normals) normals.set(seg.normals, vertCursor * 3)
    for (let i = 0; i < seg.indices.length; i++) {
      indices[idxCursor + i] = seg.indices[i] + vertCursor
    }
    sections.push({
      materialIndex: seg.segment.materialIndex,
      firstIndex: idxCursor,
      numTriangles: Math.floor(seg.indices.length / 3),
    })
    vertCursor += segVertCount
    idxCursor += seg.indices.length
  }

  return {
    numVertices: totalVerts,
    positions,
    normals,
    uv,
    indices,
    sections,
    label: `${totalVerts.toLocaleString()} verts, ${(totalIndices / 3).toLocaleString()} tris`,
  }
}

/**
 * Find a sibling `<base>.dds.phyre` Node in the same archive
 * directory as the current model. Walks up from the model node
 * to its parent directory and searches.
 *
 * Phyre HD Remaster paths look like:
 *   chr/npc/n142/mdl/nvn/n142.dae.phyre  (the model)
 *   chr/npc/n142/tex/nvn/n142.dds.phyre  (the textures)
 *
 * So we walk up to `n142/` (two levels: mdl → nvn → n142) and
 * search inside its `tex/nvn/` subdirectory.
 */
async function findPhyreTextureNode(
  root: Node,
  modelNode: Node,
  textureStem: string,
): Promise<Node | null> {
  // Climb up to the model's grand-grand-parent directory and try
  // a `tex/nvn/` sibling. Failing that, fall back to scanning
  // every directory under the model's grand-parent for a match.
  const ids: string[] = []
  let cur = modelNode.id
  while (cur && cur !== root.id) {
    const slash = cur.lastIndexOf("/")
    if (slash <= 0) break
    cur = cur.slice(0, slash)
    ids.push(cur)
  }
  for (const id of ids) {
    const node = await findNodeById(root, id)
    if (!node || !node.getChildren) continue
    const found = await findStemInTree(node, textureStem, 4)
    if (found) return found
  }
  return null
}

/**
 * Find a child node anywhere under `start` whose name matches
 * `<textureStem>.dds.phyre`. Bounded by `maxDepth` so we don't
 * recurse forever through very deep archive trees.
 */
async function findStemInTree(
  start: Node,
  textureStem: string,
  maxDepth: number,
): Promise<Node | null> {
  const target = `${textureStem.toLowerCase()}.dds.phyre`
  const queue: Array<{ node: Node; depth: number }> = [
    { node: start, depth: 0 },
  ]
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!
    if (!node.getChildren) continue
    let kids = node._children
    if (!kids) {
      try {
        kids = await node.getChildren()
        node._children = kids
      } catch {
        continue
      }
    }
    for (const k of kids) {
      if (k.name.toLowerCase() === target) return k
      if (depth + 1 <= maxDepth && k.getChildren) {
        queue.push({ node: k, depth: depth + 1 })
      }
    }
  }
  return null
}

/**
 * Walk the archive tree to find a node by id. Mirrors the
 * helper used by the BFRES viewer — kept local here to avoid a
 * circular import via preview-pane.
 */
async function findNodeById(
  root: Node,
  target: string,
): Promise<Node | null> {
  if (root.id === target) return root
  if (target !== "" && !target.startsWith(root.id + "/") && root.id !== "") {
    return null
  }
  let cur: Node = root
  while (cur.id !== target) {
    if (!cur.getChildren) return null
    const kids = cur._children ?? (cur._children = await cur.getChildren())
    let next: Node | null = null
    for (const k of kids) {
      if (k.id === target || target.startsWith(k.id + "/")) {
        if (!next || k.id.length > next.id.length) next = k
      }
    }
    if (!next) return null
    cur = next
  }
  return cur
}

export function PhyreMeshViewer({ node, root, view }: Props) {
  const renderable: RenderableMesh = useMemo(
    () => ({
      lods: [adaptMesh(view)],
      upAxis: "y-up",
      // FFX HD Remaster phyre meshes are authored with +Y = down
      // (verified by rendering m199, n142, and others — head
      // ends up at -Y, feet at +Y when not flipped). Set the
      // default to Flip Y; the toolbar checkbox lets the user
      // override if a future title uses the opposite convention.
      flipYDefault: true,
    }),
    [view],
  )

  const info = useMemo(() => {
    const segCount = view.segments.length
    return `${segCount} segment${segCount === 1 ? "" : "s"}`
  }, [view])

  // Resolve sibling .dds.phyre textures referenced by the model.
  // The model's PMaterialSet binds N materials by material slot
  // index, and the PAssetReference list gives us texture file
  // paths in declaration order. Phyre has no explicit
  // material→texture map in the data we've decoded, but the
  // FFX HD authoring convention is:
  //   - First texture = main body / albedo (used by most materials)
  //   - Subsequent textures = face animation / variant atlases
  //     (used by individual `m_texAnimID`-driven materials)
  //
  // Until we decode `PShaderParameterCaptureBufferTexture2D` to
  // map textures to specific material slots properly, we
  // broadcast the first texture to every material slot — that's
  // the right thing for static-pose previews of single-material
  // characters (the n142 head + body + clothes all share
  // n142.dds in-game). Animated face textures (n142_anim_*) get
  // dropped on the floor here; the corresponding material slot
  // will show the body texture instead, which is more useful
  // than rendering it untextured.
  const [textures, setTextures] = useState<Array<DecodedTexture | null>>([])

  useEffect(() => {
    if (!root) return
    let cancelled = false
    ;(async () => {
      const textureRefs = view.assetRefs.filter((r) => r.isTexture)
      if (textureRefs.length === 0) return
      // Material slot count = highest materialIndex + 1 across
      // all segments. (Some material slots may not be drawn but
      // we still allocate them to avoid out-of-range lookups.)
      let maxMaterialIdx = 0
      for (const seg of view.segments) {
        if (seg.segment.materialIndex > maxMaterialIdx) {
          maxMaterialIdx = seg.segment.materialIndex
        }
      }
      const slotCount = maxMaterialIdx + 1
      // Decode all referenced textures (parallel).
      const decoded = await Promise.all(
        textureRefs.map(async (ref) => {
          const stem = ref.name.replace(/\.dds$/i, "")
          const texNode = await findPhyreTextureNode(root, node, stem)
          if (!texNode || !texNode.blob) return null
          const blob = await texNode.blob()
          return decodePhyreTextureForMaterial(blob, ref.path)
        }),
      )
      // Pick the first successfully-decoded texture as the
      // default for all material slots.
      const primary = decoded.find((d) => d != null) ?? null
      const perSlot: Array<DecodedTexture | null> = []
      for (let i = 0; i < slotCount; i++) perSlot.push(primary)
      if (!cancelled) setTextures(perSlot)
    })()
    return () => {
      cancelled = true
    }
  }, [view, node.id, root])

  return (
    <MeshViewer
      mesh={renderable}
      materialDiffuseTextures={textures.length > 0 ? textures : undefined}
      infoText={info}
      baseName={node.name}
    />
  )
}
