/**
 * 3D-print export for the model viewers: a single "Export…" toolbar
 * button opening a dialog with every export setting (format, print
 * size, geometry repair / smoothing, colours). Viewers only supply a
 * `bake` callback returning world-space {@link ExportMesh}es for the
 * current pose; the pipeline itself lives in `~/lib/model-export`.
 *
 * Print size is a *scale* (mm per model unit) shared by every model
 * exported from the same opened file (see `~/lib/print-scale`), so
 * separately exported characters stay proportional to each other.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { DownloadIcon, InfoIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "~/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "~/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import { Spinner } from "~/components/ui/spinner"
import { Switch } from "~/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group"
import { analyzeGamut, mixLabel, type GamutReport } from "~/lib/full-spectrum"
import { SLICER_PROFILES, slicerProfile } from "~/lib/slicer-profile"
import { sanitizeStem, triggerDownload, type ExportMesh } from "~/lib/mesh-export"
import { rgbToHex, surfaceColorBins, type ColorBin, type Rgb } from "~/lib/mesh-export-3mf"
import { repairChangedAnything, type RepairSummary } from "~/lib/mesh-repair"
import {
  DEFAULT_EXPORT_SETTINGS,
  baseFilaments,
  printSize,
  runModelExport,
  targetProfile,
  type ExportFormat,
  type ModelExportResult,
  type ModelExportSettings,
} from "~/lib/model-export"
import { DEFAULT_TARGET_MM, defaultPrintScale, loadPrintScale, savePrintScale } from "~/lib/print-scale"

import { useModelExportScope } from "./model-export-scope"

export interface MeshExportBarProps {
  /**
   * Bake the current viewer state into world-space meshes. Called when
   * the dialog opens (for the size readout) and again on export.
   * Return null / [] when there's nothing to export.
   */
  bake: () => ExportMesh[] | null
  /** File name stem (extension stripped automatically). */
  baseName?: string
  /** Pose suffix (e.g. `_Walk_f0012` or `_bind`), evaluated on export. */
  suffix?: () => string
  /** Axis convention of the baked coordinates. Default `'y-up'`. */
  sourceAxis?: "y-up" | "z-up"
  /** Initial smoothing passes. */
  defaultSubdivision?: number
  disabled?: boolean
  /** Extra controls rendered next to the Export button. */
  children?: ReactNode
}

// ---------------------------------------------------------------------------
// Persisted settings (everything except the per-file scale)
// ---------------------------------------------------------------------------

const PREFS_KEY = "nx-archive:model-export"
const LEGACY_PREFS_KEY = "nx-archive:3mf-export"

type StoredSettings = Omit<ModelExportSettings, "subdivision">

/** Last-used export settings (shared with the library's batch export). */
export function loadSettings(): StoredSettings {
  const { subdivision: _, ...defaults } = DEFAULT_EXPORT_SETTINGS
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const s = { ...defaults, ...JSON.parse(raw) } as StoredSettings
      if (!Array.isArray(s.base) || s.base.length !== 4) s.base = defaults.base
      return s
    }
    // Carry over the earlier toolbar's choices.
    const legacy = localStorage.getItem(LEGACY_PREFS_KEY)
    if (legacy) {
      const l = JSON.parse(legacy) as Partial<{ mode: string; colors: number; mixes: number; base: string[]; repair: boolean }>
      return {
        ...defaults,
        format: l.mode === "full-spectrum" ? "3mf-full-spectrum" : "3mf",
        colors: l.colors ?? defaults.colors,
        mixes: l.mixes ?? defaults.mixes,
        base: Array.isArray(l.base) && l.base.length === 4 ? l.base : defaults.base,
        repair: l.repair ?? defaults.repair,
      }
    }
  } catch {
    // Corrupt storage: fall through to defaults.
  }
  return defaults
}

