import { describe, expect, it } from 'vitest'
import { graphShaderUvs, wrapPupilU } from '~/lib/bfres-bezel-shading'

const mat = (graph: boolean) => ({ shaderAssign: { options: graph ? { fragment_shader_graph_color: '1' } : {} } }) as never

describe('Jamboree graph-shader UVs', () => {
  it('maps V −1…1 onto a 1:2 atlas', () => {
    const out = graphShaderUvs(mat(true), Float32Array.from([0.5, -1, 0.5, 0, 0.5, 1]), 1024, 2048)
    expect(Array.from(out)).toEqual([0.5, 0, 0.5, 0.5, 0.5, 1])
  })

  it('leaves square textures and other shaders alone', () => {
    const uv = Float32Array.from([0.25, 0.75])
    expect(graphShaderUvs(mat(true), uv, 512, 512)).toBe(uv)
    expect(graphShaderUvs(mat(false), uv, 1024, 2048)).toBe(uv)
  })
})

describe('Jamboree pupil islands', () => {
  it('moves each UV island as a whole, by its centre', () => {
    // Island A (verts 0-2) centred near U 0.5; island B (3-5) straddles U 2 around 2.1.
    const uv = Float32Array.from([0.4, 0, 0.6, 0, 0.5, 1, 1.9, 0, 2.3, 0, 2.1, 1])
    const out = wrapPupilU(uv, [0, 1, 2, 3, 4, 5])
    expect(Array.from(out).map((x) => Math.round(x * 100) / 100)).toEqual([0.4, 0, 0.6, 0, 0.5, 1, -0.1, 0, 0.3, 0, 0.1, 1])
  })
})
