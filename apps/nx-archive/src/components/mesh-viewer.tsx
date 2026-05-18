/**
 * Generic Three.js viewer for any indexed mesh — used by the UE
 * StaticMesh viewer ({@link ./static-mesh-viewer.tsx}), the BFRES
 * viewer ({@link ./bfres-viewer.tsx}) — for the shared toolbar
 * + STL export logic — and the PhyreEngine `.dae.phyre` viewer.
 *
 * Per-format wrappers convert their parsed geometry into a
 * {@link RenderableMesh} (1+ LODs, each LOD = positions/normals/
 * indices/sections) and pass optional textures + animation
 * metadata. The viewer plumbs in the renderer lifecycle, orbit
 * controls, framing, wireframe + normals overlays, LOD picker,
 * animation playback controls, STL export with optional Loop
 * subdivision smoothing.
 *
 * # Why not three.js scene-driven viewers per format?
 *
 * Each format used to ship its own toolbar UI, STL emit pipeline,
 * camera framing logic, etc. This caused drift: BFRES grew an
 * animation scrubber + STL export with subdivision; UE
 * StaticMesh viewer didn't; PhyreEngine started without either.
 * Consolidating here means every format gets the same baseline
 * (and the same future improvements: gizmos, lighting controls,
 * screenshot, etc.) for free.
 *
 * # Animation API
 *
 * Animation playback is *driver-driven* — the per-format viewer
 * passes a {@link MeshViewerAnimationDriver} that knows how to
 * sample its own clip data into the scene each frame. The
 * viewer owns the play/pause/frame state and rAF loop; the
 * driver owns the per-format math (skinning, FMAA texture
 * swaps, etc.). Formats with no animations omit the prop and
 * the toolbar hides the scrubber.
 *
 * # STL export API
 *
 * STL emit lives in {@link ~/lib/mesh-export} (welding +
 * subdivision + binary STL encoder). The viewer drives it via
 * a {@link MeshViewerExportProvider} callback that knows how to
 * bake the current pose into world-space `IndexedMesh`es. The
 * default provider (when omitted) samples positions from the
 * already-rendered three.js mesh — fine for static geometry.
 * BFRES overrides this to honour skinning + visibility toggles.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

import {
  emitBinarySTL,
  loopSubdivide,
  sanitizeStem,
  triggerDownload,
  weldByPosition,
  type IndexedMesh,
} from "~/lib/mesh-export"
import type { DecodedTexture } from "~/lib/uasset-material-chain"

import { PauseIcon, PlayIcon } from "lucide-react"

/**
 * One material-bounded slice of an indexed mesh. Mirrors UE's
 * `StaticMeshSection` but generic across formats.
 */
export interface RenderableMeshSection {
  /**
   * Index into the parent {@link RenderableMesh}'s material slot
   * array. Multiple sections may share a material slot.
   */
  materialIndex: number
  /** Offset (in indices) into the LOD's index buffer. */
  firstIndex: number
  /** Triangle count rendered from `firstIndex`. */
  numTriangles: number
}

/**
 * One Level Of Detail. Pass typed arrays directly from the
 * parser; Three.js never mutates them on construction.
 *
 * `normals` is optional — if `undefined`, we call
 * {@link THREE.BufferGeometry#computeVertexNormals} to derive
 * flat-shaded normals from positions+indices. PhyreEngine meshes
 * use this path; UE static meshes ship parsed normals.
 */
export interface RenderableMeshLOD {
  /** Vertex count = positions.length / 3. */
  numVertices: number
  /** XYZ-interleaved positions. */
  positions: Float32Array
  /**
   * XYZ-interleaved unit normals, or `undefined` to auto-compute
   * from face geometry.
   */
  normals?: Float32Array
  /** First UV channel (UV-interleaved); used when textures are bound. */
  uv?: Float32Array
  /**
   * Per-vertex RGB linear colors (RGB-interleaved). When present
   * AND a section has no diffuse texture, the section's material
   * is rendered with `vertexColors: true` instead of the rainbow
   * normals fallback. Used by FF7 PC field models (per-polygon
   * vertex colors authored at PSX vertex-light bake time).
   */
  colors?: Float32Array
  /**
   * 16- or 32-bit triangle-list index buffer. Triangles are
   * `[indices[3i], indices[3i+1], indices[3i+2]]`.
   */
  indices: Uint16Array | Uint32Array
  /** Material-bounded slices. Must cover the full index buffer between them. */
  sections: RenderableMeshSection[]
  /** Optional short label shown in the LOD picker. */
  label?: string
}

