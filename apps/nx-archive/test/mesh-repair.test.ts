import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { signedVolume, weldByPosition, type IndexedMesh } from '~/lib/mesh-export'
import { buildPainted3MF } from '~/lib/mesh-export-3mf'
import { countOpenEdges, earClip, repairForPrinting } from '~/lib/mesh-repair'

const H = 0.1

/** Open hemisphere (dome, no bottom) of radius r, outward-facing. */
function dome(r = 1, rings = 6, segs = 12): IndexedMesh {
  const pos: number[] = [0, r, 0] // pole
  for (let i = 1; i <= rings; i++) {
    const phi = (i / rings) * (Math.PI / 2)
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * Math.PI * 2
      pos.push(r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th))
    }
  }
  const idx: number[] = []
  const v = (i: number, j: number) => (i === 0 ? 0 : 1 + (i - 1) * segs + (j % segs))
  for (let j = 0; j < segs; j++) idx.push(v(0, 0), v(1, j + 1), v(1, j))
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      idx.push(v(i, j), v(i, j + 1), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i + 1, j))
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

/** Every face duplicated with reversed winding (game-style double-sided). */
function doubleSided(m: IndexedMesh): IndexedMesh {
  const rev: number[] = []
  for (let i = 0; i < m.indices.length; i += 3) rev.push(m.indices[i]!, m.indices[i + 2]!, m.indices[i + 1]!)
  return { positions: m.positions, indices: new Uint32Array([...m.indices, ...rev]) }
}

function cube(o: [number, number, number] = [0, 0, 0], s = 1): IndexedMesh {
  const p: number[] = []
  for (const [x, y, z] of [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]) p.push(o[0] + x! * s, o[1] + y! * s, o[2] + z! * s)
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return { positions: new Float32Array(p), indices: new Uint32Array(f.flat()) }
}

const isCollapsed = (bary: Float32Array, t: number) => {
  const o = t * 9
  return [0, 1, 2].every((i) => bary[o + i] === bary[o + 3 + i] && bary[o + i] === bary[o + 6 + i])
}

