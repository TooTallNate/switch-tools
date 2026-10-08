import { describe, expect, it } from 'vitest'
import type { BfresGeometry, BfresMaterial } from '@tootallnate/bfres'

import {
  applyTexSrt,
  bakeAlbedoLayers,
  bezelBaseColor,
  hasAlpha,
  isBezelMaterial,
  planBezelAlbedo,
  rendersInColorPass,
  separateOverlappingIslands,
  tileHorizontally,
} from '~/lib/bfres-bezel-shading'

const srt = (scaleX: number, translateX: number) => ({
  mode: 0,
  scaleX,
  scaleY: 1,
  rotation: 0,
  translateX,
  translateY: 0,
})

/** The shape of a Bezel eye material (Mario Party Superstars `eye_m`). */
function eyeMaterial(): BfresMaterial {
  return {
    name: 'eye_m',
    textureRefs: ['eyelid', 'pupil'],
    samplers: ['_a0', '_a1'],
    bindings: [
      { samplerName: '_a0', textureName: 'eyelid' },
      { samplerName: '_a1', textureName: 'pupil' },
    ],
    shaderAssign: {
      shaderArchive: 'forward_plus_custom',
      shadingModel: 'forward_plus_color_custom',
      attribAssign: { _u0: '_u2', _u1: '_u1', _u2: '_u1' },
      samplerAssign: { _a0: '_a0', _a1: '_a1', utilitySampler2: '_a1' },
      options: {
        texture_srt_enable0: '1',
        texture_srt_enable1: '1',
        texture_srt_enable2: '1',
      },
    },
    shaderParams: {
      texsrt0: { name: 'texsrt0', type: 30, values: [], texSrt: srt(0.125, 0) },
      texsrt1: { name: 'texsrt1', type: 30, values: [], texSrt: srt(1, 2) },
      texsrt2: { name: 'texsrt2', type: 30, values: [], texSrt: srt(1, 0) },
      utilityColor0: { name: 'utilityColor0', type: 15, values: [1, 1, 1, 1] },
    },
  }
}

function geometry(uvSets: Record<string, number[]>): BfresGeometry {
  const sets = Object.fromEntries(
    Object.entries(uvSets).map(([k, v]) => [k, new Float32Array(v)]),
  )
  return { uvs: sets._u0 ?? null, uvSets: sets } as unknown as BfresGeometry
}

describe('applyTexSrt', () => {
  it('scales then offsets (Maya mode)', () => {
    expect([...applyTexSrt(new Float32Array([1, 0.5]), srt(0.125, 0))]).toEqual([0.125, 0.5])
    expect([...applyTexSrt(new Float32Array([2.5, 0.5]), srt(1, 2))]).toEqual([0.5, 0.5])
  })
})

describe('planBezelAlbedo', () => {
  it('ignores non-Bezel materials', () => {
    const mat = { ...eyeMaterial(), shaderAssign: undefined }
    expect(isBezelMaterial(mat)).toBe(false)
    expect(planBezelAlbedo(geometry({ _u0: [0, 0] }), mat)).toBeNull()
  })

  it('routes UVs through the attribute assign and texture SRTs', () => {
    const g = geometry({ _u0: [0.9, 0.9], _u1: [2.5, 0.5], _u2: [1, 0.5] })
    const plan = planBezelAlbedo(g, eyeMaterial())!
    expect(plan.baseTexture).toBe('eyelid')
    // Shader UV0 = mesh _u2 scaled to one eighth of the atlas.
    expect([...plan.baseUvs!]).toEqual([0.125, 0.5])
    // The pupil layer is sampled at shader UV1 (shifted) and UV2.
    expect(plan.layers.map((l) => [l.textureName, ...l.uvs])).toEqual([
      ['pupil', 0.5, 0.5],
      ['pupil', 2.5, 0.5],
    ])
    expect(plan.windowColor).toEqual([255, 255, 255])
  })

  it('resolves the base through the sampler assign', () => {
    const mat = eyeMaterial()
    mat.shaderAssign!.samplerAssign = { _a0: '_a1' }
    expect(planBezelAlbedo(geometry({ _u2: [0, 0] }), mat)!.baseTexture).toBe('pupil')
  })
})

