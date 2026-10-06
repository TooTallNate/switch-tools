import { describe, expect, it } from 'vitest'
import { decodeUnityAnimationClip, unityPathHash } from '../src/index.js'

/** Encode streamed-clip frames into the `uint[]` Unity serialises. */
function streamedData(frames: { time: number; keys: { index: number; coeff: [number, number, number, number] }[] }[]): number[] {
	const words: number[] = []
	const f32 = (x: number) => {
		const dv = new DataView(new ArrayBuffer(4))
		dv.setFloat32(0, x, true)
		words.push(dv.getUint32(0, true))
	}
	for (const f of frames) {
		f32(f.time)
		words.push(f.keys.length)
		for (const k of f.keys) {
			words.push(k.index)
			k.coeff.forEach(f32)
		}
	}
	return words
}

const FLT_MAX = 3.4028234663852886e38

function clip() {
	// Curves: 0–3 streamed rotation (x,y,z,w), 4–6 dense position, 7–9 constant scale.
	return {
		m_Name: 'wave',
		m_SampleRate: 60,
		m_MuscleClip: {
			m_StartTime: 0,
			m_StopTime: 1,
			m_LoopTime: 1,
			m_Clip: {
				data: {
					m_StreamedClip: {
						curveCount: 4,
						data: streamedData([
							{ time: -FLT_MAX, keys: [0, 1, 2, 3].map((index) => ({ index, coeff: [0, 0, 0, index === 3 ? 1 : 0] as [number, number, number, number] })) },
							// Curve 0 ramps linearly from 0 at t=0 (slope 0.5); others hold.
							{ time: 0, keys: [{ index: 0, coeff: [0, 0, 0.5, 0] }] },
							{ time: FLT_MAX, keys: [] },
						]),
					},
					m_DenseClip: {
						m_FrameCount: 2,
						m_CurveCount: 3,
						m_SampleRate: 1,
						m_BeginTime: 0,
						m_SampleArray: [0, 0, 0, 2, 4, 6],
					},
					m_ConstantClip: { data: [1, 2, 3] },
				},
			},
		},
		m_ClipBindingConstant: {
			genericBindings: [
				{ path: unityPathHash('Hips/Arm'), attribute: 2, typeID: 4 },
				{ path: unityPathHash('Hips/Arm'), attribute: 1, typeID: 4 },
				{ path: unityPathHash('Hips'), attribute: 3, typeID: 4 },
			],
		},
	}
}

describe('decodeUnityAnimationClip', () => {
	it('maps bindings onto streamed → dense → constant curves', () => {
		const c = decodeUnityAnimationClip(clip())
		expect(c).toMatchObject({ name: 'wave', duration: 1, loop: true, curveCount: 10 })
		expect(c.tracks.map((t) => [t.property, t.curves])).toEqual([
			['rotation', [0, 1, 2, 3]],
			['position', [4, 5, 6]],
			['scale', [7, 8, 9]],
		])
		expect(c.tracks[0]!.pathHash).toBe(unityPathHash('Hips/Arm'))
	})

	it('evaluates streamed polynomials, dense lerps and constants', () => {
		const c = decodeUnityAnimationClip(clip())
		const at = (t: number) => [...c.sample(t)].map((x) => Math.round(x * 1000) / 1000)
		expect(at(0)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 2, 3])
		expect(at(0.5)).toEqual([0.25, 0, 0, 1, 1, 2, 3, 1, 2, 3])
		// Clamped to the clip's length.
		expect(at(5)).toEqual([0.5, 0, 0, 1, 2, 4, 6, 1, 2, 3])
	})
})

describe('unityPathHash', () => {
	it('is CRC32 of the path', () => {
		expect(unityPathHash('abc')).toBe(0x352441c2)
		expect(unityPathHash('')).toBe(0)
	})
})