function saveSettings(s: StoredSettings) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(s))
  } catch {
    // Private mode / quota — settings just won't persist.
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Build volume used for the "too big" warning. */
function bedLimit(settings: Pick<ModelExportSettings, "format" | "profile">): { mm: number; label: string } {
  const profile = targetProfile(settings)
  return profile
    ? { mm: profile.buildVolumeMm, label: `the ${profile.label}'s ${profile.buildVolumeMm} mm build volume` }
    : { mm: 256, label: "a typical 256 mm build volume" }
}

const fmtMm = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2))
/** Up to 4 significant digits, no exponent noise. */
const fmtScale = (v: number) => String(Number(v.toPrecision(4)))

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

/** "DekuTree · bind pose", "Mario · Walk, frame 12". */
function describeSubject(baseName: string | undefined, pose: string): string {
  const name = (baseName ?? "Model").replace(/\.[^./\\]+$/, "")
  if (!pose) return `${name} · current pose`
  if (pose === "_bind") return `${name} · bind pose`
  const m = /^_(.+)_f0*(\d+)$/.exec(pose)
  return m ? `${name} · ${m[1]!.replace(/_/g, " ")}, frame ${m[2]}` : `${name} · ${pose.replace(/^_/, "")}`
}

const pct = (f: number) => `${Math.round(f * 100)}%`

/**
 * Full Spectrum gamut warning: near-black / near-white areas the loaded
 * filaments can't mix, with a one-click toolhead swap when it helps.
 */
function GamutAlert({
  report,
  base,
  onSwap,
}: {
  report: GamutReport | null
  base: readonly string[]
  onSwap: (toolhead: number, hex: string) => void
}) {
  if (!report) return null
  const { dark, light, other } = report.unreachable
  const parts: string[] = []
  if (dark >= 0.03) parts.push(`${pct(dark)} dark`)
  if (light >= 0.03) parts.push(`${pct(light)} light`)
  if (other >= 0.1) parts.push(`${pct(other)} saturated`)
  if (parts.length === 0 && !report.suggestion) return null
  const s = report.suggestion
  const filaments = baseFilaments(base)
  const current = s ? filaments[s.toolhead]! : null
  // Only explain the dark limit when no loaded filament is dark itself.
  const hasDark = filaments.some((f) => 0.2126 * f.rgb[0] + 0.7152 * f.rgb[1] + 0.0722 * f.rgb[2] < 70)
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>Some colors are out of reach</AlertTitle>
      <AlertDescription>
        {parts.length > 0 && (
          <p>
            About {parts.join(", ").replace(/, ([^,]*)$/, " and $1")} colors of this model
            can't be matched closely by these filaments or their mixes
            {dark >= 0.03 && !hasDark && " (the darkest possible mix is a mid purple)"}.
          </p>
        )}
        {s && current && (
          <p>
            Swapping toolhead {s.toolhead + 1} ({current.name}) for {s.filament.name} brings the
            colors {pct(s.improvement)} closer.
          </p>
        )}
      </AlertDescription>
      {s && (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => onSwap(s.toolhead, rgbToHex(s.filament.rgb))}>
            Use {s.filament.name}
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

function Swatch({ rgb }: { rgb: Rgb }) {
  return (
    <span
      className="inline-block size-3 shrink-0 rounded-sm border"
      style={{ backgroundColor: rgbToHex(rgb) }}
    />
  )
}

/** Numeric input that keeps the user's text while typing. */
function NumberInput({
  id,
  value,
  onCommit,
  unit,
  format = fmtScale,
}: {
  id: string
  value: number
  onCommit: (v: number) => void
  unit: string
  format?: (v: number) => string
}) {
  const [text, setText] = useState(format(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(format(value))
  }, [value, focused, format])
  const parsed = Number(text)
  const invalid = !(Number.isFinite(parsed) && parsed > 0)
  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        inputMode="decimal"
        value={text}
        aria-invalid={invalid}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value)
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v > 0) onCommit(v)
        }}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText>{unit}</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  )
}

