import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ExportMesh } from '~/lib/mesh-export'
import { DEFAULT_EXPORT_SETTINGS, printSize, runModelExport, type ModelExportSettings } from '~/lib/model-export'
import { defaultPrintScale, loadPrintScale, savePrintScale } from '~/lib/print-scale'

/** Closed axis-aligned box w × h × d (Y-up). */
function box(w: number, h: number, d: number): ExportMesh {
  const p: number[] = []
  for (const [x, y, z] of [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]) p.push(x! * w, y! * h, z! * d)
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return { positions: new Float32Array(p), indices: new Uint32Array(f.flat()) }
}

const settings = (patch: Partial<ModelExportSettings>): ModelExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, ...patch })

function bounds(positions: number[]) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k]!, positions[i + k]!); mx[k] = Math.max(mx[k]!, positions[i + k]!)
  }
  return mx.map((v, k) => v - mn[k]!)
}

describe('printSize', () => {
  it('reports print axes (Z up) for Y-up sources', () => {
    expect(printSize([box(1, 3, 2)], 'y-up')).toEqual([1, 2, 3])
    expect(printSize([box(1, 3, 2)], 'z-up')).toEqual([1, 3, 2])
  })
})

describe('runModelExport', () => {
  const job = { stem: 'm', pose: '', sourceAxis: 'y-up' as const }

  it('scales STL output to millimetres', () => {
    const r = runModelExport({ ...job, meshes: [box(1, 2, 1)], settings: settings({ format: 'stl' }), mmPerUnit: 25 })
    const view = new DataView(r.bytes.buffer, r.bytes.byteOffset)
    const n = view.getUint32(80, true)
    const pos: number[] = []
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) pos.push(view.getFloat32(84 + t * 50 + 12 + k * 4, true))
    const [x, y, z] = bounds(pos)
    expect([x, y, z].map((v) => +v!.toFixed(4))).toEqual([25, 25, 50]) // height 2 units → 50 mm on Z
    expect(r.fileName).toBe('m.stl')
  })

  it('scales 3MF output and thickens sheets by the wall thickness in mm', () => {
    // An open 4 × 4 unit sheet in the XZ plane (flat on the bed).
    const sheet: ExportMesh = {
      positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4]),
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    }
    const r = runModelExport({ ...job, meshes: [sheet], settings: settings({ format: '3mf', colors: 1, wallMm: 2 }), mmPerUnit: 10 })
    const xml = strFromU8(unzipSync(r.bytes)['3D/3dmodel.model']!)
    const pos = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap((m) => [+m[1]!, +m[2]!, +m[3]!])
    const [x, y, z] = bounds(pos)
    expect(x).toBeCloseTo(40)
    expect(y).toBeCloseTo(40)
    expect(z).toBeCloseTo(2) // 2 mm wall, independent of the scale
    expect(r.repair?.sheetsThickened).toBe(1)
  })

  it('embeds the palette as filament colours with the U1 profile', () => {
    // Two-colour texture: red | blue.
    const quad: ExportMesh = {
      ...box(1, 1, 1),
      uvs: new Float32Array(16).map((_, i) => (i % 2 === 0 ? (i / 2) % 2 : 0.5)),
      materials: [{ texture: { pixels: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1, wrapS: 'clamp', wrapT: 'clamp' } }],
    }
    const r = runModelExport({ ...job, meshes: [quad], settings: settings({ format: '3mf', colors: 4 }), mmPerUnit: 20 })
    const files = unzipSync(r.bytes)
    const cfg = JSON.parse(strFromU8(files['Metadata/project_settings.config']!))
    expect(cfg.filament_colour).toEqual(r.palette!.map((c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()))
    expect(cfg.filament_colour.length).toBeGreaterThan(1)
    expect(cfg.printer_settings_id).toBe('Snapmaker U1 (0.4 nozzle)')
    expect(cfg.print_settings_id).toBe('0.20mm Standard @Snapmaker U1 (0.4 nozzle)')
    expect(cfg.filament_settings_id).toEqual(cfg.filament_colour.map(() => 'Snapmaker PLA Basic @U1'))
    expect(cfg.different_settings_to_system).toHaveLength(cfg.filament_colour.length + 2)
    expect(r.profile?.id).toBe('snapmaker-u1')
  })

  it('writes a plain 3MF without a profile', () => {
    const r = runModelExport({ ...job, meshes: [box(1, 1, 1)], settings: settings({ format: '3mf', profile: 'none' }), mmPerUnit: 20 })
    expect(Object.keys(unzipSync(r.bytes))).not.toContain('Metadata/project_settings.config')
    expect(r.profile).toBeUndefined()
  })

  it('produces Full Spectrum 3MFs', () => {
    const r = runModelExport({ ...job, meshes: [box(1, 1, 1)], settings: settings({ format: '3mf-full-spectrum' }), mmPerUnit: 20 })
    expect(r.fileName).toMatch(/_fs\d+\.3mf$/)
    expect(r.fullSpectrum?.base).toHaveLength(4)
  })
})

describe('print scale storage', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
  })

  it('is shared per base file', () => {
    expect(loadPrintScale('game.nsp:1')).toBeNull()
    savePrintScale('game.nsp:1', 42)
    savePrintScale('other.xci:2', 7)
    expect(loadPrintScale('game.nsp:1')).toBe(42)
    expect(loadPrintScale('other.xci:2')).toBe(7)
  })

  it('defaults so the largest dimension is 100 mm', () => {
    expect(defaultPrintScale([1, 2, 4])).toBe(25)
  })
})
