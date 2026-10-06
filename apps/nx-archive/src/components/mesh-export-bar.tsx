/**
 * Shared "export" toolbar for the 3D viewers: smoothing, Download STL,
 * and Download 3MF in one of two colour modes:
 *
 *   - Standard: the model's colours reduced to N filaments (any
 *     OrcaSlicer / Bambu Studio printer).
 *   - Full Spectrum: Snapmaker U1 — four physical filaments (default:
 *     the Full Spectrum CMY + Gray bundle) plus mixed virtual filaments
 *     that Snapmaker Orca prints by alternating layers.
 *
 * Viewers only supply a `bake` callback that returns world-space
 * {@link ExportMesh}es for the current pose; everything after that
 * lives here and in `~/lib/mesh-export*` / `~/lib/full-spectrum`, so
 * every viewer gets identical behaviour.
 */
import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"

import {
  FULL_SPECTRUM_BUNDLE,
  buildFullSpectrum3MF,
  mixLabel,
  type PhysicalFilament,
} from "~/lib/full-spectrum"
import {
  emitBinarySTL,
  loopSubdivide,
  sanitizeStem,
  triggerDownload,
  weldByPosition,
  type ExportMesh,
} from "~/lib/mesh-export"
import { buildPainted3MF, rgbToHex, type Rgb } from "~/lib/mesh-export-3mf"
import {
  defaultMinThickness,
  repairChangedAnything,
  repairForPrinting,
  summarizeRepairs,
  type RepairReport,
  type RepairSummary,
} from "~/lib/mesh-repair"

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

type PaintMode = "standard" | "full-spectrum"

const PREFS_KEY = "nx-archive:3mf-export"

interface ExportPrefs {
  mode: PaintMode
  colors: number
  mixes: number
  /** Physical filament colours (hex) for Full Spectrum mode. */
  base: string[]
  /** Close holes / thicken sheets so every part is a printable solid. */
  repair: boolean
}

const DEFAULT_PREFS: ExportPrefs = {
  mode: "standard",
  colors: 4,
  mixes: 12,
  base: FULL_SPECTRUM_BUNDLE.map((f) => rgbToHex(f.rgb)),
  repair: true,
}

function loadPrefs(): ExportPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const p = { ...DEFAULT_PREFS, ...JSON.parse(raw) } as ExportPrefs
    if (!Array.isArray(p.base) || p.base.length !== 4) p.base = DEFAULT_PREFS.base
    return p
  } catch {
    return DEFAULT_PREFS
  }
}

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** Base filaments; keep bundle names for unchanged colours. */
function baseFilaments(hexes: string[]): PhysicalFilament[] {
  return hexes.map((hex, i) => {
    const bundle = FULL_SPECTRUM_BUNDLE[i]
    const same = bundle && rgbToHex(bundle.rgb) === hex.toUpperCase()
    return { name: same ? bundle.name : `F${i + 1}`, rgb: hexToRgb(hex) }
  })
}

/** One-line description of what printability repair changed. */
function describeRepair(s: RepairSummary): string {
  const parts: string[] = []
  if (s.holesFilled) parts.push(`closed ${s.holesFilled} hole${s.holesFilled === 1 ? "" : "s"}`)
  if (s.sheetsThickened)
    parts.push(`thickened ${s.sheetsThickened} open surface${s.sheetsThickened === 1 ? "" : "s"}`)
  if (s.duplicatesRemoved)
    parts.push(`removed ${s.duplicatesRemoved} duplicate face${s.duplicatesRemoved === 1 ? "" : "s"}`)
  if (s.nonManifoldEdgesCut) parts.push(`split ${s.nonManifoldEdgesCut} non-manifold edges`)
  const left = s.openEdgesAfter > 0 ? ` (${s.openEdgesAfter} open edges remain)` : ""
  return `Repaired for printing: ${parts.join(", ")}${left}.`
}

