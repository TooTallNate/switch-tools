/**
 * Preview components for FF7 PC's 3D model file formats:
 *
 *   - `.hrc` skeleton hierarchy (text)
 *   - `.rsd` resource reference (text)
 *   - `.p` binary mesh
 *   - `.tex` texture
 *
 * The HRC preview is the showcase: it follows each bone's RSD
 * reference to its `.p` mesh + `.tex` textures, places the
 * meshes at their bone-bind-pose positions, and renders the
 * full assembled character through the shared {@link MeshViewer}.
 * Falling back to a structured listing when the sibling files
 * aren't available (e.g. when the HRC was opened standalone
 * outside the LGP).
 *
 * The RSD preview surfaces the resolved sibling-file names plus
 * an inline mesh preview if the sibling `.p` is reachable.
 *
 * The P preview renders one mesh in the shared `MeshViewer`
 * (one group flattened into a flat triangle list).
 *
 * The TEX preview shows the decoded image on a transparency-
 * checkerboarded canvas with a `Save .png` link.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type { Node } from "~/lib/archive"
import {
  parseFf7HrcForView,
  parseFf7PForView,
  parseFf7RsdForView,
  parseFf7TexForView,
  ff7ExtractTriangles,
  type Ff7HrcView,
  type Ff7PView,
  type Ff7RsdView,
  type Ff7TexView,
} from "~/lib/preview"
import { formatBytes } from "~/lib/utils"
import type { DecodedTexture } from "~/lib/uasset-material-chain"

import {
  MeshViewer,
  type RenderableMesh,
  type RenderableMeshLOD,
  type RenderableMeshSection,
} from "./mesh-viewer"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"

// ===========================================================================
// Sibling resolution
// ===========================================================================

/**
 * Resolve a sibling file by base name (case-insensitive) inside
 * the same parent directory as `selected`. Used by the HRC
 * composite preview to find `.rsd` / `.p` / `.tex` files
 * referenced by name.
 *
 * Walks the parent node's children list (one level only).
 * Returns `null` if the name isn't found.
 */
async function findSiblingByBaseName(
  root: Node | null,
  selected: Node,
  baseName: string,
): Promise<Node | null> {
  if (!root) return null
  const slash = selected.id.lastIndexOf("/")
  if (slash <= 0) return null
  const parentId = selected.id.slice(0, slash)
  const parent = await findNodeById(root, parentId)
  if (!parent?.getChildren) return null
  const kids = parent._children ?? (parent._children = await parent.getChildren())
  const targetLower = baseName.toLowerCase()
  for (const k of kids) {
    if (k.name.toLowerCase() === targetLower) return k
  }
  return null
}

/**
 * Walk the archive tree to find a node by id. Same shape as the
 * helper used in the phyre / midi previews; keeping a copy here
 * avoids a cross-file circular import.
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

// ===========================================================================
// HRC (skeleton) — composite 3D + tree view
// ===========================================================================

/**
 * Resolved data for one bone in the assembled character:
 * world-space pivot position (after walking the bone chain
 * from `root`) and the geometry/textures attached at that pivot.
 */
interface ResolvedBone {
  name: string
  parent: string
  /** Bind-pose direction this bone extends from its parent. */
  direction: [number, number, number]
  /** World-space pivot at the *child* end of this bone (origin
   *  for any descendants). The bone's mesh is anchored at the
   *  PARENT's pivot, not this one. */
  pivot: [number, number, number]
  /** World-space pivot at the *parent* end of this bone (where
   *  the bone's own mesh is anchored). */
  parentPivot: [number, number, number]
  /** One entry per attached RSD reference. Empty for bones that
   *  only define a joint without geometry. */
  meshes: ResolvedBoneMesh[]
}

interface ResolvedBoneMesh {
  rsdName: string
  rsd: Ff7RsdView | null
  mesh: Ff7PView | null
  /** Per-texture decoded RGBA (top-down origin). Null entries
   *  for texture references the sibling lookup couldn't find. */
  textures: Array<Ff7TexView | null>
}

interface AssembledHrcView {
  hrc: Ff7HrcView
  bones: ResolvedBone[]
  /** True when at least one bone resolved geometry. */
  hasGeometry: boolean
  /** Reasons sibling lookups failed, for the diagnostics panel. */
  warnings: string[]
}