describe('bakeAlbedoLayers', () => {
  const solid = (w: number, h: number, rgba: number[]) => {
    const pixels = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) pixels.set(rgba, i * 4)
    return { pixels, width: w, height: h }
  }
  // One triangle covering the lower-left half of a 4×4 base.
  const baseUvs = new Float32Array([0, 0, 1, 0, 0, 1])
  const indices = [0, 1, 2]
  const layerUvs = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])

  it('blends an opaque layer over an opaque base and leaves uncovered texels', () => {
    const base = solid(4, 4, [10, 20, 30, 255])
    const layer = solid(2, 2, [200, 0, 0, 255])
    expect(hasAlpha(base)).toBe(false)
    const out = bakeAlbedoLayers(base, baseUvs, indices, [{ image: layer, uvs: layerUvs }], null)
    expect([...out.subarray(0, 4)]).toEqual([200, 0, 0, 255]) // covered
    expect([...out.subarray((3 * 4 + 3) * 4, (3 * 4 + 3) * 4 + 4)]).toEqual([10, 20, 30, 255])
  })

  it('treats base alpha as an eyelid mask when given a window colour', () => {
    const base = solid(4, 4, [50, 50, 50, 255])
    base.pixels[3] = 0 // texel (0,0) is the eyeball window
    expect(hasAlpha(base)).toBe(true)
    const clear = solid(2, 2, [0, 0, 0, 0])
    const out = bakeAlbedoLayers(base, baseUvs, indices, [{ image: clear, uvs: layerUvs }], [240, 240, 240])
    expect([...out.subarray(0, 4)]).toEqual([240, 240, 240, 255]) // window → sclera
    expect([...out.subarray(4, 8)]).toEqual([50, 50, 50, 255]) // lid stays
    const pupil = solid(2, 2, [0, 0, 200, 255])
    const out2 = bakeAlbedoLayers(base, baseUvs, indices, [{ image: pupil, uvs: layerUvs }], [240, 240, 240])
    expect([...out2.subarray(0, 4)]).toEqual([0, 0, 200, 255]) // pupil shows in the window
    expect([...out2.subarray(4, 8)]).toEqual([50, 50, 50, 255]) // but not over the lid
  })

  it('skips layer samples outside [0, 1]', () => {
    const base = solid(4, 4, [10, 20, 30, 255])
    const layer = solid(2, 2, [200, 0, 0, 255])
    const off = new Float32Array([2.5, 0.5, 2.5, 0.5, 2.5, 0.5])
    const out = bakeAlbedoLayers(base, baseUvs, indices, [{ image: layer, uvs: off }], null)
    expect([...out.subarray(0, 4)]).toEqual([10, 20, 30, 255])
  })
})

describe('bezelBaseColor', () => {
  it('returns baseColor only when use_base_color_value is on', () => {
    const mat = eyeMaterial()
    mat.shaderParams!.baseColor = { name: 'baseColor', type: 15, values: [0.006, 0.006, 0.034, 1] }
    expect(bezelBaseColor(mat)).toBeNull()
    mat.shaderAssign!.options.use_base_color_value = '1'
    expect(bezelBaseColor(mat)).toEqual([0.006, 0.006, 0.034])
    expect(bezelBaseColor({ ...mat, shaderAssign: undefined })).toBeNull()
  })
})

describe('rendersInColorPass', () => {
  const mat = (renderInfo?: Record<string, (number | string)[]>) =>
    ({ ...eyeMaterial(), renderInfo }) as BfresMaterial

  it('follows the render_color flag', () => {
    expect(rendersInColorPass(mat({ render_color: [1] }), [])).toBe(true)
    expect(rendersInColorPass(mat({ render_color: [0] }), [])).toBe(false)
  })

  it('hides untagged materials only when the model uses the convention', () => {
    const body = mat({ render_color: [1] })
    const fluid = mat({ fluid_type: [1] })
    expect(rendersInColorPass(fluid, [body, fluid])).toBe(false)
    // Another engine's render info: no render_color anywhere.
    const other = mat({ gsys_render_state_mode: ['opaque'] })
    expect(rendersInColorPass(other, [other])).toBe(true)
    expect(rendersInColorPass(mat(undefined), [body])).toBe(true)
  })
})

