import { describe, expect, it } from 'vitest'

import { parseUnityFs } from '~/lib/unityfs'

/**
 * Minimal UnityFS v7 bundle with uncompressed storage blocks. The
 * blocks-info table is stored uncompressed too (compression type 0),
 * directly after the 16-byte-aligned header.
 */
function buildUnityFs(blockSizes: number[], nodes: { path: string; offset: number; size: number }[]): {
  bytes: Uint8Array
  stream: Uint8Array
} {
  const total = blockSizes.reduce((a, b) => a + b, 0)
  const stream = new Uint8Array(total)
  for (let i = 0; i < total; i++) stream[i] = (i * 7 + (i >> 8)) & 0xff
  const enc = new TextEncoder()
  const info: number[] = [...new Array(16).fill(0)]
  const u32 = (v: number) => info.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  const u16 = (v: number) => info.push((v >>> 8) & 0xff, v & 0xff)
  const i64 = (v: number) => (u32(Math.floor(v / 2 ** 32)), u32(v >>> 0))
  u32(blockSizes.length)
  for (const s of blockSizes) (u32(s), u32(s), u16(0))
  u32(nodes.length)
  for (const n of nodes) (i64(n.offset), i64(n.size), u32(4), info.push(...enc.encode(n.path), 0))
  const header: number[] = [...enc.encode('UnityFS'), 0]
  const hu32 = (v: number) => header.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  hu32(7)
  header.push(...enc.encode('5.x.x'), 0, ...enc.encode('2021.3.15f1'), 0)
  const sizePos = header.length
  hu32(0), hu32(0) // size (i64), patched below
  hu32(info.length), hu32(info.length), hu32(0) // blocksInfo sizes, flags (no compression, info after header)
  while (header.length % 16) header.push(0)
  const bytes = new Uint8Array(header.length + info.length + total)
  bytes.set(header, 0)
  bytes.set(info, header.length)
  bytes.set(stream, header.length + info.length)
  new DataView(bytes.buffer).setUint32(sizePos + 4, bytes.length)
  return { bytes, stream }
}

describe('UnityFS random access', () => {
  const blocks = [1000, 1000, 1000, 500]
  const { bytes, stream } = buildUnityFs(blocks, [
    { path: 'CAB-a', offset: 0, size: 900 },
    { path: 'CAB-a.resS', offset: 900, size: 2400 }, // spans blocks 0–3
    { path: 'tail', offset: 3300, size: 200 },
  ])

  it('reads entries that span storage blocks', async () => {
    const { nodes } = await parseUnityFs(new Blob([bytes as BlobPart]))
    expect(nodes.map((n) => n.path)).toEqual(['CAB-a', 'CAB-a.resS', 'tail'])
    for (const n of nodes) {
      const got = new Uint8Array(await n.data.arrayBuffer())
      expect(got).toEqual(stream.subarray(n.offset, n.offset + n.size))
    }
  })

  it('slices and streams without materialising the whole entry', async () => {
    const res = (await parseUnityFs(new Blob([bytes as BlobPart]))).nodes[1]!
    const part = res.data.slice(50, 1250).slice(10, 1100) // nested slices across a block edge
    expect(part.size).toBe(1090)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(stream.subarray(960, 2050))
    const chunks: Uint8Array[] = []
    const reader = res.data.stream().getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const joined = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0))
    let o = 0
    for (const c of chunks) (joined.set(c, o), (o += c.length))
    expect(joined).toEqual(stream.subarray(900, 3300))
  })

  it('only reads the storage blocks a read touches', async () => {
    const reads: [number, number][] = []
    const base = new Blob([bytes as BlobPart])
    const tracked = {
      size: base.size,
      slice: (a: number, b: number) => {
        reads.push([a, b])
        return base.slice(a, b)
      },
    } as unknown as Blob
    const { nodes } = await parseUnityFs(tracked)
    reads.length = 0
    await nodes[2]!.data.slice(0, 4).arrayBuffer() // inside the last block
    expect(reads).toHaveLength(1)
    expect(reads[0]![1] - reads[0]![0]).toBe(500)
  })
})
