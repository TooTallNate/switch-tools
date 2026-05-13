/**
 * Three.js viewer for a parsed UE StaticMesh.
 *
 * Simpler cousin of the BFRES viewer:
 *   - One mesh, multiple sections (each gets its own draw call but
 *     shares the same buffer geometry via index ranges).
 *   - MeshNormalMaterial by default so the shading reads even with
 *     no texture; LOD picker swaps between detail levels.
 *   - Orbit controls, automatic framing.
 *
 * Lifecycle: the renderer + scene live inside a `useEffect` so we
 * dispose everything when the component unmounts. The mesh data is
 * a stable prop — re-rendering means tearing down and rebuilding,
 * which is fine because parseStaticMesh runs once upstream and we
 * only re-mount when the user switches files.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

import type { LoadedStaticMesh, StaticMeshLOD } from "@tootallnate/uasset"

interface Props {
  mesh: LoadedStaticMesh
}

/**
 * Build a Three.js BufferGeometry from one UE LOD. Re-uses the typed
 * arrays the parser produced — no copies, since `BufferAttribute`
 * holds a reference and Three.js never mutates incoming attribute
 * data on construction.
 */
function buildGeometry(lod: StaticMeshLOD): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute("position", new THREE.BufferAttribute(lod.positions, 3))
  geom.setAttribute("normal", new THREE.BufferAttribute(lod.normals, 3))
  if (lod.uvs[0]) geom.setAttribute("uv", new THREE.BufferAttribute(lod.uvs[0], 2))
  geom.setIndex(new THREE.BufferAttribute(lod.indices, 1))
  geom.computeBoundingBox()
  geom.computeBoundingSphere()
  return geom
}

export function StaticMeshViewer({ mesh }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [selectedLOD, setSelectedLOD] = useState(0)
  const [showWireframe, setShowWireframe] = useState(false)
  const [showNormals, setShowNormals] = useState(false)

  // Stable geometry per LOD so the canvas effect can swap without
  // rebuilding the attribute buffers every render.
  const geometries = useMemo(() => mesh.lods.map(buildGeometry), [mesh])

  useEffect(() => {
    return () => {
      // Dispose all geometries when the component unmounts.
      for (const g of geometries) g.dispose()
    }
  }, [geometries])

  const lod = mesh.lods[selectedLOD]
  const geometry = geometries[selectedLOD]

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

    // Fill lights — MeshNormalMaterial ignores these but if we
    // later swap to MeshStandardMaterial they'll already be set.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7)
    dirLight.position.set(2, 4, 3)
    scene.add(dirLight)

    // One material per section so the UI can later attach material
    // names. For now MeshNormalMaterial is uniform across sections.
    const material = new THREE.MeshNormalMaterial({
      side: THREE.DoubleSide,
      wireframe: showWireframe,
      flatShading: false,
    })
    const meshObj = new THREE.Mesh(geometry, material)
    // UE uses a left-handed Z-up coordinate system; Three.js is
    // right-handed Y-up. Rotate so the model looks right-side-up.
    meshObj.rotation.x = -Math.PI / 2
    scene.add(meshObj)

    // Optional normal-line overlay (small lines from each vertex
    // along its normal direction). Built once per-LOD; cheap enough
    // even for thousand-vertex meshes.
    let normalsHelper: THREE.LineSegments | null = null
    if (showNormals) {
      normalsHelper = buildNormalsHelper(lod)
      meshObj.add(normalsHelper)
    }

    // Frame the camera around the geometry's bounding sphere so
    // we don't depend on the asset's reported bounds (which are
    // sometimes loose for FX / decal meshes).
    const sphere = geometry.boundingSphere!
    const radius = Math.max(sphere.radius, 0.01)
    const center = sphere.center.clone()
    // Account for the model rotation we applied above when
    // positioning the camera.
    const rotMat = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
    center.applyMatrix4(rotMat)

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
      material.dispose()
      if (normalsHelper) {
        normalsHelper.geometry.dispose()
        ;(normalsHelper.material as THREE.Material).dispose()
      }
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [geometry, lod, showWireframe, showNormals])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-sm font-medium">Mesh viewer unavailable</p>
        <p className="text-xs text-muted-foreground">{error.message}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">LOD</span>
        <select
          className="rounded border bg-background px-2 py-1 font-mono"
          value={selectedLOD}
          onChange={(e) => setSelectedLOD(Number(e.target.value))}
        >
          {mesh.lods.map((l, i) => (
            <option key={i} value={i}>
              {i}: {l.numVertices.toLocaleString()} verts, {(l.indices.length / 3).toLocaleString()} tris
            </option>
          ))}
        </select>
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
        {lod && (
          <span className="ml-auto text-muted-foreground">
            {lod.sections.length} section{lod.sections.length === 1 ? "" : "s"}
            {lod.colors ? " · vertex colors" : ""}
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className="min-h-[400px] flex-1 rounded-md border bg-[oklch(0.92_0_0)] dark:bg-[oklch(0.18_0_0)]"
      />
    </div>
  )
}

/**
 * Build a `LineSegments` overlay of normal vectors, one short line
 * from each vertex along its normal. Length is scaled to the mesh's
 * bounding-sphere radius so the lines remain visible regardless of
 * world-space scale.
 */
function buildNormalsHelper(lod: StaticMeshLOD): THREE.LineSegments {
  const positions = new Float32Array(lod.numVertices * 6)
  // Estimate a sensible line length from the bounding sphere of
  // the positions. We re-do this cheaply rather than threading the
  // radius through props.
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < lod.numVertices; i++) {
    cx += lod.positions[i * 3]!
    cy += lod.positions[i * 3 + 1]!
    cz += lod.positions[i * 3 + 2]!
  }
  cx /= lod.numVertices; cy /= lod.numVertices; cz /= lod.numVertices
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
    positions[i * 6]     = px
    positions[i * 6 + 1] = py
    positions[i * 6 + 2] = pz
    positions[i * 6 + 3] = px + lod.normals[i * 3]! * len
    positions[i * 6 + 4] = py + lod.normals[i * 3 + 1]! * len
    positions[i * 6 + 5] = pz + lod.normals[i * 3 + 2]! * len
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({ color: 0xffaa00 })
  return new THREE.LineSegments(geom, mat)
}
