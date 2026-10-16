import { describe, expect, it } from 'vitest'

import type { ExportMesh } from '~/lib/mesh-export'
import { sampleSource, triSourceOf } from '~/lib/mesh-export-3mf'
import { findSeeThroughLids } from '~/lib/mesh-see-through'

/**
 * A body plate with a square pit (an eye socket): walls face into the
 * pit, a black pupil at the bottom faces up, and a culled lid over the
 * opening faces *down* into the pit, as Let's Go eye lids do. A wing
 * (a lone culled plane) floats off to the side.
 */
function eyeScene(): { mesh: ExportMesh; lidTris: number; wingTris: [number, number] } {
  const P: number[] = []
  const I: number[] = []
  const M: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[], mat: number) => {
    const o = P.length / 3
    P.push(...a, ...b, ...c, ...d)
    I.push(o, o + 1, o + 2, o, o + 2, o + 3)
    M.push(mat, mat)
  }
  // Pit: x, y in [-1, 1], z in [-1, 0]. Materials: 0 wall (white), 1 pupil (black), 2 lid (culled), 3 body.
  quad([-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], 1) // bottom, facing +z
  quad([-1, -1, 0], [1, -1, 0], [1, -1, -1], [-1, -1, -1], 0) // y = -1, facing +y
  quad([1, 1, 0], [-1, 1, 0], [-1, 1, -1], [1, 1, -1], 0) // y = +1, facing -y
  quad([-1, 1, 0], [-1, -1, 0], [-1, -1, -1], [-1, 1, -1], 0) // x = -1, facing +x
  quad([1, -1, 0], [1, 1, 0], [1, 1, -1], [1, -1, -1], 0) // x = +1, facing -x
  // Lid at z = 0 facing -z (into the pit), 4 × 4 cells.
  const lidStart = M.length
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const x0 = -1 + i * 0.5, x1 = x0 + 0.5, y0 = -1 + j * 0.5, y1 = y0 + 0.5
      quad([x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0], 2)
    }
  const lidTris = M.length - lidStart
  // Body plate far below, so the model is big enough for the cavity reach.
  quad([-20, -20, -6], [-20, 20, -6], [20, 20, -6], [20, -20, -6], 3)
  // Wing: a culled plane off to the side, facing +x.
  const wingStart = M.length
  quad([12, -2, 2], [12, 2, 2], [12, 2, 6], [12, -2, 6], 2)
  const mesh: ExportMesh = {
    positions: Float32Array.from(P),
    indices: Uint32Array.from(I),
    triangleMaterials: Int32Array.from(M),
    materials: [
      { texture: null, baseColor: [240, 240, 240] },
      { texture: null, baseColor: [10, 10, 10] },
      { texture: null, baseColor: [200, 200, 200], backFaceCulled: true },
      { texture: null, baseColor: [230, 150, 60] },
    ],
  }
  return { mesh, lidTris, wingTris: [wingStart, wingStart + 1] }
}

describe('see-through lids', () => {
  it('finds the lid over the pit, not the wing, and paints it with the pupil', () => {
    const { mesh, lidTris, wingTris } = eyeScene()
    const lids = findSeeThroughLids(mesh)
    expect(lids.size).toBe(lidTris)
    for (const w of wingTris) expect(lids.has(w)).toBe(false)
    // Every lid looks straight down into the pit.
    const [first, info] = [...lids][0]!
    expect(info.dir.map((v) => Math.round(v))).toEqual([0, 0, -1])

    const P = mesh.positions
    const I = mesh.indices
    const pos = Float64Array.from([0, 1, 2].flatMap((k) => [...P.subarray(I[first * 3 + k]! * 3, I[first * 3 + k]! * 3 + 3)]))
    const src = triSourceOf(mesh, first)
    src.pos = pos
    src.through = { info, mesh, cache: new Map() }
    const out = new Uint8Array(3)
    sampleSource(src, 1 / 3, 1 / 3, out)
    expect(Array.from(out)).toEqual([10, 10, 10])
  })

  it('leaves models without culled materials alone', () => {
    const { mesh } = eyeScene()
    const plain = { ...mesh, materials: mesh.materials!.map((m) => ({ ...m, backFaceCulled: false })) }
    expect(findSeeThroughLids(plain).size).toBe(0)
  })
})
