import { describe, expect, it } from 'vitest'
import { graphShaderUvs } from '~/lib/bfres-bezel-shading'

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
