import { describe, expect, it } from 'vitest'
import { extractUnityMesh, toRightHanded, unityMeshStreamRef } from '../src/index.js'

/**
 * A two-stream quad (4 vertices): stream 0 = float3 position + float3
 * normal, stream 1 = UNorm8x4 colour + float2 UV, matching the layout
 * Unity 2021 emits for skinned character meshes.
 */
function quadMesh(opts: { indexFormat?: 0 | 1; streamed?: boolean } = {}) {
	const vertexCount = 4
	const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
	const uv = [0, 0, 1, 0, 1, 1, 0, 1]
	const stride0 = 24
	const stride1 = 12
	const s1Start = (stride0 * vertexCount + 15) & ~15
	const bytes = new Uint8Array(s1Start + stride1 * vertexCount)
	const dv = new DataView(bytes.buffer)
	for (let i = 0; i < vertexCount; i++) {
		for (let k = 0; k < 3; k++) dv.setFloat32(i * stride0 + k * 4, pos[i * 3 + k]!, true)
		dv.setFloat32(i * stride0 + 20, 1, true) // normal +Z
		const o = s1Start + i * stride1
		bytes.set([255, 128, 0, 255], o)
		dv.setFloat32(o + 4, uv[i * 2]!, true)
		dv.setFloat32(o + 8, uv[i * 2 + 1]!, true)
	}
	const tri = [0, 1, 2, 0, 2, 3]
	const wide = opts.indexFormat === 1
	const ib = new Uint8Array(tri.length * (wide ? 4 : 2))
	const ibv = new DataView(ib.buffer)
	tri.forEach((t, i) => (wide ? ibv.setUint32(i * 4, t, true) : ibv.setUint16(i * 2, t, true)))
	const none = { stream: 0, offset: 0, format: 0, dimension: 0 }
	const channels = [
		{ stream: 0, offset: 0, format: 0, dimension: 3 },
		{ stream: 0, offset: 12, format: 0, dimension: 3 },
		none,
		{ stream: 1, offset: 0, format: 2, dimension: 4 },
		{ stream: 1, offset: 4, format: 0, dimension: 2 },
		...Array(9).fill(none),
	]
	return {
		bytes,
		mesh: {
			m_Name: 'quad',
			m_SubMeshes: [
				{ firstByte: 0, indexCount: 3, topology: 0, baseVertex: 0 },
				{ firstByte: 3 * (wide ? 4 : 2), indexCount: 3, topology: 0, baseVertex: 0 },
			],
			m_MeshCompression: 0,
			m_IndexFormat: opts.indexFormat ?? 0,
			m_IndexBuffer: ib,
			m_VertexData: {
				m_VertexCount: vertexCount,
				m_Channels: channels,
				m_DataSize: opts.streamed ? { size: 0, data: new Uint8Array(0) } : { size: bytes.length, data: bytes },
			},
			m_StreamData: opts.streamed
				? { offset: 100n, size: bytes.length, path: 'archive:/CAB-x/CAB-x.resS' }
				: { offset: 0n, size: 0, path: '' },
		} as Record<string, unknown>,
	}
}

describe('extractUnityMesh', () => {
	it('decodes multi-stream vertex data and sub-meshes', () => {
		const { mesh } = quadMesh()
		expect(unityMeshStreamRef(mesh)).toBeNull()
		const g = extractUnityMesh(mesh, '2021.3.15f1')
		expect(g.name).toBe('quad')
		expect(g.vertexCount).toBe(4)
		expect([...g.positions.slice(3, 6)]).toEqual([1, 0, 0])
		expect([...g.normals!.slice(0, 3)]).toEqual([0, 0, 1])
		expect([...g.uv0!.slice(4, 6)]).toEqual([1, 1])
		expect(g.colors![0]).toBe(1)
		expect(g.colors![1]).toBeCloseTo(128 / 255)
		expect([...g.indices]).toEqual([0, 1, 2, 0, 2, 3])
		expect(g.subMeshes).toEqual([
			{ firstIndex: 0, indexCount: 3 },
			{ firstIndex: 3, indexCount: 3 },
		])
	})

	it('reads 32-bit index buffers', () => {
		const g = extractUnityMesh(quadMesh({ indexFormat: 1 }).mesh, '2021.3.15f1')
		expect([...g.indices]).toEqual([0, 1, 2, 0, 2, 3])
	})

	it('uses externally-resolved stream data', () => {
		const { mesh, bytes } = quadMesh({ streamed: true })
		expect(unityMeshStreamRef(mesh)).toEqual({ path: 'archive:/CAB-x/CAB-x.resS', offset: 100, size: bytes.length })
		expect(() => extractUnityMesh(mesh, '2021.3.15f1')).toThrow(/\.resS/)
		expect(extractUnityMesh(mesh, '2021.3.15f1', bytes).vertexCount).toBe(4)
	})

	it('converts to right-handed coordinates', () => {
		const g = toRightHanded(extractUnityMesh(quadMesh().mesh, '2021.3.15f1'))
		expect(g.positions[3]).toBe(-1)
		expect([...g.indices.slice(0, 3)]).toEqual([0, 2, 1])
	})

	it('decodes skin weights, bone indices and bind poses', () => {
		const { mesh, bytes } = quadMesh()
		// Append a third stream: 2 × float weights + 2 × u32 indices per vertex.
		const stride = 16
		const s2Start = (bytes.length + 15) & ~15
		const all = new Uint8Array(s2Start + stride * 4)
		all.set(bytes)
		const dv = new DataView(all.buffer)
		for (let v = 0; v < 4; v++) {
			dv.setFloat32(s2Start + v * stride, 0.75, true)
			dv.setFloat32(s2Start + v * stride + 4, 0.25, true)
			dv.setUint32(s2Start + v * stride + 8, v, true)
			dv.setUint32(s2Start + v * stride + 12, 1, true)
		}
		const vd = mesh.m_VertexData as Record<string, any>
		vd.m_DataSize = { size: all.length, data: all }
		vd.m_Channels[12] = { stream: 2, offset: 0, format: 0, dimension: 2 }
		vd.m_Channels[13] = { stream: 2, offset: 8, format: 10, dimension: 2 }
		const ident: Record<string, number> = {}
		for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) ident[`e${r}${c}`] = r === c ? 1 : 0
		mesh.m_BindPose = [{ ...ident, e03: 5 }]
		const g = extractUnityMesh(mesh, '2021.3.15f1')
		expect([...g.skin!.weights.slice(4, 8)]).toEqual([0.75, 0.25, 0, 0])
		expect([...g.skin!.indices.slice(8, 12)]).toEqual([2, 1, 0, 0])
		expect(g.bindPoses[0]![12]).toBe(5) // translation x, column-major
		expect(toRightHanded(g).bindPoses[0]![12]).toBe(-5)
	})
})

