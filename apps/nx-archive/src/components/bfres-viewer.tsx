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
  parseBfres,
  type BfresGeometry,
  type BfresMaterial,
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
 * Lazy cache: texture name → decoded Three.js Texture for one BNTX
 * bank. Built on first lookup and reused across shapes that
 * reference the same texture (very common — many shapes share the
 * same albedo or bake map).
 */
type BntxTextureCache = {
  /** All decodable textures in the bank, keyed by name. */
  byName: Map<string, BntxTexture>
  /** Memoised Three.js textures (decoded lazily on demand). */
  decoded: Map<string, THREE.Texture | null>
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
    return { byName, decoded: new Map(), bytes }
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

  // Memoised decode — many shapes share textures.
  if (cache.decoded.has(textureName)) {
    return cache.decoded.get(textureName) ?? null
  }
  const bntxTex = cache.byName.get(textureName)
  if (!bntxTex) {
    cache.decoded.set(textureName, null)
    return null
  }
  let tex: THREE.Texture | null = null
  try {
    const decoded = decodeBntxLayer(cache.bytes, bntxTex, 0)
    // `decodeBntxLayer` returns RGBA8 in `pixels`. Wrap it in a
    // Three.js DataTexture so the renderer can sample from it
    // directly without going through an HTMLImageElement.
    const data = new Uint8ClampedArray(
      decoded.pixels.buffer,
      decoded.pixels.byteOffset,
      decoded.pixels.byteLength,
    )
    tex = new THREE.DataTexture(
      data,
      decoded.width,
      decoded.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    )
    tex.colorSpace = bntxTex.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    // We flip V on the BFRES UV side (Tegra/DirectX convention →
    // OpenGL/Three.js convention), so leave `flipY` off here.
    tex.flipY = false
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.minFilter = THREE.LinearMipMapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = true
    tex.needsUpdate = true
  } catch {
    tex = null
  }
  cache.decoded.set(textureName, tex)
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
  // Controls for the rendered scene live outside React state so we
  // can mutate them in event handlers without re-rendering.
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    animationId: number
  } | null>(null)

  // ---- Load + extract geometry from the BFRES blob ----
  useEffect(() => {
    let cancelled = false
    setError(null)
    setShapes(null)

    void (async () => {
      try {
        const blob = await node.blob!()
        const [geoms, materials, textureCache] = await Promise.all([
          extractGeometry(blob),
          extractMaterials(blob),
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
          const material: THREE.Material = albedo
            ? new THREE.MeshBasicMaterial({
                map: albedo,
                side: THREE.DoubleSide,
                // The Tegra block-linear deswizzler we ported
                // produces sRGB-encoded RGBA already; tell Three.js
                // to treat the texture's bytes as sRGB so its
                // linear-light pipeline does the right thing.
                color: 0xffffff,
              })
            : new THREE.MeshNormalMaterial({
                flatShading: false,
                side: THREE.DoubleSide,
              })
          const mesh = new THREE.Mesh(geometry, material)
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

    // Combined bounding box from all shapes' AABBs — used to auto-frame.
    const bb = new THREE.Box3()
    for (const r of shapes) {
      bb.expandByPoint(
        new THREE.Vector3(
          r.geom.boundingBox.min[0],
          r.geom.boundingBox.min[1],
          r.geom.boundingBox.min[2],
        ),
      )
      bb.expandByPoint(
        new THREE.Vector3(
          r.geom.boundingBox.max[0],
          r.geom.boundingBox.max[1],
          r.geom.boundingBox.max[2],
        ),
      )
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

    sceneRef.current = { renderer, scene, camera, controls, animationId }

    // Resize handling — observe the container, not just window.
    const ro = new ResizeObserver(updateSize)
    ro.observe(container)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(animationId)
      controls.dispose()
      // Dispose every geometry / material / texture we created.
      for (const r of shapes) {
        r.mesh.geometry.dispose()
        if (r.mesh.material instanceof THREE.Material) {
          // MeshBasicMaterial.map may carry a DataTexture we owned —
          // dispose it too so its GPU memory comes back.
          const m = r.mesh.material as THREE.Material & { map?: THREE.Texture }
          if (m.map) m.map.dispose()
          r.mesh.material.dispose()
        }
      }
      renderer.dispose()
      renderer.domElement.remove()
      sceneRef.current = null
    }
  }, [shapes])

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
