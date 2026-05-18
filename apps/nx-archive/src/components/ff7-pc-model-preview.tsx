/**
 * Preview components for FF7 PC's 3D model file formats:
 *
 *   - `.hrc` skeleton hierarchy (text)
 *   - `.rsd` resource reference (text)
 *   - `.p` binary mesh
 *   - `.tex` texture
 *
 * The HRC preview is the showcase: it follows each bone's RSD
 * reference to its `.p` mesh + `.tex` textures, scans sibling
 * `.a` animation files for matching bone counts, and renders
 * the assembled character through the shared {@link MeshViewer}.
 * Picks a 1-frame `.a` as the default bind pose; switching to
 * a multi-frame `.a` enables real-time skeletal playback via
 * the viewer's animation transport.
 *
 * Without any sibling animation, the preview falls back to a
 * by-name heuristic that puts each bone in a reasonable
 * anatomical direction (spine up, arms sideways, legs down).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import * as THREE from "three"

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
import { parseAnim, type ParsedAnim } from "@tootallnate/ff7-pc-model"

import {
  MeshViewer,
  type MeshViewerAnimation,
  type MeshViewerAnimationDriver,
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
 * the same parent directory as `selected`.
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
 * List every sibling whose name matches a predicate. Used to
 * discover `.a` animation files alongside an HRC inside its
 * LGP container.
 */
async function findSiblingsByPredicate(
  root: Node | null,
  selected: Node,
  pred: (n: Node) => boolean,
): Promise<Node[]> {
  if (!root) return []
  const slash = selected.id.lastIndexOf("/")
  if (slash <= 0) return []
  const parentId = selected.id.slice(0, slash)
  const parent = await findNodeById(root, parentId)
  if (!parent?.getChildren) return []
  const kids = parent._children ?? (parent._children = await parent.getChildren())
  return kids.filter(pred)
}

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
 * Resolved data for one bone in the assembled character: bone
 * length, the meshes attached to it (with their pre-transformed
 * "local" vertex coordinates), and the index of the parent bone
 * in the flat bone list (`-1` = root).
 */
interface ResolvedBone {
  name: string
  parent: string
  /** Index of `parent` in the bones array; `-1` when parent is `root`. */
  parentIndex: number
  /** Bone segment length from parent's pivot to this bone's pivot. */
  length: number
  /** RSD-referenced meshes attached AT THIS BONE's pivot. */
  meshes: ResolvedBoneMesh[]
}

interface ResolvedBoneMesh {
  rsdName: string
  rsd: Ff7RsdView | null
  mesh: Ff7PView | null
  /** Per-texture decoded RGBA (top-down origin). */
  textures: Array<Ff7TexView | null>
}

/** Discovered sibling `.a` animation file. */
interface AvailableAnim {
  node: Node
  name: string
  framesCount: number
  bonesCount: number
}

interface AssembledHrcView {
  hrc: Ff7HrcView
  bones: ResolvedBone[]
  /** True when at least one bone resolved geometry. */
  hasGeometry: boolean
  /** All sibling `.a` files matching the HRC's bone count. */
  availableAnims: AvailableAnim[]
  /** Reasons sibling lookups failed (for the diagnostics panel). */
  warnings: string[]
}

/**
 * Walk the HRC + resolve all sibling assets. Doesn't bake any
 * vertex positions yet — that happens in
 * {@link buildCompositeRig} (one-time) and {@link applyFrameToGeometry}
 * (per-frame).
 */
