import { describe, expect, it } from 'vitest'
import { unityPathHash, type UnityMeshGeometry } from '@tootallnate/unity-asset'

import type { UnityFileContext, UnityObjectRef } from '~/lib/unity-mesh'
import { buildUnityRig, findRigClips, UnityPosePlayer } from '~/lib/unity-rig'

const ptr = (id: bigint) => ({ m_FileID: 0, m_PathID: id })
const obj = (classId: number, pathId: bigint, value: Record<string, unknown>): UnityObjectRef => ({
  classId,
  pathId,
  value: async () => value,
})
const S45 = Math.SQRT1_2

/**
 * Root (GameObject "model") → Arm at Unity (1, 0, 0). One vertex at
 * Unity (2, 0, 0) is fully weighted to Arm. The "raise" clip rotates
 * Arm +90° about Z, which in Unity sends +X to +Y, so the vertex
 * should land at Unity (1, 1, 0) = right-handed (−1, 1, 0).
 */
function fixture(): { file: UnityFileContext; geometry: UnityMeshGeometry; renderer: Record<string, unknown> } {
  const rot = [0, 0, S45, S45] // Unity quaternion (x, y, z, w)
  const clip = {
    m_Name: 'raise',
    m_SampleRate: 30,
    m_MuscleClip: {
      m_StartTime: 0,
      m_StopTime: 1,
      m_LoopTime: 1,
      m_Clip: {
        data: {
          m_StreamedClip: { curveCount: 0, data: [] },
          m_DenseClip: { m_FrameCount: 0, m_CurveCount: 0, m_SampleArray: [] },
          m_ConstantClip: { data: rot },
        },
      },
    },
    m_ClipBindingConstant: {
      genericBindings: [{ path: unityPathHash('Arm'), attribute: 2, typeID: 4 }],
    },
  }
  const objects = [
    obj(1, 1n, { m_Name: 'model' }),
    obj(1, 2n, { m_Name: 'Arm' }),
    obj(4, 10n, { m_GameObject: ptr(1n), m_Father: ptr(0n), m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 } }),
    obj(4, 11n, { m_GameObject: ptr(2n), m_Father: ptr(10n), m_LocalPosition: { x: 1, y: 0, z: 0 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 } }),
    obj(74, 20n, clip),
  ]
  const renderer = { m_GameObject: ptr(1n), m_Bones: [ptr(11n)], m_RootBone: ptr(11n) }
  // Right-handed (post-`toRightHanded`) mesh: vertex at (−2, 0, 0);
  // inverse bind of Arm (at RH (−1, 0, 0)) is a +1 X translation.
  const bind = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1])
  const geometry = {
    name: 'm',
    vertexCount: 1,
    positions: new Float32Array([-2, 0, 0]),
    normals: new Float32Array([-1, 0, 0]),
    uv0: null,
    colors: null,
    indices: new Uint32Array(0),
    subMeshes: [],
    skin: { weights: new Float32Array([1, 0, 0, 0]), indices: new Uint16Array([0, 0, 0, 0]) },
    bindPoses: [bind],
  } satisfies UnityMeshGeometry
  return { file: { key: 'f', objects, resolveExternal: async () => null }, geometry, renderer }
}

const round = (a: Float32Array) => [...a].map((x) => Math.round(x * 1e4) / 1e4 + 0)

describe('UnityPosePlayer', () => {
  it('skins vertices through the bone hierarchy and an animation clip', async () => {
    const { file, geometry, renderer } = fixture()
    const rig = (await buildUnityRig(file, renderer, geometry))!
    expect(rig.bones).toHaveLength(1)
    const clips = await findRigClips(file, rig)
    expect(clips.map((c) => [c.clip.name, c.bound.length])).toEqual([['raise', 1]])

    const player = new UnityPosePlayer(rig, geometry)
    const pos = new Float32Array(3)
    const nrm = new Float32Array(3)
    // Rest pose: the bind pose reproduces the authored vertex.
    player.apply(pos, nrm)
    expect(round(pos)).toEqual([-2, 0, 0])
    // Arm raised 90° about Z.
    player.setLayer(0, clips[0]!, 0.5)
    player.apply(pos, nrm)
    expect(round(pos)).toEqual([-1, 1, 0])
    expect(round(nrm)).toEqual([0, 1, 0])
    // The source arrays stay untouched so re-posing is stable.
    expect([...geometry.positions]).toEqual([-2, 0, 0])
  })
})
