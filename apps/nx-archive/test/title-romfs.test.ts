import { describe, expect, it } from 'vitest'

import type { Node } from '../src/lib/archive'
import { registerRomfs, romfsFileFor, romfsFor } from '../src/lib/title-romfs'

function dir(id: string, name: string, kids: (parent: string) => Node[]): Node {
  return { id, name, kind: 'directory', isContainer: true, getChildren: async () => kids(id) }
}
function file(parent: string, name: string): Node {
  return { id: `${parent}/${name}`, name, kind: 'file', isContainer: false, blob: async () => new Blob([name]) }
}

describe('title RomFS lookup', () => {
  const romfs = dir('/game.nsp/a.nca/section1 (RomFS)', 'section1 (RomFS)', (p) => [
    dir(`${p}/Sound`, 'Sound', (q) => [dir(`${q}/Stream`, 'Stream', (r) => [file(r, 'Track.bfstm')])]),
  ])
  registerRomfs(romfs)

  it('finds the RomFS a nested node belongs to', () => {
    expect(romfsFor(`${romfs.id}/Pack/x.sarc/y.bars/Track.bfstp`)).toBe(romfs)
    expect(romfsFor('/other.nsp/b.nca/section0 (PFS0)/main')).toBeNull()
  })

  it('falls back to a RomFS in the same package', () => {
    expect(romfsFor('/game.nsp/update.nca/section1 (RomFS)/x')).toBe(romfs)
  })

  it('resolves a path relative to the RomFS root', async () => {
    const n = await romfsFileFor(`${romfs.id}/Pack/y.bars/Track.bfstp`, 'Sound/Stream/Track.bfstm')
    expect(n?.name).toBe('Track.bfstm')
    expect(await romfsFileFor(`${romfs.id}/z`, 'Sound/Stream/Missing.bfstm')).toBeNull()
  })
})