function RepairLine({ summary }: { summary: RepairSummary | null }) {
  if (!summary || !repairChangedAnything(summary)) return null
  return <span>{describeRepair(summary)}</span>
}

function notifyRepair(summary: RepairSummary) {
  if (repairChangedAnything(summary)) toast.info(describeRepair(summary), { duration: 8000 })
}

function Swatch({ rgb }: { rgb: Rgb }) {
  return (
    <span
      className="inline-block size-3 shrink-0 rounded-sm border"
      style={{ backgroundColor: rgbToHex(rgb) }}
    />
  )
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
  const [prefs, setPrefs] = useState<ExportPrefs>(loadPrefs)
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // Private mode / quota — preferences just won't persist.
    }
  }, [prefs])
  const update = (patch: Partial<ExportPrefs>) => setPrefs((p) => ({ ...p, ...patch }))

  const names = () => {
    const stem = sanitizeStem(baseName ?? "model") || "model"
    const pose = suffix?.() ?? ""
    const sub = subdivision > 0 ? `_sub${subdivision}` : ""
    return { stem, pose, sub }
  }

  const exportSTL = () => {
    const meshes = bake()
    if (!meshes || meshes.length === 0) return
    const minThickness = defaultMinThickness(meshes)
    const reports: RepairReport[] = []
    const cooked = meshes.map((m) => {
      let c = weldByPosition(m)
      if (prefs.repair) {
        const r = repairForPrinting(c, { minThickness })
        reports.push(r.report)
        c = r
      }
      for (let p = 0; p < subdivision; p++) c = loopSubdivide(c)
      return c
    })
    if (prefs.repair) notifyRepair(summarizeRepairs(reports))
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
    const { mode, colors, mixes, base, repair } = prefs
    const id = toast.loading("Painting 3MF…")
    setTimeout(() => {
      try {
        if (mode === "full-spectrum") {
          const result = buildFullSpectrum3MF(meshes, {
            base: baseFilaments(base),
            maxMixes: mixes,
            repair,
            subdivisionPasses: subdivision,
            sourceAxis,
            title: `${stem}${pose}`,
          })
          const n = result.base.length + result.mixes.length
          triggerDownload(result.bytes, `${stem}${pose}${sub}_fs${n}.3mf`, "model/3mf")
          toast.success(`Exported Full Spectrum 3MF (${result.mixes.length} mixes)`, {
            id,
            duration: 30000,
            description: (
              <div className="mt-1 flex flex-col gap-0.5">
                <RepairLine summary={result.repair} />
                <span>
                  Open in Snapmaker Orca in a new, empty project — filaments and mixes load
                  automatically. For smooth blends use 0.08 mm layers and enable Process →
                  Multimaterial → Subdivide Mix Layer.
                </span>
                {result.base.map((f, i) => (
                  <span key={`p${i}`} className="flex items-center gap-1.5 font-mono">
                    <Swatch rgb={f.rgb} />
                    {i + 1}: {f.name} {rgbToHex(f.rgb)}
                  </span>
                ))}
                {result.mixes.map((m, i) => (
                  <span key={`m${i}`} className="flex items-center gap-1.5 font-mono">
                    <Swatch rgb={m.rgb} />
                    {result.base.length + 1 + i}: {mixLabel(result.base, m)}
                  </span>
                ))}
              </div>
            ),
          })
          return
        }
        const result = buildPainted3MF(meshes, {
          colorCount: colors,
          repair,
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
              <RepairLine summary={result.repair} />
              <span>Set these filament colors in your slicer:</span>
              {result.palette.map((c, i) => (
                <span key={i} className="flex items-center gap-1.5 font-mono">
                  <Swatch rgb={c} />
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

  const selectClass = "rounded-md border bg-card px-1.5 py-0.5"
  const buttonClass = "rounded-md border bg-card px-2 py-1 disabled:opacity-50"

  return (
    <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground">
      <label className="flex items-center gap-1.5">
        <span>Smooth</span>
        <select
          value={subdivision}
          onChange={(e) => setSubdivision(Number(e.target.value))}
          title="Loop subdivision passes applied before export. Each pass quadruples the triangle count and rounds out corners."
          className={selectClass}
        >
          <option value={0}>None</option>
          <option value={1}>1× (4× tris)</option>
          <option value={2}>2× (16× tris)</option>
        </select>
      </label>
      <label
        className="flex items-center gap-1.5"
        title="Make every part a closed, outward-facing solid for 3D printing: removes duplicate double-sided faces, closes holes (e.g. missing undersides) and thickens open surfaces, so slicers don't report errors that need fixing."
      >
        <input
          type="checkbox"
          checked={prefs.repair}
          onChange={(e) => update({ repair: e.target.checked })}
          className="h-3 w-3"
        />
        <span>Repair</span>
      </label>
      <button
        type="button"
        onClick={exportSTL}
        disabled={disabled}
        title="Download the current pose as a binary STL (Z-up, slicer-ready)"
        className={buttonClass}
      >
        Download STL
      </button>
      <select
        value={prefs.mode}
        onChange={(e) => update({ mode: e.target.value as PaintMode })}
        title="3MF color mode. Standard: reduce the model's colors to N filaments (OrcaSlicer / Bambu Studio). Full Spectrum: Snapmaker U1 — 4 filaments plus layer-mixed colors (Snapmaker Orca only)."
        className={selectClass}
      >
        <option value="standard">3MF: Standard</option>
        <option value="full-spectrum">3MF: Full Spectrum (U1)</option>
      </select>
      {prefs.mode === "standard" ? (
        <label className="flex items-center gap-1.5">
          <span>Colors</span>
          <select
            value={prefs.colors}
            onChange={(e) => update({ colors: Number(e.target.value) })}
            title="Number of filaments the model's colors are reduced to"
            className={selectClass}
          >
            {[2, 3, 4, 5, 6, 7, 8, 12, 16].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <span
            className="flex items-center gap-1"
            title="Physical filaments by toolhead (default: Snapmaker PLA Full Spectrum bundle — Cyan, Magenta, Yellow, Gray). Click to change."
          >
            {prefs.base.map((hex, i) => (
              <input
                key={i}
                type="color"
                value={hex}
                onChange={(e) => {
                  const next = prefs.base.slice()
                  next[i] = e.target.value.toUpperCase()
                  update({ base: next })
                }}
                aria-label={`Toolhead ${i + 1} filament color`}
                className="size-5 cursor-pointer rounded-sm border bg-transparent p-0"
              />
            ))}
            {prefs.base.join() !== DEFAULT_PREFS.base.join() && (
              <button
                type="button"
                onClick={() => update({ base: DEFAULT_PREFS.base })}
                title="Reset to the Full Spectrum CMY + Gray bundle"
                className="px-1 underline"
              >
                reset
              </button>
            )}
          </span>
          <label className="flex items-center gap-1.5">
            <span>Mixes</span>
            <select
              value={prefs.mixes}
              onChange={(e) => update({ mixes: Number(e.target.value) })}
              title="Maximum number of mixed colors added on top of the 4 filaments (fewer are used if they wouldn't help)"
              className={selectClass}
            >
              {/* 6 pairs × 3 ratios = 18 candidate mixes. */}
              {[4, 8, 12, 18].map((n) => (
                <option key={n} value={n}>
                  {n === 18 ? "≤18 (all)" : `≤${n}`}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <button
        type="button"
        onClick={export3MF}
        disabled={disabled}
        title={
          prefs.mode === "full-spectrum"
            ? "Download a Snapmaker Orca Full Spectrum 3MF: 4 filaments plus mixed colors, with filament colors and mix recipes embedded"
            : "Download the current pose as a multi-color 3MF with per-triangle filament painting (OrcaSlicer / Bambu Studio)"
        }
        className={buttonClass}
      >
        Download 3MF
      </button>
      {children}
    </div>
  )
}
