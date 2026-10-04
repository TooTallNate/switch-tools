import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  buildPainted3MF,
  encodePaintLeaf,
  encodePaintTree,
  type PaintMeshInput,
} from '~/lib/mesh-export-3mf'

describe('paint_color encoding', () => {
  it('matches OrcaSlicer CONST_FILAMENTS for leaf states', () => {
    // From OrcaSlicer src/libslic3r/Model.cpp `CONST_FILAMENTS`.
    const orca = ['', '4', '8', '0C', '1C', '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'AC', 'BC', 'CC', 'DC', 'EC']
    for (let s = 1; s < orca.length; s++) expect(encodePaintLeaf(s)).toBe(orca[s])
    expect(encodePaintLeaf(0)).toBe('0')
  })

  it('matches Orca’s 4-way split layout', () => {
    // Orca's colour-OBJ importer writes c0 + c1 + c2 + c3 + "3".
    expect(encodePaintTree([1, 2, 3, 4])).toBe('480C1C3')
    expect(encodePaintTree([[1, 1, 2, 2], 3, 3, 3])).toBe('44883' + '0C0C0C3')
  })
})

describe('buildPainted3MF', () => {
  // A quad split into two triangles, textured with a 2×1 red|blue texture.
  const quad = (): PaintMeshInput => ({
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    texture: {
      pixels: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      width: 2,
      height: 1,
      wrapS: 'clamp',
      wrapT: 'clamp',
    },
  })

  it('produces a 3MF with a two-colour palette and paint trees', () => {
    const res = buildPainted3MF([quad()], { colorCount: 4, sourceAxis: 'z-up' })
    expect(res.palette.length).toBe(2)
    const files = unzipSync(res.bytes)
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])
    const model = strFromU8(files['3D/3dmodel.model']!)
    expect(model.match(/<vertex /g)?.length).toBe(4)
    expect(model.match(/<triangle /g)?.length).toBe(2)
    // Both colours are present somewhere in the paint.
    const paints = [...model.matchAll(/paint_color="([0-9A-F]+)"/g)].map((m) => m[1]!)
    expect(paints.join('')).toMatch(/8/)
  })

  it('reorients negative-volume meshes so Orca will not flip them', () => {
    // Closed tetrahedron with inward-facing winding.
    const inp: PaintMeshInput = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]),
      uvs: null,
      texture: null,
    }
    const res = buildPainted3MF([inp], { colorCount: 1, sourceAxis: 'z-up' })
    const model = strFromU8(unzipSync(res.bytes)['3D/3dmodel.model']!)
    expect(model).toContain('<triangle v1="0" v2="2" v3="1"/>')
  })
})
