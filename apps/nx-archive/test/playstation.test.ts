import { describe, expect, it } from 'vitest'

import { buildRootNode, type ArchiveContext, type Node } from '~/lib/archive'
import { classifyNode } from '~/lib/media/classify'
import { previewKindForNode } from '~/lib/preview'

const ctx = { getKeys: () => null, requestKeys: () => {} } as unknown as ArchiveContext
const RAW = 2352
const XA_FORM1 = 0x0800
const XA_FORM2 = 0x1000
const XA_INTERLEAVED = 0x2000
const XA_CDDA = 0x4000

/**
 * A raw (2352-byte sector) PlayStation disc:
 *  - VOICE.XA  : XA audio, channels 0 and 1
 *  - MOVIE.STR : one 16×16 MDEC frame
 *  - TRACK.DA  : CD-DA
 *  - ICON.TIM  : 2×2 16 bpp TIM
 */
function psxDisc(): Uint8Array {
  const sectors = 40
  const img = new Uint8Array(sectors * RAW)
  for (let s = 0; s < sectors; s++) {
    const o = s * RAW
    img.set([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0], o)
    img[o + 15] = 2
    img[o + 18] = img[o + 22] = 0x08
  }
  const user = (s: number) => img.subarray(s * RAW + 24, s * RAW + 24 + 2048)
  const rec = (lba: number, size: number, name: string, dir: boolean, xa?: number) => {
    const pad = name.length % 2 === 0 ? 1 : 0
    const len = 33 + name.length + pad + (xa === undefined ? 0 : 14)
    const b = new Uint8Array(len + (len & 1))
    const dv = new DataView(b.buffer)
    b[0] = b.length
    dv.setUint32(2, lba, true)
    dv.setUint32(10, size, true)
    b[25] = dir ? 2 : 0
    b[32] = name.length
    for (let i = 0; i < name.length; i++) b[33 + i] = name.charCodeAt(i)
    if (xa !== undefined) {
      const su = 33 + name.length + pad
      dv.setUint16(su + 4, xa, false)
      b[su + 6] = 0x58
      b[su + 7] = 0x41
      b[su + 8] = 1
    }
    return b
  }
  const pvd = user(16)
  pvd.set([1, 0x43, 0x44, 0x30, 0x30, 0x31, 1])
  pvd.set(rec(18, 2048, '\0', true), 156)
  const root = user(18)
  let p = 0
  for (const r of [
    rec(18, 2048, '\0', true),
    rec(23, 2048, 'ICON.TIM;1', false, XA_FORM1),
    rec(24, 2 * 2048, 'MOVIE.STR;1', false, XA_FORM2 | XA_INTERLEAVED),
    rec(30, 2 * 2048, 'TRACK.DA;1', false, XA_CDDA),
    rec(20, 3 * 2048, 'VOICE.XA;1', false, XA_FORM2 | XA_INTERLEAVED),
  ]) {
    root.set(r, p)
    p += r.length
  }
  // XA audio sectors 20–22: channels 0, 1, 0 (mono, all-zero samples).
  ;[0, 1, 0].forEach((ch, i) => {
    const o = (20 + i) * RAW
    img[o + 16] = img[o + 20] = 1
    img[o + 17] = img[o + 21] = ch
    img[o + 18] = img[o + 22] = 0x64
    img[o + 19] = img[o + 23] = 0x00
  })
  // TIM: 2×2, 16 bpp, red.
  const tim = user(23)
  const tv = new DataView(tim.buffer, tim.byteOffset)
  tv.setUint32(0, 0x10, true)
  tv.setUint32(4, 2, true)
  tv.setUint32(8, 12 + 8, true)
  tv.setUint16(16, 2, true)
  tv.setUint16(18, 2, true)
  for (let i = 0; i < 4; i++) tv.setUint16(20 + i * 2, 0x001f, true)
  // STR: one video sector (16×16 frame, DC only) followed by padding.
  const str = user(24)
  const sv = new DataView(str.buffer, str.byteOffset)
  str.set([0x60, 0x01, 0x01, 0x80])
  sv.setUint16(6, 1, true)
  sv.setUint32(8, 1, true)
  sv.setUint32(12, 64, true)
  sv.setUint16(16, 16, true)
  sv.setUint16(18, 16, true)
  sv.setUint16(32 + 2, 0x3800, true)
  sv.setUint16(32 + 4, 1, true)
  sv.setUint16(32 + 6, 2, true)
  // Six blocks of DC 0 + EOB ("0000000000" + "10"), MSB-first in LE words.
  const bits = '000000000010'.repeat(6).padEnd(128, '0')
  for (let w = 0; w < 8; w++) sv.setUint16(32 + 8 + w * 2, parseInt(bits.slice(w * 16, w * 16 + 16), 2), true)
  return img
}

async function walk(node: Node, out: Node[] = []): Promise<Node[]> {
  if (node.getChildren) for (const c of await node.getChildren()) await walk(c, out)
  else out.push(node)
  return out
}

describe('PlayStation discs', () => {
  it('opens raw .bin images and surfaces XA, STR, CD-DA and TIM media', async () => {
    const root = await buildRootNode(new Blob([psxDisc() as BlobPart]), 'game.bin', ctx)
    expect(root.kind).toBe('cd-image')
    const leaves = await walk(root)
    expect(leaves.map((n) => n.name)).toEqual(['ICON.TIM', 'MOVIE.STR', 'TRACK.DA.wav', 'VOICE_ch00.wav', 'VOICE_ch01.wav'])
    const by = (name: string) => leaves.find((n) => n.name === name)!
    expect(previewKindForNode(by('MOVIE.STR'))).toBe('psx-str')
    expect(classifyNode(by('MOVIE.STR'), 'MOVIE.STR')?.kind).toBe('video')
    expect(classifyNode(by('ICON.TIM'), 'ICON.TIM')?.kind).toBe('image')
    expect(classifyNode(by('VOICE_ch01.wav'), 'VOICE.XA/VOICE_ch01.wav')?.kind).toMatch(/sound|music/)
    // Channel 0 spans two sectors: 2 × 18 groups × 224 mono samples.
    const wav = new Uint8Array(await (await by('VOICE_ch00.wav').blob!()).arrayBuffer())
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(2 * 4032 * 2)
    const cdda = new Uint8Array(await (await by('TRACK.DA.wav').blob!()).arrayBuffer())
    expect(cdda.length).toBe(44 + 2 * RAW)
  })
})

describe('Final Fantasy VII PSX models', () => {
  it('only claims .LZS / .BCX files that parse as FF7 models', async () => {
    const { detectFf7PsxModel } = await import('~/lib/ff7-psx')
    // An LZSS-stored stream (all literals) of zeros: not a model.
    const junk = new Uint8Array(4 + 9 * 8)
    new DataView(junk.buffer).setUint32(0, 9 * 8, true)
    for (let i = 0; i < 8; i++) junk[4 + i * 9] = 0xff
    expect(detectFf7PsxModel('STAGE00.LZS', junk)).toBeNull()
    expect(detectFf7PsxModel('readme.txt', junk)).toBeNull()
  })
})
