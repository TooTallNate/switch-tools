/**
 * 3D viewer for BFRES models. Pulls geometry out of the file via
 * `@tootallnate/bfres`'s `extractGeometry` and renders each shape
 * with Three.js. The viewer auto-frames the camera to the combined
 * bounding box of all shapes and provides orbit controls (drag to
 * rotate, scroll to zoom, right-drag to pan).
 *
 * Material handling: each shape's FMAT lists a sampler-to-texture
 * binding (e.g. `_a0` → `Bird`). We resolve the `_a0` (albedo)
 * binding against the BFRES's embedded BNTX bank, decode that
 * texture to RGBA8 via `@tootallnate/bntx`, and apply it as a
 * `MeshBasicMaterial.map`. Shapes with no albedo (or whose texture
 * isn't decodable) fall back to `MeshNormalMaterial` so they still
 * render.
 */
import { Component, useEffect, useRef, useState, type ReactNode } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import {
  evaluateCurve,
  extractAnimations,
  extractGeometry,
  extractMaterials,
  extractSkeletons,
  parseBfres,
  BoneAnimDataOffset,
  type BfresAnimations,
  type BfresGeometry,
  type BfresMaterial,
  type BfresSkeletalAnim,
  type BfresSkeleton,
} from "@tootallnate/bfres"
import { parseBntx, decodeBntxLayer, type BntxTexture } from "@tootallnate/bntx"

import type { Node } from "~/lib/archive"

/**
 * Error boundary that contains rendering exceptions to the BFRES
 * viewer pane instead of letting them blank the entire app.
 * Covers the long tail of Three.js / WebGL surprises that aren't
 * easy to predict ahead of time (driver bugs, lost contexts during
 * Vite HMR, GLSL compile failures on niche GPUs).
 */
class BfresViewerErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (this.state.error) {
      return <ViewerError error={this.state.error} />
    }
    return this.props.children
  }
}

/** Inline error display — mirrors the ErrorFiller in preview-pane.tsx. */
function ViewerError({ error }: { error: Error }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-5 text-center">
      <div className="text-sm font-medium text-destructive">
        Could not render this BFRES
      </div>
      <div className="max-w-md text-xs text-muted-foreground">
        {error.message}
      </div>
    </div>
  )
}

interface ShapeRecord {
  geom: BfresGeometry
  /** Three.js mesh — `SkinnedMesh` for shapes with skin attrs,
   *  plain `Mesh` otherwise. Kept so we can dispose it on unmount. */
  mesh: THREE.Mesh | THREE.SkinnedMesh
  /** True iff the user has toggled this shape on. Drives renderer visibility. */
  visible: boolean
  /** Whether we successfully bound an albedo texture from the BNTX. */
  hasAlbedo: boolean
}

/**
 * One Three.js scene-graph mirror of an FSKL skeleton. We build
 * one of these per FMDL: an array of `THREE.Bone` parented in a
 * hierarchy, plus a `Skeleton` carrying the inverse-bind matrices
 * for skinning. SkinnedMeshes inside the same FMDL share these
 * bones so animation drives all of them together.
 */
interface FsklSceneSkeleton {
  /** Bone array, parallel to the source `BfresSkeleton.bones`. */
  bones: THREE.Bone[]
  /** Three.js skeleton wrapper over `bones`. */
  skeleton: THREE.Skeleton
  /** Source FSKL data — the curve-driven SRT animation needs
   *  to know each bone's bind-pose values to apply curve deltas. */
  source: BfresSkeleton
  /** Root bones (no parent). Add these to the scene to get the
   *  whole skeleton in the scene graph. */
  roots: THREE.Bone[]
}

/**
 * Lazy cache for the embedded BNTX bank's textures. We split the
 * cache in two layers:
 *
 *   - `byName` — the parsed BNTX descriptor for each texture, keyed
 *     by name.
 *   - `decoded` — memoised RGBA8 pixel buffers per texture name. A
 *     decode runs once per texture; multiple shapes can then
 *     synthesise their own Three.js `DataTexture` from the same
 *     pixel buffer with different wrap modes (the underlying
 *     `Uint8ClampedArray` is shared, so this is cheap).
 *
 * Different shapes need different wrap modes — pupil meshes have
 * UVs running far outside [0, 1] and need `ClampToEdgeWrapping` so
 * out-of-range samples hit the texture's transparent border. Eye-
 * sclera meshes (e.g. Nokonoko) have UVs in `[-1, 0]` that *do*
 * need `RepeatWrapping` so the negative-U samples wrap into the
 * authored [0, 1] region. We keep one `DataTexture` per (name,
 * wrap-mode) pair.
 */
type DecodedRgba = {
  pixels: Uint8ClampedArray
  width: number
  height: number
  srgb: boolean
}

type BntxTextureCache = {
  /** All decodable textures in the bank, keyed by name. */
  byName: Map<string, BntxTexture>
  /** Memoised pixel buffers per texture name. */
  decoded: Map<string, DecodedRgba | null>
  /** Memoised `THREE.DataTexture`s keyed by `name|wrapMode`. */
  textures: Map<string, THREE.Texture | null>
  /** Source BNTX bytes — needed to deswizzle on demand. */
  bytes: Uint8Array
}

/**
 * Read the embedded `textures.bntx` (or equivalent) from a BFRES
 * blob and return a name-indexed cache. Returns `null` if there's
 * no embedded BNTX, or if it fails to parse — callers fall back to
 * normal-vis shading.
 */
async function loadEmbeddedBntxTextures(
  blob: Blob,
): Promise<BntxTextureCache | null> {
  try {
    const parsed = await parseBfres(blob)
    const ext = parsed.embeddedBntx
    if (!ext) return null
    const bytes = new Uint8Array(await ext.data.arrayBuffer())
    const bntx = parseBntx(bytes)
    const byName = new Map<string, BntxTexture>()
    for (const tex of bntx.textures) {
      if (tex.name) byName.set(tex.name, tex)
    }
    return { byName, decoded: new Map(), textures: new Map(), bytes }
  } catch {
    return null
  }
}

/**
 * Resolve the albedo texture for a single shape: walk the parent
 * model's material list, find the `_a0` sampler binding (or
 * `_a1` / `_a2` as a fallback for shapes that put their main map
 * in a different slot), and decode it via `@tootallnate/bntx`.
 *
 * Returns `null` if no albedo binding exists, or if the texture
 * format isn't decodable yet (the BNTX decoder only covers the
 * common subset of BC1/3/4/5/7 + uncompressed RGBA8).
 */
/**
 * Choose which FMDL is the "primary" rig for the multi-FMDL
 * cross-attachment heuristic — return its model index, or `-1` if
 * the BFRES is single-FMDL or all FMDLs are tied. Used to mount
 * single-bone secondary FMDLs (e.g. `Pupil` in MK8 character
 * BFRES) onto the primary FMDL's `Head` bone, since the BFRES
 * file itself contains no explicit cross-FMDL link (that's stored
 * in the parent SARC / BYAML config in real games).
 */
function pickPrimaryFmdl(skeletons: BfresSkeleton[]): number {
  if (skeletons.length < 2) return -1
  let best = 0
  for (let i = 1; i < skeletons.length; i++) {
    if (skeletons[i].bones.length > skeletons[best].bones.length) best = i
  }
  // Only treat the largest as "primary" if it's substantially
  // bigger than the others — avoids hijacking BFRES files that
  // legitimately contain multiple comparable models.
  for (let i = 0; i < skeletons.length; i++) {
    if (i !== best && skeletons[i].bones.length >= skeletons[best].bones.length / 2) {
      return -1
    }
  }
  return best
}

function findBone(
  skel: BfresSkeleton,
  name: string,
): { matrix: Float32Array } | null {
  const b = skel.bones.find((bb) => bb.name === name)
  return b ? { matrix: b.worldMatrix } : null
}

/**
 * Compute the bone-attach world matrix for a shape, or `null` if
 * no transform should be applied (i.e. vertices are already in
 * model bind-pose space).
 *
 * Rules:
 *   - `vertexSkinCount === 0` → vertices in `bones[boneIndex]`'s
 *     local space; multiply by that bone's world matrix.
 *   - `vertexSkinCount === 1` → vertices in
 *     `bones[skinBoneIndexList[0]]`'s local space; multiply by
 *     that bone's world matrix.
 *   - `vertexSkinCount >= 2` → smooth-skinned, vertices already
 *     in model bind-pose space; leave at identity.
 *   - **Multi-FMDL heuristic**: if this shape lives in a
 *     secondary single-bone FMDL (no real rig of its own) and the
 *     primary FMDL has a `Head` bone, mount the shape on the
 *     primary's `Head`. Used for Yoshi-style "Pupil" sub-models.
 */
