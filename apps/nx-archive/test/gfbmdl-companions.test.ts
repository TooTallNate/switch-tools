import { describe, expect, it } from 'vitest'

import type { Node } from '~/lib/archive'
import { folderPak, siblingVariantAnimations } from '~/lib/gfbmdl-view'

const file = (name: string): Node => ({ id: name, name, kind: 'file', isContainer: false, blob: async () => new Blob([]) })
const dir = (name: string, kids: Node[], kind = 'directory'): Node => ({
  id: name,
  name,
  kind,
  isContainer: true,
  getChildren: async () => kids,
})

/** A trainer pak: model + textures, plus `anm/` when `anims`. */
const pak = (name: string, anims: string[] = []): Node =>
  dir(
    name,
    [
      file(`${name.split('_').slice(0, 2).join('_')}.gfbmdl`),
      file('body_col.bntx'),
      ...(anims.length ? [dir('anm', anims.map(file))] : []),
    ],
    'gfpak',
  )

describe('siblingVariantAnimations', () => {
  const base = pak('tr0029_00_elitem.gfpak', ['ba0001_wait01_loop.gfbanm', 'tr0029_00.gfbanmcfg'])
  const variant = pak('tr0029_01_elitem.gfpak')
  const reskin = pak('tr0087_00_gostaff.gfpak')
  const rig = pak('tr0071_00_clerkm.gfpak', ['fi0001_wait01_loop.gfbanm'])
  const other = pak('tr0030_00_lass.gfpak', ['lass.gfbanm'])
  const tr = dir('tr', [base, variant, reskin, rig, other])

  it("borrows the base variant's animations", async () => {
    const files = await siblingVariantAnimations(variant, tr, [])
    expect(files.map((f) => f.name)).toEqual(['ba0001_wait01_loop.gfbanm', 'tr0029_00.gfbanmcfg'])
  })

  it('falls back to ids named by the textures (reskins)', async () => {
    expect((await siblingVariantAnimations(reskin, tr, [])).length).toBe(0)
    const files = await siblingVariantAnimations(reskin, tr, ['tr0071'])
    expect(files.map((f) => f.name)).toEqual(['fi0001_wait01_loop.gfbanm'])
  })

  it('never takes another character', async () => {
    expect((await siblingVariantAnimations(variant, dir('tr', [variant, other]), [])).length).toBe(0)
  })
})

describe('folderPak', () => {
  it("finds a field model pak's area textures next to its folder", async () => {
    const areaPak = dir('area01.gfpak', [file('rock01_com.bntx')], 'gfpak')
    const area = dir('area01', [dir('road023_00.gfpak', [file('road023_00.gfbmdl')], 'gfpak')])
    const field = dir('field', [area, areaPak, dir('area02.gfpak', [], 'gfpak')])
    expect(await folderPak(area, field)).toEqual([areaPak])
    expect(await folderPak(dir('area03', []), field)).toEqual([])
  })
})
