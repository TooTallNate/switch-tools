import { describe, expect, it } from 'vitest'

import { leafFormatOf } from '../src/lib/archive'
import { previewKindForNode } from '../src/lib/preview'

const blob = (bytes: number[], size = 64) => {
  const b = new Uint8Array(size)
  b.set(bytes)
  return new Blob([b])
}

describe('leafFormatOf', () => {
  it('recognises AAMP, Havok and BYML by magic', async () => {
    expect(await leafFormatOf(blob([0x41, 0x41, 0x4d, 0x50, 2, 0, 0, 0]))).toBe('aamp')
    expect(await leafFormatOf(blob([0x57, 0xe0, 0xe0, 0x57, 0x10, 0xc0, 0xc0, 0x10]))).toBe('havok')
    // "YB" v2, key table 0x10, no value table, root 0x20
    expect(await leafFormatOf(blob([0x59, 0x42, 2, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0]))).toBe('byml')
  })

  it('rejects text that merely starts with BY or YB', async () => {
    expect(await leafFormatOf(blob([...new TextEncoder().encode('BYE BYE everyone, see you')]))).toBeNull()
    expect(await leafFormatOf(blob([0x59, 0x42, 2, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0]))).toBeNull()
  })

  it('recognises BotW terrain tiles by name and exact size only', async () => {
    expect(await leafFormatOf(new Blob([new Uint8Array(256 * 256 * 2)]), '5000000000.hght')).toBe('uking-terrain')
    expect(await leafFormatOf(new Blob([new Uint8Array(64 * 64 * 8)]), '580000C0A0.water.extm')).toBe('uking-terrain')
    expect(await leafFormatOf(new Blob([new Uint8Array(1000)]), 'paint.mate')).toBeNull()
    expect(await leafFormatOf(blob([...new TextEncoder().encode('TSCB')]))).toBe('tscb')
  })

  it('routes tagged leaves to their previews', () => {
    const node = (leafFormat: string) => ({ id: 'x', name: 'Foo.bxml', kind: 'file' as const, isContainer: false, meta: { leafFormat } })
    expect(previewKindForNode(node('aamp'))).toBe('aamp-tree')
    expect(previewKindForNode(node('byml'))).toBe('byaml-tree')
    expect(previewKindForNode(node('havok'))).toBe('havok-info')
    expect(previewKindForNode(node('uking-terrain'))).toBe('terrain-tile')
    expect(previewKindForNode(node('tscb'))).toBe('tscb-info')
  })
})
