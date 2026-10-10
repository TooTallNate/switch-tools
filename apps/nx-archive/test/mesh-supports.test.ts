import { describe, expect, it } from 'vitest'

import { signedVolume, type ExportMesh } from '~/lib/mesh-export'
import { countOpenEdges } from '~/lib/mesh-repair'
import { addStructuralSupports, planSupports } from '~/lib/mesh-supports'

/** Axis-aligned closed cube (12 triangles), outward-facing, from `min` with edge `size`. */
function cube(min: [number, number, number], size: number, color: [number, number, number] = [255, 0, 0]): ExportMesh {
  const [x, y, z] = min
  const s = size
  const positions = new Float32Array([
    x, y, z, x + s, y, z, x + s, y + s, z, x, y + s, z,
    x, y, z + s, x + s, y, z + s, x + s, y + s, z + s, x, y + s, z + s,
  ])
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
  ])
  return { positions, indices, materials: [{ texture: null, baseColor: color }] }
}

describe('structural supports', () => {
  it('leaves a single part alone', () => {
    expect(planSupports([cube([0, 0, 0], 10)], { radiusMm: 1 }).report).toMatchObject({ parts: 1, struts: 0 })
  })

  it('struts a floating part to the body', () => {
    const body = cube([0, 0, 0], 20)
    const flame = cube([25, 0, 0], 4, [0, 0, 255])
    const { report, struts } = planSupports([body, flame], { radiusMm: 1 })
    expect(report).toMatchObject({ parts: 2, floating: 1, weak: 0, struts: 1 })
    // The strut spans the 5 mm gap (x 20 → 25), reaching into both parts.
    const [s] = struts
    const xs = [s.from[0], s.to[0]].sort((a, b) => a - b)
    expect(xs[0]).toBeLessThan(20)
    expect(xs[1]).toBeGreaterThan(25)
    // Coloured like the part it leaves from.
    expect(s.color).toEqual([0, 0, 255])
  })

  it('does not strut parts that overlap', () => {
    const body = cube([0, 0, 0], 20)
    // Sunk 3 mm into the body: plenty of contact.
    const block = cube([17, 2, 2], 6)
    expect(planSupports([body, block], { radiusMm: 1 }).report).toMatchObject({ parts: 2, struts: 0 })
  })

  it('braces parts that touch only at a corner', () => {
    const body = cube([0, 0, 0], 10)
    const spike = cube([10, 10, 10], 3) // shares one corner
    expect(planSupports([body, spike], { radiusMm: 1 }).report).toMatchObject({ parts: 2, weak: 1, struts: 1 })
  })

  it('adds closed, outward-facing strut meshes', () => {
    const { meshes, report } = addStructuralSupports([cube([0, 0, 0], 20), cube([25, 0, 0], 4)], { radiusMm: 1 })
    expect(report.struts).toBe(1)
    expect(meshes).toHaveLength(3)
    const strut = meshes[2]
    expect(countOpenEdges(strut)).toBe(0)
    expect(signedVolume([strut])).toBeGreaterThan(0)
    expect(strut.materials?.[0].baseColor).toEqual([255, 0, 0])
  })
})
