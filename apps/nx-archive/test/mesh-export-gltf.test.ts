import { unzlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import type { ExportMesh, ExportTexture } from '~/lib/mesh-export'
import { splitDecals } from '~/lib/mesh-export-3mf'
import { buildTexturedGlb } from '~/lib/mesh-export-gltf'

// ---------------------------------------------------------------------------
// Minimal GLB reader (JSON + accessors + filter-0 PNGs, as we write them)
// ---------------------------------------------------------------------------

interface Gltf {
  json: any
  bin: Uint8Array
}

function parseGlb(bytes: Uint8Array): Gltf {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(dv.getUint32(0, true)).toBe(0x46546c67)
  expect(dv.getUint32(4, true)).toBe(2)
  expect(dv.getUint32(8, true)).toBe(bytes.length)
  const jsonLen = dv.getUint32(12, true)
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a)
  expect(jsonLen % 4).toBe(0)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)))
  let bin = new Uint8Array(0)
  if (20 + jsonLen < bytes.length) {
    const o = 20 + jsonLen
    expect(dv.getUint32(o + 4, true)).toBe(0x004e4942)
    bin = bytes.subarray(o + 8, o + 8 + dv.getUint32(o, true))
  }
  return { json, bin }
}

function view(g: Gltf, i: number): Uint8Array {
  const bv = g.json.bufferViews[i]
  return g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
}

function accessor(g: Gltf, i: number): number[] {
  const a = g.json.accessors[i]
  const v = view(g, a.bufferView)
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type as 'SCALAR']!
  const copy = v.slice()
  const arr = a.componentType === 5126 ? new Float32Array(copy.buffer) : new Uint32Array(copy.buffer)
  return Array.from(arr.subarray(0, a.count * comps))
}

function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let o = 8
  let width = 0, height = 0
  const idat: Uint8Array[] = []
  while (o < png.length) {
    const len = dv.getUint32(o)
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8))
    const data = png.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
    } else if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0))
  let p = 0
  for (const d of idat) { joined.set(d, p); p += d.length }
  const raw = unzlibSync(joined)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0)
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4)
  }
  return { width, height, rgba }
}

/** Texel at UV (top-left origin, nearest) of a primitive's base-colour image. */
function texel(g: Gltf, material: number, u: number, v: number): number[] {
  const tex = g.json.textures[g.json.materials[material].pbrMetallicRoughness.baseColorTexture.index]
  const img = decodePng(view(g, g.json.images[tex.source].bufferView))
  const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)))
  const y = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)))
  return Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3))
}

function image(g: Gltf, material: number) {
  const tex = g.json.textures[g.json.materials[material].pbrMetallicRoughness.baseColorTexture.index]
  return { ...decodePng(view(g, g.json.images[tex.source].bufferView)), sampler: g.json.samplers[tex.sampler] }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 2 × 2 RGBA texture: red, green / blue, white (row 0 first). */
function quadTexture(patch: Partial<ExportTexture> = {}): ExportTexture {
  return {
    pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    width: 2,
    height: 2,
    wrapS: 'repeat',
    wrapT: 'repeat',
    ...patch,
  }
}

/** A unit square in the XY plane (two triangles), with UVs. */
function square(patch: Partial<ExportMesh> = {}): ExportMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    ...patch,
  }
}

const noRepair = { repair: false as const }

