import { unzipSync, strFromU8 } from 'fflate'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { emitBinarySTL, signedVolume, type ExportMesh } from '~/lib/mesh-export'
import { buildPainted3MF, encodePaintLeaf, encodePaintTree } from '~/lib/mesh-export-3mf'
import { exportMeshFromThree } from '~/lib/three-export'

const modelXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['3D/3dmodel.model']!)
const paints = (xml: string) => [...xml.matchAll(/<triangle [^>]*?(?:paint_color="([0-9A-F]+)")?\/>/g)].map((m) => m[1] ?? '')

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

// A quad split into two triangles.
const quad = (): Pick<ExportMesh, 'positions' | 'indices' | 'uvs'> => ({
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
})
const tex = (pixels: number[], width: number, height: number, flipY = false) => ({
  pixels: new Uint8Array(pixels), width, height, wrapS: 'clamp' as const, wrapT: 'clamp' as const, flipY,
})

describe('buildPainted3MF', () => {
  it('paints a two-colour texture', () => {
    const res = buildPainted3MF(
      [{ ...quad(), materials: [{ texture: tex([255, 0, 0, 255, 0, 0, 255, 255], 2, 1) }] }],
      { colorCount: 4, sourceAxis: 'z-up' },
    )
    expect(res.palette.length).toBe(2)
    const files = unzipSync(res.bytes)
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])
    const xml = modelXml(res.bytes)
    expect(xml.match(/<vertex /g)?.length).toBe(4)
    expect(paints(xml).join('')).toMatch(/8/)
  })

  it('honours flipY by sampling rows bottom-up', () => {
    // 1×2 texture: row 0 red, row 1 blue. The quad's first triangle
    // (0,1,2) sits mostly at low V.
    const pixels = [255, 0, 0, 255, 0, 0, 255, 255]
    // Make red dominant so it is filament 1 (unpainted) either way.
    const big = (flipY: boolean) =>
      buildPainted3MF(
        [{ ...quad(), materials: [{ texture: tex(pixels, 1, 2, flipY) }] }],
        { colorCount: 2, sourceAxis: 'z-up', maxPaintDepth: 0 },
      )
    const a = big(false)
    const b = big(true)
    const colorOf = (r: ReturnType<typeof big>, tri: number) => {
      const p = paints(modelXml(r.bytes))[tri]!
      return r.palette[p === '' ? 0 : p === '8' ? 1 : -1]
    }
    expect(colorOf(a, 0)).not.toEqual(colorOf(b, 0))
  })

  it('uses per-triangle materials and vertex colours', () => {
    const res = buildPainted3MF(
      [{
        ...quad(),
        // Linear 1.0 red / blue per vertex; triangle 1 uses vertex colours.
        colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1]),
        materials: [{ texture: null, baseColor: [0, 255, 0] }, { texture: null, useVertexColors: true }],
        triangleMaterials: [0, 1],
      }],
      { colorCount: 3, sourceAxis: 'z-up' },
    )
    // Green from the flat slot; the rest of the slots split the
    // red→blue gradient (interpolated in linear space, like the GPU).
    expect(res.palette.map((c) => c.join())).toContain('0,255,0')
    expect(res.palette.some(([r, g, b]) => r > 150 && g === 0 && b < 150)).toBe(true)
    const p = paints(modelXml(res.bytes))
    // Triangle 0 is flat green; triangle 1 has a red→blue gradient, so it splits.
    expect(p[1]!.endsWith('3')).toBe(true)
  })

  it('fills alpha-cutout texels with the dominant opaque colour', () => {
    // 4×1: three opaque blue texels, one transparent red texel.
    const pixels = [0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 0]
    const res = buildPainted3MF(
      [{ ...quad(), materials: [{ texture: tex(pixels, 4, 1) }] }],
      { colorCount: 4, sourceAxis: 'z-up' },
    )
    // Red never makes it into the palette, and nothing is painted with it.
    expect(res.palette).toEqual([[0, 0, 255]])
    expect(paints(modelXml(res.bytes))).toEqual(['', ''])
  })

  it('reorients negative-volume meshes so Orca will not flip them', () => {
    // Closed tetrahedron with inward-facing winding.
    const inp: ExportMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]),
    }
    const xml = modelXml(buildPainted3MF([inp], { colorCount: 1, sourceAxis: 'z-up' }).bytes)
    expect(xml).toContain('<triangle v1="0" v2="2" v3="1"/>')
  })
})

describe('emitBinarySTL', () => {
  it('re-orients inside-out (mirrored) meshes', () => {
    const inward = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]),
    }
    expect(signedVolume([inward])).toBeLessThan(0)
    const stl = emitBinarySTL([inward], { header: 'x', sourceAxis: 'z-up' })
    const view = new DataView(stl.buffer, stl.byteOffset)
    // Read back the triangles and check the written winding is outward.
    const n = view.getUint32(80, true)
    const positions: number[] = []
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) positions.push(view.getFloat32(84 + t * 50 + 12 + k * 4, true))
    const indices = new Uint32Array(n * 3).map((_, i) => i)
    expect(signedVolume([{ positions: new Float32Array(positions), indices }])).toBeGreaterThan(0)
  })
})

describe('exportMeshFromThree', () => {
  it('reads groups, UVs, colours and bound textures back from a mesh', () => {
    const geom = new THREE.BufferGeometry()
    const q = quad()
    geom.setAttribute('position', new THREE.BufferAttribute(q.positions, 3))
    geom.setAttribute('uv', new THREE.BufferAttribute(q.uvs!, 2))
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(0.5), 3))
    geom.setIndex(new THREE.BufferAttribute(q.indices, 1))
    geom.addGroup(0, 3, 0)
    geom.addGroup(3, 3, 1)
    const map = new THREE.DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1)
    map.wrapS = THREE.ClampToEdgeWrapping
    map.flipY = true
    const mesh = new THREE.Mesh(geom, [
      new THREE.MeshBasicMaterial({ map }),
      new THREE.MeshBasicMaterial({ vertexColors: true }),
    ])
    mesh.position.set(1, 0, 0)
    mesh.updateMatrixWorld(true)

    const out = exportMeshFromThree(mesh)!
    expect(out.positions[0]).toBe(1) // matrixWorld applied
    expect(Array.from(out.triangleMaterials!)).toEqual([0, 1])
    expect(out.materials![0]!.texture).toMatchObject({ width: 1, height: 1, wrapS: 'clamp', wrapT: 'clamp', flipY: true })
    expect(out.materials![1]!.useVertexColors).toBe(true)
    expect(out.uvs?.length).toBe(8)
    expect(out.colors?.length).toBe(12)
  })
})
