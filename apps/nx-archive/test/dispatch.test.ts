import { describe, expect, it } from 'vitest'

import {
  CONTAINER_FORMAT_REGISTRY,
  FILE_EXT_FORMATS,
  buildRootNode,
  type ArchiveContext,
} from '~/lib/archive'

/**
 * Guards the invariant that used to be maintained by hand — and wasn't.
 *
 * `archive.ts` dispatches from three directions: the top-level `buildRootNode`
 * (by format label), and `childNodeFor` (by extension, then by sniffed magic).
 * These were once three independent lists, so adding a format meant updating all
 * three and nothing complained if you missed one. The failure mode was silent:
 * a file would open from one direction and look like an opaque blob from
 * another. It happened four times, and a measurement of the old code found 13
 * live asymmetries.
 *
 * All three now read `CONTAINER_FORMAT_REGISTRY`. These tests assert that the
 * registry stays internally consistent and that the label table agrees with it,
 * so the drift cannot silently return.
 */

const ctx: ArchiveContext = { getKeys: () => null, requestKeys: () => {} }

describe('container format registry', () => {
  it('is not empty and has unique format labels', () => {
    expect(CONTAINER_FORMAT_REGISTRY.length).toBeGreaterThan(30)
    const labels = CONTAINER_FORMAT_REGISTRY.map((d) => d.format)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('claims each extension exactly once', () => {
    // Two formats claiming one extension would make dispatch order-dependent,
    // which is precisely the kind of ambiguity this table exists to remove.
    const seen = new Map<string, string>()
    for (const def of CONTAINER_FORMAT_REGISTRY) {
      for (const ext of def.extensions) {
        expect(seen.has(ext), `.${ext} claimed by ${seen.get(ext)} and ${def.format}`).toBe(false)
        seen.set(ext, def.format)
      }
    }
  })

  it('claims each sniff key exactly once', () => {
    const seen = new Map<string, string>()
    for (const def of CONTAINER_FORMAT_REGISTRY) {
      for (const key of def.sniff ?? []) {
        expect(seen.has(key), `${key} claimed by ${seen.get(key)} and ${def.format}`).toBe(false)
        seen.set(key, def.format)
      }
    }
  })

  it('uses lowercase, dot-free extensions', () => {
    for (const def of CONTAINER_FORMAT_REGISTRY) {
      for (const ext of def.extensions) {
        expect(ext, `${def.format}`).toBe(ext.toLowerCase())
        expect(ext.startsWith('.'), `${def.format}: .${ext}`).toBe(false)
      }
    }
  })

  it('maps every registered extension to its own label in FILE_EXT_FORMATS', () => {
    // This is the asymmetry that broke `.arc`: the extension resolved to a
    // different label than the one dispatch was registered under, so the
    // top-level path never reached the handler.
    const problems: string[] = []
    for (const def of CONTAINER_FORMAT_REGISTRY) {
      for (const ext of def.extensions) {
        const label = FILE_EXT_FORMATS[ext]
        if (label !== def.format) {
          problems.push(`.${ext}: FILE_EXT_FORMATS says ${label ?? '(missing)'}, registry says ${def.format}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('reaches the same handler from the label path and the extension path', () => {
    // The core parity check. Every registered extension must resolve to the
    // format whose label the top-level switch would have used.
    for (const def of CONTAINER_FORMAT_REGISTRY) {
      for (const ext of def.extensions) {
        expect(FILE_EXT_FORMATS[ext], `.${ext}`).toBe(def.format)
      }
    }
  })
})

describe('buildRootNode dispatch', () => {
  it('routes by extension for a registered format', async () => {
    // A tiny RARC: enough header for the parser to accept, opened by name.
    const bytes = new Uint8Array(0x60)
    bytes.set([0x52, 0x41, 0x52, 0x43], 0) // 'RARC'
    const node = await buildRootNode(new Blob([bytes]), 'x.rarc', ctx)
    expect(node.format).toBe('RARC')
  })

  it('falls back to a downloadable leaf for unknown data', async () => {
    const node = await buildRootNode(new Blob([new Uint8Array(64)]), 'mystery.qqq', ctx)
    expect(node.isContainer).toBeFalsy()
    expect(node.blob).toBeTypeOf('function')
  })

  it('does not throw for any registered extension', async () => {
    // Registered formats must degrade gracefully on junk input rather than
    // throwing out of the dispatcher.
    for (const def of CONTAINER_FORMAT_REGISTRY) {
      for (const ext of def.extensions) {
        const blob = new Blob([new Uint8Array(256)])
        await expect(
          buildRootNode(blob, `probe.${ext}`, ctx),
          `.${ext} (${def.format})`,
        ).resolves.toBeTruthy()
      }
    }
  })
})

describe('.thp is typed by its magic, not its extension', () => {
  /**
   * Melee's 75 `.thp` files are JPEG stills, not video containers. Routing on
   * the extension alone hands them to a player that can never decode them, so
   * the first bytes decide. Sunshine and Double Dash use the same extension for
   * genuine containers, so both paths have to keep working.
   */
  const thpFile = async (bytes: number[]) => {
    const blob = new Blob([new Uint8Array(bytes)])
    const root = await buildRootNode(blob, 'clip.thp', ctx)
    return root
  }

  it('treats a JPEG payload as a still image', async () => {
    // SOI, then a comment segment, as Melee's stills begin.
    const n = await thpFile([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x0b, 0x41, 0x42])
    expect(n.kind).toBe('jpeg-still')
    expect(n.format).toBe('JPEG')
    expect(n.isContainer).toBe(false)
  })

  it('leaves a non-JPEG payload as a video', async () => {
    const n = await thpFile([0x54, 0x48, 0x50, 0x00, 0x00, 0x01, 0x00, 0x00])
    expect(n.kind).toBe('thp')
    expect(n.format).toBe('THP')
  })

  it('does not mistake a truncated file for a JPEG', async () => {
    // Two of the three signature bytes, then nothing.
    const n = await thpFile([0xff, 0xd8])
    expect(n.kind).toBe('thp')
  })
})

describe('MTH dispatch', () => {
  /**
   * A minimal MTH: the fixed 0x40 header plus one 0x20-aligned frame holding a
   * tiny JPEG. Enough to exercise routing without shipping disc data.
   */
  function buildMth(): Uint8Array {
    const jpeg = [
      0xff, 0xd8,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0x00, 0x00, 0x3f, 0x00,
      0x01,
      0xff, 0xd9,
    ]
    const total = Math.ceil((jpeg.length + 4) / 0x20) * 0x20
    const out = new Uint8Array(0x40 + total)
    const v = new DataView(out.buffer)
    out.set([0x4d, 0x54, 0x48, 0x50], 0) // MTHP
    v.setInt16(0x04, 8, false)
    v.setInt32(0x08, 2, false)
    v.setInt32(0x0c, total, false)
    v.setInt32(0x10, 448, false) // width
    v.setInt32(0x14, 336, false) // height
    v.setInt32(0x18, 30, false) // fps
    v.setInt32(0x1c, 1, false) // frame count
    v.setInt32(0x20, 0x40, false) // video offset
    v.setInt32(0x28, total, false) // first frame size
    v.setInt32(0x40, total, false) // next size (loops to itself)
    out.set(new Uint8Array(jpeg), 0x44)
    return out
  }

  it('is registered by extension and by magic alike', () => {
    expect(FILE_EXT_FORMATS.mth).toBe('MTH')
    const entry = CONTAINER_FORMAT_REGISTRY.find((e) => e.format === 'MTH')
    expect(entry).toBeTruthy()
    expect(entry!.extensions).toContain('mth')
    expect(entry!.sniff).toContain('mth')
  })

  it('pairs no audio when the sibling stream is absent', async () => {
    // Named so the pairing table matches, but built standalone: with no
    // siblings there is nothing to attach, and the movie must still open.
    const n = await buildRootNode(new Blob([buildMth()]), 'MvOpen.mth', ctx)
    expect(n.kind).toBe('mth')
    expect(n.meta?.mthAudioBlob).toBeUndefined()
    // The intended stream is still recorded, so the preview can say why.
    expect(n.meta?.mthAudioMissing).toBe('opening.hps')
  })

  it('records no pairing for a movie outside the table', async () => {
    const n = await buildRootNode(new Blob([buildMth()]), 'MvUnknown.mth', ctx)
    expect(n.meta?.mthAudioMissing).toBeUndefined()
    expect(n.meta?.mthAudioName).toBeUndefined()
  })

  it('opens as a leaf so the preview pane offers a player', async () => {
    const n = await buildRootNode(new Blob([buildMth()]), 'movie.mth', ctx)
    expect(n.format).toBe('MTH')
    expect(n.kind).toBe('mth')
    // Containers are excluded from previews, so this must not be one.
    expect(n.isContainer).toBe(false)
  })
})