/**
 * Default anatomical direction for an FF7 character bone, used
 * when no `.a` animation file is available to supply a real
 * bind pose. The HRC alone only stores bone LENGTHS — the
 * orientation of each bone comes from its animation, and in
 * the bind pose all bones share the same local direction
 * (effectively collapsed onto a line).
 *
 * To get a recognisable rest pose, we pick a per-bone direction
 * by name. Naming conventions in the FF7 character corpus are
 * extremely consistent (every character uses the same bone
 * names), so the heuristic catches the vast majority of models.
 */
function defaultBoneDirection(name: string): [number, number, number] {
  const n = name.toLowerCase()
  // Spine — extends upward (+Z).
  if (n === "hip" || n === "chest" || n === "head") return [0, 0, 1]
  // Pelvis offsets + legs — extend downward (-Z).
  if (
    n.includes("femur") ||
    n.includes("tibia") ||
    n.includes("foot") ||
    (n.endsWith("_hip") && n !== "hip")
  ) {
    return [0, 0, -1]
  }
  // Left-side arm chain — extends along player's left (+X).
  if (n.startsWith("l_")) return [1, 0, 0]
  // Right-side arm chain — −X.
  if (n.startsWith("r_")) return [-1, 0, 0]
  // Unknown — keep along the spine axis.
  return [0, 0, 1]
}

/**
 * Rotate a mesh-local vertex from its native +Z-extending frame
 * into the bone's world-direction frame. The four supported
 * directions are all axis-aligned, so this is a fixed 3×3
 * rotation matrix lookup with no trig.
 */
function rotateToBoneDir(
  dir: [number, number, number],
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  if (dir[2] === 1) return [x, y, z] // +Z — identity
  if (dir[2] === -1) return [-x, y, -z] // -Z — flip Z (and X to preserve handedness)
  if (dir[0] === 1) return [z, y, -x] // +X — rotate −90° around Y
  if (dir[0] === -1) return [-z, y, x] // -X — rotate +90° around Y
  return [x, y, z]
}

/**
 * Walk the HRC's bone hierarchy, resolving RSD/P/TEX siblings
 * via the archive parent directory.
 *
 * Each bone is given an anatomical bind-pose direction via
 * {@link defaultBoneDirection} (spine up, legs down, arms
 * sideways). Pivots accumulate along those directions; each
 * bone's mesh lives in the bone's local +Z frame and gets
 * rotated into the world direction by {@link rotateToBoneDir}.
 *
 * The result is a recognisable T-pose / standing-rest pose
 * even without an associated `.a` animation file. When `.a`
 * decoding is added later, the first-frame rotations from
 * the animation will replace `defaultBoneDirection`.
 */
