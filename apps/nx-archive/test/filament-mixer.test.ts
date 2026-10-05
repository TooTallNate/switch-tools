import { describe, expect, it } from 'vitest'

import { filamentMixerBlend, filamentMixerLerp } from '~/lib/filament-mixer'

describe('filamentMixerLerp', () => {
  // Golden values from compiling Snapmaker Orca's
  // src/libslic3r/filament_mixer_model.h and calling filament_mixer::lerp
  // (t passed as C++ float, hence Math.fround).
  const cases: Array<[[number, number, number], [number, number, number], number, [number, number, number]]> = [
    [[0, 33, 133], [252, 211, 0], 0.5, [47, 141, 56]], // documented blue + yellow → green
    [[8, 171, 251], [249, 237, 61], 0.5, [104, 226, 124]], // FS cyan + yellow
    [[217, 59, 144], [8, 171, 251], 0.333333, [150, 78, 168]], // FS magenta + cyan
    [[249, 237, 61], [145, 153, 164], 0.666667, [173, 190, 119]], // FS yellow + gray
    [[255, 0, 0], [0, 0, 255], 0.25, [176, 0, 60]],
  ]
  for (const [a, b, t, want] of cases) {
    it(`mixes ${a} + ${b} @ ${t}`, () => {
      expect(filamentMixerLerp(a, b, Math.fround(t))).toEqual(want)
    })
  }

  it('returns endpoints exactly at t = 0 / 1', () => {
    expect(filamentMixerLerp([1, 2, 3], [4, 5, 6], 0)).toEqual([1, 2, 3])
    expect(filamentMixerLerp([1, 2, 3], [4, 5, 6], 1)).toEqual([4, 5, 6])
  })

  it('blends weighted lists pairwise', () => {
    expect(
      filamentMixerBlend([
        { rgb: [0, 33, 133], weight: 1 },
        { rgb: [252, 211, 0], weight: 1 },
      ]),
    ).toEqual([47, 141, 56])
  })
})