function successToast(result: ModelExportResult): { title: string; description: ReactNode; duration: number } {
  const repairLine =
    result.repair && repairChangedAnything(result.repair) ? <span>{describeRepair(result.repair)}</span> : null
  if (result.fullSpectrum) {
    const { base, mixes } = result.fullSpectrum
    return {
      title: `Exported Full Spectrum 3MF (${mixes.length} mixes)`,
      duration: 30000,
      description: (
        <div className="mt-1 flex flex-col gap-0.5">
          {repairLine}
          <span>
            Open in Snapmaker Orca in a new, empty project — the U1 profile, filaments and mixes
            load automatically.
          </span>
          {base.map((f, i) => (
            <span key={`p${i}`} className="flex items-center gap-1.5 font-mono">
              <Swatch rgb={f.rgb} />
              {i + 1}: {f.name} {rgbToHex(f.rgb)}
            </span>
          ))}
          {mixes.map((m, i) => (
            <span key={`m${i}`} className="flex items-center gap-1.5 font-mono">
              <Swatch rgb={m.rgb} />
              {base.length + 1 + i}: {mixLabel(base, m)}
            </span>
          ))}
        </div>
      ),
    }
  }
  if (result.palette) {
    return {
      title: `Exported ${result.palette.length}-color 3MF`,
      duration: 15000,
      description: (
        <div className="mt-1 flex flex-col gap-0.5">
          {repairLine}
          <span>
            {result.profile
              ? `Filament colors are embedded for the ${result.profile.label}. Open in Snapmaker Orca in a new, empty project.`
              : "Set these filament colors in your slicer:"}
          </span>
          {result.palette.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5 font-mono">
              <Swatch rgb={c} />
              {i + 1}: {rgbToHex(c)}
            </span>
          ))}
        </div>
      ),
    }
  }
  return { title: "Exported STL", duration: 8000, description: repairLine }
}

// ---------------------------------------------------------------------------
// Toolbar + dialog
// ---------------------------------------------------------------------------

