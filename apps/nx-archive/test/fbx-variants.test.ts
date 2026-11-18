import { describe, expect, it } from 'vitest'
import { fbxVariants } from '~/lib/fbx-model'

describe('FBX variants', () => {
  it('turns a second form number on a part into a variant swapping that part', () => {
    const meshes = ['pm0025_00_BodySkin', 'pm0025_00_SippoSkin', 'pm0025_01_SippoSkin'].map((name) => ({ name }))
    const v = fbxVariants({ meshes } as never, 'pm0025_00_Rig.fbx')
    expect(v).toEqual([
      { label: 'Default', meshes: [0, 1] },
      { label: 'Female', meshes: [0, 2] },
    ])
  })

  it('keeps every mesh when names carry no form numbers', () => {
    expect(fbxVariants({ meshes: [{ name: 'Body' }, { name: 'Hat' }] } as never, 'hero.fbx')).toEqual([{ label: 'Default', meshes: [0, 1] }])
  })
})