describe('buildTexturedGlb', () => {
  it('writes a valid GLB that keeps the original texture and UVs', () => {
    const r = buildTexturedGlb([square({ materials: [{ texture: quadTexture() }] })], { ...noRepair, objectName: 'Sq', metadata: { SourceFile: 'x.bin' } })
    const g = parseGlb(r.bytes)
    expect(g.json.asset).toMatchObject({ version: '2.0', generator: 'nx-archive', extras: { SourceFile: 'x.bin' } })
    expect(g.json.nodes[0].name).toBe('Sq')
    expect(r.textureCount).toBe(1)
    expect(r.atlas).toBeNull()
    const prim = g.json.meshes[0].primitives[0]
    const img = image(g, prim.material)
    expect([img.width, img.height]).toEqual([2, 2])
    expect(Array.from(img.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255])
    expect(img.sampler).toEqual({ wrapS: 10497, wrapT: 10497 })
    // UVs are carried through unchanged.
    const uvs = accessor(g, prim.attributes.TEXCOORD_0)
    expect(uvs.every((v) => v === 0 || v === 1)).toBe(true)
    expect(accessor(g, prim.indices)).toHaveLength(6)
  })

  it('stands the model on Y = 0, centred, in the input units (mm)', () => {
    const r = buildTexturedGlb([square({ positions: new Float32Array([10, 5, 0, 30, 5, 0, 30, 25, 0, 10, 25, 0]), materials: [{ texture: quadTexture() }] })], noRepair)
    const g = parseGlb(r.bytes)
    const a = g.json.accessors[g.json.meshes[0].primitives[0].attributes.POSITION]
    expect(a.min).toEqual([-10, 0, 0])
    expect(a.max).toEqual([10, 20, 0])
  })

  it('rotates Z-up sources to glTF Y-up', () => {
    const r = buildTexturedGlb([square({ materials: [{ texture: quadTexture() }] })], { ...noRepair, sourceAxis: 'z-up' })
    const g = parseGlb(r.bytes)
    const a = g.json.accessors[g.json.meshes[0].primitives[0].attributes.POSITION]
    // Source Y (0..1) becomes depth on -Z; the square lies flat at Y = 0.
    expect(a.min[1]).toBe(0)
    expect(a.max[1]).toBe(0)
    expect(a.max[2] - a.min[2]).toBeCloseTo(1)
  })

  it('flips flipY textures into glTF orientation', () => {
    const r = buildTexturedGlb([square({ materials: [{ texture: quadTexture({ flipY: true }) }] })], noRepair)
    const g = parseGlb(r.bytes)
    const img = image(g, 0)
    // Bottom source row (blue, white) comes first.
    expect(Array.from(img.rgba.subarray(0, 4))).toEqual([0, 0, 255, 255])
  })

  it('unrolls mirrored-repeat textures into a 2× tile with halved UVs', () => {
    const mesh = square({ uvs: new Float32Array([0, 2, 2, 2, 2, 0, 0, 0]), materials: [{ texture: quadTexture({ wrapS: 'mirror' }) }] })
    const g = parseGlb(buildTexturedGlb([mesh], noRepair).bytes)
    const prim = g.json.meshes[0].primitives[0]
    const img = image(g, prim.material)
    expect([img.width, img.height]).toEqual([4, 2])
    expect(img.sampler.wrapS).toBe(10497)
    // Row 0: red, green, green, red.
    const row = Array.from({ length: 4 }, (_, x) => img.rgba[x * 4 + 1]! > 0 ? 'g' : 'r')
    expect(row).toEqual(['r', 'g', 'g', 'r'])
    const uvs = accessor(g, prim.attributes.TEXCOORD_0)
    expect(Math.max(...uvs.filter((_, i) => i % 2 === 0))).toBe(1)
    expect(Math.max(...uvs.filter((_, i) => i % 2 === 1))).toBe(2)
  })

  it('bleeds opaque colour into cut-out texels and marks the material MASK', () => {
    const tex = quadTexture()
    ;(tex.pixels as Uint8Array).set([9, 9, 9, 0], 12) // white texel → transparent junk
    const g = parseGlb(buildTexturedGlb([square({ materials: [{ texture: tex }] })], noRepair).bytes)
    expect(g.json.materials[0]).toMatchObject({ alphaMode: 'MASK', alphaCutoff: 0.5 })
    const img = image(g, 0)
    expect(img.rgba[15]).toBe(0)
    expect(Array.from(img.rgba.subarray(12, 15))).not.toEqual([9, 9, 9])
  })

  it('bakes vertex-colour gradients into the atlas', () => {
    const mesh: ExportMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      colorSpace: 'srgb',
      materials: [{ texture: null, useVertexColors: true }],
    }
    const r = buildTexturedGlb([mesh], noRepair)
    expect(r.atlas).not.toBeNull()
    const g = parseGlb(r.bytes)
    const prim = g.json.meshes[0].primitives[0]
    expect(g.json.materials[prim.material].name).toBe('baked_colors')
    const uvs = accessor(g, prim.attributes.TEXCOORD_0)
    const pos = accessor(g, prim.attributes.POSITION)
    const idx = accessor(g, prim.indices)
    // Each corner's UV, nudged towards the centroid, lands on its own colour.
    const cu = (uvs[idx[0]! * 2]! + uvs[idx[1]! * 2]! + uvs[idx[2]! * 2]!) / 3
    const cv = (uvs[idx[0]! * 2 + 1]! + uvs[idx[1]! * 2 + 1]! + uvs[idx[2]! * 2 + 1]!) / 3
    for (const i of idx) {
      const u = uvs[i * 2]! + (cu - uvs[i * 2]!) * 0.15
      const v = uvs[i * 2 + 1]! + (cv - uvs[i * 2 + 1]!) * 0.15
      const c = texel(g, prim.material, u, v)
      const x = pos[i * 3]!, y = pos[i * 3 + 1]!
      const expected = x > 0.25 ? 1 : y > 0.5 ? 2 : 0 // red at origin, green at +X, blue at +Y
      expect(c.indexOf(Math.max(...c))).toBe(expected)
    }
  })

  it('shares one swatch per flat colour', () => {
    const mesh: ExportMesh = {
      ...square(),
      uvs: null,
      materials: [{ texture: null, baseColor: [10, 200, 30] }, { texture: null, baseColor: [200, 10, 30] }],
      triangleMaterials: [0, 1],
    }
    const twice: ExportMesh = { ...mesh, positions: mesh.positions.map((v, i) => (i % 3 === 0 ? v + 2 : v)) }
    const r = buildTexturedGlb([mesh, twice], noRepair)
    const g = parseGlb(r.bytes)
    const prim = g.json.meshes[0].primitives[0]
    const uvs = accessor(g, prim.attributes.TEXCOORD_0)
    const distinct = new Set<string>()
    for (let i = 0; i < uvs.length; i += 2) distinct.add(`${uvs[i]},${uvs[i + 1]}`)
    expect(distinct.size).toBe(2)
    const colors = [...distinct].map((k) => texel(g, prim.material, +k.split(',')[0]!, +k.split(',')[1]!))
    expect(colors).toContainEqual([10, 200, 30])
    expect(colors).toContainEqual([200, 10, 30])
  })

  it('paints decals onto the surface beneath and drops their geometry', () => {
    const decalTex: ExportTexture = { pixels: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, wrapS: 'clamp', wrapT: 'clamp' }
    const mesh: ExportMesh = {
      // A white square, plus a small black decal floating just above its centre.
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.4, 0.4, 0.01, 0.6, 0.4, 0.01, 0.5, 0.6, 0.01]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]),
      uvs: new Float32Array(14).fill(0.5),
      materials: [{ texture: null, baseColor: [255, 255, 255] }, { texture: decalTex, decal: true }],
      triangleMaterials: [0, 0, 1],
    }
    const split = splitDecals([mesh])
    const r = buildTexturedGlb(split.meshes, { ...noRepair, decals: split.decals })
    expect(r.triangleCount).toBe(2)
    const g = parseGlb(r.bytes)
    const prim = g.json.meshes[0].primitives[0]
    const img = image(g, prim.material)
    let black = 0, white = 0
    for (let i = 0; i < img.rgba.length; i += 4) {
      if (img.rgba[i] === 0) black++
      if (img.rgba[i] === 255) white++
    }
    expect(black).toBeGreaterThan(0)
    expect(white).toBeGreaterThan(0)
  })

  it('bakes clamped textures sampled outside [0, 1]', () => {
    const mesh = square({ uvs: new Float32Array([0, 1.5, 1.5, 1.5, 1.5, 0, 0, 0]), materials: [{ texture: quadTexture({ wrapS: 'clamp', wrapT: 'clamp' }) }] })
    const r = buildTexturedGlb([mesh], noRepair)
    expect(r.atlas).not.toBeNull()
    expect(r.textureCount).toBe(0)
  })

  it('orients inside-out input outward', () => {
    const tet = (flip: boolean): ExportMesh => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array(flip ? [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2] : [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
      materials: [{ texture: null, baseColor: [128, 128, 128] }],
    })
    const vol = (m: ExportMesh) => {
      const g = parseGlb(buildTexturedGlb([m], noRepair).bytes)
      const prim = g.json.meshes[0].primitives[0]
      const p = accessor(g, prim.attributes.POSITION), idx = accessor(g, prim.indices)
      let v = 0
      for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3]
        v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
      }
      return v
    }
    expect(vol(tet(false))).toBeGreaterThan(0)
    expect(vol(tet(true))).toBeGreaterThan(0)
  })
})