export function MeshExportBar({
  bake,
  baseName,
  suffix,
  sourceAxis = "y-up",
  defaultSubdivision = 0,
  disabled,
  children,
}: MeshExportBarProps) {
  const scope = useModelExportScope()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<StoredSettings>(loadSettings)
  const [subdivision, setSubdivision] = useState(defaultSubdivision)
  useEffect(() => saveSettings(settings), [settings])
  const update = (patch: Partial<StoredSettings>) => setSettings((s) => ({ ...s, ...patch }))

  // Size of the current pose, in model units (print axes), captured
  // when the dialog opens.
  const [sizeUnits, setSizeUnits] = useState<[number, number, number] | null>(null)
  const [scale, setScale] = useState(1)
  const [scaleSaved, setScaleSaved] = useState(false)
  const [bins, setBins] = useState<ColorBin[] | null>(null)
  const gamut = useMemo(
    () =>
      bins && settings.format === "3mf-full-spectrum"
        ? analyzeGamut(bins, baseFilaments(settings.base))
        : null,
    [bins, settings.format, settings.base],
  )

  const openDialog = () => {
    const meshes = bake()
    const size = meshes && meshes.length ? printSize(meshes, sourceAxis) : null
    setSizeUnits(size)
    // Surface colours for the Full Spectrum gamut check (cheap: no
    // welding / repair / painting).
    setBins(meshes && meshes.length ? surfaceColorBins(meshes, 20_000) : null)
    const stored = loadPrintScale(scope.key)
    setScaleSaved(stored !== null)
    setScale(stored ?? (size ? defaultPrintScale(size) : 1))
    setOpen(true)
  }

  const sizeMm = useMemo(
    () => (sizeUnits ? (sizeUnits.map((v) => v * scale) as [number, number, number]) : null),
    [sizeUnits, scale],
  )
  const limit = bedLimit(settings)
  const tooBig = sizeMm ? Math.max(...sizeMm) > limit.mm : false

  const doExport = () => {
    const meshes = bake()
    if (!meshes || meshes.length === 0) return
    const stem = sanitizeStem(baseName ?? "model") || "model"
    const pose = suffix?.() ?? ""
    setBusy(true)
    // Yield a frame so the spinner renders before the (potentially
    // multi-second) export.
    setTimeout(() => {
      try {
        const result = runModelExport({
          meshes,
          settings: { ...settings, subdivision },
          mmPerUnit: scale,
          sourceAxis,
          stem,
          pose,
        })
        savePrintScale(scope.key, scale)
        triggerDownload(result.bytes, result.fileName, result.mimeType)
        const t = successToast(result)
        toast.success(t.title, { description: t.description, duration: t.duration })
        setOpen(false)
      } catch (err) {
        toast.error("Export failed", {
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setBusy(false)
      }
    }, 16)
  }

  const is3mf = settings.format !== "stl"

  return (
    <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground">
      <Button variant="outline" size="sm" onClick={openDialog} disabled={disabled}>
        <DownloadIcon data-icon="inline-start" />
        Export for 3D printing…
      </Button>
      {children}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Export for 3D printing</DialogTitle>
            <DialogDescription>{describeSubject(baseName, suffix?.() ?? "")}</DialogDescription>
          </DialogHeader>

          {/* Only the settings scroll; title and actions stay put. */}
          <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
            <FieldGroup>
              <FieldSet>
                <FieldLegend>Format</FieldLegend>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={settings.format}
                  onValueChange={(v) => v && update({ format: v as ExportFormat })}
                >
                  <ToggleGroupItem value="stl">STL</ToggleGroupItem>
                  <ToggleGroupItem value="3mf">3MF (color)</ToggleGroupItem>
                  <ToggleGroupItem value="3mf-full-spectrum">Full Spectrum (U1)</ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription>
                  {settings.format === "stl"
                    ? "Geometry only, for any slicer."
                    : settings.format === "3mf"
                      ? "Model colors painted onto filaments, for OrcaSlicer / Bambu Studio."
                      : "Four filaments plus layer-mixed colors, for Snapmaker Orca on a Snapmaker U1."}
                </FieldDescription>
              </FieldSet>

              <FieldSeparator />

              <FieldSet>
                <FieldLegend>Size</FieldLegend>
                <FieldGroup className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="export-scale">Scale</FieldLabel>
                    <NumberInput
                      id="export-scale"
                      value={scale}
                      unit="mm / unit"
                      onCommit={setScale}
                    />
                  </Field>
                  <Field data-disabled={!sizeUnits || undefined}>
                    <FieldLabel htmlFor="export-height">Height of this model</FieldLabel>
                    <NumberInput
                      id="export-height"
                      value={sizeMm ? sizeMm[2] : 0}
                      unit="mm"
                      format={fmtMm}
                      onCommit={(h) => sizeUnits && sizeUnits[2] > 0 && setScale(h / sizeUnits[2])}
                    />
                  </Field>
                </FieldGroup>
                <FieldDescription>
                  {sizeMm && `${fmtMm(sizeMm[0])} × ${fmtMm(sizeMm[1])} × ${fmtMm(sizeMm[2])} mm. `}
                  The scale is shared by every model exported from {scope.label}, so they print
                  at the same relative size.
                  {!scaleSaved && ` Not set yet: defaulting to ${DEFAULT_TARGET_MM} mm for this model.`}
                </FieldDescription>
                {sizeUnits && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-fit"
                    onClick={() => setScale(defaultPrintScale(sizeUnits))}
                  >
                    <RotateCcwIcon data-icon="inline-start" />
                    Fit this model to {DEFAULT_TARGET_MM} mm
                  </Button>
                )}
                {tooBig && (
                  <Alert>
                    <TriangleAlertIcon />
                    <AlertDescription>
                      This model is larger than {limit.label}.
                    </AlertDescription>
                  </Alert>
                )}
              </FieldSet>

              <FieldSeparator />

              <FieldSet>
                <FieldLegend>Geometry</FieldLegend>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="export-repair">Repair for printing</FieldLabel>
                    <FieldDescription>
                      Close holes, remove double-sided duplicates and thicken open surfaces so
                      every part is a watertight solid the slicer won't flag.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="export-repair"
                    checked={settings.repair}
                    onCheckedChange={(repair) => update({ repair })}
                  />
                </Field>
                <FieldGroup className="grid grid-cols-2 gap-3">
                  <Field data-disabled={!settings.repair || undefined}>
                    <FieldLabel htmlFor="export-wall">Thickness for open surfaces</FieldLabel>
                    <NumberInput
                      id="export-wall"
                      value={settings.wallMm}
                      unit="mm"
                      format={fmtMm}
                      onCommit={(wallMm) => update({ wallMm })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="export-smooth">Smoothing</FieldLabel>
                    <Select value={String(subdivision)} onValueChange={(v) => setSubdivision(Number(v))}>
                      <SelectTrigger id="export-smooth" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="0">None</SelectItem>
                          <SelectItem value="1">1× (4× triangles)</SelectItem>
                          <SelectItem value="2">2× (16× triangles)</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
              </FieldSet>

              {is3mf && <FieldSeparator />}

              {settings.format === "3mf" && (
                <FieldSet>
                  <FieldLegend>Colors</FieldLegend>
                  <Field>
                    <FieldLabel htmlFor="export-colors">Filaments</FieldLabel>
                    <Select value={String(settings.colors)} onValueChange={(v) => update({ colors: Number(v) })}>
                      <SelectTrigger id="export-colors" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {[2, 3, 4, 5, 6, 7, 8, 12, 16].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n} colors
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>The model's colors are reduced to this many filaments.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="export-profile">Slicer profile</FieldLabel>
                    <Select value={settings.profile} onValueChange={(profile) => update({ profile })}>
                      <SelectTrigger id="export-profile" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {SLICER_PROFILES.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.label}
                            </SelectItem>
                          ))}
                          <SelectItem value="none">None</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {slicerProfile(settings.profile)
                        ? "Embeds the filament colors and selects this printer's stock profiles, so the file opens ready to print in Snapmaker Orca."
                        : "Plain 3MF for any OrcaSlicer / Bambu Studio printer. Filament colors aren't embedded; you set them in the slicer."}
                    </FieldDescription>
                  </Field>
                </FieldSet>
              )}

              {settings.format === "3mf-full-spectrum" && (
                <FieldSet>
                  <FieldLegend>Colors</FieldLegend>
                  <Field>
                    <FieldLabel>Filaments by toolhead</FieldLabel>
                    <div className="flex items-center gap-2">
                      {settings.base.map((hex, i) => (
                        <input
                          key={i}
                          type="color"
                          value={hex}
                          onChange={(e) => {
                            const base = settings.base.slice()
                            base[i] = e.target.value.toUpperCase()
                            update({ base })
                          }}
                          aria-label={`Toolhead ${i + 1} filament color`}
                          className="size-8 cursor-pointer rounded-md border bg-transparent p-0.5"
                        />
                      ))}
                      {settings.base.join() !== DEFAULT_EXPORT_SETTINGS.base.join() && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => update({ base: DEFAULT_EXPORT_SETTINGS.base })}
                        >
                          <RotateCcwIcon data-icon="inline-start" />
                          Full Spectrum bundle
                        </Button>
                      )}
                    </div>
                    <FieldDescription>
                      Default: Snapmaker PLA Full Spectrum (Cyan, Magenta, Yellow, Gray).
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="export-mixes">Mixed colors</FieldLabel>
                    <Select value={String(settings.mixes)} onValueChange={(v) => update({ mixes: Number(v) })}>
                      <SelectTrigger id="export-mixes" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {/* 6 pairs × 3 ratios = 18 candidate mixes. */}
                          {[4, 8, 12, 18].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n === 18 ? "Up to 18 (all)" : `Up to ${n}`}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      Fewer are used when more wouldn't improve the colors.
                    </FieldDescription>
                  </Field>
                  <GamutAlert
                    report={gamut}
                    base={settings.base}
                    onSwap={(toolhead, hex) => {
                      const base = settings.base.slice()
                      base[toolhead] = hex
                      update({ base })
                    }}
                  />
                  <Alert>
                    <InfoIcon />
                    <AlertDescription>
                      Open the file in Snapmaker Orca in a new, empty project. It selects the U1
                      0.4 mm nozzle, Color Mixing process and Full Spectrum PLA profiles.
                    </AlertDescription>
                  </Alert>
                </FieldSet>
              )}
            </FieldGroup>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={doExport} disabled={busy || !sizeUnits}>
              {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
              Export {settings.format === "stl" ? "STL" : "3MF"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
