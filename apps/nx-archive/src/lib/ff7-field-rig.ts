/**
 * FF7 PC field-model rig: resolve an `.hrc` skeleton's RSD → P → TEX
 * siblings and `.a` animations, merge every bone's meshes into one
 * {@link RenderableMesh}, and pose it. React-free so both the HRC
 * preview and the media library (thumbnails, headless export) can use
 * it. Extracted unchanged from `components/ff7-pc-model-preview.tsx`.
 */
import * as THREE from 'three'
import { parseAnim, type ParsedAnim } from '@tootallnate/ff7-pc-model'

import type {
  RenderableMesh,
  RenderableMeshLOD,
  RenderableMeshSection,
} from '~/components/mesh-viewer'
import type { Node } from './archive'
import {
  ff7ExtractTriangles,
  parseFf7PForView,
  parseFf7RsdForView,
  parseFf7TexForView,
  type Ff7HrcView,
  type Ff7PView,
  type Ff7RsdView,
  type Ff7TexView,
} from './preview'
import type { DecodedTexture } from './uasset-material-chain'
import { findNodeById } from './unity-external'

// ===========================================================================
// Sibling resolution
// ===========================================================================

/**
 * Resolve a sibling file by base name (case-insensitive) inside
 * the same parent directory as `selected`.
 */
export async function findSiblingByBaseName(
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
export async function findSiblingsByPredicate(
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


// ===========================================================================
// HRC (skeleton) — composite 3D + tree view
// ===========================================================================

/**
 * Resolved data for one bone in the assembled character: bone
 * length, the meshes attached to it (with their pre-transformed
 * "local" vertex coordinates), and the index of the parent bone
 * in the flat bone list (`-1` = root).
 */
export interface ResolvedBone {
  name: string
  parent: string
  /** Index of `parent` in the bones array; `-1` when parent is `root`. */
  parentIndex: number
  /** Bone segment length from parent's pivot to this bone's pivot. */
  length: number
  /** RSD-referenced meshes attached AT THIS BONE's pivot. */
  meshes: ResolvedBoneMesh[]
}

export interface ResolvedBoneMesh {
  rsdName: string
  rsd: Ff7RsdView | null
  mesh: Ff7PView | null
  /** Per-texture decoded RGBA (top-down origin). */
  textures: Array<Ff7TexView | null>
}

/** Discovered sibling `.a` animation file. */
export interface AvailableAnim {
  node: Node
  name: string
  framesCount: number
  bonesCount: number
}

export interface AssembledHrcView {
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
export async function assembleHrcCharacter(
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

  // Sibling `.a` files with a matching bone count. The header scan is
  // shared per archive: `char.lgp` holds ~3,200 `.a` files and every
  // character in it would otherwise re-read all of them.
  const availableAnims: AvailableAnim[] = (await animHeadersFor(root, selected))
    .filter((a) => a.bonesCount === hrc.boneCount)
    .map((a) => ({ ...a }))
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
export interface RigMeshPiece {
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
export interface BuiltRig {
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
export function buildCompositeRig(assembled: AssembledHrcView): BuiltRig | null {
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
    // Bone math already places the model in three.js's +Y-up
    // convention (the root applies a 180° X-flip to convert
    // FF7's source -Y-up to +Y-up). No further viewer-level
    // transform needed.
    upAxis: "y-up",
  }
  return { mesh, pieces, textures }
}

// ===========================================================================
// Skinning: compute per-bone matrices for a frame, apply to geometry
// ===========================================================================

/** Per-bone transform stack — one 4x4 world matrix per bone. */
export type BoneMatrices = THREE.Matrix4[]

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
export function computeBoneMatrices(
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
export function applyFrameToGeometry(
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


/**
 * Apply the given bone matrices directly to the rig's underlying
 * typed-array positions/normals. Used to initialise the bind
 * pose before the WebGL renderer is constructed (no
 * `needsUpdate` flag needed at that point).
 */
export function applyMatricesToTypedArrays(
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
export function sampleAnimFrame(
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

const animHeaderCache = new WeakMap<Node, Promise<AvailableAnim[]>>()

/** Headers (frame / bone counts) of every `.a` sibling of `selected`, cached per parent. */
async function animHeadersFor(root: Node | null, selected: Node): Promise<AvailableAnim[]> {
  if (!root) return []
  const slash = selected.id.lastIndexOf('/')
  if (slash <= 0) return []
  const parent = await findNodeById(root, selected.id.slice(0, slash))
  if (!parent) return []
  let cached = animHeaderCache.get(parent)
  if (!cached) {
    cached = (async () => {
      const aNodes = (parent._children ?? (parent._children = await parent.getChildren!())).filter(
        (n) => n.name.toLowerCase().endsWith('.a') && !!n.blob,
      )
      const out: AvailableAnim[] = []
      // Read headers in parallel batches (each is a tiny ranged read).
      for (let i = 0; i < aNodes.length; i += 64) {
        const batch = await Promise.all(
          aNodes.slice(i, i + 64).map(async (n): Promise<AvailableAnim | null> => {
            try {
              const head = new Uint8Array(await (await n.blob!()).slice(0, 36).arrayBuffer())
              if (head.byteLength < 36) return null
              const v = new DataView(head.buffer, head.byteOffset, head.byteLength)
              if (v.getUint32(0, true) !== 1) return null
              return { node: n, name: n.name.replace(/\.a$/i, ''), framesCount: v.getUint32(4, true), bonesCount: v.getUint32(8, true) }
            } catch {
              return null
            }
          }),
        )
        for (const a of batch) if (a) out.push(a)
      }
      return out
    })()
    animHeaderCache.set(parent, cached)
  }
  return cached
}

/**
 * Pose a built rig in its library rest pose: the first 1-frame `.a`
 * (FF7's stored bind poses), else frame 0 of the first animation,
 * else the bones' identity rotations.
 */
export async function poseFf7FieldRest(assembled: AssembledHrcView, rig: BuiltRig): Promise<string | null> {
  for (const a of assembled.availableAnims) {
    try {
      const bytes = new Uint8Array(await (await a.node.blob!()).arrayBuffer())
      const anim = parseAnim(bytes)
      const frame = anim.frames[0]
      if (!frame) continue
      applyMatricesToTypedArrays(rig, computeBoneMatrices(assembled.bones, frame, anim.rotationOrder))
      return a.name
    } catch {
      // try the next one
    }
  }
  applyMatricesToTypedArrays(rig, computeBoneMatrices(assembled.bones, null, null))
  return null
}