async function assembleHrcCharacter(
  hrc: Ff7HrcView,
  root: Node | null,
  selected: Node,
): Promise<AssembledHrcView> {
  const warnings: string[] = []
  const bones: ResolvedBone[] = []
  const nameToIndex = new Map<string, number>()
  for (let i = 0; i < hrc.bones.length; i++) {
    nameToIndex.set(hrc.bones[i]!.name, i)
  }

  for (const bone of hrc.bones) {
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
      parentIndex: nameToIndex.get(bone.parent) ?? -1,
      length: bone.length,
      meshes,
    })
  }

  // Sniff sibling `.a` files with matching bone count. Read each
  // file's header only (36 bytes) — actually parsing the frames
  // is deferred until the user picks one for playback.
  const availableAnims: AvailableAnim[] = []
  const aNodes = await findSiblingsByPredicate(root, selected, (n) =>
    n.name.toLowerCase().endsWith(".a") && !!n.blob,
  )
  for (const n of aNodes) {
    try {
      const blob = await n.blob!()
      const head = new Uint8Array(await blob.slice(0, 36).arrayBuffer())
      if (head.byteLength < 36) continue
      const v = new DataView(
        head.buffer,
        head.byteOffset,
        head.byteLength,
      )
      const version = v.getUint32(0, true)
      if (version !== 1) continue
      const framesCount = v.getUint32(4, true)
      const bonesCount = v.getUint32(8, true)
      if (bonesCount !== hrc.boneCount) continue
      availableAnims.push({
        node: n,
        name: n.name.replace(/\.a$/i, ""),
        framesCount,
        bonesCount,
      })
    } catch {
      /* skip unreadable */
    }
  }
  // Sort: 1-frame animations (bind poses) first, then by frame
  // count ascending so common "stand / walk / run" triplets stay
  // together.
  availableAnims.sort((a, b) => {
    if ((a.framesCount === 1) !== (b.framesCount === 1)) {
      return a.framesCount === 1 ? -1 : 1
    }
    return a.framesCount - b.framesCount
  })

  const hasGeometry = bones.some((b) => b.meshes.some((m) => m.mesh != null))
  return { hrc, bones, hasGeometry, availableAnims, warnings }
}

// ===========================================================================
// Composite mesh builder
// ===========================================================================

/**
 * One mesh-piece anchored to a specific bone. Holds the
 * untransformed local vertex positions + normals, the vertex
 * range in the flat composite buffer, and the bone index.
 */
interface RigMeshPiece {
  /** Index into `AssembledHrcView.bones`. */
  boneIndex: number
  /** Local-frame positions, vec3-interleaved. */
  localPositions: Float32Array
  /** Local-frame normals, vec3-interleaved. */
  localNormals: Float32Array
  /** First vertex index in the composite buffer. */
  vertexStart: number
  /** Vertex count (= localPositions.length / 3). */
  vertexCount: number
  /** Section index in the composite mesh (also material slot). */
  sectionIndex: number
}

/**
 * The static rig: a `RenderableMesh` whose positions buffer is
 * zero-initialised; plus the metadata needed to repaint that
 * buffer for any animation frame.
 */
interface BuiltRig {
  mesh: RenderableMesh
  /** Flat list of mesh pieces, in section-emission order. */
  pieces: RigMeshPiece[]
  /** Material textures by section/material index. */
  textures: Array<DecodedTexture | null>
}

/**
 * Build the static rig: emit one section per bone-mesh-group
 * with placeholder positions. Local vertex data is retained so
 * the per-frame skinner can transform them into world space.
 */
function buildCompositeRig(assembled: AssembledHrcView): BuiltRig | null {
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
  if (totalSections === 0) return null

  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)
  const uvs = new Float32Array(totalVerts * 2)
  // Per-vertex baked colors from the P file (BGRA8 → RGB float).
  // FF7 PC field models bake per-vertex lighting at author time;
  // untextured polygon groups render with these colors instead
  // of relying on real-time lighting.
  const colors = new Float32Array(totalVerts * 3)
  const indices = new Uint32Array(totalTris * 3)
  const sections: RenderableMeshSection[] = []
  const textures: Array<DecodedTexture | null> = []
  const pieces: RigMeshPiece[] = []

  let vertCursor = 0
  let idxCursor = 0
  let hasAnyUv = false
  let materialSlot = 0
  for (let bi = 0; bi < assembled.bones.length; bi++) {
    const bone = assembled.bones[bi]!
    for (const m of bone.meshes) {
      if (!m.mesh) continue
      for (const g of m.mesh.groups) {
        const tris = ff7ExtractTriangles(m.mesh, g)
        const vc = tris.positions.length / 3
        // Retain local-frame positions + normals for per-frame
        // skinning. We don't write them into the composite
        // buffer here — `applyFrameToGeometry` does that.
        if (tris.texCoords) {
          uvs.set(tris.texCoords, vertCursor * 2)
          hasAnyUv = true
        }
        colors.set(tris.colors, vertCursor * 3)
        for (let i = 0; i < tris.indices.length; i++) {
          indices[idxCursor + i] = tris.indices[i]! + vertCursor
        }
        sections.push({
          materialIndex: materialSlot,
          firstIndex: idxCursor,
          numTriangles: Math.floor(tris.indices.length / 3),
        })
        // Resolve the texture for this section.
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
              flipY: false,
            }
          }
        }
        textures.push(decoded)
        pieces.push({
          boneIndex: bi,
          localPositions: tris.positions,
          localNormals: tris.normals,
          vertexStart: vertCursor,
          vertexCount: vc,
          sectionIndex: materialSlot,
        })
        vertCursor += vc
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
    colors,
    indices,
    sections,
    label: `${vertCursor.toLocaleString()} verts, ${(idxCursor / 3).toLocaleString()} tris`,
  }
  const mesh: RenderableMesh = {
    lods: [lod],
    // FF7 PC characters are authored Z-up; the viewer rotates
    // -90° around X to display Y-up. Flip Y is enabled by
    // default because the bind pose (especially aafe.a style)
    // has the model standing on +Z = top after rotation.
    upAxis: "z-up",
    flipYDefault: true,
  }
  return { mesh, pieces, textures }
}

