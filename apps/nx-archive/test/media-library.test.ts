import { describe, expect, it } from 'vitest'

import type { Node } from '~/lib/archive'
import { classifyNode, titleFor } from '~/lib/media/classify'
import { gapReportMarkdown, summarize } from '~/lib/media/gaps'
import { scanMedia } from '~/lib/media/scanner'

/** Minimal synthetic tree nodes. */
function file(parent: string, name: string, opts: Partial<Node> & { bytes?: Uint8Array } = {}): Node {
  const bytes = opts.bytes ?? new Uint8Array(64).fill(0xab)
  return {
    id: `${parent}/${name}`,
    name,
    kind: 'file',
    isContainer: false,
    size: bytes.length,
    blob: async () => new Blob([bytes as BlobPart]),
    ...opts,
  }
}

function dir(parent: string, name: string, kids: (id: string) => Node[], opts: Partial<Node> = {}): Node {
  const id = `${parent}/${name}`
  return {
    id,
    name,
    kind: 'directory',
    isContainer: true,
    getChildren: async () => kids(id),
    ...opts,
  }
}

const base = { fileName: 'game.bin', fileSize: 1, platform: 'TEST' }

describe('classifyNode', () => {
  it('maps preview kinds onto media kinds', () => {
    const k = (name: string, path = name) => {
      const c = classifyNode(file('/r', name), path)
      return c.type === 'media' ? c.kind : c.type
    }
    expect(k('a.bntx')).toBe('image')
    expect(k('a.gfbmdl')).toBe('model')
    expect(k('a.bfwav')).toBe('sound')
    expect(k('a.bfstm')).toBe('music')
    expect(k('a.ogg', 'sound/bgm/field01.ogg')).toBe('music')
    expect(k('a.mp4')).toBe('video')
    expect(k('a.bfotf')).toBe('font')
    expect(k('a.msbt')).toBe('known')
    expect(k('a.xyzzy')).toBe('unknown')
  })

  it('classifies Unity objects by class', () => {
    const mesh = file('/r', 'Body.mesh.bin', { kind: 'unity-object', meta: { unityClass: 'Mesh' } })
    const c = classifyNode(mesh, 'Body.mesh.bin')
    expect(c.type === 'media' && c.kind).toBe('model')
    expect(titleFor(mesh, ['r', 'Body.mesh.bin'])).toBe('Body')
  })

  it('prefixes meaningless leaf names with their parent', () => {
    expect(titleFor(file('/r/char01', 'model'), ['r', 'char01', 'model'])).toBe('char01 · model')
  })
})

