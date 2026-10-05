import { describe, expect, it } from 'vitest'

import {
  findMeshMaterialIds,
  pickAlbedoTexture,
  resolveMeshAlbedoTextures,
  type UnityObjectRef,
} from '~/lib/unity-mesh'

const ptr = (id: bigint, fileId = 0) => ({ m_FileID: fileId, m_PathID: id })
const obj = (classId: number, pathId: bigint, value: Record<string, unknown>): UnityObjectRef => ({
  classId,
  pathId,
  value: async () => value,
})
const tex = (name: string, colorSpace = 1, size = 512) => ({
  m_Name: name,
  m_ColorSpace: colorSpace,
  m_Width: size,
  m_Height: size,
})
const material = (name: string, envs: [string, bigint][]) => ({
  m_Name: name,
  m_SavedProperties: {
    m_TexEnvs: envs.map(([first, id]) => ({ first, second: { m_Texture: ptr(id) } })),
  },
})

describe('pickAlbedoTexture', () => {
  it('prefers conventional property names', () => {
    const c = [
      { property: '_BumpMap', texturePathId: 1n, texture: tex('a') },
      { property: '_MainTex', texturePathId: 2n, texture: tex('b') },
    ]
    expect(pickAlbedoTexture(c)?.texturePathId).toBe(2n)
  })

  it('falls back to texture names for Shader Graph properties', () => {
    // Super Mario RPG: generated property names, role only in the texture name.
    const c = [
      { property: 'FresnelMask', texturePathId: 1n, texture: tex('p0122_frmask') },
      { property: 'Texture2D_2A45DA31', texturePathId: 2n, texture: tex('p0122_nml', 0, 1024) },
      { property: 'Texture2D_380DA1A9', texturePathId: 3n, texture: tex('p0122', 1, 1024) },
      { property: 'Texture2D_7923EF37', texturePathId: 4n, texture: tex('p0122_mass', 0) },
      { property: 'Texture2D_AAAA', texturePathId: 5n, texture: tex('p0122_emm') },
    ]
    expect(pickAlbedoTexture(c)?.texturePathId).toBe(3n)
  })

  it('returns null when every texture is a non-colour map', () => {
    expect(pickAlbedoTexture([{ property: 'X', texturePathId: 1n, texture: tex('foo_nml') }])).toBeNull()
    expect(pickAlbedoTexture([])).toBeNull()
  })
})

describe('material resolution', () => {
  it('follows SkinnedMeshRenderer.m_Mesh → m_Materials → albedo', async () => {
    const objects = [
      obj(137, 10n, { m_Mesh: ptr(1n), m_Materials: [ptr(20n), ptr(21n), ptr(99n, 1)] }),
      obj(21, 20n, material('body', [['_MainTex', 30n]])),
      obj(21, 21n, material('empty', [['_MainTex', 0n]])),
      obj(28, 30n, tex('body_alb')),
    ]
    expect(await findMeshMaterialIds(objects, 1n)).toEqual([20n, 21n, null])
    const r = await resolveMeshAlbedoTextures(objects, 1n)
    expect(r.materialNames).toEqual(['body', 'empty', ''])
    expect(r.textures.map((t) => t?.m_Name ?? null)).toEqual(['body_alb', null, null])
  })

  it('follows MeshFilter → GameObject → MeshRenderer', async () => {
    const objects = [
      obj(33, 10n, { m_GameObject: ptr(5n), m_Mesh: ptr(1n) }),
      obj(23, 11n, { m_GameObject: ptr(6n), m_Materials: [ptr(21n)] }),
      obj(23, 12n, { m_GameObject: ptr(5n), m_Materials: [ptr(20n)] }),
    ]
    expect(await findMeshMaterialIds(objects, 1n)).toEqual([20n])
    expect(await findMeshMaterialIds(objects, 2n)).toEqual([])
  })
})