// ===========================================================================
// Skinning: compute per-bone matrices for a frame, apply to geometry
// ===========================================================================

/** Per-bone transform stack — one 4x4 world matrix per bone. */
type BoneMatrices = THREE.Matrix4[]

/**
 * Compute world-space matrices for every bone in the skeleton.
 *
 * `frame` (when non-null) supplies per-bone Euler rotations
 * + a root translation; without it bones use identity rotation
 * (T-pose with only the upright X-flip applied at the root).
 *
 * Each bone's frame is:
 *
 *     M_B = M_parent · T(0, 0, -parent.length) · R(boneRotation)
 *
 * The translation along the parent's local -Z axis matches
 * FF7's bone-extension convention (verified against kujata's
 * ff7-to-gltf.js).
 *
 * The parent's bone *length* is what positions the child at the
 * end of the parent's segment; the child's *own* rotation
 * orients its local frame.
 *
 * The root bone (parent == 'root') is offset by the frame's
 * root-translation. The root rotation is applied to the whole
 * skeleton via the first bone's frame.
 */
function computeBoneMatrices(
  bones: ResolvedBone[],
  frame: ParsedAnim["frames"][number] | null,
  rotationOrder: ParsedAnim["rotationOrder"] | null,
): BoneMatrices {
  const matrices: BoneMatrices = new Array(bones.length)
  // FF7 PC field models always use intrinsic Euler order "YXZ"
  // (kujata, FF7ToBlender). The `rotation_order` byte triple in
  // the corpus is always [1, 0, 2] which maps to YXZ; defensively
  // we still derive from the header.
  const eulerOrder = rotationOrderToEulerString(rotationOrder)

  const tmpRot = new THREE.Matrix4()
  const tmpEuler = new THREE.Euler()
  const tmpTrans = new THREE.Matrix4()

  // Root transform: translation × rotation, with +180° added to
  // X so the model stands upright. FF7 is -Y-up, three.js is
  // +Y-up — the 180° X-flip resolves the mismatch (matches
  // kujata's `ROOT_X_ROTATION_DEGREES = 180.0`).
  const rootTrans = new THREE.Matrix4()
  const rootRot = new THREE.Matrix4()
  if (frame) {
    rootTrans.makeTranslation(
      frame.rootTranslation[0],
      frame.rootTranslation[1],
      frame.rootTranslation[2],
    )
    const [a, b, c] = frame.rootRotation
    tmpEuler.set(
      THREE.MathUtils.degToRad(a + 180),
      THREE.MathUtils.degToRad(b),
      THREE.MathUtils.degToRad(c),
      eulerOrder,
    )
    rootRot.makeRotationFromEuler(tmpEuler)
  } else {
    // No animation loaded: apply only the upright flip.
    tmpEuler.set(Math.PI, 0, 0, eulerOrder)
    rootRot.makeRotationFromEuler(tmpEuler)
  }
  const rootMat = new THREE.Matrix4().multiplyMatrices(rootTrans, rootRot)

  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i]!
    const parentMat = bone.parentIndex >= 0 ? matrices[bone.parentIndex]! : rootMat

    // Per-bone rotation from the animation, or identity when
    // none is loaded (the "rest pose" — bones extend straight
    // along their authored axis).
    if (frame) {
      const [a, b, c] = frame.boneRotations[i] ?? [0, 0, 0]
      tmpEuler.set(
        THREE.MathUtils.degToRad(a),
        THREE.MathUtils.degToRad(b),
        THREE.MathUtils.degToRad(c),
        eulerOrder,
      )
      tmpRot.makeRotationFromEuler(tmpEuler)
    } else {
      tmpRot.identity()
    }

    // FF7 bones extend along their LOCAL -Z axis (kujata). The
    // child bone sits at the parent's `(0, 0, -parent.length)`
    // in the parent's local frame.
    const parentLength =
      bone.parentIndex >= 0 ? bones[bone.parentIndex]!.length : 0
    tmpTrans.makeTranslation(0, 0, -parentLength)

    const m = new THREE.Matrix4()
    m.multiplyMatrices(parentMat, tmpTrans)
    m.multiply(tmpRot)
    matrices[i] = m
  }
  return matrices
}