function pickShapeMatrix(
  g: BfresGeometry,
  skeletons: BfresSkeleton[],
  primaryModelIndex: number,
  primaryHead: { matrix: Float32Array } | null,
): Float32Array | null {
  const skel = skeletons[g.modelIndex]
  if (!skel) return null

  // Multi-FMDL heuristic — for secondary FMDLs whose own
  // skeleton is just a single root-pose bone (e.g. MK8's "Pupil"
  // sub-FMDL), mount on the primary FMDL's `Head` bone using its
  // full world matrix (translation + rotation). Verified against
  // Yoshi: pupils' authored X=3.19..5.57 maps through Head's
  // rotation to land just above the body, on the front of the
  // head, at the eye position.
  //
  // The BFRES file itself contains no explicit cross-FMDL link —
  // commercial games store that in the parent SARC/BYAML. The
  // `Head` heuristic catches the common case (character Pupil
  // sub-models); single-FMDL BFRES and BFRES with a primary FMDL
  // that has no `Head` bone are unaffected.
  if (
    g.modelIndex !== primaryModelIndex &&
    primaryHead &&
    skel.bones.length === 1 &&
    isIdentityishMatrix(skel.bones[0].worldMatrix)
  ) {
    return primaryHead.matrix
  }

  if (g.vertexSkinCount === 0) {
    const b = skel.bones[g.boneIndex]
    return b && !isIdentityishMatrix(b.worldMatrix) ? b.worldMatrix : null
  }
  if (g.vertexSkinCount === 1 && g.skinBoneIndexList.length > 0) {
    const idx = g.skinBoneIndexList[0]
    const b = skel.bones[idx]
    return b && !isIdentityishMatrix(b.worldMatrix) ? b.worldMatrix : null
  }
  // `vertexSkinCount >= 2` — vertices already in model bind-pose.
  return null
}

/**
 * Build a Three.js scene-graph mirror of one FSKL skeleton:
 *   - One `THREE.Bone` per source bone, parented per the FSKL
 *     hierarchy.
 *   - A `THREE.Skeleton` wrapper carrying inverse-bind matrices
 *     so SkinnedMeshes can perform LBS.
 *   - The bone's bind-pose `position` / `quaternion` / `scale` are
 *     loaded from the source's local SRT so the rig is in bind
 *     pose by default. Animation later overrides these.
 */
/**
 * Convert BFRES Euler XYZ angles `(rx, ry, rz)` to a quaternion
 * matching BfresLibrary's `STMath.FromEulerAngles` — which builds
 * the quaternion as `qz · qy · qx`. This is **not** equivalent to
 * Three.js's `Euler('XYZ')` (which is actually `qx · qy · qz` per
 * its `makeRotationFromEuler`'s XYZ branch), so we have to do the
 * composition manually. Writes into `out` and returns it for
 * chaining.
 */
function eulerXyzToQuaternionBfres(
  rx: number,
  ry: number,
  rz: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const cx = Math.cos(rx * 0.5), sx = Math.sin(rx * 0.5)
  const cy = Math.cos(ry * 0.5), sy = Math.sin(ry * 0.5)
  const cz = Math.cos(rz * 0.5), sz = Math.sin(rz * 0.5)
  // qx = (sx, 0, 0, cx); qy = (0, sy, 0, cy); qz = (0, 0, sz, cz).
  // Hamilton product `q1 * q2`:
  //   x = w1*x2 + x1*w2 + y1*z2 - z1*y2
  //   y = w1*y2 - x1*z2 + y1*w2 + z1*x2
  //   z = w1*z2 + x1*y2 - y1*x2 + z1*w2
  //   w = w1*w2 - x1*x2 - y1*y2 - z1*z2
  // Compute qzqy = qz * qy:
  const qzqy_x = cz * 0 + 0 * cy + 0 * sy - sz * sy // = -sz*sy
  const qzqy_y = cz * sy - 0 * sy + 0 * cy + sz * 0 // = cz*sy
  const qzqy_z = cz * 0 + 0 * sy - 0 * 0 + sz * cy // = sz*cy
  const qzqy_w = cz * cy - 0 * 0 - 0 * sy - sz * 0 // = cz*cy
  // Then (qzqy) * qx:
  out.x = qzqy_w * sx + qzqy_x * cx + qzqy_y * 0 - qzqy_z * 0 // = qzqy_w*sx + qzqy_x*cx
  out.y = qzqy_w * 0 - qzqy_x * 0 + qzqy_y * cx + qzqy_z * sx // = qzqy_y*cx + qzqy_z*sx
  out.z = qzqy_w * 0 + qzqy_x * 0 - qzqy_y * sx + qzqy_z * cx // = -qzqy_y*sx + qzqy_z*cx
  out.w = qzqy_w * cx - qzqy_x * sx - qzqy_y * 0 - qzqy_z * 0 // = qzqy_w*cx - qzqy_x*sx
  return out
}

function buildSceneSkeleton(source: BfresSkeleton): FsklSceneSkeleton {
  // We set each bone's PRS by **decomposing the source's already-
  // composed `localMatrix`**, rather than feeding the raw Euler XYZ
  // angles into `THREE.Euler('XYZ')`. The two conventions look the
  // same on paper but produce different rotation matrices:
  //   - BfresLibrary's `STMath.FromEulerAngles` builds the
  //     quaternion as `Qz · Qy · Qx`, giving the matrix
  //     `Mz · My · Mx` — i.e. when applied to a vector, rotate
  //     about X first, then Y, then Z (intrinsic XYZ).
  //   - Three.js's `Euler('XYZ')` actually computes `Mx · My · Mz`
  //     (verified against the source: `makeRotationFromEuler`'s
  //     XYZ branch). Applied as `M·v` it rotates Z first, then Y,
  //     then X — the OPPOSITE order.
  // Going via `localMatrix.decompose()` sidesteps the convention
  // mismatch entirely; whatever the source intends, the matrix we
  // computed in the parser is authoritative.
  const tmpMat = new THREE.Matrix4()
  const bones: THREE.Bone[] = source.bones.map((sb) => {
    const b = new THREE.Bone()
    b.name = sb.name
    tmpMat.fromArray(sb.localMatrix as unknown as number[])
    tmpMat.decompose(b.position, b.quaternion, b.scale)
    return b
  })

  // Parent the bones into a tree per the source's parentIndex.
  const roots: THREE.Bone[] = []
  for (let i = 0; i < bones.length; i++) {
    const sb = source.bones[i]!
    if (sb.parentIndex < 0 || sb.parentIndex >= bones.length) {
      roots.push(bones[i]!)
    } else {
      bones[sb.parentIndex]!.add(bones[i]!)
    }
  }

  // Inverse-bind matrices come straight from the source. Wrap each
  // in a `THREE.Matrix4`; the underlying Float32Array is shared
  // (Matrix4 reads `elements` as a length-16 view).
  const boneInverses = source.bones.map((sb) => {
    const m = new THREE.Matrix4()
    m.fromArray(sb.inverseBindMatrix as unknown as number[])
    return m
  })
  const skeleton = new THREE.Skeleton(bones, boneInverses)
  return { bones, skeleton, source, roots }
}

/** Look up a `THREE.Bone` by name in a scene skeleton. */
function findThreeBone(
  sceneSkel: FsklSceneSkeleton,
  name: string,
): THREE.Bone | null {
  return sceneSkel.bones.find((b) => b.name === name) ?? null
}

/**
 * Remap per-vertex skin indices into direct skeleton-bone indices
 * usable by Three.js's `SkinnedMesh.skinIndex` attribute.
 *
 * BFRES per-vertex `_i0` values index into the FSKL skeleton's
 * `matrixToBoneList` array — that array is the global "skin matrix
 * table", and each entry is a bone index. (The per-shape
 * `skinBoneIndexList` is a sparse subset metadata used by the
 * engine to know which matrices to upload to the GPU; it is NOT
 * indexed by `_i0`.) Confirmed against Peach's eye shape:
 * `_i0[v] = 11` resolves through `matrixToBoneList[11] = 13` =
 * the `Head` bone, which is correct for an eye vertex.
 */
function remapSkinIndices(
  raw: Float32Array,
  matrixToBoneList: Uint16Array,
): Uint16Array {
  const out = new Uint16Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    const idx = raw[i]! | 0
    out[i] = idx >= 0 && idx < matrixToBoneList.length ? matrixToBoneList[idx]! : 0
  }
  return out
}

/**
 * Apply a {@link BfresSkeletalAnim} to a Three.js scene skeleton at
 * frame `t`. For each animated bone, evaluate the per-channel
 * curves and fold them with the bone's base/bind-pose values, then
 * write into the matching `THREE.Bone`.
 *
 * Bones not animated by this clip retain their bind-pose values.
 */