/**
 * Generic mesh prop. `upAxis` lets per-format wrappers undo any
 * coordinate-system rotation:
 *   - `'y-up'` (default): no rotation; matches Three.js convention.
 *   - `'z-up'`: rotate −90° around X so Z-up models stand upright.
 *   - `'y-down'`: rotate 180° around Z so −Y-up models stand upright.
 *
 * `flipYDefault` is the *initial state* of the toolbar's "Flip Y"
 * checkbox — the user can toggle it interactively afterwards.
 * Useful when a format's coordinate convention isn't reliably
 * determinable up front (PhyreEngine NVN: some are Y-up, some
 * are Y-down depending on the source authoring tool).
 */
export interface RenderableMesh {
  lods: RenderableMeshLOD[]
  upAxis?: "y-up" | "z-up" | "y-down"
  flipYDefault?: boolean
}

/**
 * One animation clip exposed to the viewer's dropdown. Frame
 * count drives the scrubber max; the actual sampling is handled
 * by the {@link MeshViewerAnimationDriver}.
 */
export interface MeshViewerAnimation {
  name: string
  frameCount: number
  /** Optional category label (e.g. "skeletal", "material"). Used when multiple drivers coexist. */
  category?: string
  loop?: boolean
}

/**
 * Per-format animation driver. The viewer calls
 * {@link MeshViewerAnimationDriver.sample} every frame the
 * scrubber advances; the driver mutates its own scene state.
 *
 * `category` lets multi-track formats (BFRES: skeletal + material
 * animations) ship one driver per category with independent
 * selection state — though the simplest case is one category.
 */
export interface MeshViewerAnimationDriver {
  /** Stable identifier shown in the dropdown title (e.g. "skeletal"). Defaults to "Animation". */
  category?: string
  /** Animation clips. The viewer renders one `<select>` per driver. */
  animations: MeshViewerAnimation[]
  /**
   * Apply a clip + frame to the scene. Called every rAF tick
   * the viewer's frame counter changes. `index = -1` means "no
   * animation selected" — the driver should reset to bind pose.
   *
   * Drivers that need to mutate the rendered mesh's geometry
   * (FF7 skeletal animation, BFRES skin pose, …) can do so via
   * `ctx.geometry` — the `THREE.BufferGeometry` currently
   * mounted on the visible mesh. Mark mutated attributes with
   * `.needsUpdate = true` so Three.js re-uploads them.
   */
  sample(
    index: number,
    frame: number,
    ctx: { geometry: THREE.BufferGeometry | null },
  ): void
}

/**
 * Per-format STL export provider. The default provider (used
 * when omitted) bakes the currently-rendered scene mesh into
 * world space via `Mesh.matrixWorld` — fine for static meshes.
 *
 * Skinned meshes (BFRES) override this to additionally bake
 * skinning + visibility filters + custom welding tolerance.
 */
export interface MeshViewerExportProvider {
  /**
   * Bake the current viewer state (animation frame, visibility,
   * skinning) into one or more world-space indexed meshes.
   * Return an empty array to disable export.
   */
  bake(scene: THREE.Scene): IndexedMesh[]
  /** Override the STL header free-form text. */
  header?: string
  /**
   * Override the STL output's source-axis flag. By default,
   * matches the viewer's `mesh.upAxis` to produce slicer-friendly
   * Z-up output (UE meshes are already Z-up; we mark them as
   * such so the STL emitter doesn't re-rotate them).
   */
  sourceAxis?: "y-up" | "z-up"
}