async function assembleHrcCharacter(
  hrc: Ff7HrcView,
  root: Node | null,
  selected: Node,
): Promise<AssembledHrcView> {
  const pivots = new Map<string, [number, number, number]>()
  pivots.set("root", [0, 0, 0])
  // Walk in HRC declaration order — parents always come before
  // their children in well-formed FF7 skeletons.
  for (const bone of hrc.bones) {
    const parent = pivots.get(bone.parent) ?? [0, 0, 0]
    const d = defaultBoneDirection(bone.name)
    pivots.set(bone.name, [
      parent[0] + d[0] * bone.length,
      parent[1] + d[1] * bone.length,
      parent[2] + d[2] * bone.length,
    ])
  }

  const warnings: string[] = []
  const bones: ResolvedBone[] = []
  for (const bone of hrc.bones) {
    const pivot = pivots.get(bone.name)!
    const parentPivot = pivots.get(bone.parent) ?? [0, 0, 0]
    const direction = defaultBoneDirection(bone.name)
    const meshes: ResolvedBoneMesh[] = []
    for (const rsdName of bone.rsds) {
      const rsdNode = await findSiblingByBaseName(
        root,
        selected,
        `${rsdName.toLowerCase()}.rsd`,
      )
      if (!rsdNode?.blob) {
        warnings.push(`RSD ${rsdName.toLowerCase()}.rsd not found`)
        meshes.push({ rsdName, rsd: null, mesh: null, textures: [] })
        continue
      }
      const rsd = await parseFf7RsdForView(await rsdNode.blob())
      const pNode = await findSiblingByBaseName(
        root,
        selected,
        `${rsd.ply.toLowerCase()}.p`,
      )
      let mesh: Ff7PView | null = null
      if (pNode?.blob) {
        try {
          mesh = await parseFf7PForView(await pNode.blob())
        } catch (err) {
          warnings.push(
            `Failed to parse ${rsd.ply.toLowerCase()}.p: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      } else {
        warnings.push(`P mesh ${rsd.ply.toLowerCase()}.p not found`)
      }
      const textures: Array<Ff7TexView | null> = []
      for (const texName of rsd.textures) {
        if (!texName) {
          textures.push(null)
          continue
        }
        const texNode = await findSiblingByBaseName(
          root,
          selected,
          `${texName.toLowerCase()}.tex`,
        )
        if (!texNode?.blob) {
          warnings.push(`Texture ${texName.toLowerCase()}.tex not found`)
          textures.push(null)
          continue
        }
        try {
          textures.push(await parseFf7TexForView(await texNode.blob()))
        } catch (err) {
          warnings.push(
            `Failed to decode ${texName.toLowerCase()}.tex: ${err instanceof Error ? err.message : String(err)}`,
          )
          textures.push(null)
        }
      }
      meshes.push({ rsdName, rsd, mesh, textures })
    }
    bones.push({
      name: bone.name,
      parent: bone.parent,
      direction,
      pivot,
      parentPivot,
      meshes,
    })
  }
  const hasGeometry = bones.some((b) => b.meshes.some((m) => m.mesh != null))
  return { hrc, bones, hasGeometry, warnings }
}

/**
 * Build a single `RenderableMesh` from an assembled HRC: every
 * bone's mesh is translated into world space by adding the
 * bone's pivot to each vertex position, and emitted as its own
 * section so the shared MeshViewer can render per-material
 * texture slots.
 *
 * Texture indices on each section are GLOBAL across the whole
 * character, so the `materialDiffuseTextures` we pass to the
 * MeshViewer is a flat list indexed by global section index.
 * `texturesByGlobalIndex` returns that flat list.
 */
function buildCompositeMesh(assembled: AssembledHrcView): {
  mesh: RenderableMesh
  textures: Array<DecodedTexture | null>
} {
  // First pass: count total verts + indices + sections, allocate
  // typed arrays.
  let totalVerts = 0
  let totalTris = 0
  let totalSections = 0
  for (const bone of assembled.bones) {
    for (const m of bone.meshes) {
      if (!m.mesh) continue
      for (const g of m.mesh.groups) {
        totalSections++
        totalTris += g.numPolygons
        totalVerts += g.numPolygons * 3
      }
    }
  }
  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)
  const uvs = new Float32Array(totalVerts * 2)
  const indices = new Uint32Array(totalTris * 3)
  const sections: RenderableMeshSection[] = []
  const textures: Array<DecodedTexture | null> = []

  let vertCursor = 0
  let idxCursor = 0
  let hasAnyUv = false
  let materialSlot = 0
  for (const bone of assembled.bones) {
    const [px, py, pz] = bone.parentPivot
    for (const m of bone.meshes) {
      if (!m.mesh) continue
      for (const g of m.mesh.groups) {
        const tris = ff7ExtractTriangles(m.mesh, g)
        // The bone's mesh is authored in a frame where the bone
        // extends along +Z. Rotate that local frame into the
        // bone's bind-pose direction, then translate to the
        // parent's pivot (where the bone is anchored). Apply the
        // same rotation to the normals so lighting comes out
        // right.
        for (let i = 0; i < tris.positions.length; i += 3) {
          const [rx, ry, rz] = rotateToBoneDir(
            bone.direction,
            tris.positions[i]!,
            tris.positions[i + 1]!,
            tris.positions[i + 2]!,
          )
          positions[(vertCursor + i / 3) * 3 + 0] = rx + px
          positions[(vertCursor + i / 3) * 3 + 1] = ry + py
          positions[(vertCursor + i / 3) * 3 + 2] = rz + pz
        }
        for (let i = 0; i < tris.normals.length; i += 3) {
          const [nx, ny, nz] = rotateToBoneDir(
            bone.direction,
            tris.normals[i]!,
            tris.normals[i + 1]!,
            tris.normals[i + 2]!,
          )
          normals[(vertCursor + i / 3) * 3 + 0] = nx
          normals[(vertCursor + i / 3) * 3 + 1] = ny
          normals[(vertCursor + i / 3) * 3 + 2] = nz
        }
        if (tris.texCoords) {
          uvs.set(tris.texCoords, vertCursor * 2)
          hasAnyUv = true
        }
        for (let i = 0; i < tris.indices.length; i++) {
          indices[idxCursor + i] = tris.indices[i]! + vertCursor
        }
        sections.push({
          materialIndex: materialSlot,
          firstIndex: idxCursor,
          numTriangles: Math.floor(tris.indices.length / 3),
        })
        // Resolve the texture for this section. The P group
        // `textureNumber` indexes into the RSD's texture list;
        // we flatten the (RSD, slot) pair into a global
        // material slot.
        let decoded: DecodedTexture | null = null
        if (g.areTexturesUsed && g.textureNumber < m.textures.length) {
          const tex = m.textures[g.textureNumber]
          if (tex) {
            decoded = {
              packagePath: `${m.rsdName}#${g.textureNumber}`,
              width: tex.width,
              height: tex.height,
              pixels: tex.pixels,
              pixelFormat: tex.paletted ? "TEX8" : `TEX${tex.bitsPerPixel}`,
              normalReconstructed: false,
              // FF7 TEX is already top-down + UVs put V=0 at top
              // of the texture. Three.js's default `flipY=true`
              // would put V=0 at the bottom on GPU, which gives
              // mirrored textures. Disable the flip.
              flipY: false,
            }
          }
        }
        textures.push(decoded)
        vertCursor += tris.positions.length / 3
        idxCursor += tris.indices.length
        materialSlot++
      }
    }
  }

  const lod: RenderableMeshLOD = {
    numVertices: vertCursor,
    positions,
    normals,
    uv: hasAnyUv ? uvs : undefined,
    indices,
    sections,
    label: `${vertCursor.toLocaleString()} verts, ${(idxCursor / 3).toLocaleString()} tris`,
  }
  const renderable: RenderableMesh = {
    lods: [lod],
    // FF7 bones extend along +Z, which becomes +Y up after the
    // viewer's z-up rotation. The bind pose has head at +Y after
    // rotation, BUT chr/npc skeletons are authored with feet at
    // +Z and head near root — so the assembled body extends
    // *downward* from root. Flip Y to put head up.
    upAxis: "z-up",
    flipYDefault: true,
  }
  return { mesh: renderable, textures }
}