describe('repairForPrinting', () => {
  it('turns a double-sided open dome (Deku Tree canopy) into a capped solid', () => {
    const m = weldByPosition(doubleSided(dome()))
    const r = repairForPrinting(m, { minThickness: H })
    expect(r.report.duplicatesRemoved).toBe(m.indices.length / 6)
    expect(r.report.holesFilled).toBe(1)
    expect(r.report.openEdgesAfter).toBe(0)
    expect(countOpenEdges(r)).toBe(0)
    // ≈ hemisphere volume (2/3 π r³), slightly less for the polygonal dome.
    const v = signedVolume([r]) / 6
    expect(v).toBeGreaterThan(0.85 * (2 / 3) * Math.PI)
    expect(v).toBeLessThan((2 / 3) * Math.PI)
  })

  it('thickens an open flat sheet instead of capping it', () => {
    const sheet: IndexedMesh = {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    }
    const r = repairForPrinting(sheet, { minThickness: H })
    expect(r.report.sheetsThickened).toBe(1)
    expect(countOpenEdges(r)).toBe(0)
    expect(signedVolume([r]) / 6).toBeCloseTo(4 * H, 5)
    // Side walls take the colour where they attach.
    const walls = Array.from({ length: r.indices.length / 3 }, (_, t) => t).filter((t) => isCollapsed(r.bary, t))
    expect(walls).toHaveLength(8)
  })

  it('reduces a two-layer, differently triangulated card to one thickened layer', () => {
    // Front: 2 triangles; back: 4 triangles around a centre vertex. Closed, zero volume.
    const card: IndexedMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 1, 0, 4, 2, 1, 4, 3, 2, 4, 0, 3]),
    }
    expect(countOpenEdges(card)).toBe(0) // Orca would accept it…
    const r = repairForPrinting(card, { minThickness: H })
    expect(r.report.zeroThicknessSplit).toBe(1)
    expect(countOpenEdges(r)).toBe(0)
    expect(Math.abs(signedVolume([r]) / 6)).toBeCloseTo(1 * H, 5) // …but now it has volume
  })

  it('fixes inconsistent winding and inside-out parts', () => {
    const c = cube()
    const idx = c.indices.slice()
    ;[idx[1], idx[2]] = [idx[2]!, idx[1]!] // flip one face
    const r = repairForPrinting({ positions: c.positions, indices: idx }, { minThickness: H })
    expect(countOpenEdges(r)).toBe(0)
    expect(signedVolume([r]) / 6).toBeCloseTo(1, 5)

    const inside = Uint32Array.from(c.indices)
    for (let i = 0; i < inside.length; i += 3) [inside[i + 1], inside[i + 2]] = [inside[i + 2]!, inside[i + 1]!]
    const r2 = repairForPrinting({ positions: c.positions, indices: inside }, { minThickness: H })
    expect(r2.report.partsFlipped).toBe(1)
    expect(signedVolume([r2]) / 6).toBeCloseTo(1, 5)
  })

  it('cuts edges shared by more than two faces', () => {
    // Two cubes touching along one edge → that edge has 4 faces after welding.
    const a = cube([0, 0, 0]), b = cube([1, 1, 0])
    const m = weldByPosition({
      positions: new Float32Array([...a.positions, ...b.positions]),
      indices: new Uint32Array([...a.indices, ...Array.from(b.indices, (i) => i + 8)]),
    })
    expect(countOpenEdges(m)).toBeGreaterThanOrEqual(0)
    const r = repairForPrinting(m, { minThickness: H })
    expect(r.report.nonManifoldEdgesCut).toBe(1)
    expect(countOpenEdges(r)).toBe(0)
    expect(signedVolume([r]) / 6).toBeCloseTo(2, 5)
  })

  it('leaves already-good meshes alone', () => {
    const c = cube()
    const r = repairForPrinting(c, { minThickness: H })
    expect(r.indices).toEqual(c.indices)
    expect(r.report).toMatchObject({ holesFilled: 0, sheetsThickened: 0, partsFlipped: 0, duplicatesRemoved: 0 })
  })

  it('keeps provenance: original faces keep their source, caps collapse onto an edge', () => {
    const m = dome()
    const nOrig = m.indices.length / 3
    const r = repairForPrinting(m, { minThickness: H })
    for (let t = 0; t < nOrig; t++) expect(r.src[t]).toBe(t)
    for (let t = nOrig; t < r.indices.length / 3; t++) {
      expect(isCollapsed(r.bary, t)).toBe(true)
      expect(r.src[t]).toBeLessThan(nOrig)
    }
  })
})

describe('earClip', () => {
  it('triangulates a concave polygon', () => {
    // L-shape, area 3.
    const xy = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2]
    const tris = earClip(xy)!
    expect(tris).toHaveLength((6 - 2) * 3)
    let area = 0
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i]!, tris[i + 1]!, tris[i + 2]!]
      area += ((xy[b * 2]! - xy[a * 2]!) * (xy[c * 2 + 1]! - xy[a * 2 + 1]!) - (xy[b * 2 + 1]! - xy[a * 2 + 1]!) * (xy[c * 2]! - xy[a * 2]!)) / 2
    }
    expect(area).toBeCloseTo(3)
  })
})

describe('3MF export', () => {
  it('writes watertight geometry for a double-sided open dome, with smoothing', () => {
    const res = buildPainted3MF([doubleSided(dome())], { colorCount: 1, sourceAxis: 'y-up', subdivisionPasses: 1 })
    expect(res.repair?.openEdgesAfter).toBe(0)
    const xml = strFromU8(unzipSync(res.bytes)['3D/3dmodel.model']!)
    const positions = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap((m) => [+m[1]!, +m[2]!, +m[3]!])
    const indices = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].flatMap((m) => [+m[1]!, +m[2]!, +m[3]!])
    const out = { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
    expect(countOpenEdges(out)).toBe(0)
    expect(signedVolume([out])).toBeGreaterThan(0)
  })
})