interface MeshViewerProps {
  mesh: RenderableMesh
  /**
   * Optional per-slot diffuse textures. Index matches each
   * section's `materialIndex`. Entries may be `null` for slots
   * that didn't resolve a usable texture. When undefined or all-
   * null, falls back to {@link THREE.MeshNormalMaterial}.
   */
  materialDiffuseTextures?: Array<DecodedTexture | null>
  /** Optional informational text shown in the toolbar (e.g. "4 sections · 1522 triangles"). */
  infoText?: string
  /** Animation drivers (zero or more). Each renders its own dropdown. */
  animationDrivers?: MeshViewerAnimationDriver[]
  /**
   * Custom STL export provider. When omitted, STL export uses
   * a default "bake whatever's in the scene" pipeline that
   * works for static meshes.
   */
  exportProvider?: MeshViewerExportProvider
  /** Base file name (without extension) used when downloading exports. */
  baseName?: string
  /**
   * Imperative ref handle for callers that need direct access
   * to the scene / renderer (e.g. BFRES exposes per-shape
   * visibility toggles outside the toolbar).
   */
  viewerRef?: RefObject<MeshViewerHandle | null>
}

/**
 * Imperative handle exposed by {@link MeshViewer} for advanced
 * callers (BFRES needs direct scene access to bind its custom
 * `bakeShapeToWorld` skin sampler). Most callers should NOT
 * need this — the {@link MeshViewerExportProvider} callback
 * already gets a scene reference.
 */
export interface MeshViewerHandle {
  scene: THREE.Scene | null
  renderer: THREE.WebGLRenderer | null
}

/**
 * Build a Three.js BufferGeometry from one LOD. Re-uses the
 * caller's typed arrays — `BufferAttribute` holds a reference
 * and Three.js never mutates incoming attribute data on
 * construction.
 *
 * If `normals` is omitted, derive them from face geometry via
 * `computeVertexNormals()` — this produces visually-decent flat
 * shading for unlit meshes (e.g. PhyreEngine `.dae.phyre` where
 * we haven't decoded the normal stream yet).
 *
 * Each section becomes a `geometry.group`, so the viewer can
 * render the mesh with multiple materials in a single draw-call
 * pipeline. Sections with `materialIndex` outside the materials
 * array fall back to the slot-0 material.
 */
function buildGeometry(lod: RenderableMeshLOD): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute("position", new THREE.BufferAttribute(lod.positions, 3))
  if (lod.normals) {
    geom.setAttribute("normal", new THREE.BufferAttribute(lod.normals, 3))
  }
  if (lod.uv) {
    geom.setAttribute("uv", new THREE.BufferAttribute(lod.uv, 2))
  }
  if (lod.colors) {
    geom.setAttribute("color", new THREE.BufferAttribute(lod.colors, 3))
  }
  geom.setIndex(new THREE.BufferAttribute(lod.indices, 1))
  for (const sec of lod.sections) {
    geom.addGroup(sec.firstIndex, sec.numTriangles * 3, sec.materialIndex)
  }
  if (!lod.normals) {
    geom.computeVertexNormals()
  }
  geom.computeBoundingBox()
  geom.computeBoundingSphere()
  return geom
}

/**
 * Build a Three.js DataTexture from a {@link DecodedTexture}.
 * RGBA8 bytes, sRGB color space, Y-flipped per the decoder's
 * `flipY` flag (defaults to `true` — UE / Maya convention).
 */
function buildDataTexture(decoded: DecodedTexture): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    decoded.pixels,
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.flipY = decoded.flipY ?? true
  tex.needsUpdate = true
  return tex
}

/**
 * Compose the transform we apply to the mesh + camera framing
 * from the format's `upAxis` and the user's "Flip Y" toggle.
 *
 *   - `upAxis` corrects the source coordinate system's up-vector
 *     to Three.js's Y-up convention via a proper rotation.
 *   - `flipY` is a pure Y-axis mirror (`scale.y = -1`). Mirrors
 *     are NOT rotations — they flip triangle winding, so we
 *     compensate with `side: BackSide` materials (or
 *     `DoubleSide`) when this flag is on. The advantage over
 *     180° rotations is that the camera continues to see the
 *     model's intended front face regardless of orientation
 *     mismatches in the source coordinate system.
 *
 * Returns the composed scale + rotation. The caller applies the
 * rotation to `Object3D.rotation` and the scale to
 * `Object3D.scale`. The matrix form is used to transform the
 * camera-framing pivot.
 */
