/**
 * 3D viewer for BFRES models. Pulls geometry out of the file via
 * `@tootallnate/bfres`'s `extractGeometry` and renders each shape
 * with Three.js. The viewer auto-frames the camera to the combined
 * bounding box of all shapes and provides orbit controls (drag to
 * rotate, scroll to zoom, right-drag to pan).
 *
 * Materials are deliberately simple: a flat-shaded `MeshNormalMaterial`
 * that visualises surface direction with RGB tinting. Texture binding
 * + PBR shading would require parsing FMAT material records and
 * resolving the embedded BNTX, which is a larger effort.
 */
import { Component, useEffect, useRef, useState, type ReactNode } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { extractGeometry, type BfresGeometry } from "@tootallnate/bfres"

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
        const geoms = await extractGeometry(blob)
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
          // Flat-shaded normal material — visualises the surface
          // direction as colour, no textures needed. Looks
          // meaningfully different per-shape and surfaces back-face
          // / shading errors immediately if our extraction is buggy.
          const material = new THREE.MeshNormalMaterial({
            flatShading: false,
            side: THREE.DoubleSide,
          })
          const mesh = new THREE.Mesh(geometry, material)
          mesh.name = g.name
          return { geom: g, mesh, visible: true }
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
      // Dispose every geometry / material we created.
      for (const r of shapes) {
        r.mesh.geometry.dispose()
        if (r.mesh.material instanceof THREE.Material) r.mesh.material.dispose()
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
