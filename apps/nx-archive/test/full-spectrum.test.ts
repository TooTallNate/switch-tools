import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  FULL_SPECTRUM_BUNDLE,
  buildFullSpectrum3MF,
  chooseMixes,
  mixCandidates,
  mixPreviewColor,
  mixedFilamentDefinitions,
  pairLayerRatios,
} from '~/lib/full-spectrum'
import type { ExportMesh } from '~/lib/mesh-export'
import { encodePaintLeaf } from '~/lib/mesh-export-3mf'

const base = FULL_SPECTRUM_BUNDLE.map((f) => f.rgb)

describe('paint states above 17', () => {
  it('matches upstream Orca up to 32 and Snapmaker’s continuation beyond', () => {
    expect(encodePaintLeaf(17)).toBe('EC')
    expect(encodePaintLeaf(18)).toBe('0FC') // upstream CONST_FILAMENTS[18]
    expect(encodePaintLeaf(32)).toBe('EFC') // upstream CONST_FILAMENTS[32]
    expect(encodePaintLeaf(33)).toBe('0FFC') // Snapmaker: 3 + 15 + 15 + 0
    expect(() => encodePaintLeaf(256)).toThrow()
  })
})

describe('mix model', () => {
  it('derives Snapmaker Orca’s layer cadence from the mix percentage', () => {
    expect(pairLayerRatios(50)).toEqual([1, 1])
    expect(pairLayerRatios(33)).toEqual([2, 1]) // A, A, B
    expect(pairLayerRatios(67)).toEqual([1, 2])
    expect(pairLayerRatios(25)).toEqual([3, 1])
  })

  it('predicts colours with FilamentMixer', () => {
    // Cyan + Yellow 50/50 → green (golden value from the C++ model).
    expect(mixPreviewColor(base, 1, 3, 50)).toEqual([104, 226, 124])
  })

  it('offers every pair at each ratio', () => {
    expect(mixCandidates(base)).toHaveLength(6 * 3)
  })
})

describe('mixed_filament_definitions', () => {
  it('lists our mixes first, then the auto pairs as deleted', () => {
    const defs = mixedFilamentDefinitions(
      [
        { a: 1, b: 3, mixB: 50, rgb: [0, 0, 0] },
        { a: 2, b: 4, mixB: 33, rgb: [0, 0, 0] },
      ],
      4,
    )
    const rows = defs.split(';')
    expect(rows).toHaveLength(2 + 6)
    expect(rows[0]).toBe('1,3,1,1,50,0,g,w,m2,z0,xa0,xb0,d0,o0,u1,cm0')
    expect(rows[1]).toBe('2,4,1,1,33,0,g,w,m2,z0,xa0,xb0,d0,o0,u2,cm0')
    expect(rows[2]).toBe('1,2,0,0,50,0,g,w,m2,z0,xa0,xb0,d1,o1,u3')
    // Every auto row is disabled + deleted so none takes a virtual ID.
    for (const r of rows.slice(2)) expect(r).toMatch(/^\d,\d,0,0,50,.*,d1,o1,u\d+$/)
  })
})

describe('chooseMixes', () => {
  it('adds the mix that matches an off-palette colour, and stops early', () => {
    const green = mixPreviewColor(base, 1, 3, 50)
    const mixes = chooseMixes([{ rgb: green, weight: 1 }, { rgb: base[0]!, weight: 1 }], base, 8)
    expect(mixes[0]).toMatchObject({ a: 1, b: 3, mixB: 50 })
    expect(mixes.length).toBeLessThan(8)
  })
})

describe('buildFullSpectrum3MF', () => {
  // A *vertical* quad (z-up) split in two: left half cyan, right half
  // the Cyan+Yellow 50/50 mix colour.
  const green = mixPreviewColor(base, 1, 3, 50)
  const wall: ExportMesh = {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    materials: [
      {
        texture: {
          pixels: new Uint8Array([...base[0]!, 255, ...green, 255]),
          width: 2,
          height: 1,
          wrapS: 'clamp',
          wrapT: 'clamp',
        },
      },
    ],
  }

  it('embeds filaments + mix recipes and paints with virtual IDs', () => {
    const res = buildFullSpectrum3MF([wall], { maxMixes: 4, sourceAxis: 'z-up' })
    expect(res.mixes[0]).toMatchObject({ a: 1, b: 3, mixB: 50 })
    const files = unzipSync(res.bytes)
    const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']!))
    expect(settings.filament_colour).toEqual(['#08ABFB', '#D93B90', '#F9ED3D', '#9199A4'])
    expect(settings.mixed_filament_definitions.split(';')[0]).toMatch(/^1,3,1,1,50,/)
    const model = strFromU8(files['3D/3dmodel.model']!)
    // Filament 5 (the first mix) is encoded "2C".
    expect(model).toMatch(/paint_color="[0-9A-F]*2C[0-9A-F]*"/)
    expect(model).toContain('Snapmaker Orca Full Spectrum')
  })

  it('keeps flat faces on physical filaments', () => {
    // Same quad lying flat (normal along Z): mixes can't show there.
    const flat: ExportMesh = {
      ...wall,
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
    }
    const res = buildFullSpectrum3MF([flat], { maxMixes: 4, sourceAxis: 'z-up' })
    const model = strFromU8(unzipSync(res.bytes)['3D/3dmodel.model']!)
    const states = [...model.matchAll(/paint_color="([0-9A-F]+)"/g)].map((m) => m[1]!)
    // Only "", "4", "8", "0C", "1C" (filaments 1–4) may appear.
    for (const s of states) expect(s.replace(/[48]|0C|1C|3/g, '')).toBe('')
  })
})