function meshTransform(
  upAxis: NonNullable<RenderableMesh["upAxis"]>,
  flipY: boolean,
): {
  rotation: THREE.Euler
  scale: THREE.Vector3
  matrix: THREE.Matrix4
  /** True when the transform inverts triangle winding (mirror). */
  windingFlipped: boolean
} {
  const rot = new THREE.Matrix4()
  switch (upAxis) {
    case "y-up":
      rot.identity()
      break
    case "z-up":
      rot.makeRotationX(-Math.PI / 2)
      break
    case "y-down":
      // 180° around X — mirrors via rotation. Caller may prefer
      // `flipYDefault: true` over this if they specifically
      // want the scale-based flip.
      rot.makeRotationX(Math.PI)
      break
  }
  const scale = new THREE.Vector3(1, 1, 1)
  if (flipY) {
    scale.y = -1
  }
  const matrix = new THREE.Matrix4()
    .makeScale(scale.x, scale.y, scale.z)
    .multiply(rot)
  const euler = new THREE.Euler().setFromRotationMatrix(rot)
  // Determinant negativity ⇔ winding flipped.
  const windingFlipped = matrix.determinant() < 0
  return { rotation: euler, scale, matrix, windingFlipped }
}

/**
 * Generic Three.js mesh viewer. Renders an indexed mesh with
 * orbit controls, optional textures, wireframe + normals
 * overlays, optional animation playback, and an STL download
 * button with optional Loop-subdivision smoothing.
 */