/**
 * Map an FF7 rotation_order byte triple to a three.js Euler
 * order string. The mapping:
 *
 *   axis 0 → X
 *   axis 1 → Y
 *   axis 2 → Z
 *
 * The three byte values are the AXES IN APPLICATION ORDER, so
 * we concatenate their letters.
 */
function rotationOrderToEulerString(
  order: ParsedAnim["rotationOrder"] | null,
): THREE.EulerOrder {
  if (!order) return "YXZ"
  const letters = order.map((n) => (n === 0 ? "X" : n === 1 ? "Y" : "Z")).join("")
  // three.js valid orders are XYZ, XZY, YXZ, YZX, ZXY, ZYX.
  switch (letters) {
    case "XYZ":
    case "XZY":
    case "YXZ":
    case "YZX":
    case "ZXY":
    case "ZYX":
      return letters as THREE.EulerOrder
    default:
      return "YXZ"
  }
}

/**
 * Apply bone matrices to a composite geometry's position
 * buffer (in place). Each piece's local positions/normals are
 * transformed by its bone's world matrix and written into the
 * piece's vertex range.
 *
 * Marks both `position` and `normal` attributes with
 * `.needsUpdate = true` so Three.js re-uploads them to the GPU
 * next render.
 */
function applyFrameToGeometry(
  geometry: THREE.BufferGeometry,
  pieces: RigMeshPiece[],
  matrices: BoneMatrices,
): void {
  const posAttr = geometry.getAttribute("position") as
    | THREE.BufferAttribute
    | undefined
  const normAttr = geometry.getAttribute("normal") as
    | THREE.BufferAttribute
    | undefined
  if (!posAttr) return
  const posArr = posAttr.array as Float32Array
  const normArr = normAttr?.array as Float32Array | undefined
  // The normal matrix is the inverse-transpose of the upper-3×3
  // of the bone matrix; for rigid rotations this is just the
  // rotation itself, so we can reuse `boneMat` directly.
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (const piece of pieces) {
    const m = matrices[piece.boneIndex]!
    for (let i = 0; i < piece.vertexCount; i++) {
      const li = i * 3
      const gi = (piece.vertexStart + i) * 3
      v.set(
        piece.localPositions[li]!,
        piece.localPositions[li + 1]!,
        piece.localPositions[li + 2]!,
      )
      v.applyMatrix4(m)
      posArr[gi] = v.x
      posArr[gi + 1] = v.y
      posArr[gi + 2] = v.z
      if (normArr) {
        n.set(
          piece.localNormals[li]!,
          piece.localNormals[li + 1]!,
          piece.localNormals[li + 2]!,
        )
        // Rotate normals (drop translation by setting w=0 implicitly).
        n.transformDirection(m)
        normArr[gi] = n.x
        normArr[gi + 1] = n.y
        normArr[gi + 2] = n.z
      }
    }
  }
  posAttr.needsUpdate = true
  if (normAttr) normAttr.needsUpdate = true
  // The bounding sphere stays roughly correct after skinning;
  // recompute it cheaply so the camera-frame fit doesn't drift
  // over time.
  geometry.computeBoundingSphere()
}

// ===========================================================================
// React components
// ===========================================================================

