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
  extractGeometry,
  extractMaterials,
  extractSkeletons,
  parseBfres,
  type BfresGeometry,
  type BfresMaterial,
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
  /** Three.js mesh — kept so we can dispose it on unmount. */
  mesh: THREE.Mesh
  /** True iff the user has toggled this shape on. Drives renderer visibility. */
  visible: boolean
  /** Whether we successfully bound an albedo texture from the BNTX. */
  hasAlbedo: boolean
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
  const [showSkeleton, setShowSkeleton] = useState(false)
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
        const [geoms, materials, skeletons, textureCache] = await Promise.all([
          extractGeometry(blob),
          extractMaterials(blob),
          extractSkeletons(blob),
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

        // Pre-pick a "primary" FMDL for the multi-FMDL attachment
        // heuristic. The primary FMDL is the one with the most
        // bones (i.e. an actual rig with a Head bone). Secondary
        // FMDLs that contain only one identity-pose bone get
        // mounted on the primary FMDL's `Head` bone if it has one
        // — this is how Yoshi-style "Pupil" sub-models join the
        // body, since the BFRES file itself contains no explicit
        // cross-FMDL link (that lives in the parent SARC/BYAML).
        skeletonsRef.current = skeletons
        const primaryModelIndex = pickPrimaryFmdl(skeletons)
        const primaryHead =
          primaryModelIndex >= 0
            ? findBone(skeletons[primaryModelIndex], "Head")
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
          const mesh = new THREE.Mesh(geometry, material)
          mesh.name = g.name

          // Apply the shape's bone-attach transform if any. See
          // {@link pickShapeMatrix} for the rules. Mesh.matrixAutoUpdate
          // is left at the default `true`, so we modify position /
          // quaternion / scale via Matrix4.decompose.
          const attach = pickShapeMatrix(
            g,
            skeletons,
            primaryModelIndex,
            primaryHead,
          )
          if (attach) {
            const m = new THREE.Matrix4().fromArray(attach)
            m.decompose(mesh.position, mesh.quaternion, mesh.scale)
          }
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
      scene.add(r.mesh)
    }

    let animationId = 0
    const loop = () => {
      try {
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
  const toggleShape = (index: number) => {
    setShapes((cur) => {
      if (!cur) return cur
      const next = cur.slice()
      next[index] = { ...next[index], visible: !next[index].visible }
      next[index].mesh.visible = next[index].visible
      return next
    })
  }

  if (error) return <ViewerError error={error} />
  if (!shapes) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Decoding geometry…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div
        ref={containerRef}
        className="relative min-h-[260px] flex-1 overflow-hidden rounded-md border bg-gradient-to-b from-muted/40 to-background"
      />
      <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
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