export function MeshViewer({
  mesh,
  materialDiffuseTextures,
  infoText,
  animationDrivers,
  exportProvider,
  baseName,
  viewerRef,
}: MeshViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<{
    scene: THREE.Scene
    renderer: THREE.WebGLRenderer
  } | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [selectedLOD, setSelectedLOD] = useState(0)
  const [showWireframe, setShowWireframe] = useState(false)
  const [showNormals, setShowNormals] = useState(false)
  const [forceNormalShading, setForceNormalShading] = useState(false)
  // User-toggleable Y-flip. Some game engines store models with
  // `+Y = down` (Unreal historically, some PhyreEngine titles);
  // the per-format adapter can't always know which convention
  // the source file used. The toggle defaults to the value the
  // caller suggests via `mesh.flipYDefault`, then the user can
  // override interactively.
  const [flipY, setFlipY] = useState(Boolean(mesh.flipYDefault))

  // Animation state. One selected index per driver (parallel
  // arrays to `animationDrivers`); a shared frame counter; a
  // single play/pause toggle that drives all selected clips
  // together.
  const drivers = animationDrivers ?? []
  const [selectedAnims, setSelectedAnims] = useState<number[]>(() =>
    drivers.map(() => -1),
  )
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(true)
  const driversRef = useRef(drivers)
  driversRef.current = drivers
  const selectedAnimsRef = useRef(selectedAnims)
  selectedAnimsRef.current = selectedAnims
  // Stable ref to the currently-mounted geometry, so animation
  // drivers can mutate it in place without us threading
  // closures through the rAF loop.
  const geometryRef = useRef<THREE.BufferGeometry | null>(null)

  // Resize the per-driver selection array if the driver count
  // changes (rare — drivers usually arrive once at mount).
  useEffect(() => {
    if (selectedAnims.length !== drivers.length) {
      setSelectedAnims(drivers.map(() => -1))
    }
  }, [drivers.length])

  // STL export state — subdivision passes applied before emit.
  const [stlSubdivision, setStlSubdivision] = useState(0)

  // Stable geometry per LOD so the canvas effect can swap without
  // rebuilding the attribute buffers every render.
  const geometries = useMemo(() => mesh.lods.map(buildGeometry), [mesh])
  const hasAnyTexture = useMemo(
    () => Boolean(materialDiffuseTextures?.some((t) => t)),
    [materialDiffuseTextures],
  )

  useEffect(() => {
    return () => {
      for (const g of geometries) g.dispose()
    }
  }, [geometries])

  const lod = mesh.lods[selectedLOD]
  const geometry = geometries[selectedLOD]
  // Mirror the currently-displayed geometry into the stable
  // ref so animation drivers can mutate it.
  geometryRef.current = geometry ?? null
  const upAxis = mesh.upAxis ?? "y-up"

  useEffect(() => {
    if (!geometry || !lod || !containerRef.current) return
    const container = containerRef.current

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch (err) {
      setError(
        err instanceof Error
          ? err
          : new Error("WebGL is not available in this browser"),
      )
      return
    }
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(renderer.domElement)
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"

    const scene = new THREE.Scene()
    scene.background = null

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7)
    dirLight.position.set(2, 4, 3)
    scene.add(dirLight)

    const useTextures = !forceNormalShading && hasAnyTexture
    const hasVertexColors = Boolean(lod.colors)
    const slotCount = Math.max(
      ...lod.sections.map((s) => s.materialIndex + 1),
      materialDiffuseTextures?.length ?? 0,
      1,
    )
    const materials: THREE.Material[] = []
    const ownedTextures: THREE.DataTexture[] = []
    for (let i = 0; i < slotCount; i++) {
      const decoded = useTextures ? materialDiffuseTextures?.[i] : null
      if (decoded) {
        const tex = buildDataTexture(decoded)
        ownedTextures.push(tex)
        materials.push(
          new THREE.MeshStandardMaterial({
            map: tex,
            side: THREE.DoubleSide,
            wireframe: showWireframe,
            roughness: 0.85,
            metalness: 0,
            // Even when the geometry has a `color` attribute,
            // textured slots should render the texture as-is —
            // FF7 bakes very dark vertex colors into eye/mouth
            // polygons that would otherwise blacken the texture.
            vertexColors: false,
            // FF7 textures use 1-bit alpha for cutout regions
            // (eye sockets, mouth interiors). Discard fully-
            // transparent texels at the fragment level so the
            // model behind them shows through.
            transparent: true,
            alphaTest: 0.5,
          }),
        )
      } else if (hasVertexColors && !forceNormalShading) {
        // Per-vertex baked colors (FF7 PC field models). Use a
        // basic unlit-ish material so the authored colors show
        // up faithfully without being washed out by lighting.
        materials.push(
          new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            wireframe: showWireframe,
          }),
        )
      } else {
        materials.push(
          new THREE.MeshNormalMaterial({
            side: THREE.DoubleSide,
            wireframe: showWireframe,
            flatShading: false,
          }),
        )
      }
    }
    const meshMaterial: THREE.Material | THREE.Material[] =
      materials.length === 1 ? materials[0]! : materials
    const meshObj = new THREE.Mesh(geometry, meshMaterial)
    const {
      rotation: meshRot,
      scale: meshScale,
      matrix: meshMatrix,
    } = meshTransform(upAxis, flipY)
    meshObj.rotation.copy(meshRot)
    meshObj.scale.copy(meshScale)
    scene.add(meshObj)

    let normalsHelper: THREE.LineSegments | null = null
    if (showNormals) {
      normalsHelper = buildNormalsHelper(lod, geometry)
      meshObj.add(normalsHelper)
    }

    // Frame the camera around the geometry's bounding sphere so
    // we don't depend on the asset's reported bounds. Account
    // for the model rotation before placing the camera so the
    // initial view sits front-three-quarter-up regardless of
    // the source coordinate system.
    const sphere = geometry.boundingSphere!
    const radius = Math.max(sphere.radius, 0.01)
    const center = sphere.center.clone()
    // Apply the same composed rotation we used on the mesh so
    // the camera frames the model in its post-rotation position.
    center.applyMatrix4(meshMatrix)

    const camera = new THREE.PerspectiveCamera(
      45,
      1,
      radius * 0.01,
      radius * 100,
    )
    camera.position.set(
      center.x + radius * 2,
      center.y + radius * 1.4,
      center.z + radius * 2,
    )
    camera.lookAt(center)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(center)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.update()

    sceneRef.current = { scene, renderer }
    if (viewerRef) {
      viewerRef.current = { scene, renderer }
    }

    const onResize = () => {
      const { clientWidth, clientHeight } = container
      if (clientWidth === 0 || clientHeight === 0) return
      renderer.setSize(clientWidth, clientHeight, false)
      camera.aspect = clientWidth / clientHeight
      camera.updateProjectionMatrix()
    }
    onResize()
    const ro = new ResizeObserver(onResize)
    ro.observe(container)

    let rafId = 0
    const tick = () => {
      controls.update()
      renderer.render(scene, camera)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      controls.dispose()
      for (const m of materials) m.dispose()
      for (const t of ownedTextures) t.dispose()
      if (normalsHelper) {
        normalsHelper.geometry.dispose()
        ;(normalsHelper.material as THREE.Material).dispose()
      }
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
      sceneRef.current = null
      if (viewerRef) {
        viewerRef.current = null
      }
    }
  }, [
    geometry,
    lod,
    showWireframe,
    showNormals,
    materialDiffuseTextures,
    forceNormalShading,
    hasAnyTexture,
    upAxis,
    flipY,
    viewerRef,
  ])

  // Compute scrubber max = longest selected clip across drivers.
  const scrubMax = useMemo(() => {
    let max = 0
    for (let d = 0; d < drivers.length; d++) {
      const idx = selectedAnims[d] ?? -1
      if (idx < 0) continue
      const clip = drivers[d]!.animations[idx]
      if (clip && clip.frameCount - 1 > max) max = clip.frameCount - 1
    }
    return max
  }, [drivers, selectedAnims])
  const anyAnimSelected = selectedAnims.some((i) => i >= 0)

  // Drive the animation clock when `playing`. Each tick advances
  // `frame`; each driver gets a `sample()` call with its
  // currently-selected clip index.
  useEffect(() => {
    if (!anyAnimSelected) return
    if (!playing) {
      // When paused, push the current frame to all drivers once
      // so scrubbing has immediate visual feedback.
      for (let d = 0; d < driversRef.current.length; d++) {
        const idx = selectedAnimsRef.current[d] ?? -1
        driversRef.current[d]!.sample(idx, frame, { geometry: geometryRef.current })
      }
      return
    }
    let raf = 0
    let lastTime = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = (now - lastTime) / 1000
      lastTime = now
      // 60 fps clip playback; clamp to drivers' loop flag.
      setFrame((f) => {
        let next = f + dt * 60
        if (scrubMax > 0) {
          const looped = next > scrubMax
          if (looped) {
            // Loop unless every selected clip has loop=false.
            const allOneShot = driversRef.current.every((drv, d) => {
              const idx = selectedAnimsRef.current[d] ?? -1
              if (idx < 0) return true
              return drv.animations[idx]!.loop === false
            })
            if (allOneShot) {
              setPlaying(false)
              return scrubMax
            }
            next = next % (scrubMax + 1)
          }
        }
        for (let d = 0; d < driversRef.current.length; d++) {
          const idx = selectedAnimsRef.current[d] ?? -1
          driversRef.current[d]!.sample(idx, next, { geometry: geometryRef.current })
        }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, anyAnimSelected, scrubMax, frame, drivers.length])

  // Apply the current frame whenever scrubbed or driver selection
  // changes (covers the "paused + dropdown change" path that
  // doesn't trigger the rAF loop above).
  useEffect(() => {
    for (let d = 0; d < drivers.length; d++) {
      const idx = selectedAnims[d] ?? -1
      drivers[d]!.sample(idx, frame, { geometry: geometryRef.current })
    }
  }, [selectedAnims, drivers])

  const handleExportSTL = () => {
    const ctx = sceneRef.current
    if (!ctx) return
    const provider = exportProvider ?? defaultExportProvider(geometry, upAxis)
    let baked = provider.bake(ctx.scene)
    if (baked.length === 0) return
    if (stlSubdivision > 0) {
      baked = baked.map((m) => {
        let cooked = weldByPosition(m)
        for (let p = 0; p < stlSubdivision; p++) cooked = loopSubdivide(cooked)
        return cooked
      })
    } else {
      baked = baked.map(weldByPosition)
    }
    const sourceAxis =
      provider.sourceAxis ?? (upAxis === "z-up" ? "z-up" : "y-up")
    const stem = sanitizeStem(baseName ?? "model") || "model"
    // Encode the active animation clip + frame into the suffix
    // so a sequence of exports stays orderable by file name.
    let suffix = ""
    for (let d = 0; d < drivers.length; d++) {
      const idx = selectedAnims[d] ?? -1
      if (idx < 0) continue
      const clip = drivers[d]!.animations[idx]!
      const safe = clip.name.replace(/[^A-Za-z0-9._-]+/g, "_")
      suffix += `_${safe}_f${String(Math.floor(frame)).padStart(4, "0")}`
    }
    if (!suffix && drivers.length > 0) suffix = "_bind"
    if (stlSubdivision > 0) suffix += `_sub${stlSubdivision}`
    const bytes = emitBinarySTL(baked, {
      header:
        provider.header ?? `nx-archive ${stem} export${suffix}`,
      sourceAxis,
    })
    triggerDownload(bytes, `${stem}${suffix}.stl`, "model/stl")
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-sm font-medium">Mesh viewer unavailable</p>
        <p className="text-xs text-muted-foreground">{error.message}</p>
      </div>
    )
  }

  const totalFrames = scrubMax

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {mesh.lods.length > 1 && (
          <>
            <span className="text-muted-foreground">LOD</span>
            <select
              className="rounded border bg-background px-2 py-1 font-mono"
              value={selectedLOD}
              onChange={(e) => setSelectedLOD(Number(e.target.value))}
            >
              {mesh.lods.map((l, i) => (
                <option key={i} value={i}>
                  {l.label ??
                    `${i}: ${l.numVertices.toLocaleString()} verts, ${(l.indices.length / 3).toLocaleString()} tris`}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showWireframe}
            onChange={(e) => setShowWireframe(e.target.checked)}
          />
          <span>Wireframe</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showNormals}
            onChange={(e) => setShowNormals(e.target.checked)}
          />
          <span>Normals</span>
        </label>
        <label
          className="flex items-center gap-1"
          title="Rotate 180° around X. Use this when the model is upside-down — common for game formats whose authoring tool baked in a Y-down convention."
        >
          <input
            type="checkbox"
            checked={flipY}
            onChange={(e) => setFlipY(e.target.checked)}
          />
          <span>Flip Y</span>
        </label>
        {hasAnyTexture && (
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={forceNormalShading}
              onChange={(e) => setForceNormalShading(e.target.checked)}
            />
            <span>Normal shading</span>
          </label>
        )}
        {infoText && (
          <span className="ml-auto text-muted-foreground">{infoText}</span>
        )}
      </div>
      <div
        ref={containerRef}
        className="min-h-[400px] flex-1 rounded-md border bg-[oklch(0.92_0_0)] dark:bg-[oklch(0.18_0_0)]"
      />
      {drivers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {drivers.map((drv, d) => (
            <select
              key={d}
              value={selectedAnims[d] ?? -1}
              onChange={(e) => {
                const idx = Number(e.target.value)
                setSelectedAnims((prev) => {
                  const next = prev.slice()
                  next[d] = idx
                  return next
                })
                setFrame(0)
                if (idx >= 0) setPlaying(true)
              }}
              title={drv.category ? `${drv.category} animation` : "Animation"}
              className="rounded-md border bg-card px-2 py-1"
            >
              <option value={-1}>
                ({drv.category ? `no ${drv.category}` : "no animation"})
              </option>
              {drv.animations.map((a, i) => (
                <option key={i} value={i}>
                  {a.name} ({a.frameCount}f{a.loop ? ", loop" : ""})
                </option>
              ))}
            </select>
          ))}
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            disabled={!anyAnimSelected}
            aria-label={playing ? "Pause animation" : "Play animation"}
            title={playing ? "Pause" : "Play"}
            className="inline-flex items-center justify-center rounded-md border bg-card p-1.5 disabled:opacity-50"
          >
            {playing ? (
              <PauseIcon className="size-4" />
            ) : (
              <PlayIcon className="size-4" />
            )}
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
            disabled={!anyAnimSelected}
            className="flex-1"
          />
          <span className="font-mono text-muted-foreground tabular-nums">
            {anyAnimSelected
              ? `${Math.floor(Math.min(frame, totalFrames))} / ${totalFrames}`
              : "—"}
          </span>
        </div>
      )}
      {/* STL export bar — always visible (every mesh can be exported). */}
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
          onClick={handleExportSTL}
          title="Download the current pose as a binary STL (Z-up, slicer-ready)"
          className="rounded-md border bg-card px-2 py-1"
        >
          Download STL
        </button>
      </div>
    </div>
  )
}

/**
 * Default STL bake provider: extract positions + indices from
 * every visible `THREE.Mesh` in the scene, applying its world
 * matrix. Good enough for static (non-skinned) geometry; BFRES
 * overrides this to honour skinning + per-shape visibility.
 */
function defaultExportProvider(
  initialGeometry: THREE.BufferGeometry,
  upAxis: NonNullable<RenderableMesh["upAxis"]>,
): MeshViewerExportProvider {
  void initialGeometry // currently we walk the scene; reserved for future bypass
  return {
    bake(scene) {
      const meshes: IndexedMesh[] = []
      const tmp = new THREE.Vector3()
      scene.updateMatrixWorld(true)
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return
        if (!obj.visible) return
        const geom = obj.geometry
        const pos = geom.getAttribute("position") as
          | THREE.BufferAttribute
          | undefined
        const idx = geom.getIndex()
        if (!pos || !idx) return
        const vertexCount = pos.count
        const positions = new Float32Array(vertexCount * 3)
        for (let v = 0; v < vertexCount; v++) {
          tmp.fromBufferAttribute(pos, v)
          tmp.applyMatrix4(obj.matrixWorld)
          positions[v * 3 + 0] = tmp.x
          positions[v * 3 + 1] = tmp.y
          positions[v * 3 + 2] = tmp.z
        }
        const idxArr = idx.array as ArrayLike<number>
        const indices = new Uint32Array(idxArr.length)
        for (let i = 0; i < idxArr.length; i++) indices[i] = idxArr[i]!
        meshes.push({ positions, indices })
      })
      return meshes
    },
    // Scene is already in three.js world space (Y-up after our
    // upAxis rotation), so STL emitter must rotate to Z-up.
    sourceAxis: "y-up",
  }
}