export function Ff7HrcPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  const { loading, data: hrc, error } = useAsync(async () => {
    return parseFf7HrcForView(await node.blob!())
  }, [node.id])

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
            {assembled?.availableAnims.length
              ? ` · ${assembled.availableAnims.length} matching animation${assembled.availableAnims.length === 1 ? "" : "s"}`
              : ""}
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
  // Build the static rig once per assembled-character; per-frame
  // mutations happen inside the animation driver.
  const rig = useMemo(() => {
    if (!assembled || !assembled.hasGeometry) return null
    return buildCompositeRig(assembled)
  }, [assembled])

  // Cache of fully-parsed `.a` animations, lazily loaded on
  // first selection.
  const animCacheRef = useRef<Map<string, ParsedAnim>>(new Map())
  // The driver re-creates if the available-anims list changes
  // (different HRC opened or new siblings discovered). The
  // viewer's animation transport uses the FIRST animation as
  // the default "selected" entry.
  const driver = useMemo<MeshViewerAnimationDriver | null>(() => {
    if (!assembled || !rig) return null
    const animations: MeshViewerAnimation[] = assembled.availableAnims.map(
      (a) => ({
        name: `${a.name} (${a.framesCount}f)`,
        frameCount: Math.max(1, a.framesCount),
        loop: a.framesCount > 1,
      }),
    )
    return {
      category: "animation",
      animations,
      sample(index, frame, ctx) {
        if (!ctx.geometry) return
        const animDescriptor =
          index >= 0 && index < assembled.availableAnims.length
            ? assembled.availableAnims[index]
            : null
        let parsed: ParsedAnim | null = null
        if (animDescriptor) {
          parsed = animCacheRef.current.get(animDescriptor.name) ?? null
          if (!parsed) {
            // Schedule a lazy load; the next sample call will
            // pick it up. For the very first sample call after
            // selection we render the fallback bind pose.
            void (async () => {
              try {
                const blob = await animDescriptor.node.blob!()
                const bytes = new Uint8Array(await blob.arrayBuffer())
                animCacheRef.current.set(animDescriptor.name, parseAnim(bytes))
                // Force a re-sample by mutating the geometry now
                // that the data is available. The viewer's rAF
                // loop will pick up the updated geometry on its
                // next tick.
                const pa = animCacheRef.current.get(animDescriptor.name)
                if (pa) {
                  const matrices = computeBoneMatrices(
                    assembled.bones,
                    pa.frames[
                      Math.min(Math.floor(frame), pa.frames.length - 1)
                    ] ?? null,
                    pa.rotationOrder,
                  )
                  applyFrameToGeometry(ctx.geometry!, rig.pieces, matrices)
                }
              } catch {
                /* drop unparseable animations silently */
              }
            })()
            return
          }
        }
        // Interpolate frame index between integer frames. The
        // driver receives a floating-point `frame` value
        // (rAF-driven), so for visual smoothness we lerp Euler
        // rotations between the bracketing keyframes. FF7
        // animations were authored at 15 fps but the viewer
        // ticks at 60 fps — without this we'd see judder.
        const fr = parsed
          ? sampleAnimFrame(parsed, frame)
          : null
        const matrices = computeBoneMatrices(
          assembled.bones,
          fr,
          parsed?.rotationOrder ?? null,
        )
        applyFrameToGeometry(ctx.geometry, rig.pieces, matrices)
      },
    }
  }, [assembled, rig])

  // First render of the geometry: apply the bind pose (either
  // the first available 1-frame `.a` or the fallback heuristic).
  // We watch for the FIRST geometry handoff via a ref + an
  // effect that runs after the viewer has constructed it.
  useEffect(() => {
    if (!rig || !assembled || !driver) return
    // The driver's `sample` will be called by the viewer
    // automatically when an animation is selected. Until then,
    // we want the rig in its bind pose so the model isn't a
    // collapsed dot at the origin. The viewer's animation
    // dropdown defaults to "no animation" — but we want the
    // FIRST one selected. The viewer doesn't currently support
    // a pre-selected index, so we apply the bind pose directly
    // via the rig's underlying typed arrays. This runs before
    // the WebGL renderer is attached, so no `needsUpdate`
    // needed.
    const matrices = computeBoneMatrices(assembled.bones, null, null)
    applyMatricesToTypedArrays(rig, matrices)
  }, [rig, assembled, driver])

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

  const lod = rig!.mesh.lods[0]!
  return (
    <section className="flex flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {
            assembled.bones.filter((b) => b.meshes.some((m) => m.mesh))
              .length
          }{" "}
          rendered bone
          {assembled.bones.filter((b) => b.meshes.some((m) => m.mesh))
            .length === 1
            ? ""
            : "s"}{" "}
          · {lod.numVertices.toLocaleString()} verts ·{" "}
          {(lod.indices.length / 3).toLocaleString()} triangles
          {assembled.availableAnims.length > 0 ? (
            <> · {assembled.availableAnims.length} animation
              {assembled.availableAnims.length === 1 ? "" : "s"}
            </>
          ) : null}
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
          mesh={rig!.mesh}
          materialDiffuseTextures={rig!.textures}
          animationDrivers={driver ? [driver] : undefined}
          baseName={node.name}
        />
      </div>
    </section>
  )
}

