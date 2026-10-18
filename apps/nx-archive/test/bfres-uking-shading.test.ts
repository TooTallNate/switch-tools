import { describe, expect, it } from 'vitest'
import type { BfresMaterial } from '@tootallnate/bfres'

import { ukingBaseColor } from '../src/lib/bfres-uking-shading'

const ALBEDO = ['_a0']

function material(
  options: Record<string, string>,
  params: Record<string, number[]>,
  bindings: { samplerName: string; textureName: string }[] = [],
  shadingModel = 'uking_mat',
): BfresMaterial {
  return {
    name: 'Mt_Test',
    bindings,
    shaderAssign: { shaderArchive: shadingModel, shadingModel, attribAssign: {}, samplerAssign: {}, options },
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