export function Ff7HrcPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  // Step 1: parse the HRC (cheap).
  const { loading, data: hrc, error } = useAsync(async () => {
    return parseFf7HrcForView(await node.blob!())
  }, [node.id])

  // Step 2: walk the bone chain + load sibling RSDs/Ps/TEXs.
  // Expensive — only happens once per HRC, and the user can
  // jump straight to the text-tree view if the assembly fails.
  const {
    loading: assembling,
    data: assembled,
    error: assembleError,
  } = useAsync(async () => {
    if (!hrc) return null
    return assembleHrcCharacter(hrc, root, node)
  }, [hrc, node.id, root])

  const [mode, setMode] = useState<"3d" | "tree">("3d")

  if (loading) return <LoadingFiller label="Parsing skeleton…" />
  if (error) return <ErrorFiller error={error} />
  const v = hrc!

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-medium">{node.name}</h2>
          <p className="text-xs text-muted-foreground">
            FF7 skeleton: <code className="font-mono">{v.skeletonName}</code> ·{" "}
            {v.boneCount} bone{v.boneCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            className={`rounded-md border px-2 py-1 ${mode === "3d" ? "bg-accent" : "bg-card"}`}
            onClick={() => setMode("3d")}
          >
            3D
          </button>
          <button
            type="button"
            className={`rounded-md border px-2 py-1 ${mode === "tree" ? "bg-accent" : "bg-card"}`}
            onClick={() => setMode("tree")}
          >
            Skeleton
          </button>
        </div>
      </div>

      {mode === "3d" && (
        <CompositeMeshSection
          assembling={assembling}
          assembled={assembled ?? null}
          assembleError={assembleError ?? null}
          node={node}
        />
      )}
      {mode === "tree" && <BoneTree view={v} />}
    </div>
  )
}