/**
 * Apply the given bone matrices directly to the rig's underlying
 * typed-array positions/normals. Used to initialise the bind
 * pose before the WebGL renderer is constructed (no
 * `needsUpdate` flag needed at that point).
 */
function applyMatricesToTypedArrays(
  rig: BuiltRig,
  matrices: BoneMatrices,
): void {
  const lod = rig.mesh.lods[0]!
  const posArr = lod.positions
  const normArr = lod.normals
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (const piece of rig.pieces) {
    const m = matrices[piece.boneIndex]!
    for (let i = 0; i < piece.vertexCount; i++) {
      const li = i * 3
      const gi = (piece.vertexStart + i) * 3
      v.set(
        piece.localPositions[li]!,
        piece.localPositions[li + 1]!,
        piece.localPositions[li + 2]!,
      )
      v.applyMatrix4(m)
      posArr[gi] = v.x
      posArr[gi + 1] = v.y
      posArr[gi + 2] = v.z
      if (normArr) {
        n.set(
          piece.localNormals[li]!,
          piece.localNormals[li + 1]!,
          piece.localNormals[li + 2]!,
        )
        n.transformDirection(m)
        normArr[gi] = n.x
        normArr[gi + 1] = n.y
        normArr[gi + 2] = n.z
      }
    }
  }
}

/**
 * Resolve an animation's frame at a (possibly fractional)
 * frame index, lerping Euler rotations between the bracketing
 * integer frames. FF7's authored frame rate was 15 fps; the
 * viewer's animation transport ticks at 60 fps, so most
 * sample calls land between two keyframes.
 */
function sampleAnimFrame(
  anim: ParsedAnim,
  frame: number,
): ParsedAnim["frames"][number] {
  if (anim.frames.length === 0) {
    return {
      rootRotation: [0, 0, 0],
      rootTranslation: [0, 0, 0],
      boneRotations: [],
    }
  }
  const looped = ((frame % anim.frames.length) + anim.frames.length) % anim.frames.length
  const f0 = Math.floor(looped)
  const f1 = (f0 + 1) % anim.frames.length
  const t = looped - f0
  const a = anim.frames[f0]!
  if (t <= 0 || f0 === f1) return a
  const b = anim.frames[f1]!
  const lerpAngle = (x: number, y: number) => {
    // Shortest-arc Euler interpolation (angles in degrees).
    let d = y - x
    while (d > 180) d -= 360
    while (d < -180) d += 360
    return x + d * t
  }
  return {
    rootRotation: [
      lerpAngle(a.rootRotation[0], b.rootRotation[0]),
      lerpAngle(a.rootRotation[1], b.rootRotation[1]),
      lerpAngle(a.rootRotation[2], b.rootRotation[2]),
    ],
    rootTranslation: [
      a.rootTranslation[0] + (b.rootTranslation[0] - a.rootTranslation[0]) * t,
      a.rootTranslation[1] + (b.rootTranslation[1] - a.rootTranslation[1]) * t,
      a.rootTranslation[2] + (b.rootTranslation[2] - a.rootTranslation[2]) * t,
    ],
    boneRotations: a.boneRotations.map((ar, i) => {
      const br = b.boneRotations[i] ?? ar
      return [
        lerpAngle(ar[0], br[0]),
        lerpAngle(ar[1], br[1]),
        lerpAngle(ar[2], br[2]),
      ] as [number, number, number]
    }),
  }
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
  void root
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
    const colors = new Float32Array(totalVerts * 3)
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
      colors.set(tris.colors, vertCursor * 3)
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
      colors,
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
