import { describe, expect, it } from 'vitest'
import { decodeMsgpack, isRttsMsgpack } from '~/lib/msgpack'

describe('MessagePack', () => {
  it('decodes maps, arrays, strings, numbers and binary', () => {
    // { "a": [1, -1, 300, 1.5, true, null], "b": <bin 2> }
    const bytes = Uint8Array.from([
      0x82, 0xa1, 0x61, 0x96, 0x01, 0xff, 0xcd, 0x01, 0x2c, 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0, 0xc3, 0xc0, 0xa1, 0x62, 0xc4, 0x02, 9, 9,
    ])
    expect(decodeMsgpack(bytes)).toEqual({ a: [1, -1, 300, 1.5, true, null], b: '<2 bytes>' })
  })

  it('spots Bezel rtts files', () => {
    const key = new TextEncoder().encode('rtts_file_format_version')
    expect(isRttsMsgpack(Uint8Array.from([0x84, 0xa0 | key.length, ...key]))).toBe(true)
    expect(isRttsMsgpack(Uint8Array.from([0x84, 0xa3, 0x61, 0x62, 0x63, ...new Uint8Array(16)]))).toBe(false)
  })
})
