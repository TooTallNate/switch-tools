import { unzipSync, strFromU8 } from 'fflate'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { emitBinarySTL, signedVolume, type ExportMesh } from '~/lib/mesh-export'
import { buildPainted3MF, encodePaintLeaf, encodePaintTree, splitDecals } from '~/lib/mesh-export-3mf'
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
      { colorCount: 4, sourceAxis: 'z-up', repair: false },
    )
    expect(res.palette.length).toBe(2)
    const files = unzipSync(res.bytes)
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', 'Metadata/model_settings.config', '[Content_Types].xml', '_rels/.rels'])
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
      { colorCount: 4, sourceAxis: 'z-up', repair: false },
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
    expect(signedVolume([parseModel(xml)])).toBeGreaterThan(0)
  })

  it('places the model on the plate: centred in XY, resting on Z = 0', () => {
    // Origin-centred cube-ish tetra hanging below the bed, like most game models.
    const inp: ExportMesh = {
      positions: new Float32Array([-5, -5, -20, 5, -5, -20, -5, 5, -20, -5, -5, -10]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    }
    const check = (center: [number, number] | undefined, want: [number, number]) => {
      const m = parseModel(modelXml(buildPainted3MF([inp], { colorCount: 1, sourceAxis: 'z-up', bedCenter: center }).bytes))
      const xs = [], ys = [], zs = []
      for (let i = 0; i < m.positions.length; i += 3) xs.push(m.positions[i]!), ys.push(m.positions[i + 1]!), zs.push(m.positions[i + 2]!)
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(want[0])
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(want[1])
      expect(Math.min(...zs)).toBeCloseTo(0)
    }
    check(undefined, [128, 128])
    check([135.5, 136], [135.5, 136])
  })

  it('omits unreferenced vertices (no NaN from subdividing orphans)', () => {
    // Quad plus two vertices no triangle uses — like spare entries in
    // a BFRES vertex buffer. Loop subdivision used to turn them into
    // NaN, which gave Orca a "nan × nan" bounding box.
    const q = quad()
    const inp: ExportMesh = {
      positions: new Float32Array([...q.positions, 99, 99, 99, 5, 5, 5]),
      indices: q.indices,
    }
    const xml = modelXml(buildPainted3MF([inp], { colorCount: 1, sourceAxis: 'z-up', subdivisionPasses: 1, repair: false }).bytes)
    expect(xml).not.toMatch(/NaN|Infinity/)
    const m = parseModel(xml)
    // Every written vertex is referenced by some triangle.
    expect(new Set(m.indices).size).toBe(m.positions.length / 3)
    expect(m.indices.length / 3).toBe(8)
  })
})

function parseModel(xml: string): ExportMesh {
  const positions = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap((m) => [+m[1]!, +m[2]!, +m[3]!])
  const indices = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap((m) => [+m[1]!, +m[2]!, +m[3]!])
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

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

describe('decals', () => {
  // A red (vertex-coloured) quad with a decal quad 0.1 above it whose
  // texture is a blue dot (left texel) on transparency (right texel).
  const withDecal = (): ExportMesh => ({
    positions: new Float32Array([
      0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
      0, 0, 0.1, 10, 0, 0.1, 10, 10, 0.1, 0, 10, 0.1,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    uvs: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1]),
    colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    colorStride: 3,
    colorSpace: 'srgb',
    materials: [{ texture: null, useVertexColors: true }, { texture: tex([0, 0, 255, 255, 0, 0, 0, 0], 2, 1), decal: true }],
    triangleMaterials: [0, 0, 1, 1],
  })

  it('pulls decal triangles out of the geometry', () => {
    const { meshes, decals } = splitDecals([withDecal()])
    expect(decals).toHaveLength(2)
    expect(meshes[0]!.indices.length).toBe(6)
    expect([...meshes[0]!.triangleMaterials!]).toEqual([0, 0])
  })

  it('paints opaque decal texels onto the surface beneath', () => {
    const { meshes, decals } = splitDecals([withDecal()])
    const res = buildPainted3MF(meshes, { colorCount: 4, sourceAxis: 'z-up', repair: false, decals })
    // Red skin plus the blue decal; no black from transparent texels.
    expect(res.palette.map((c) => c.join(','))).toEqual(expect.arrayContaining(['255,0,0', '0,0,255']))
    expect(res.palette.some((c) => c[0] + c[1] + c[2] < 30)).toBe(false)
    const xml = modelXml(res.bytes)
    expect(xml.match(/<triangle /g)?.length).toBe(2)
    expect(paints(xml).some(Boolean)).toBe(true)
  })
})

describe('3MF metadata', () => {
  it('names the object and plate, and embeds custom metadata', () => {
    const res = buildPainted3MF([{ ...quad(), materials: [{ texture: null, baseColor: [10, 20, 30] }] }], {
      colorCount: 1,
      sourceAxis: 'z-up',
      repair: false,
      title: 'CLOUD_Walk_f0012',
      metadata: { SourceFile: 'Final Fantasy VII (USA).pbp', Pose: 'CLOUD · Walk, frame 12', CreationDate: '2026-10-10' },
    })
    const files = unzipSync(res.bytes)
    const xml = strFromU8(files['3D/3dmodel.model']!)
    expect(xml).toContain('xmlns:nx="')
    expect(xml).toContain('<metadata name="nx:SourceFile">Final Fantasy VII (USA).pbp</metadata>')
    expect(xml).toContain('<metadata name="nx:Pose">CLOUD · Walk, frame 12</metadata>')
    expect(xml).toContain('<metadata name="CreationDate">2026-10-10</metadata>')
    expect(xml).toContain('<object id="1" type="model" name="CLOUD_Walk_f0012">')
    const settings = strFromU8(files['Metadata/model_settings.config']!)
    expect(settings).toContain('<metadata key="name" value="CLOUD_Walk_f0012"/>')
    expect(settings).toContain('<metadata key="plater_name" value="CLOUD_Walk_f0012"/>')
  })
})
