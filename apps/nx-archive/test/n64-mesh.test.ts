import { describe, expect, it } from 'vitest'
import type { F3dexMaterial } from '@tootallnate/f3dex'
import { decodeF3dexTextures, f3dexMaterialColors } from '~/lib/n64-mesh'

const material = (over: Partial<F3dexMaterial>): F3dexMaterial => ({
  textureAddress: null,
  textureOffset: null,
  format: 0,
  size: 2,
  formatName: 'RGBA16',
  width: 1,
  height: 1,
  tlutAddress: null,
  tlutOffset: null,
  wrapS: 'wrap',
  wrapT: 'wrap',
  lit: true,
  primColor: null,
  envColor: null,
  combine: null,
  lightColor: [0, 255, 0],
  externalTexture: false,
  ...over,
})

// G_CC_MODULATERGBA: TEXEL0 · SHADE, alpha TEXEL0 · SHADE.
const MODULATE: [number, number] = [0x127e24, 0xfffffbfd]
// G_CC_SHADE.
const SHADE: [number, number] = [0xffffff, 0xfffe793c]

describe('N64 combiner baking (Super Mario 64)', () => {
  it('bakes a lit material’s light colour into its texture', () => {
    // One white RGBA16 texel (0xFFFF).
    const bytes = new Uint8Array([0xff, 0xff])
    const mesh = { materials: [material({ textureAddress: 0x05000000, textureOffset: 0, combine: MODULATE })] }
    const [tex] = decodeF3dexTextures(bytes, mesh, { tint: true, combiner: true })
    expect(Array.from(tex!.pixels)).toEqual([0, 255, 0, 255])
  })

  it('gives untextured lit materials a flat colour for the viewer to light', () => {
    const mesh = { materials: [material({ combine: SHADE }), material({ lit: false, combine: SHADE })] }
    expect(f3dexMaterialColors(mesh, [null, null])).toEqual([[0, 1, 0], null])
  })
})
