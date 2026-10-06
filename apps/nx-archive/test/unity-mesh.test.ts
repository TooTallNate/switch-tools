import { describe, expect, it } from 'vitest'

import {
  findMeshMaterialIds,
  materialBaseColor,
  pickAlbedoTexture,
  resolveMeshAlbedoTextures,
  type UnityFileContext,
  type UnityObjectRef,
} from '~/lib/unity-mesh'
import { externalCabName } from '~/lib/unity-external'

const fileOf = (
  objects: UnityObjectRef[],
  externals: Record<number, UnityFileContext> = {},
): UnityFileContext => ({
  key: 'f',
  objects,
  resolveExternal: async (id) => externals[id] ?? null,
})

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
    const r = await resolveMeshAlbedoTextures(fileOf(objects), 1n)
    expect(r.materialNames).toEqual(['body', 'empty', ''])
    expect(r.textures.map((t) => t?.texture.m_Name ?? null)).toEqual(['body_alb', null, null])
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

describe('cross-file and fallback resolution', () => {
  it('follows material and texture PPtrs into other files', async () => {
    // Material lives in external file 1; its texture in that file's external 2.
    const texFile = fileOf([obj(28, 7n, tex('shared_alb'))])
    const matFile = fileOf([obj(21, 5n, material('shared', [['_BaseMap', 7n]]))], {})
    // Rewrite the texture PPtr to point at external file 2 of matFile.
    const mat = await matFile.objects[0]!.value()
    ;(mat.m_SavedProperties as any).m_TexEnvs[0].second.m_Texture = ptr(7n, 2)
    matFile.resolveExternal = async (id) => (id === 2 ? texFile : null)
    const meshFile = fileOf([obj(137, 10n, { m_Mesh: ptr(1n), m_Materials: [ptr(5n, 1)] })], { 1: matFile })
    const r = await resolveMeshAlbedoTextures(meshFile, 1n)
    expect(r.materialNames).toEqual(['shared'])
    expect(r.textures[0]?.texture.m_Name).toBe('shared_alb')
    expect(r.textures[0]?.file).toBe(texFile)
  })

  it('swaps an empty FBX-default material for the textured one it names', async () => {
    // Super Mario RPG: the renderer keeps the importer default
    // `p0001_mdl_mario_new_p0001_base`; the real material is `p0001_base`.
    const objects = [
      obj(137, 10n, { m_Mesh: ptr(1n), m_Materials: [ptr(20n), ptr(21n)] }),
      obj(21, 20n, material('p0001_mdl_mario_new_p0001_base', [['_BaseMap', 0n]])),
      obj(21, 21n, material('p0001_mdl_mario_new_p0001_eye', [])),
      obj(21, 22n, material('p0001_base', [['Texture2D_380DA1A9', 30n], ['Texture2D_2A45DA31', 31n]])),
      obj(28, 30n, tex('p0001', 1, 1024)),
      obj(28, 31n, tex('p0001_nml', 0, 1024)),
    ]
    const r = await resolveMeshAlbedoTextures(fileOf(objects), 1n)
    // Base: via the sibling material. Eye: no matching material, and we
    // don't guess from the `p0001` name token (the atlas region is wrong).
    expect(r.textures.map((t) => t?.texture.m_Name ?? null)).toEqual(['p0001', null])
  })

  it('leaves genuinely untextured materials alone', async () => {
    const objects = [
      obj(137, 10n, { m_Mesh: ptr(1n), m_Materials: [ptr(20n)] }),
      obj(21, 20n, material('z_exit045', [])),
      obj(28, 30n, tex('d01_floor')),
    ]
    expect((await resolveMeshAlbedoTextures(fileOf(objects), 1n)).textures).toEqual([null])
  })

  it('names external CABs by their basename', () => {
    expect(externalCabName('archive:/CAB-E1AF/CAB-E1AF')).toBe('cab-e1af')
    // Trailing NULs (seen in some builds) are stripped.
    expect(externalCabName('archive:/CAB-x/CAB-x\0')).toBe('cab-x')
  })
})

describe('materialBaseColor', () => {
  it('reads conventional colour properties', () => {
    const mat = (colors: [string, Record<string, number>][]) => ({
      m_SavedProperties: { m_Colors: colors.map(([first, second]) => ({ first, second })) },
    })
    expect(materialBaseColor(mat([['_EmissionColor', { r: 1, g: 0, b: 0, a: 1 }], ['_BaseColor', { r: 0.5, g: 0.25, b: 2, a: 1 }]]))).toEqual([0.5, 0.25, 1])
    expect(materialBaseColor(mat([['_Color', { r: 0, g: 1, b: 0, a: 1 }]]))).toEqual([0, 1, 0])
    expect(materialBaseColor(mat([['Color_7A81B365', { r: 0, g: 1, b: 0, a: 1 }]]))).toBeNull()
  })
})