function applySkeletalAnim(
  sceneSkel: FsklSceneSkeleton,
  anim: BfresSkeletalAnim,
  t: number,
): void {
  // Reset every bone to its bind pose first. Without this, a clip
  // that doesn't touch a particular channel would inherit values
  // from whatever the previous clip left there.
  // We decompose each bone's source `localMatrix` (which uses our
  // `Mz·My·Mx` Euler convention) rather than re-running Three.js's
  // `Euler('XYZ')` (which uses the OPPOSITE order). See
  // {@link eulerXyzToQuaternionBfres} for the convention details.
  const tmpMat = new THREE.Matrix4()
  for (let i = 0; i < sceneSkel.bones.length; i++) {
    const sb = sceneSkel.source.bones[i]!
    const tb = sceneSkel.bones[i]!
    tmpMat.fromArray(sb.localMatrix as unknown as number[])
    tmpMat.decompose(tb.position, tb.quaternion, tb.scale)
  }

  // Apply each bone-anim track.
  for (const ba of anim.boneAnims) {
    const boneIdx = sceneSkel.bones.findIndex((b) => b.name === ba.name)
    if (boneIdx < 0) continue
    const tb = sceneSkel.bones[boneIdx]!
    const sb = sceneSkel.source.bones[boneIdx]!
    // Start with the bone's bind-pose values from the rig. Channels
    // present in this anim's base data overwrite them (per the
    // FSKA `FlagsBase` flags) and animated curves further overwrite
    // those at the current frame. Falling back to bind pose for
    // missing channels is what the engine does — using the FSKA
    // track's zero-defaults when a base channel isn't present
    // produces a degenerate transform that crumples the rig.
    let sx = sb.scale[0], sy = sb.scale[1], sz = sb.scale[2]
    let rx = sb.rotation[0], ry = sb.rotation[1], rz = sb.rotation[2]
    let rw = sb.rotation[3]
    let tx = sb.position[0], ty = sb.position[1], tz = sb.position[2]
    // If the track's base values are non-default, use them. The
    // BFRES extractor sets each base channel to bind pose defaults
    // (1/1/1, 0/0/0/1, 0/0/0) when the corresponding `FlagsBase`
    // bit is unset — so a non-default value means the file
    // explicitly stored a base value that should override the rig.
    // Heuristic: if any of (scale, rotate, translate) base differs
    // from defaults, prefer it. This is approximate but matches the
    // observed behaviour on MK8 character clips.
    const SX = ba.baseScale[0], SY = ba.baseScale[1], SZ = ba.baseScale[2]
    if (SX !== 1 || SY !== 1 || SZ !== 1) { sx = SX; sy = SY; sz = SZ }
    const RX = ba.baseRotation[0], RY = ba.baseRotation[1], RZ = ba.baseRotation[2], RW = ba.baseRotation[3]
    if (RX !== 0 || RY !== 0 || RZ !== 0 || RW !== 1) { rx = RX; ry = RY; rz = RZ; rw = RW }
    const TX = ba.baseTranslation[0], TY = ba.baseTranslation[1], TZ = ba.baseTranslation[2]
    if (TX !== 0 || TY !== 0 || TZ !== 0) { tx = TX; ty = TY; tz = TZ }

    for (const c of ba.curves) {
      const value = evaluateCurve(c, t)
      switch (c.animDataOffset) {
        case BoneAnimDataOffset.ScaleX: sx = value; break
        case BoneAnimDataOffset.ScaleY: sy = value; break
        case BoneAnimDataOffset.ScaleZ: sz = value; break
        case BoneAnimDataOffset.TranslateX: tx = value; break
        case BoneAnimDataOffset.TranslateY: ty = value; break
        case BoneAnimDataOffset.TranslateZ: tz = value; break
        case BoneAnimDataOffset.RotateX: rx = value; break
        case BoneAnimDataOffset.RotateY: ry = value; break
        case BoneAnimDataOffset.RotateZ: rz = value; break
        case BoneAnimDataOffset.RotateW: rw = value; break
      }
    }
    tb.position.set(tx, ty, tz)
    tb.scale.set(sx, sy, sz)
    if (anim.rotationMode === 'eulerXYZ') {
      eulerXyzToQuaternionBfres(rx, ry, rz, tb.quaternion)
    } else {
      tb.quaternion.set(rx, ry, rz, rw)
    }
  }
}

/**
 * Build a `THREE.Group` visualising every FMDL's FSKL skeleton:
 *
 *   - parent→child bone segments (line strip, one color per FMDL)
 *   - small spheres at each bone's world position
 *   - a tiny set of XYZ axes at world origin so we can see the
 *     model's coordinate frame at a glance
 *
 * Used for debugging — toggle via the "Show skeleton" checkbox.
 */
function buildSkeletonGroup(skeletons: BfresSkeleton[]): THREE.Group {
  const group = new THREE.Group()
  group.name = "skeleton-overlay"
  group.renderOrder = 999 // draw on top of meshes
  // Color palette per-FMDL — primary (most bones) gets cyan; the
  // others rotate through magenta / yellow / orange so we can
  // tell which sub-FMDL a stray bone belongs to.
  const palette = [0x00ffff, 0xff00ff, 0xffff00, 0xff8800, 0x88ff00]
  for (let mi = 0; mi < skeletons.length; mi++) {
    const skel = skeletons[mi]
    if (!skel.bones.length) continue
    const color = palette[mi % palette.length]
    const lineMat = new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    })
    const positions: number[] = []
    for (const b of skel.bones) {
      if (b.parentIndex < 0 || b.parentIndex >= skel.bones.length) continue
      const p = skel.bones[b.parentIndex].worldMatrix
      const m = b.worldMatrix
      positions.push(p[12], p[13], p[14], m[12], m[13], m[14])
    }
    if (positions.length) {
      const lg = new THREE.BufferGeometry()
      lg.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      )
      const lines = new THREE.LineSegments(lg, lineMat)
      lines.renderOrder = 999
      group.add(lines)
    }
    // Bone-tip markers (one tiny sphere per bone). Reuse one
    // SphereGeometry across all instances via InstancedMesh-lite
    // (just regular Mesh per bone — bone count is small, ≤ ~50).
    const sphereGeom = new THREE.SphereGeometry(0.04, 6, 6)
    const sphereMat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
    })
    for (const b of skel.bones) {
      const sphere = new THREE.Mesh(sphereGeom, sphereMat)
      sphere.position.set(b.worldMatrix[12], b.worldMatrix[13], b.worldMatrix[14])
      sphere.renderOrder = 999
      // Scale spheres relative to bone reach so they're visible on
      // both Yoshi (~10 unit reach) and tiny Bird (~0.1 unit reach).
      group.add(sphere)
    }
  }
  // World-origin axes for orientation reference.
  const axisLen =
    Math.max(
      ...skeletons.flatMap((s) =>
        s.bones.map((b) =>
          Math.hypot(b.worldMatrix[12], b.worldMatrix[13], b.worldMatrix[14]),
        ),
      ),
      1,
    ) * 0.5
  group.add(new THREE.AxesHelper(axisLen))
  return group
}

function disposeSkeletonGroup(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh | THREE.LineSegments
    if (m.geometry) m.geometry.dispose()
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) mat.dispose()
    }
  })
}

/**
 * Cheap "is this matrix the identity?" check — avoids computing a
 * Three.js Mesh transform when there's nothing to apply.
 */
function isIdentityishMatrix(m: Float32Array): boolean {
  const eps = 1e-5
  return (
    Math.abs(m[0] - 1) < eps && Math.abs(m[5] - 1) < eps && Math.abs(m[10] - 1) < eps &&
    Math.abs(m[1]) < eps && Math.abs(m[2]) < eps &&
    Math.abs(m[4]) < eps && Math.abs(m[6]) < eps &&
    Math.abs(m[8]) < eps && Math.abs(m[9]) < eps &&
    Math.abs(m[12]) < eps && Math.abs(m[13]) < eps && Math.abs(m[14]) < eps
  )
}

/**
 * Compute a tight bounding box over a shape's UV array. Returns
 * `null` for shapes with no UVs.
 */
