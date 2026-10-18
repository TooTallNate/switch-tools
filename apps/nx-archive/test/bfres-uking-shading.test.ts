import { describe, expect, it } from 'vitest'
import type { BfresMaterial } from '@tootallnate/bfres'

import { ukingAlbedoTexture, ukingBaseColor } from '../src/lib/bfres-uking-shading'

const ALBEDO = ['_a0']

function material(
  options: Record<string, string>,
  params: Record<string, number[]>,
  bindings: { samplerName: string; textureName: string }[] = [],
  shadingModel = 'uking_mat',
  samplerAssign: Record<string, string> = {},
): BfresMaterial {
  return {
    name: 'Mt_Test',
    bindings,
    shaderAssign: { shaderArchive: shadingModel, shadingModel, attribAssign: {}, samplerAssign, options },
    shaderParams: Object.fromEntries(
      Object.entries(params).map(([name, values]) => [name, { name, type: 12, values }]),
    ),
  } as unknown as BfresMaterial
}

describe('ukingBaseColor', () => {
  it('reads const_color and darkens it by a const_value AO (Korok face shadow)', () => {
    const m = material(
      { uking_albedo_color: '104', uking_enable_ao: '1', uking_ao_color: '400' },
      { const_color4: [1, 1, 1, 1], const_value0: [0.01] },
    )
    const c = ukingBaseColor(m, ALBEDO)!
    for (const v of c) expect(v).toBeCloseTo(0.01)
  })

  it('ignores AO unless it is enabled', () => {
    const m = material(
      { uking_albedo_color: '101', uking_ao_color: '400' },
      { const_color1: [0.5, 0.25, 1, 1], const_value0: [0.01] },
    )
    expect(ukingBaseColor(m, ALBEDO)).toEqual([0.5, 0.25, 1])
  })

  it('returns null for textured, unknown-selector and non-BotW materials', () => {
    const textured = material(
      { uking_albedo_color: '104' },
      { const_color4: [1, 1, 1, 1] },
      [{ samplerName: '_a0', textureName: 'Body_Alb' }],
    )
    expect(ukingBaseColor(textured, ALBEDO)).toBeNull()
    expect(ukingBaseColor(material({ uking_albedo_color: '200' }, {}), ALBEDO)).toBeNull()
    expect(
      ukingBaseColor(material({ uking_albedo_color: '104' }, { const_color4: [1, 1, 1, 1] }, [], 'other'), ALBEDO),
    ).toBeNull()
  })
})

describe('ukingBaseColor calc colours', () => {
  it('follows calc nodes by their first operand down to a constant (water)', () => {
    const m = material(
      {
        uking_albedo_color: '209',
        uking_enable_calc_color9: '1',
        uking_color9_A: '206',
        uking_enable_calc_color6: '1',
        uking_color6_A: '101',
      },
      { const_color1: [0.001, 0.0085, 0.011, 1] },
    )
    expect(ukingBaseColor(m, ALBEDO)).toEqual([0.001, 0.0085, 0.011])
  })

  it('gives up on disabled calc nodes', () => {
    expect(ukingBaseColor(material({ uking_albedo_color: '203' }, {}), ALBEDO)).toBeNull()
  })
})

describe('ukingAlbedoTexture', () => {
  const terrain = (options: Record<string, string>) =>
    material(
      options,
      { texture_array_index0: [18] },
      [
        { samplerName: 'tma', textureName: 'MaterialAlb' },
        { samplerName: 'tmc', textureName: 'MaterialCmb' },
      ],
      'uking_mat',
      { _a0: 'tma', _s0: 'tmc' },
    )

  it('routes _a0 through samplerAssign to a texture-array layer (Korok stake rock)', () => {
    expect(ukingAlbedoTexture(terrain({ uking_sampler_use_array: '1', uking_texture_array_texture0: '0' }))).toEqual({
      textureName: 'MaterialAlb',
      layer: 18,
    })
  })

  it('uses layer 0 when the array option is off', () => {
    expect(ukingAlbedoTexture(terrain({ uking_texture_array_texture0: '-1' }))).toEqual({ textureName: 'MaterialAlb', layer: 0 })
  })

  it('never offers a flat colour for a routed texture', () => {
    const m = terrain({ uking_albedo_color: '104' })
    expect(ukingBaseColor(m, ALBEDO)).toBeNull()
  })
})
