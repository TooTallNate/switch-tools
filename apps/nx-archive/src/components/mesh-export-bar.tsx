/**
 * Shared "export" toolbar for the 3D viewers: smoothing, filament
 * count, Download STL, Download 3MF. Viewers only supply a `bake`
 * callback that returns world-space {@link ExportMesh}es for the
 * current pose; everything after that (weld → subdivide → STL, or
 * palette reduction → paint trees → 3MF) lives here and in
 * `~/lib/mesh-export*`, so every viewer gets identical behaviour.
 */
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import {
  emitBinarySTL,
  loopSubdivide,
  sanitizeStem,
  triggerDownload,
  weldByPosition,
  type ExportMesh,
} from "~/lib/mesh-export"
import { buildPainted3MF, rgbToHex } from "~/lib/mesh-export-3mf"

export interface MeshExportBarProps {
  /**
   * Bake the current viewer state into world-space meshes. Called on
   * click. Return null / [] when there's nothing to export.
   */
  bake: () => ExportMesh[] | null
  /** File name stem (extension stripped automatically). */
  baseName?: string
  /** Pose suffix (e.g. `_Walk_f0012` or `_bind`), evaluated on click. */
  suffix?: () => string
  /** Axis convention of the baked coordinates. Default `'y-up'`. */
  sourceAxis?: "y-up" | "z-up"
  /** Initial smoothing passes. */
  defaultSubdivision?: number
  disabled?: boolean
  /** Extra controls rendered at the end of the bar. */
  children?: ReactNode
}

export function MeshExportBar({
  bake,
  baseName,
  suffix,
  sourceAxis = "y-up",
  defaultSubdivision = 0,
  disabled,
  children,
}: MeshExportBarProps) {
  const [subdivision, setSubdivision] = useState(defaultSubdivision)
  // Filament count for the 3MF export (e.g. 4 for a 4-toolhead
  // Snapmaker U1 / single-AMS Bambu).
  const [colors, setColors] = useState(4)

  const names = () => {
    const stem = sanitizeStem(baseName ?? "model") || "model"
    const pose = suffix?.() ?? ""
    const sub = subdivision > 0 ? `_sub${subdivision}` : ""
    return { stem, pose, sub }
  }

  const exportSTL = () => {
    const meshes = bake()
    if (!meshes || meshes.length === 0) return
    const cooked = meshes.map((m) => {
      let c = weldByPosition(m)
      for (let p = 0; p < subdivision; p++) c = loopSubdivide(c)
      return c
    })
    const { stem, pose, sub } = names()
    const bytes = emitBinarySTL(cooked, {
      header: `nx-archive ${stem}${pose}${sub}`,
      sourceAxis,
    })
    triggerDownload(bytes, `${stem}${pose}${sub}.stl`, "model/stl")
  }

  const export3MF = () => {
    // Bake synchronously so the pose matches the click, then yield
    // a frame so the toast renders before the (potentially
    // multi-second) paint pass.
    const meshes = bake()
    if (!meshes || meshes.length === 0) return
    const { stem, pose, sub } = names()
    const id = toast.loading("Painting 3MF…")
    setTimeout(() => {
      try {
        const result = buildPainted3MF(meshes, {
          colorCount: colors,
          subdivisionPasses: subdivision,
          sourceAxis,
          title: `${stem}${pose}`,
        })
        const n = result.palette.length
        triggerDownload(result.bytes, `${stem}${pose}${sub}_${n}c.3mf`, "model/3mf")
        toast.success(`Exported ${n}-color 3MF`, {
          id,
          duration: 15000,
          description: (
            <div className="mt-1 flex flex-col gap-0.5">
              <span>Set these filament colors in your slicer:</span>
              {result.palette.map((c, i) => (
                <span key={i} className="flex items-center gap-1.5 font-mono">
                  <span
                    className="inline-block size-3 rounded-sm border"
                    style={{ backgroundColor: rgbToHex(c) }}
                  />
                  {i + 1}: {rgbToHex(c)}
                </span>
              ))}
            </div>
          ),
        })
      } catch (err) {
        toast.error("3MF export failed", {
          id,
          description: err instanceof Error ? err.message : String(err),
        })
      }
    }, 16)
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground">
      <label className="flex items-center gap-1.5">
        <span>Smooth</span>
        <select
          value={subdivision}
          onChange={(e) => setSubdivision(Number(e.target.value))}
          title="Loop subdivision passes applied before export. Each pass quadruples the triangle count and rounds out corners."
          className="rounded-md border bg-card px-1.5 py-0.5"
        >
          <option value={0}>None</option>
          <option value={1}>1× (4× tris)</option>
          <option value={2}>2× (16× tris)</option>
        </select>
      </label>
      <button
        type="button"
        onClick={exportSTL}
        disabled={disabled}
        title="Download the current pose as a binary STL (Z-up, slicer-ready)"
        className="rounded-md border bg-card px-2 py-1 disabled:opacity-50"
      >
        Download STL
      </button>
      <label className="flex items-center gap-1.5">
        <span>Colors</span>
        <select
          value={colors}
          onChange={(e) => setColors(Number(e.target.value))}
          title="Number of filaments the model's colors are reduced to for the 3MF export"
          className="rounded-md border bg-card px-1.5 py-0.5"
        >
          {[2, 3, 4, 5, 6, 7, 8, 12, 16].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={export3MF}
        disabled={disabled}
        title="Download the current pose as a multi-color 3MF with per-triangle filament painting (OrcaSlicer / Bambu Studio)"
        className="rounded-md border bg-card px-2 py-1 disabled:opacity-50"
      >
        Download 3MF
      </button>
      {children}
    </div>
  )
}