describe('older Bezel shaders (Super Mario Party)', () => {
  /** `forward_plus_char`: no `texture_srt_enable*` options, SRTs always apply. */
  function smpEyeMaterial(): BfresMaterial {
    return {
      name: 'eye_m',
      textureRefs: ['pc56_eye_alb'],
      samplers: ['_a0'],
      bindings: [{ samplerName: '_a0', textureName: 'pc56_eye_alb' }],
      shaderAssign: {
        shaderArchive: 'forward_plus_char',
        shadingModel: 'forward_plus_color',
        attribAssign: { _u0: '_u1', _u1: '_u1' },
        samplerAssign: { _a0: '_a0' },
        options: { eye_render_mode: '0' },
      },
      shaderParams: {
        texsrt0: { name: 'texsrt0', type: 30, values: [], texSrt: srt(0.125, 0) },
      },
    }
  }

  it('recognises the shader archive and applies the SRT without an enable option', () => {
    const mat = smpEyeMaterial()
    expect(isBezelMaterial(mat)).toBe(true)
    const plan = planBezelAlbedo(geometry({ _u1: [1.5, 0.5] }), mat)!
    expect(plan.baseTexture).toBe('pc56_eye_alb')
    expect([...plan.baseUvs!]).toEqual([0.1875, 0.5])
    expect(plan.layers).toEqual([])
  })

  it('still honours an explicit texture_srt_enable0 = 0', () => {
    const mat = smpEyeMaterial()
    mat.shaderAssign!.options.texture_srt_enable0 = '0'
    expect([...planBezelAlbedo(geometry({ _u1: [1.5, 0.5] }), mat)!.baseUvs!]).toEqual([1.5, 0.5])
  })
})

describe('per-eye pupils', () => {
  it('samples the second pupil at raw UV1 when the shader has no _u2 input', () => {
    // Super Mario Party Yoshi: texsrt1 shifts one eye's pupil island by 2;
    // the other eye's island sits at its raw UV1.
    const mat = eyeMaterial()
    mat.shaderAssign!.attribAssign = { _u0: '_u0', _u1: '_u1' }
    const plan = planBezelAlbedo(geometry({ _u0: [0.5, 0.5], _u1: [2.5, 0.5] }), mat)!
    expect(plan.layers.map((l) => [...l.uvs])).toEqual([
      [0.5, 0.5], // UV1 − 2
      [2.5, 0.5], // raw UV1
    ])
  })

  it('moves overlapping UV islands into their own tiles', () => {
    // Two disconnected triangles (both eyes) over the same base texels.
    const uvs = new Float32Array([0.1, 0.1, 0.4, 0.1, 0.1, 0.4, 0.1, 0.1, 0.4, 0.1, 0.1, 0.4])
    const split = separateOverlappingIslands(uvs, [0, 1, 2, 3, 4, 5])
    expect(split.copies).toBe(2)
    expect([...split.uvs.slice(0, 2)].map((x) => +x.toFixed(3))).toEqual([0.05, 0.1])
    expect([...split.uvs.slice(6, 8)].map((x) => +x.toFixed(3))).toEqual([0.55, 0.1])
  })

  it('leaves disjoint or wrapped islands alone', () => {
    const disjoint = new Float32Array([0.1, 0.1, 0.2, 0.1, 0.1, 0.2, 0.6, 0.6, 0.7, 0.6, 0.6, 0.7])
    expect(separateOverlappingIslands(disjoint, [0, 1, 2, 3, 4, 5]).copies).toBe(1)
    const wrapped = new Float32Array([1.1, 0.1, 1.4, 0.1, 1.1, 0.4, 1.1, 0.1, 1.4, 0.1, 1.1, 0.4])
    expect(separateOverlappingIslands(wrapped, [0, 1, 2, 3, 4, 5]).copies).toBe(1)
  })

  it('tiles an image horizontally', () => {
    const img = { pixels: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]), width: 1, height: 2 }
    expect([...tileHorizontally(img, 2).pixels]).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8])
  })
})