function CompositeMeshSection({
  assembling,
  assembled,
  assembleError,
  node,
}: {
  assembling: boolean
  assembled: AssembledHrcView | null
  assembleError: Error | null
  node: Node
}) {
  const built = useMemo(() => {
    if (!assembled || !assembled.hasGeometry) return null
    return buildCompositeMesh(assembled)
  }, [assembled])

  if (assembling) return <LoadingFiller label="Assembling character…" />
  if (assembleError) return <ErrorFiller error={assembleError} />
  if (!assembled) return null

  if (!assembled.hasGeometry) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4 text-xs">
        <p className="text-sm">No assembled geometry.</p>
        <p className="text-muted-foreground">
          The HRC's bone chain references RSD / P / TEX files that aren't in
          the surrounding archive — open this file from inside an LGP (e.g.
          <code className="ml-1 font-mono">char.lgp</code>) to get the full
          textured 3D character.
        </p>
        {assembled.warnings.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground">
              Missing references ({assembled.warnings.length})
            </summary>
            <ul className="mt-1 ml-4 list-disc font-mono">
              {assembled.warnings.slice(0, 50).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    )
  }

  const lod = built!.mesh.lods[0]!
  return (
    <section className="flex flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {assembled.bones.filter((b) => b.meshes.some((m) => m.mesh)).length}{" "}
          rendered bone
          {assembled.bones.filter((b) => b.meshes.some((m) => m.mesh)).length === 1 ? "" : "s"}{" "}
          · {lod.numVertices.toLocaleString()} verts ·{" "}
          {(lod.indices.length / 3).toLocaleString()} triangles
        </span>
        {assembled.warnings.length > 0 && (
          <details className="ml-auto">
            <summary className="cursor-pointer">
              {assembled.warnings.length} warning
              {assembled.warnings.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1 ml-4 list-disc font-mono">
              {assembled.warnings.slice(0, 30).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {assembled.warnings.length > 30 && (
                <li>… and {assembled.warnings.length - 30} more</li>
              )}
            </ul>
          </details>
        )}
      </div>
      <div className="min-h-[480px] flex-1">
        <MeshViewer
          mesh={built!.mesh}
          materialDiffuseTextures={built!.textures}
          baseName={node.name}
        />
      </div>
    </section>
  )
}

function BoneTree({ view }: { view: Ff7HrcView }) {
  const childrenByParent = useMemo(() => {
    const map = new Map<string, typeof view.bones>()
    for (const b of view.bones) {
      const list = map.get(b.parent) ?? []
      list.push(b)
      map.set(b.parent, list)
    }
    return map
  }, [view])

  const renderBone = (parentName: string, depth: number): ReactNode[] => {
    const bones = childrenByParent.get(parentName) ?? []
    return bones.flatMap((b) => [
      <div
        key={b.name}
        className="flex flex-col gap-0.5 border-l py-1 pl-3 text-xs"
        style={{ marginLeft: depth * 12 }}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">{b.name}</span>
          <span className="text-muted-foreground">
            length {b.length.toFixed(2)}
          </span>
          {b.rsds.length > 0 && (
            <span className="text-muted-foreground">
              · {b.rsds.length} mesh ref{b.rsds.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {b.rsds.length > 0 && (
          <div className="text-muted-foreground font-mono">
            RSDs: {b.rsds.join(", ")}
          </div>
        )}
      </div>,
      ...renderBone(b.name, depth + 1),
    ])
  }

  return (
    <section className="flex flex-col gap-1 rounded-md border bg-card p-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Bone hierarchy
      </h3>
      <div className="flex flex-col">{renderBone("root", 0)}</div>
    </section>
  )
}

// ===========================================================================
// RSD (resource reference)
// ===========================================================================

export function Ff7RsdPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  void root // sibling-fetch hook reserved for a future inline mesh preview
  const { loading, data, error } = useAsync(async () => {
    return parseFf7RsdForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing resource…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div>
        <h2 className="font-heading text-base font-medium">{node.name}</h2>
        <p className="text-xs text-muted-foreground">
          FF7 resource reference · version{" "}
          <code className="font-mono">{v.version}</code>
        </p>
      </div>
      <section className="flex flex-col gap-1 rounded-md border bg-card p-3 text-xs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">P mesh</dt>
          <dd className="font-mono">
            {v.ply ? `${v.ply.toLowerCase()}.p` : "—"}
          </dd>
          <dt className="text-muted-foreground">Materials</dt>
          <dd className="font-mono">
            {v.mat ? `${v.mat.toLowerCase()}.mat` : "—"}
          </dd>
          <dt className="text-muted-foreground">Groups</dt>
          <dd className="font-mono">
            {v.grp ? `${v.grp.toLowerCase()}.grp` : "—"}
          </dd>
          <dt className="text-muted-foreground">Textures</dt>
          <dd className="font-mono">
            {v.textures.length === 0
              ? "—"
              : v.textures.map((t) => `${t.toLowerCase()}.tex`).join(", ")}
          </dd>
        </dl>
      </section>
    </div>
  )
}

// ===========================================================================
// P (binary mesh)
// ===========================================================================

export function Ff7PMeshPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    const view = await parseFf7PForView(await node.blob!())
    let totalVerts = 0
    let totalTris = 0
    for (const g of view.groups) {
      totalVerts += g.numPolygons * 3
      totalTris += g.numPolygons
    }
    const positions = new Float32Array(totalVerts * 3)
    const normals = new Float32Array(totalVerts * 3)
    const uvs = new Float32Array(totalVerts * 2)
    const indices = new Uint32Array(totalTris * 3)
    const sections: RenderableMeshSection[] = []
    let vertCursor = 0
    let idxCursor = 0
    let hasAnyUv = false
    for (let gi = 0; gi < view.groups.length; gi++) {
      const g = view.groups[gi]!
      const tris = ff7ExtractTriangles(view, g)
      positions.set(tris.positions, vertCursor * 3)
      normals.set(tris.normals, vertCursor * 3)
      if (tris.texCoords) {
        uvs.set(tris.texCoords, vertCursor * 2)
        hasAnyUv = true
      }
      for (let i = 0; i < tris.indices.length; i++) {
        indices[idxCursor + i] = tris.indices[i]! + vertCursor
      }
      sections.push({
        materialIndex: g.areTexturesUsed ? g.textureNumber : 0,
        firstIndex: idxCursor,
        numTriangles: Math.floor(tris.indices.length / 3),
      })
      vertCursor += tris.positions.length / 3
      idxCursor += tris.indices.length
    }
    const lod: RenderableMeshLOD = {
      numVertices: vertCursor,
      positions,
      normals,
      uv: hasAnyUv ? uvs : undefined,
      indices,
      sections,
      label: `${vertCursor.toLocaleString()} verts, ${(idxCursor / 3).toLocaleString()} tris`,
    }
    const renderable: RenderableMesh = {
      lods: [lod],
      upAxis: "z-up",
    }
    return { view, renderable }
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing P mesh…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const totalVerts = v.view.positions.length / 3
  const totalTris = v.view.polygons.length
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-2">
        <h2 className="font-heading text-sm font-medium">{node.name}</h2>
        <p className="text-xs text-muted-foreground">
          FF7 P-format mesh · {v.view.groups.length} group
          {v.view.groups.length === 1 ? "" : "s"} ·{" "}
          {totalVerts.toLocaleString()} vertices ·{" "}
          {totalTris.toLocaleString()} triangles · drag to orbit, scroll to zoom
        </p>
      </div>
      <div className="flex-1 p-3">
        <MeshViewer
          mesh={v.renderable}
          baseName={node.name}
          infoText={`${v.view.groups.length} group${v.view.groups.length === 1 ? "" : "s"}`}
        />
      </div>
    </div>
  )
}

// ===========================================================================
// TEX (texture)
// ===========================================================================

export function Ff7TexPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseFf7TexForView(await node.blob!())
  }, [node.id])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pngUrl, setPngUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = data.width
    canvas.height = data.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const imageData = ctx.createImageData(data.width, data.height)
    imageData.data.set(data.pixels)
    ctx.putImageData(imageData, 0, 0)
    canvas.toBlob((b) => {
      if (b) setPngUrl(URL.createObjectURL(b))
    }, "image/png")
    return () => {
      setPngUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding TEX…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const baseName = node.name.replace(/\.tex$/i, "")
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <div>
        <h2 className="font-heading text-base font-medium">{node.name}</h2>
        <p className="text-xs text-muted-foreground">
          FF7 TEX · {v.width} × {v.height} · {v.bitsPerPixel}-bit{" "}
          {v.paletted
            ? `palette-indexed (${v.colorsPerPalette} colors${v.paletteCount > 1 ? ` × ${v.paletteCount} palettes` : ""})`
            : "direct color"}
        </p>
      </div>
      <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
        <div
          className="overflow-auto rounded-md border"
          style={{
            background:
              "repeating-conic-gradient(rgb(36, 36, 36) 0% 25%, rgb(20, 20, 20) 0% 50%) 50% / 16px 16px",
            maxHeight: "70vh",
          }}
        >
          <canvas
            ref={canvasRef}
            className="block max-w-full"
            style={{
              imageRendering:
                v.width <= 256 && v.height <= 256 ? "pixelated" : "auto",
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            Decoded → 8-bit RGBA ({v.width} × {v.height},{" "}
            {formatBytes(v.pixels.byteLength)})
          </span>
          {pngUrl && (
            <a
              href={pngUrl}
              download={`${baseName}.png`}
              className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
            >
              Save .png
            </a>
          )}
        </div>
      </section>
    </div>
  )
}