/**
 * Build a `LineSegments` overlay of normal vectors, one short
 * line from each vertex along its normal. Length is scaled to
 * the mesh's bounding-sphere radius so the lines remain visible
 * regardless of world-space scale.
 */
function buildNormalsHelper(
  lod: RenderableMeshLOD,
  geometry: THREE.BufferGeometry,
): THREE.LineSegments {
  const positions = new Float32Array(lod.numVertices * 6)
  const normalAttr = geometry.getAttribute("normal") as THREE.BufferAttribute
  const normalArr = normalAttr.array as Float32Array
  let cx = 0,
    cy = 0,
    cz = 0
  for (let i = 0; i < lod.numVertices; i++) {
    cx += lod.positions[i * 3]!
    cy += lod.positions[i * 3 + 1]!
    cz += lod.positions[i * 3 + 2]!
  }
  cx /= lod.numVertices
  cy /= lod.numVertices
  cz /= lod.numVertices
  let maxR2 = 0
  for (let i = 0; i < lod.numVertices; i++) {
    const dx = lod.positions[i * 3]! - cx
    const dy = lod.positions[i * 3 + 1]! - cy
    const dz = lod.positions[i * 3 + 2]! - cz
    const r2 = dx * dx + dy * dy + dz * dz
    if (r2 > maxR2) maxR2 = r2
  }
  const len = Math.max(0.01, Math.sqrt(maxR2) * 0.05)
  for (let i = 0; i < lod.numVertices; i++) {
    const px = lod.positions[i * 3]!
    const py = lod.positions[i * 3 + 1]!
    const pz = lod.positions[i * 3 + 2]!
    positions[i * 6] = px
    positions[i * 6 + 1] = py
    positions[i * 6 + 2] = pz
    positions[i * 6 + 3] = px + normalArr[i * 3]! * len
    positions[i * 6 + 4] = py + normalArr[i * 3 + 1]! * len
    positions[i * 6 + 5] = pz + normalArr[i * 3 + 2]! * len
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({ color: 0xffaa00 })
  return new THREE.LineSegments(geom, mat)
}