function uvRange(g: BfresGeometry): {
  minU: number
  maxU: number
  minV: number
  maxV: number
} | null {
  if (!g.uvs || g.uvs.length === 0) return null
  let minU = Infinity, maxU = -Infinity
  let minV = Infinity, maxV = -Infinity
  for (let i = 0; i < g.uvs.length; i += 2) {
    const u = g.uvs[i]
    const v = g.uvs[i + 1]
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  return { minU, maxU, minV, maxV }
}

/**
 * Pick the right texture-wrap mode for a shape based on its UV
 * range:
 *
 *   - Span > 1.5 in either axis → likely a pupil-style mesh whose
 *     authored UVs deliberately extend far outside [0, 1] expecting
 *     the engine to clamp to a transparent border. Use
 *     `ClampToEdgeWrapping`. (RepeatWrapping would produce a tiled
 *     grid of pupil copies.)
 *   - Otherwise (UVs within or slightly outside [0, 1]) → use
 *     `RepeatWrapping` so meshes with negative-U coordinates (e.g.
 *     Nokonoko's `Body__m_Eye` in U=[-0.97, -0.03]) sample the
 *     authored [0, 1] region rather than clamping to a black edge
 *     pixel.
 */
function pickWrapMode(g: BfresGeometry): THREE.Wrapping {
  const r = uvRange(g)
  if (!r) return THREE.RepeatWrapping
  const spanU = r.maxU - r.minU
  const spanV = r.maxV - r.minV
  if (spanU > 1.5 || spanV > 1.5) return THREE.ClampToEdgeWrapping
  return THREE.RepeatWrapping
}

function pickAlbedo(
  geom: BfresGeometry,
  materials: BfresMaterial[][],
  cache: BntxTextureCache | null,
): THREE.Texture | null {
  if (!cache) return null
  const mat = materials[geom.modelIndex]?.[geom.materialIndex]
  if (!mat) return null
  // Switch BFRES samplers use a leading-underscore naming
  // convention: `_a0`/`_a1`/`_a2` are albedo, `_n0` normal,
  // `_s0` specular, etc. We try each albedo slot in order.
  const albedoSamplers = ["_a0", "_a1", "_a2"]
  let textureName: string | null = null
  for (const want of albedoSamplers) {
    const b = mat.bindings.find((bb) => bb.samplerName === want)
    if (b) {
      textureName = b.textureName
      break
    }
  }
  if (!textureName) return null

  const wrap = pickWrapMode(geom)
  const wrapKey = wrap === THREE.ClampToEdgeWrapping ? "clamp" : "repeat"
  const cacheKey = `${textureName}|${wrapKey}`
  // Already built a Three.js texture for this (name, wrap-mode) pair?
  if (cache.textures.has(cacheKey)) {
    return cache.textures.get(cacheKey) ?? null
  }

  // Decode the raw RGBA pixels once per texture name (memoised).
  let decoded = cache.decoded.get(textureName) ?? null
  if (!cache.decoded.has(textureName)) {
    const bntxTex = cache.byName.get(textureName)
    if (bntxTex) {
      try {
        const d = decodeBntxLayer(cache.bytes, bntxTex, 0)
        decoded = {
          pixels: new Uint8ClampedArray(
            d.pixels.buffer,
            d.pixels.byteOffset,
            d.pixels.byteLength,
          ),
          width: d.width,
          height: d.height,
          srgb: bntxTex.srgb,
        }
      } catch {
        decoded = null
      }
    }
    cache.decoded.set(textureName, decoded)
  }
  if (!decoded) {
    cache.textures.set(cacheKey, null)
    return null
  }

  const tex = new THREE.DataTexture(
    decoded.pixels,
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  tex.colorSpace = decoded.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  // `flipY` and the UV V-flip both stay OFF — that's the empirically
  // correct combination for the BFRES corpus we've tested.
  tex.flipY = false
  tex.wrapS = wrap
  tex.wrapT = wrap
  tex.minFilter = THREE.LinearMipMapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  cache.textures.set(cacheKey, tex)
  return tex
}

/** Indexed mesh in flat arrays — convenient for processing. */
interface IndexedMesh {
  /** Packed `[x, y, z, x, y, z, …]` positions. Length is 3 × vertex count. */
  positions: Float32Array
  /** Packed triangle indices. Length is 3 × triangle count. */
  indices: Uint32Array
}

/**
 * Sample every vertex of a single shape into world space, taking
 * skeletal-animation deformation into account. Returns an indexed
 * mesh so subsequent processing (welding, subdivision) can stay
 * O(triangles) without re-walking the skin.
 *
 * SkinnedMeshes use `applyBoneTransform()` so the result reflects
 * the *current* bone poses (i.e. whatever frame of whatever
 * animation the viewer is currently sitting on). Plain Meshes
 * (e.g. Pupil sub-FMDLs parented to a Head bone) inherit the
 * bone's world transform via the scene-graph; we just apply
 * `matrixWorld` directly.
 */
function bakeShapeToWorld(record: ShapeRecord): IndexedMesh | null {
  const geom = record.mesh.geometry
  const pos = geom.getAttribute("position") as THREE.BufferAttribute | undefined
  const idx = geom.getIndex()
  if (!pos || !idx) return null

  const vertexCount = pos.count
  const positions = new Float32Array(vertexCount * 3)
  const tmp = new THREE.Vector3()
  const isSkinned = (record.mesh as THREE.SkinnedMesh).isSkinnedMesh
  for (let v = 0; v < vertexCount; v++) {
    tmp.fromBufferAttribute(pos, v)
    if (isSkinned) {
      // `applyBoneTransform` reads skinIndex/skinWeight from the
      // geometry, looks up matrices on the bound skeleton, and
      // writes the skinned position back into `tmp`. With our
      // identity bindMatrix/bindMatrixInverse the bind transform
      // is a no-op, leaving us with `world_current * inv_bind *
      // v_model_bind` (or `world_current * v_bone_local` for
      // rigid-skin shapes that use identity inverses).
      ;(record.mesh as THREE.SkinnedMesh).applyBoneTransform(v, tmp)
    } else {
      tmp.applyMatrix4(record.mesh.matrixWorld)
    }
    positions[v * 3 + 0] = tmp.x
    positions[v * 3 + 1] = tmp.y
    positions[v * 3 + 2] = tmp.z
  }

  // Copy the index buffer to a Uint32Array up front so subsequent
  // passes have a uniform integer type to work with regardless of
  // whether Three.js gave us 16- or 32-bit indices.
  const idxArr = idx.array as ArrayLike<number>
  const indices = new Uint32Array(idxArr.length)
  for (let i = 0; i < idxArr.length; i++) indices[i] = idxArr[i]!

  return { positions, indices }
}

/**
 * Weld vertices that share the same world-space position. BFRES
 * authoring often duplicates a position at material / UV / normal
 * seams; without welding, those duplicates look like cracks to
 * the subdivision algorithm and prevent it from smoothing across
 * the seam (each side becomes a "boundary" edge with no neighbor
 * triangle, halving its smoothing weight).
 *
 * We bin vertices by quantised `(x, y, z)` — coordinates rounded
 * to `1 / WELD_SCALE` units. The original BFRES verts at a seam
 * are bit-exact duplicates so any reasonable scale catches them;
 * `WELD_SCALE = 1e5` (= 0.00001 unit tolerance, sub-millimetre
 * for typical model scales) is conservative.
 *
 * Triangles that collapse to <3 unique vertices after welding
 * are dropped (they were degenerate even before welding).
 */
function weldByPosition(mesh: IndexedMesh): IndexedMesh {
  const WELD_SCALE = 1e5
  const remap = new Uint32Array(mesh.positions.length / 3)
  const seen = new Map<string, number>()
  const out: number[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!
    const y = mesh.positions[i + 1]!
    const z = mesh.positions[i + 2]!
    const key =
      Math.round(x * WELD_SCALE) +
      "_" +
      Math.round(y * WELD_SCALE) +
      "_" +
      Math.round(z * WELD_SCALE)
    let idx = seen.get(key)
    if (idx === undefined) {
      idx = out.length / 3
      seen.set(key, idx)
      out.push(x, y, z)
    }
    remap[i / 3] = idx
  }
  // Apply the remap to the index buffer, dropping degenerate tris.
  const triOut: number[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = remap[mesh.indices[i]!]!
    const b = remap[mesh.indices[i + 1]!]!
    const c = remap[mesh.indices[i + 2]!]!
    if (a === b || b === c || a === c) continue
    triOut.push(a, b, c)
  }
  return {
    positions: new Float32Array(out),
    indices: new Uint32Array(triOut),
  }
}

/**
 * One pass of Loop subdivision. For every existing triangle we
 * emit four new ones by inserting a midpoint vertex on each edge:
 *
 *        a                    a
 *       / \                  /|\
 *      /   \      →         m─┼─n
 *     /     \              /\ | /\
 *    b───────c            b──p────c
 *
 * (m = midpoint of a–b, n = midpoint of a–c, p = midpoint of b–c.)
 * Both the new "odd" (edge-midpoint) vertices and the existing
 * "even" vertices are repositioned with smoothing weights so the
 * surface approaches a C² limit surface as passes accumulate.
 *
 * Smoothing rules (Loop, with Warren's β):
 *
 *   - Interior odd vertex (edge a–b shared by two tris with
 *     opposite vertices c, d): `3/8 (a+b) + 1/8 (c+d)`.
 *   - Boundary odd vertex (edge a–b shared by exactly one tri):
 *     `1/2 (a+b)`.
 *   - Interior even vertex of valence n: `(1 - n β) v + β Σ neighbours`,
 *     where β = `n == 3 ? 3/16 : 3/(8 n)`.
 *   - Boundary even vertex (lies on at least one boundary edge):
 *     `3/4 v + 1/8 (n1 + n2)` where n1, n2 are the two boundary
 *     neighbours.
 *
 * Boundary edges occur naturally on open surfaces (the underside
 * of a flat cape, the rim of a chalice, a hand's fingernail) —
 * they're real features of the source mesh, not authoring bugs.
 * Treating them with the boundary rules preserves crease lines
 * rather than smearing them inward.
 */
function loopSubdivide(mesh: IndexedMesh): IndexedMesh {
  const oldVerts = mesh.positions.length / 3
  const triCount = mesh.indices.length / 3

  // Build edge → (triCount, opposite-vertex-1, opposite-vertex-2)
  // and vertex → set(neighbour vertex) tables in one pass over
  // triangles. Edge keys are sorted-pair "min_max" strings.
  const edgeKey = (a: number, b: number) =>
    a < b ? a + "_" + b : b + "_" + a
  // For each edge: count of triangles sharing it (1 = boundary,
  // 2 = interior, >2 = non-manifold which we treat like interior
  // by only remembering two opposite verts), plus the two
  // opposite vertices.
  interface EdgeInfo {
    count: number
    opp1: number
    opp2: number
    /** Lower-indexed endpoint of the edge. */
    a: number
    /** Higher-indexed endpoint of the edge. */
    b: number
  }
  const edges = new Map<string, EdgeInfo>()
  // Per-vertex neighbour list (deduped via Set).
  const neighbours: Set<number>[] = new Array(oldVerts)
  for (let i = 0; i < oldVerts; i++) neighbours[i] = new Set()

  const recordEdge = (a: number, b: number, opp: number) => {
    const k = edgeKey(a, b)
    const e = edges.get(k)
    if (e) {
      e.count++
      if (e.count === 2) e.opp2 = opp
    } else {
      const lo = Math.min(a, b), hi = Math.max(a, b)
      edges.set(k, { count: 1, opp1: opp, opp2: -1, a: lo, b: hi })
    }
    neighbours[a]!.add(b)
    neighbours[b]!.add(a)
  }

  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3]!
    const b = mesh.indices[t * 3 + 1]!
    const c = mesh.indices[t * 3 + 2]!
    recordEdge(a, b, c)
    recordEdge(b, c, a)
    recordEdge(c, a, b)
  }

  // Identify boundary status per vertex (vertex lies on a
  // boundary if any incident edge has count === 1) and remember
  // its two boundary neighbours for the boundary-vertex rule.
  const isBoundaryVert = new Uint8Array(oldVerts)
  const boundaryNeighbours: [number, number][] = new Array(oldVerts)
  for (let i = 0; i < oldVerts; i++) boundaryNeighbours[i] = [-1, -1]
  for (const e of edges.values()) {
    if (e.count !== 1) continue
    isBoundaryVert[e.a] = 1
    isBoundaryVert[e.b] = 1
    const ba = boundaryNeighbours[e.a]!
    if (ba[0] === -1) ba[0] = e.b
    else if (ba[1] === -1 && ba[0] !== e.b) ba[1] = e.b
    const bb = boundaryNeighbours[e.b]!
    if (bb[0] === -1) bb[0] = e.a
    else if (bb[1] === -1 && bb[0] !== e.a) bb[1] = e.a
  }

  // Allocate the new position array: old vertices + one new
  // midpoint per unique edge.
  const newVertCount = oldVerts + edges.size
  const newPositions = new Float32Array(newVertCount * 3)
  // Indices into `newPositions` for each edge's odd vertex.
  const edgeMidIndex = new Map<string, number>()

  // 1. Compute repositioned even (existing) vertices.
  for (let i = 0; i < oldVerts; i++) {
    const px = mesh.positions[i * 3]!
    const py = mesh.positions[i * 3 + 1]!
    const pz = mesh.positions[i * 3 + 2]!
    if (isBoundaryVert[i]) {
      const [n1, n2] = boundaryNeighbours[i]!
      if (n1 >= 0 && n2 >= 0) {
        const ax = mesh.positions[n1 * 3]!, ay = mesh.positions[n1 * 3 + 1]!, az = mesh.positions[n1 * 3 + 2]!
        const bx = mesh.positions[n2 * 3]!, by = mesh.positions[n2 * 3 + 1]!, bz = mesh.positions[n2 * 3 + 2]!
        newPositions[i * 3 + 0] = 0.75 * px + 0.125 * (ax + bx)
        newPositions[i * 3 + 1] = 0.75 * py + 0.125 * (ay + by)
        newPositions[i * 3 + 2] = 0.75 * pz + 0.125 * (az + bz)
      } else {
        // Corner vertex (only one boundary neighbour in this
        // mesh component) — leave in place.
        newPositions[i * 3 + 0] = px
        newPositions[i * 3 + 1] = py
        newPositions[i * 3 + 2] = pz
      }
    } else {
      const nbs = neighbours[i]!
      const n = nbs.size
      // Warren's β: β = n == 3 ? 3/16 : 3/(8n).
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n)
      let sx = 0, sy = 0, sz = 0
      for (const nb of nbs) {
        sx += mesh.positions[nb * 3]!
        sy += mesh.positions[nb * 3 + 1]!
        sz += mesh.positions[nb * 3 + 2]!
      }
      newPositions[i * 3 + 0] = (1 - n * beta) * px + beta * sx
      newPositions[i * 3 + 1] = (1 - n * beta) * py + beta * sy
      newPositions[i * 3 + 2] = (1 - n * beta) * pz + beta * sz
    }
  }

  // 2. Compute new odd (edge-midpoint) vertices.
  let nextIdx = oldVerts
  for (const [k, e] of edges) {
    const ax = mesh.positions[e.a * 3]!, ay = mesh.positions[e.a * 3 + 1]!, az = mesh.positions[e.a * 3 + 2]!
    const bx = mesh.positions[e.b * 3]!, by = mesh.positions[e.b * 3 + 1]!, bz = mesh.positions[e.b * 3 + 2]!
    let nx: number, ny: number, nz: number
    if (e.count >= 2 && e.opp2 >= 0) {
      const cx = mesh.positions[e.opp1 * 3]!, cy = mesh.positions[e.opp1 * 3 + 1]!, cz = mesh.positions[e.opp1 * 3 + 2]!
      const dx = mesh.positions[e.opp2 * 3]!, dy = mesh.positions[e.opp2 * 3 + 1]!, dz = mesh.positions[e.opp2 * 3 + 2]!
      nx = 0.375 * (ax + bx) + 0.125 * (cx + dx)
      ny = 0.375 * (ay + by) + 0.125 * (cy + dy)
      nz = 0.375 * (az + bz) + 0.125 * (cz + dz)
    } else {
      nx = 0.5 * (ax + bx)
      ny = 0.5 * (ay + by)
      nz = 0.5 * (az + bz)
    }
    newPositions[nextIdx * 3 + 0] = nx
    newPositions[nextIdx * 3 + 1] = ny
    newPositions[nextIdx * 3 + 2] = nz
    edgeMidIndex.set(k, nextIdx)
    nextIdx++
  }

  // 3. Emit four sub-triangles per old triangle. Winding stays
  //    consistent with the original (counter-clockwise viewed
  //    from the same side) because each new tri keeps the
  //    parent's orientation.
  const newIndices = new Uint32Array(triCount * 12)
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3]!
    const b = mesh.indices[t * 3 + 1]!
    const c = mesh.indices[t * 3 + 2]!
    const ab = edgeMidIndex.get(edgeKey(a, b))!
    const bc = edgeMidIndex.get(edgeKey(b, c))!
    const ca = edgeMidIndex.get(edgeKey(c, a))!
    const o = t * 12
    // Corners.
    newIndices[o + 0] = a; newIndices[o + 1] = ab; newIndices[o + 2] = ca
    newIndices[o + 3] = b; newIndices[o + 4] = bc; newIndices[o + 5] = ab
    newIndices[o + 6] = c; newIndices[o + 7] = ca; newIndices[o + 8] = bc
    // Center (winding matches the parent triangle).
    newIndices[o + 9] = ab; newIndices[o + 10] = bc; newIndices[o + 11] = ca
  }

  return { positions: newPositions, indices: newIndices }
}

