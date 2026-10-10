import { inflateSync } from 'node:zlib'
import { deswizzle } from '@tootallnate/bntx'
import { describe, expect, it } from 'vitest'

import { buildRootNode, type ArchiveContext, type Node } from '~/lib/archive'
import { classifyNode } from '~/lib/media/classify'
import { isMk64Rom } from '~/lib/mk64-karts'
import { encodePng } from '~/lib/png'
import { previewKindForNode } from '~/lib/preview'
import { decodeUeMip } from '~/lib/uasset-texture'

const ctx = { getKeys: () => null, requestKeys: () => {} } as unknown as ArchiveContext

/** Minimal uncompressed (PC layout) Halo map with one 2×2 X8R8G8B8 bitmap tag. */
function haloMap(): Uint8Array {
  const IDX = 0x1000
  const BASE = 0x40440000
  const b = new Uint8Array(IDX + 0x400)
  const v = new DataView(b.buffer)
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i) }
  const addr = (off: number) => BASE + (off - IDX)
  ascii(0, 'daeh')
  v.setUint32(4, 7, true) // PC: stored raw
  v.setUint32(8, b.length, true)
  v.setUint32(0x10, IDX, true)
  v.setUint32(0x14, 0x400, true)
  ascii(0x20, 'tiny')
  ascii(0x7fc, 'toof')
  // Pixels at 0x800: BGRA red, green, blue, white.
  b.set([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255], 0x800)
  v.setUint32(IDX, addr(IDX + 0x28), true)
  v.setUint32(IDX + 0x0c, 1, true)
  const e = IDX + 0x28
  v.setUint32(e, 0x6269746d, true) // 'bitm'
  v.setUint32(e + 4, 0xffffffff, true)
  v.setUint32(e + 8, 0xffffffff, true)
  ascii(IDX + 0x100, 'ui\\logo')
  v.setUint32(e + 0x10, addr(IDX + 0x100), true)
  v.setUint32(e + 0x14, addr(IDX + 0x200), true)
  v.setUint32(IDX + 0x200 + 0x60, 1, true)
  v.setUint32(IDX + 0x200 + 0x64, addr(IDX + 0x280), true)
  const bd = IDX + 0x280
  v.setUint16(bd + 4, 2, true)
  v.setUint16(bd + 6, 2, true)
  v.setUint16(bd + 8, 1, true)
  v.setUint16(bd + 0x0c, 10, true) // x8r8g8b8, linear
  v.setUint32(bd + 0x18, 0x800, true)
  v.setUint32(bd + 0x1c, 16, true)
  return b
}

async function walk(node: Node, out: Node[] = []): Promise<Node[]> {
  if (node.getChildren) for (const c of await node.getChildren()) await walk(c, out)
  else out.push(node)
  return out
}

describe('Halo cache files', () => {
  it('routes `.map` by its `daeh` magic and exposes bitmaps as PNGs', async () => {
    const root = await buildRootNode(new Blob([haloMap() as BlobPart]), 'tiny.map', ctx)
    expect(root.kind).toBe('halo-map')
    const leaves = await walk(root)
    expect(leaves.map((n) => n.id)).toEqual(['/tiny.map/ui/logo.png'])
    const [png] = leaves
    expect(classifyNode(png, 'ui/logo.png')?.kind).toBe('image')
    const bytes = new Uint8Array(await (await png.blob!()).arrayBuffer())
    expect([...bytes.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
  })

  it('leaves other `.map` files (FF7/FF8 fields) alone', async () => {
    const root = await buildRootNode(new Blob([new Uint8Array(4096)]), 'bgroom_1.map', ctx)
    expect(root.isContainer).toBeFalsy()
    expect(previewKindForNode(root)).toBe('ff8-field-scene')
  })
})

describe('encodePng', () => {
  it('writes a valid RGBA PNG', async () => {
    const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 0xff)
    const png = await encodePng(3, 2, rgba)
    const dv = new DataView(png.buffer, png.byteOffset)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect([dv.getUint32(16), dv.getUint32(20), png[24], png[25]]).toEqual([3, 2, 8, 6])
    const idatLen = dv.getUint32(33)
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT')
    const raw = inflateSync(png.subarray(41, 41 + idatLen))
    // Each scanline: filter byte 0 + 12 pixel bytes.
    expect(raw.length).toBe(2 * 13)
    expect([...raw.subarray(1, 13)]).toEqual([...rgba.subarray(0, 12)])
    expect([...raw.subarray(14, 26)]).toEqual([...rgba.subarray(12, 24)])
  })
})

describe('decodeUeMip Tegra auto-detection', () => {
  const W = 64
  const H = 64
  // Smooth BGRA gradient: R = x*4, G = y*4.
  const linear = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      linear.set([0, y * 4, x * 4, 255], o)
    }
  }
  /** Inverse of `deswizzle` for 4-byte texels, via its index permutation. */
  function swizzle(src: Uint8Array, blockHeight: number): Uint8Array {
    const ids = new Uint8Array(W * H * 4)
    const iv = new DataView(ids.buffer)
    for (let i = 0; i < W * H; i++) iv.setUint32(i * 4, i, true)
    const perm = deswizzle({ width: W, height: H, blkWidth: 1, blkHeight: 1, bytesPerBlock: 4, data: ids, blockHeight })
    const pv = new DataView(perm.buffer)
    const out = new Uint8Array(src.length)
    for (let j = 0; j < W * H; j++) {
      const s = pv.getUint32(j * 4, true)
      out.set(src.subarray(j * 4, j * 4 + 4), s * 4)
    }
    return out
  }
  const expected = (() => {
    const px = new Uint8Array(linear.length)
    for (let i = 0; i < linear.length; i += 4) px.set([linear[i + 2], linear[i + 1], linear[i], 255], i)
    return px
  })()

  it('keeps linear textures as-is', async () => {
    const mip = await decodeUeMip('PF_B8G8R8A8', W, H, linear)
    expect(Buffer.from(mip.pixels).equals(Buffer.from(expected))).toBe(true)
  })

  it.each([8, 4, 2])('deswizzles block-linear textures (block height %i)', async (bh) => {
    const mip = await decodeUeMip('PF_B8G8R8A8', W, H, swizzle(linear, bh))
    expect(Buffer.from(mip.pixels).equals(Buffer.from(expected))).toBe(true)
  })
})

describe('Mario Kart 64 kart sprites', () => {
  it('only matches the MK64 USA layout', () => {
    expect(isMk64Rom(new Uint8Array(0x700000))).toBe(false)
  })
})