describe('scanMedia', () => {
  // Fresh tree per test: scanning caches expansions on the nodes.
  const makeTree = () => dir('', 'game.bin', (root) => [
    file(root, 'title.bntx'),
    file(root, 'bgm_title.bfstm'),
    file(root, 'mystery.xyz', { bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]) }),
    file(root, 'empty.xyz', { bytes: new Uint8Array(0) }),
    // A model container: its images are the model's textures.
    dir(root, 'pm0025_00.gfpak', (pak) => [file(pak, 'pm0025_00.gfbmdl'), file(pak, 'pm0025_00_BodyA_col.bntx')], {
      kind: 'gfpak',
      format: 'GFPAK',
    }),
    // FF7 battle model: the `aa` skeleton owns its `<id>xx` siblings.
    dir(root, 'battle.lgp', (lgp) => [
      file(lgp, 'rtaa', { meta: { ff7BattleSkeleton: true } }),
      file(lgp, 'rtam', { meta: { ff7P: true } }),
      file(lgp, 'rtac', { meta: { ff7Tex: true } }),
    ]),
    dir(root, 'huge.ncz', () => [], { kind: 'nca', format: 'NCZ', size: 5e9 }),
    dir(root, 'broken.sarc', () => Promise.reject(new Error('bad header')) as never),
  ])

  it('lists media, merges parts, and records gaps', async () => {
    const index = await scanMedia(makeTree(), base)
    const byTitle = new Map(index.items.map((i) => [i.title, i]))

    expect(byTitle.get('title')?.kind).toBe('image')
    expect(byTitle.get('bgm_title')?.kind).toBe('music')

    const model = byTitle.get('pm0025_00')!
    expect(model.kind).toBe('model')
    expect(byTitle.get('pm0025_00_BodyA_col')?.partOf).toBe(model.id)
    expect(model.parts).toContain(byTitle.get('pm0025_00_BodyA_col')!.id)

    const battle = byTitle.get('rtaa')!
    expect(battle.kind).toBe('model')
    expect(byTitle.get('rtam')?.partOf).toBe(battle.id)
    expect(byTitle.get('rtac')?.partOf).toBe(battle.id)

    // Gaps: unknown files (zero-byte placeholders excluded), skipped NCZ, broken container.
    expect(index.unknown).toEqual([
      expect.objectContaining({ ext: 'xyz', count: 1, magics: ['de ad be ef 01 02 03 04'] }),
    ])
    expect(index.skipped.map((s) => s.path)).toEqual(['huge.ncz'])
    expect(index.errors).toEqual([{ path: 'broken.sarc', message: 'bad header' }])
    expect(index.complete).toBe(true)

    const s = summarize(index)
    expect(s.counts.model).toBe(2)
    expect(s.parts).toBe(3)
  })

  it('expands skipped containers on request', async () => {
    const index = await scanMedia(makeTree(), base, { include: new Set(['/game.bin/huge.ncz']) })
    expect(index.skipped).toEqual([])
  })

  it('stops when aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const index = await scanMedia(makeTree(), base, { signal: ac.signal })
    expect(index.complete).toBe(false)
  })

  it('renders a gap report', async () => {
    const md = gapReportMarkdown(await scanMedia(makeTree(), base))
    expect(md).toContain('# nx-archive media coverage: game.bin')
    expect(md).toContain('| `.xyz` | 1 |')
    expect(md).toContain('`de ad be ef 01 02 03 04`')
    expect(md).toContain('broken.sarc')
    expect(md).toContain('huge.ncz')
  })
})

describe('duplicate folding', () => {
  const png = (fill: number) => new Uint8Array(200).fill(fill)
  const tree = () =>
    dir('', 'game.bin', (id) => [
      dir(id, 'Disc 1', (d) => [file(d, 'logo.png', { bytes: png(1) }), file(d, 'title.png', { bytes: png(2) })]),
      dir(id, 'Disc 2', (d) => [file(d, 'logo.png', { bytes: png(1) }), file(d, 'title.png', { bytes: png(3) })]),
      dir(id, 'Disc 3', (d) => [file(d, 'logo.png', { bytes: png(1) })]),
    ])

  it('folds identical copies into one item listing every location', async () => {
    const index = await scanMedia(tree(), base)
    const logos = index.items.filter((i) => i.title === 'logo')
    expect(logos).toHaveLength(1)
    expect(logos[0]!.path).toBe('Disc 1/logo.png')
    expect(logos[0]!.duplicates?.map((d) => d.path)).toEqual(['Disc 2/logo.png', 'Disc 3/logo.png'])
    expect(index.stats.duplicates).toBe(2)
  })

  it('keeps files with the same name but different content apart', async () => {
    const index = await scanMedia(tree(), base)
    expect(index.items.filter((i) => i.title === 'title')).toHaveLength(2)
  })

  it('uses content keys instead of reading decoded files', async () => {
    let reads = 0
    const keyed = (d: string, key: string) =>
      file(d, 'boom.wav', {
        meta: { contentKey: key },
        blob: async () => {
          reads++
          return new Blob([png(9) as BlobPart])
        },
      })
    const root = dir('', 'game.bin', (id) => [
      dir(id, 'a.map', (d) => [keyed(d, 'snd:boom')]),
      dir(id, 'b.map', (d) => [keyed(d, 'snd:boom')]),
    ])
    const index = await scanMedia(root, base)
    expect(index.items.filter((i) => i.title === 'boom')).toHaveLength(1)
    expect(reads).toBe(0)
  })

  it('can be turned off', async () => {
    const index = await scanMedia(tree(), base, { dedupe: false })
    expect(index.items.filter((i) => i.title === 'logo')).toHaveLength(3)
  })
})