/**
 * Bake all currently-visible meshes — including any skeletal-
 * animation deformation applied for the active frame — into a
 * binary STL file and trigger a browser download.
 *
 * Pipeline:
 *
 *   1. For each visible shape, sample posed world-space
 *      positions ({@link bakeShapeToWorld}).
 *   2. Weld duplicate-position vertices ({@link weldByPosition})
 *      so seams don't masquerade as boundary edges in the next
 *      step.
 *   3. Optionally apply N passes of Loop subdivision
 *      ({@link loopSubdivide}); each pass quadruples the triangle
 *      count and smooths corners.
 *   4. Convert from BFRES Y-up to slicer Z-up by rotating −90°
 *      about the X axis.
 *   5. Compute flat per-triangle normals (cross product of two
 *      edges) and emit a binary STL: 80-byte free-form header,
 *      uint32 triangle count, then 50 bytes per triangle.
 *
 * Triangles whose vertices contain non-finite components after
 * baking (rare, but defensive — a malformed skin weight could
 * produce this) are dropped rather than written with garbage
 * values that might crash the slicer.
 */
function exportPosedSTL(
  shapes: ShapeRecord[],
  scene: THREE.Scene,
  baseName: string,
  suffix: string,
  subdivisionPasses: number,
): void {
  // Make sure every mesh's `matrixWorld` and every Skeleton's
  // `boneMatrices` reflect the current pose. The render loop
  // does this once per frame, but the user could in principle
  // hit "Download" before the first render — call explicitly to
  // be safe.
  scene.updateMatrixWorld(true)
  for (const r of shapes) {
    if (!r.visible) continue
    if ((r.mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      ;(r.mesh as THREE.SkinnedMesh).skeleton.update()
    }
  }

  // Per-shape: bake → weld → subdivide. We keep meshes separate
  // through these steps because cross-shape vertex sharing isn't
  // meaningful for BFRES (different shapes have different
  // materials and topologies that happen to coincide spatially).
  const cooked: IndexedMesh[] = []
  for (const r of shapes) {
    if (!r.visible) continue
    const baked = bakeShapeToWorld(r)
    if (!baked) continue
    let m = weldByPosition(baked)
    for (let p = 0; p < subdivisionPasses; p++) {
      m = loopSubdivide(m)
    }
    cooked.push(m)
  }

  // Total triangle count for the STL header.
  let totalTris = 0
  for (const m of cooked) totalTris += m.indices.length / 3
  if (totalTris === 0) return

  // Allocate the binary STL buffer up front. 80B header +
  // uint32 count + 50B per triangle.
  const bufSize = 84 + 50 * totalTris
  const buf = new ArrayBuffer(bufSize)
  const view = new DataView(buf)
  const headerBytes = new Uint8Array(buf, 0, 80)
  // STL spec: don't start with "solid" (some readers heuristic-
  // ally treat that as ASCII STL). Anything else is fine.
  const header =
    `nx-archive BFRES export ${baseName}${suffix}` +
    (subdivisionPasses > 0 ? ` sub${subdivisionPasses}` : "")
  const headerTrimmed = header.slice(0, 79)
  for (let i = 0; i < headerTrimmed.length; i++) {
    headerBytes[i] = headerTrimmed.charCodeAt(i)
  }
  view.setUint32(80, totalTris, true)

  let off = 84
  let written = 0
  const ax = new Float32Array(3)
  const bx = new Float32Array(3)
  const cx = new Float32Array(3)
  for (const m of cooked) {
    const positions = m.positions
    const indices = m.indices
    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i]! * 3
      const ib = indices[i + 1]! * 3
      const ic = indices[i + 2]! * 3
      // Pull vertex positions and apply Y-up → Z-up rotation
      // (x, y, z) ← (x, −z, y) inline.
      ax[0] = positions[ia]!; ax[1] = -positions[ia + 2]!; ax[2] = positions[ia + 1]!
      bx[0] = positions[ib]!; bx[1] = -positions[ib + 2]!; bx[2] = positions[ib + 1]!
      cx[0] = positions[ic]!; cx[1] = -positions[ic + 2]!; cx[2] = positions[ic + 1]!
      // Skip triangles whose vertices have non-finite components.
      if (
        !Number.isFinite(ax[0]! + ax[1]! + ax[2]!) ||
        !Number.isFinite(bx[0]! + bx[1]! + bx[2]!) ||
        !Number.isFinite(cx[0]! + cx[1]! + cx[2]!)
      ) {
        continue
      }
      // Flat per-triangle normal via cross product. Degenerate
      // triangles (zero-length cross) get a default `(0, 0, 1)`.
      const e1x = bx[0]! - ax[0]!, e1y = bx[1]! - ax[1]!, e1z = bx[2]! - ax[2]!
      const e2x = cx[0]! - ax[0]!, e2y = cx[1]! - ax[1]!, e2z = cx[2]! - ax[2]!
      let nx = e1y * e2z - e1z * e2y
      let ny = e1z * e2x - e1x * e2z
      let nz = e1x * e2y - e1y * e2x
      const len = Math.hypot(nx, ny, nz)
      if (len > 0) { nx /= len; ny /= len; nz /= len }
      else { nx = 0; ny = 0; nz = 1 }
      view.setFloat32(off, nx, true); off += 4
      view.setFloat32(off, ny, true); off += 4
      view.setFloat32(off, nz, true); off += 4
      view.setFloat32(off, ax[0]!, true); off += 4
      view.setFloat32(off, ax[1]!, true); off += 4
      view.setFloat32(off, ax[2]!, true); off += 4
      view.setFloat32(off, bx[0]!, true); off += 4
      view.setFloat32(off, bx[1]!, true); off += 4
      view.setFloat32(off, bx[2]!, true); off += 4
      view.setFloat32(off, cx[0]!, true); off += 4
      view.setFloat32(off, cx[1]!, true); off += 4
      view.setFloat32(off, cx[2]!, true); off += 4
      view.setUint16(off, 0, true); off += 2 // attribute byte count
      written++
    }
  }

  // If we dropped any non-finite triangles, patch the header's
  // count to match what we actually wrote so the file's still
  // valid.
  if (written !== totalTris) {
    view.setUint32(80, written, true)
  }

  // Sanitise the BFRES base name into a filesystem-safe stem.
  // We strip any extension (`.bfres`, `.szs`, etc.) and replace
  // path-hostile characters; the suffix already encodes anim +
  // frame and is provided by the caller in safe form.
  const stem = baseName.replace(/\.[^./\\]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_")
  const subSuffix = subdivisionPasses > 0 ? `_sub${subdivisionPasses}` : ""
  const fileName = `${stem || "model"}${suffix}${subSuffix}.stl`

  // Trigger download via a transient anchor + object URL.
  // Slice the buffer to the actually-written length when we
  // dropped non-finite triangles; otherwise the slicer sees
  // trailing zero-bytes after the declared triangle count.
  const finalBytes = written === totalTris ? buf : buf.slice(0, 84 + 50 * written)
  const blob = new Blob([finalBytes], { type: "model/stl" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revocation so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function BfresViewer({ node }: { node: Node }) {
  return (
    <BfresViewerErrorBoundary>
      <BfresViewerInner node={node} />
    </BfresViewerErrorBoundary>
  )
}

function BfresViewerInner({ node }: { node: Node }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [shapes, setShapes] = useState<ShapeRecord[] | null>(null)
  const skeletonsRef = useRef<BfresSkeleton[] | null>(null)
  const sceneSkeletonsRef = useRef<FsklSceneSkeleton[] | null>(null)
  const animationsRef = useRef<BfresAnimations | null>(null)
  const [showSkeleton, setShowSkeleton] = useState(false)
  // STL export options. `stlSubdivision` is the number of Loop
  // subdivision passes applied before STL emit — 0 = raw mesh
  // (fastest, smallest file, blocky look on low-poly characters);
  // 1 = ~4× tris (recommended for Switch character meshes); 2 =
  // ~16× tris (overkill for most prints, but available).
  const [stlSubdivision, setStlSubdivision] = useState<number>(1)
  // Animation playback state. `currentAnim` indexes into
  // `animations.skeletal` (or -1 for "no animation, bind pose").
  const [currentAnim, setCurrentAnim] = useState<number>(-1)
  const [playing, setPlaying] = useState<boolean>(true)
  const [frame, setFrame] = useState<number>(0)
  // Animation timing — lives in a ref so the rAF loop can read it
  // without forcing React rerenders 60×/sec.
  const animTimingRef = useRef<{
    lastTimestamp: number
    fps: number
  }>({ lastTimestamp: 0, fps: 30 })
  // Controls for the rendered scene live outside React state so we
  // can mutate them in event handlers without re-rendering.
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    animationId: number
    skeletonGroup: THREE.Group | null
  } | null>(null)

  // ---- Load + extract geometry from the BFRES blob ----
  useEffect(() => {
    let cancelled = false
    setError(null)
    setShapes(null)

    void (async () => {
      try {
        const blob = await node.blob!()
        const [geoms, materials, skeletons, animations, textureCache] = await Promise.all([
          extractGeometry(blob),
          extractMaterials(blob),
          extractSkeletons(blob),
          extractAnimations(blob),
          loadEmbeddedBntxTextures(blob),
        ])
        if (cancelled) return
        if (geoms.length === 0) {
          setError(
            new Error(
              "BFRES has no extractable geometry (no FMDL with triangle shapes).",
            ),
          )
          return
        }

        skeletonsRef.current = skeletons
        animationsRef.current = animations

        // Build a Three.js scene-graph skeleton per FMDL — array of
        // `THREE.Bone`s parented in a hierarchy, plus an `Skeleton`
        // wrapper carrying the inverse-bind matrices. SkinnedMeshes
        // bind to one of these so animation drives them all.
        const sceneSkeletons = skeletons.map(buildSceneSkeleton)
        sceneSkeletonsRef.current = sceneSkeletons

        // Pre-pick a "primary" FMDL for the multi-FMDL attachment
        // heuristic. The primary FMDL is the one with the most
        // bones (i.e. an actual rig with a Head bone). Secondary
        // FMDLs that contain only one identity-pose bone get
        // mounted on the primary FMDL's `Head` bone if it has one
        // — this is how Yoshi-style "Pupil" sub-models join the
        // body, since the BFRES file itself contains no explicit
        // cross-FMDL link (that lives in the parent SARC/BYAML).
        const primaryModelIndex = pickPrimaryFmdl(skeletons)
        const primaryHeadBone =
          primaryModelIndex >= 0
            ? findThreeBone(sceneSkeletons[primaryModelIndex]!, "Head")
            : null
        const primaryHeadSourceMatrix =
          primaryModelIndex >= 0
            ? findBone(skeletons[primaryModelIndex]!, "Head")
            : null

        const records: ShapeRecord[] = geoms.map((g) => {
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(g.positions, 3),
          )
          if (g.normals) {
            geometry.setAttribute(
              "normal",
              new THREE.BufferAttribute(g.normals, 3),
            )
          }
          if (g.uvs) {
            geometry.setAttribute("uv", new THREE.BufferAttribute(g.uvs, 2))
          }
          geometry.setIndex(new THREE.BufferAttribute(g.indices, 1))
          if (!g.normals) geometry.computeVertexNormals()

          // Pick a material: prefer the resolved albedo texture,
          // fall back to flat-shaded normal-vis if there isn't one.
          const albedo = pickAlbedo(g, materials, textureCache)
          // Many Switch albedo textures (BC3 specifically) carry
          // meaningful alpha — pupil textures are a clear example,
          // with ~57% of pixels alpha=0 to make the eye visible
          // only in a small central region. Without alphaTest those
          // transparent pixels render as opaque-but-textured, which
          // produces the "tiled pupil grid" effect we saw on Peach.
          // alphaTest discards alpha<0.5 fragments in the GPU
          // before depth-write, also avoiding z-fighting between
          // the pupil mesh and surrounding eye geometry.
          const material: THREE.Material = albedo
            ? new THREE.MeshBasicMaterial({
                map: albedo,
                side: THREE.DoubleSide,
                color: 0xffffff,
                transparent: true,
                alphaTest: 0.5,
              })
            : new THREE.MeshNormalMaterial({
                flatShading: false,
                side: THREE.DoubleSide,
              })

          // Build either a `SkinnedMesh` (shapes with skin attrs)
          // or a plain `Mesh` (rigid shapes — typically the Pupil
          // sub-FMDL).
          const sceneSkel = sceneSkeletons[g.modelIndex]
          let mesh: THREE.Mesh | THREE.SkinnedMesh
          if (g.skinIndices && g.skinWeights && sceneSkel && sceneSkel.bones.length > 0) {
            // Per-vertex `_i0` is an index into the shape's
            // `skinBoneIndexList`, which itself stores indices into
            // the FSKL skeleton. Three.js's `skinIndex` attribute
            // wants direct skeleton indices, so remap once here.
            const skinIndex = remapSkinIndices(
              g.skinIndices,
              sceneSkel.source.matrixToBoneList,
            )
            geometry.setAttribute(
              "skinIndex",
              new THREE.Uint16BufferAttribute(skinIndex, 4),
            )
            geometry.setAttribute(
              "skinWeight",
              new THREE.BufferAttribute(g.skinWeights, 4),
            )
            const skinned = new THREE.SkinnedMesh(geometry, material)
            // Pick the right `THREE.Skeleton` instance to bind
            // against. The bone array is shared across all
            // SkinnedMeshes in the same FMDL (so animation drives
            // them in lockstep), but the *inverse-bind matrices*
            // depend on what space the shape's vertices live in:
            //
            //   - Smooth-skinned shapes (`vertexSkinCount >= 2`)
            //     have vertices in model bind-pose space; the
            //     inverse-bind matrices from the FSKL
            //     (`inv(world_bind)`) are correct, because the
            //     shader does `world_current * inv(world_bind) * v`
            //     which is identity in bind pose.
            //
            //   - Rigid-skinned shapes (`vertexSkinCount === 1`)
            //     in BFRES store vertices in *bone-local* space
            //     (e.g. Yoshi's eye is authored at Y≈0..1.5,
            //     not Y≈8 where the Head bone lives). For these
            //     the shader needs `world_current * v_bone_local`
            //     directly, so the inverse-bind matrix must be
            //     **identity**. Otherwise the eye lands at bone-
            //     local origin in bind pose, on the floor.
            //
            // Build a separate `THREE.Skeleton` for the rigid
            // case, sharing the same bones but with identity
            // inverses, so this override doesn't leak into
            // smooth-skinned meshes that use the same skeleton.
            const bindSkel =
              g.vertexSkinCount === 1
                ? new THREE.Skeleton(
                    sceneSkel.bones,
                    sceneSkel.bones.map(() => new THREE.Matrix4()),
                  )
                : sceneSkel.skeleton
            // CRITICAL: pass an explicit bindMatrix (identity here)
            // so Three.js's `bind()` does NOT call
            // `skeleton.calculateInverses()` — that would recompute
            // the inverse-bind matrices from the current bone
            // matrixWorlds, throwing away whichever bind matrices
            // we just chose.
            skinned.bind(bindSkel, new THREE.Matrix4())
            // SkinnedMeshes are typically frustum-culled by their
            // *static* AABB which doesn't account for animation —
            // disable to avoid pop-out when bones move.
            skinned.frustumCulled = false
            mesh = skinned
          } else {
            mesh = new THREE.Mesh(geometry, material)
            // Multi-FMDL Pupil-style shapes: parent the mesh to the
            // primary FMDL's Head bone so it follows head animation
            // automatically. Identified by "this FMDL's only bone
            // is at identity AND we have a primary Head".
            if (
              g.modelIndex !== primaryModelIndex &&
              sceneSkel &&
              sceneSkel.bones.length === 1 &&
              primaryHeadBone &&
              isIdentityishMatrix(sceneSkel.source.bones[0]!.worldMatrix)
            ) {
              primaryHeadBone.add(mesh)
              // Mesh stays at its authored local position; the bone's
              // animated world matrix carries it.
            } else {
              // Fallback: shapes whose authored vertices live in some
              // bone's local space (e.g. `vertexSkinCount === 0` with
              // a non-identity boneIndex). Apply a static bone
              // transform — won't animate, but at least lands at the
              // bind-pose location.
              const attach = pickShapeMatrix(
                g,
                skeletons,
                primaryModelIndex,
                primaryHeadSourceMatrix,
              )
              if (attach) {
                const m = new THREE.Matrix4().fromArray(attach)
                m.decompose(mesh.position, mesh.quaternion, mesh.scale)
              }
            }
          }
          mesh.name = g.name
          return { geom: g, mesh, visible: true, hasAlbedo: !!albedo }
        })
        setShapes(records)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [node.id, node])

  // ---- Set up Three.js renderer once shapes are ready ----
  useEffect(() => {
    if (!shapes || !containerRef.current) return
    const container = containerRef.current

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: false,
      })
    } catch (err) {
      // No WebGL context available (headless browsers, very old
      // hardware, certain VM environments). Surface a clear error
      // instead of crashing the React tree.
      setError(
        err instanceof Error
          ? err
          : new Error("WebGL is not available in this browser"),
      )
      return
    }
    renderer.setPixelRatio(window.devicePixelRatio)
    // sRGB output so albedo textures (which we tag as sRGB) display
    // with correct gamma. Three.js tone-maps linearly through this
    // pipeline by default since r152.
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const updateSize = () => {
      const { clientWidth, clientHeight } = container
      renderer.setSize(clientWidth, clientHeight, false)
      camera.aspect = clientWidth / Math.max(1, clientHeight)
      camera.updateProjectionMatrix()
    }

    container.appendChild(renderer.domElement)
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"

    const scene = new THREE.Scene()
    scene.background = null

    // Add some ambient + directional fill so even non-textured meshes
    // read clearly. (MeshNormalMaterial doesn't actually need lights,
    // but if we swap to standard material later these stay relevant.)
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(2, 4, 3)
    scene.add(dir)

    // Combined bounding box from each shape's mesh — computed in
    // world space so it accounts for per-shape bone-attach matrices
    // (Yoshi's eye lifted to head height, etc.). Falls back to the
    // raw geometry AABB for shapes whose mesh hasn't been rendered
    // yet (matrixWorld is up-to-date because we set position /
    // quaternion / scale and matrixAutoUpdate is true; calling
    // updateMatrixWorld(true) here forces recompute).
    const bb = new THREE.Box3()
    const tmpBox = new THREE.Box3()
    for (const r of shapes) {
      r.mesh.updateMatrixWorld(true)
      const geom = r.mesh.geometry
      if (!geom.boundingBox) geom.computeBoundingBox()
      tmpBox.copy(geom.boundingBox!).applyMatrix4(r.mesh.matrixWorld)
      bb.union(tmpBox)
    }
    const center = new THREE.Vector3()
    bb.getCenter(center)
    const size = new THREE.Vector3()
    bb.getSize(size)
    const radius = Math.max(size.x, size.y, size.z) || 1

    const camera = new THREE.PerspectiveCamera(45, 1, radius * 0.01, radius * 100)
    // Position the camera up-and-back, looking at the model centre.
    camera.position.set(
      center.x + radius * 1.5,
      center.y + radius * 1.5,
      center.z + radius * 2.5,
    )
    camera.lookAt(center)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(center)
    controls.dampingFactor = 0.1
    controls.enableDamping = true
    controls.update()

    // Add the meshes to the scene (visibility driven by the React
    // `shapes` state via the `visible` flag).
    for (const r of shapes) {
      r.mesh.visible = r.visible
      // SkinnedMeshes go straight under the scene root. Plain
      // meshes parented to a bone (multi-FMDL Pupil case) already
      // have a parent in the scene graph; leave them alone.
      if (!r.mesh.parent) scene.add(r.mesh)
    }
    // Add scene-skeleton root bones so their world matrices are
    // computed each frame. SkinnedMeshes look up bones by reference,
    // so they need to be in the scene graph (any branch is fine).
    if (sceneSkeletonsRef.current) {
      for (const ss of sceneSkeletonsRef.current) {
        for (const root of ss.roots) {
          // A root bone might already be in the scene if e.g. it's
          // hosting a Pupil mesh as a descendant — but bones don't
          // have a parent unless we explicitly added them, so safe
          // to add unconditionally.
          if (!root.parent) scene.add(root)
        }
      }
    }

    let animationId = 0
    const loop = () => {
      try {
        // Drive the active animation forward in time. Frame state
        // is held in a ref so we don't burn React rerenders per
        // frame; the React `frame` state is only updated on user
        // interaction (scrubber) or for the UI's frame counter.
        const ctx = sceneRef.current
        if (ctx) {
          // (No-op here; per-frame anim sampling is in a separate
          // useEffect that subscribes to `currentAnim` / `playing` /
          // `frame`.)
        }
        controls.update()
        renderer.render(scene, camera)
        animationId = requestAnimationFrame(loop)
      } catch (err) {
        // Hot-reload edge case: the GL context can be lost between
        // frames. Don't keep scheduling more frames; surface the
        // error instead.
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    }
    updateSize()
    animationId = requestAnimationFrame(loop)

    sceneRef.current = {
      renderer,
      scene,
      camera,
      controls,
      animationId,
      skeletonGroup: null,
    }

    // Resize handling — observe the container, not just window.
    const ro = new ResizeObserver(updateSize)
    ro.observe(container)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(animationId)
      controls.dispose()
      // Dispose every geometry / material / texture we created.
      // Multiple shapes can share the same `DataTexture` (same
      // texture name + wrap-mode pairing), so dedupe before
      // disposing — calling `.dispose()` twice on the same texture
      // is a no-op in Three.js but flags it as disposed mid-loop.
      const seenTextures = new Set<THREE.Texture>()
      for (const r of shapes) {
        r.mesh.geometry.dispose()
        if (r.mesh.material instanceof THREE.Material) {
          const m = r.mesh.material as THREE.Material & { map?: THREE.Texture }
          if (m.map && !seenTextures.has(m.map)) {
            seenTextures.add(m.map)
            m.map.dispose()
          }
          r.mesh.material.dispose()
        }
      }
      renderer.dispose()
      renderer.domElement.remove()
      sceneRef.current = null
    }
  }, [shapes])

  // ---- Manual scrub: apply animation at the current frame
  // when paused (the rAF loop below only runs while playing). ----
  useEffect(() => {
    if (playing) return
    const sceneSkeletons = sceneSkeletonsRef.current
    const animations = animationsRef.current
    if (!sceneSkeletons || !animations) return
    const anim = currentAnim >= 0 ? animations.skeletal[currentAnim] : null
    if (!anim) return
    for (const ss of sceneSkeletons) {
      applySkeletalAnim(ss, anim, frame)
    }
  }, [playing, frame, currentAnim, shapes])

  // ---- Animation playback driver ----
  // When an animation is selected and playing, advance the frame
  // each rAF tick (fixed at the BFRES default 30 fps unless the
  // file says otherwise — Nintendo BFRES doesn't store an explicit
  // FPS, the convention is `frameCount` is in 30 fps frames).
  // On every frame we re-evaluate every animated bone's curves and
  // write into the `THREE.Bone`s of the scene skeleton; the bound
  // SkinnedMeshes deform automatically next render.
  useEffect(() => {
    const sceneSkeletons = sceneSkeletonsRef.current
    const animations = animationsRef.current
    if (!sceneSkeletons || !animations) return
    const anim = currentAnim >= 0 ? animations.skeletal[currentAnim] : null

    // Reset to bind pose when no animation is selected. Decompose
    // each bone's source `localMatrix` (BFRES convention) directly
    // rather than feeding raw Euler angles into `THREE.Euler('XYZ')`
    // — see {@link eulerXyzToQuaternionBfres}.
    if (!anim) {
      const tmpMat = new THREE.Matrix4()
      for (const ss of sceneSkeletons) {
        for (let i = 0; i < ss.bones.length; i++) {
          const sb = ss.source.bones[i]!
          const tb = ss.bones[i]!
          tmpMat.fromArray(sb.localMatrix as unknown as number[])
          tmpMat.decompose(tb.position, tb.quaternion, tb.scale)
        }
      }
      return
    }

    // Bail out completely while paused: the manual-scrub effect
    // above is the sole driver of the displayed pose, so the rAF
    // loop has nothing useful to do, and if it kept running it
    // would call `setFrame(localFrame)` every tick — clobbering
    // whatever the user just dragged the scrubber to.
    if (!playing) return

    let cancelled = false
    let lastTimestamp = 0
    // Pick up the React-state frame as the playback cursor's
    // starting point. If the user scrubbed while paused, this is
    // where they parked it; if they hit Play at the end of a non-
    // looping clip we restart from 0 so they always get *some*
    // playback.
    const fps = 30 // BFRES convention
    const totalFrames = Math.max(1, anim.frameCount)
    let localFrame = frame
    if (!anim.loop && localFrame >= totalFrames - 1) localFrame = 0
    const tick = (timestamp: number) => {
      if (cancelled) return
      if (lastTimestamp > 0) {
        const dt = (timestamp - lastTimestamp) / 1000
        localFrame += dt * fps
        if (localFrame >= totalFrames) {
          if (anim.loop) localFrame %= totalFrames
          else localFrame = totalFrames - 1
        }
      }
      lastTimestamp = timestamp

      // Apply the animation to each scene skeleton. (FSKA targets
      // bones by name, and Yoshi-style multi-FMDL setups have the
      // same bone names across both rigs only in the primary
      // skeleton. Driving every scene skeleton is harmless: the
      // anim's `boneAnims` only matches names that actually exist.)
      for (const ss of sceneSkeletons) {
        applySkeletalAnim(ss, anim, localFrame)
      }
      // Push the rounded frame number to React state for UI
      // display only. Suppressed when unchanged to avoid
      // re-renders 60×/sec.
      const rounded = Math.floor(localFrame)
      setFrame((cur) => (cur === rounded ? cur : rounded))

      requestAnimationFrame(tick)
    }
    const id = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
    // We intentionally don't list `frame` here — the rAF loop reads
    // it via the closure'd `localFrame` and only writes to React
    // state for UI display. Re-running the effect on every frame
    // tick would tear down and rebuild the rAF loop unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, currentAnim, playing])

  // ---- Skeleton wireframe overlay ----
  // Driven by `showSkeleton`: when on, build a Group of LineSegments
  // (parent→child bone connections, color-coded per-FMDL) plus
  // small markers at each bone tip and a tiny axes helper at world
  // origin. Toggling off disposes the group. Used purely for
  // debugging bone-attach positioning bugs.
  useEffect(() => {
    const ctx = sceneRef.current
    if (!ctx) return
    if (ctx.skeletonGroup) {
      ctx.scene.remove(ctx.skeletonGroup)
      disposeSkeletonGroup(ctx.skeletonGroup)
      ctx.skeletonGroup = null
    }
    if (!showSkeleton || !skeletonsRef.current) return
    const group = buildSkeletonGroup(skeletonsRef.current)
    ctx.scene.add(group)
    ctx.skeletonGroup = group
    return () => {
      const c = sceneRef.current
      if (c?.skeletonGroup === group) {
        c.scene.remove(group)
        disposeSkeletonGroup(group)
        c.skeletonGroup = null
      }
    }
  }, [showSkeleton, shapes])

  // ---- Toggle visibility of a single shape ----
  // We deliberately mutate the existing `ShapeRecord` array in
  // place (rather than allocating a new one) and then nudge a
  // small counter to force a re-render. Replacing the array
  // would change its referential identity, which would re-fire
  // every effect that depends on `[shapes]` — including the
  // scene-creation effect, which would tear down the renderer
  // and dispose the very meshes we just toggled.
  const [, setVisibilityTick] = useState(0)
  const toggleShape = (index: number) => {
    if (!shapes) return
    const r = shapes[index]
    if (!r) return
    r.visible = !r.visible
    r.mesh.visible = r.visible
    setVisibilityTick((t) => t + 1)
  }

  if (error) return <ViewerError error={error} />
  if (!shapes) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Decoding geometry…
      </div>
    )
  }

  const skeletalAnims = animationsRef.current?.skeletal ?? []
  const activeAnim = currentAnim >= 0 ? skeletalAnims[currentAnim] : null
  const totalFrames = activeAnim ? Math.max(0, activeAnim.frameCount - 1) : 0

  return (
    <div className="flex h-full flex-col gap-2">
      <div
        ref={containerRef}
        className="relative min-h-[260px] flex-1 overflow-hidden rounded-md border bg-gradient-to-b from-muted/40 to-background"
      />
      {/* Animation control bar — only renders when the BFRES has at
          least one skeletal animation. The dropdown selects which
          clip; the play/pause button and frame scrubber drive
          playback. */}
      {skeletalAnims.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={currentAnim}
            onChange={(e) => {
              const idx = Number(e.target.value)
              setCurrentAnim(idx)
              setFrame(0)
            }}
            className="rounded-md border bg-card px-2 py-1"
          >
            <option value={-1}>(bind pose — no animation)</option>
            {skeletalAnims.map((a, i) => (
              <option key={i} value={i}>
                {a.name} ({a.frameCount}f{a.loop ? ", loop" : ""})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            disabled={currentAnim < 0}
            className="rounded-md border bg-card px-2 py-1 disabled:opacity-50"
          >
            {playing ? "Pause" : "Play"}
          </button>
          <input
            type="range"
            min={0}
            max={totalFrames}
            step={1}
            value={Math.min(frame, totalFrames)}
            onChange={(e) => {
              setFrame(Number(e.target.value))
              setPlaying(false)
            }}
            disabled={currentAnim < 0}
            className="flex-1"
          />
          <span className="font-mono text-muted-foreground tabular-nums">
            {currentAnim >= 0 ? `${Math.min(frame, totalFrames)} / ${totalFrames}` : "—"}
          </span>
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <span>Smooth</span>
          <select
            value={stlSubdivision}
            onChange={(e) => setStlSubdivision(Number(e.target.value))}
            title="Loop subdivision passes applied before STL export. Each pass quadruples the triangle count and rounds out corners."
            className="rounded-md border bg-card px-1.5 py-0.5"
          >
            <option value={0}>None</option>
            <option value={1}>1× (4× tris)</option>
            <option value={2}>2× (16× tris)</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            const ctx = sceneRef.current
            if (!ctx || !shapes) return
            // Encode the active animation + frame into the STL
            // file name so a sequence of exports stays orderable
            // by name. Bind pose gets a clean "_bind" suffix.
            const safeName = (s: string) =>
              s.replace(/[^A-Za-z0-9._-]+/g, "_")
            const suffix = activeAnim
              ? `_${safeName(activeAnim.name)}_f${String(
                  Math.min(frame, totalFrames),
                ).padStart(4, "0")}`
              : "_bind"
            exportPosedSTL(
              shapes,
              ctx.scene,
              node.name,
              suffix,
              stlSubdivision,
            )
          }}
          disabled={!shapes || shapes.length === 0}
          title="Download the current pose as a binary STL (Z-up, slicer-ready)"
          className="rounded-md border bg-card px-2 py-1 disabled:opacity-50"
        >
          Download STL
        </button>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showSkeleton}
            onChange={(e) => setShowSkeleton(e.target.checked)}
            className="h-3 w-3"
          />
          <span>Show skeleton</span>
        </label>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {shapes.map((r, i) => {
          const tris = r.geom.indices.length / 3
          return (
            <label
              key={i}
              className="flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-xs"
            >
              <input
                type="checkbox"
                checked={r.visible}
                onChange={() => toggleShape(i)}
                className="h-3 w-3"
              />
              <span className="truncate" title={r.geom.name}>
                {r.geom.name || `(unnamed shape ${i})`}
              </span>
              {r.hasAlbedo ? (
                <span
                  className="shrink-0 rounded-sm bg-primary/15 px-1 text-[9px] font-medium uppercase tracking-wider text-primary"
                  title="Albedo texture bound from embedded BNTX"
                >
                  Tex
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                {r.geom.vertexCount}v / {tris}t
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
