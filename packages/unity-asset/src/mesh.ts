/**
 * Unity `Mesh` (class 43) geometry decoder.
 *
 * Works on the TypeTree-decoded object value (the output of
 * `parseObject`). Field names match Unity's serialisation, so the
 * input shape is stable across 2017–2023 builds. Supports:
 *
 *   - Vertex data split across multiple streams. Each stream's
 *     stride is the furthest channel extent in it, and streams are
 *     laid back to back with 16-byte alignment, matching how Unity
 *     builds `m_VertexData`.
 *   - Both vertex-format enumerations: `VertexFormat` (2019+, 12
 *     codes) and the older `VertexChannelFormat` (2017–2018, 5 codes).
 *   - Inline vertex bytes (`m_VertexData.m_DataSize`) or streamed
 *     bytes in a `.resS` (`m_StreamData`). The caller resolves the
 *     latter and passes them in.
 *   - 16/32-bit index buffers, `baseVertex`, and triangle/quad
 *     sub-meshes. Line and point topologies are skipped.
 *
 * Not handled: `m_CompressedMesh` (meshes built with Mesh
 * Compression), which throws a descriptive error. Blend shapes are
 * also skipped.
 *
 * Coordinates are returned in Unity's native left-handed space (+X
 * right, +Y up, +Z forward). Callers targeting a right-handed
 * renderer should negate X and reverse triangle winding. See
 * {@link toRightHanded}.
 *
 * Layout references: AssetStudio `Classes/Mesh.cs` (MIT).
 */
import { parseUnityVersion, uvAtLeast } from './classes.js';

export interface UnityMeshSubMesh {
	/** Offset into {@link UnityMeshGeometry.indices}, in indices. */
	firstIndex: number;
	/** Number of triangle indices (a multiple of 3). */
	indexCount: number;
}

export interface UnityMeshGeometry {
	name: string;
	vertexCount: number;
	/** XYZ positions, `vertexCount * 3`. */
	positions: Float32Array;
	/** XYZ normals, or `null` if the mesh has none. */
	normals: Float32Array | null;
	/** First UV set, `vertexCount * 2`, or `null`. V = 0 is the bottom row. */
	uv0: Float32Array | null;
	/** RGBA vertex colours in 0..1, `vertexCount * 4`, or `null`. */
	colors: Float32Array | null;
	/** Triangle-list indices with `baseVertex` already applied. */
	indices: Uint32Array;
	/** One entry per Unity sub-mesh, in order (sub-mesh i ↔ material slot i). */
	subMeshes: UnityMeshSubMesh[];
	/** Per-vertex skinning, or `null` for unskinned meshes. */
	skin: UnityMeshSkin | null;
	/**
	 * Inverse bind matrices, one per bone, as column-major 4×4 arrays
	 * (`m[col * 4 + row]`, the Three.js / glTF layout). Bone `i` is
	 * `SkinnedMeshRenderer.m_Bones[i]`.
	 */
	bindPoses: Float32Array[];
}

export interface UnityMeshSkin {
	/** Up to 4 influences per vertex; unused slots have weight 0. `vertexCount * 4`. */
	weights: Float32Array;
	/** Bone indices matching {@link weights}. `vertexCount * 4`. */
	indices: Uint16Array;
}

/** Semantic slots of `m_Channels` (Unity 2018+ layout, 14 channels). */
const CH = {
	position: 0,
	normal: 1,
	tangent: 2,
	color: 3,
	uv0: 4,
	blendWeight: 12,
	blendIndices: 13,
} as const;
/** Pre-2018 layout (8 channels): pos, normal, color, uv0–uv3, tangent. */
const CH_LEGACY = { position: 0, normal: 1, color: 2, uv0: 3 } as const;

interface Channel {
	stream: number;
	offset: number;
	format: number;
	dimension: number;
}

type ComponentReader = (view: DataView, offset: number) => number;

/** Byte size + reader for a component format, per the Unity version's enum. */
function componentFormat(
	format: number,
	modern: boolean,
): { size: number; read: ComponentReader } | null {
	const half: ComponentReader = (v, o) => halfToFloat(v.getUint16(o, true));
	if (modern) {
		// UnityEngine.Rendering.VertexAttributeFormat (2019+).
		switch (format) {
			case 0: return { size: 4, read: (v, o) => v.getFloat32(o, true) };
			case 1: return { size: 2, read: half };
			case 2: return { size: 1, read: (v, o) => v.getUint8(o) / 255 };
			case 3: return { size: 1, read: (v, o) => Math.max(v.getInt8(o) / 127, -1) };
			case 4: return { size: 2, read: (v, o) => v.getUint16(o, true) / 65535 };
			case 5: return { size: 2, read: (v, o) => Math.max(v.getInt16(o, true) / 32767, -1) };
			case 6: return { size: 1, read: (v, o) => v.getUint8(o) };
			case 7: return { size: 1, read: (v, o) => v.getInt8(o) };
			case 8: return { size: 2, read: (v, o) => v.getUint16(o, true) };
			case 9: return { size: 2, read: (v, o) => v.getInt16(o, true) };
			case 10: return { size: 4, read: (v, o) => v.getUint32(o, true) };
			case 11: return { size: 4, read: (v, o) => v.getInt32(o, true) };
			default: return null;
		}
	}
	// VertexChannelFormat (2017–2018).
	switch (format) {
		case 0: return { size: 4, read: (v, o) => v.getFloat32(o, true) };
		case 1: return { size: 2, read: half };
		case 2: return { size: 1, read: (v, o) => v.getUint8(o) / 255 };
		case 3: return { size: 1, read: (v, o) => v.getUint8(o) };
		case 4: return { size: 4, read: (v, o) => v.getUint32(o, true) };
		default: return null;
	}
}

function halfToFloat(h: number): number {
	const sign = h & 0x8000 ? -1 : 1;
	const exp = (h >> 10) & 0x1f;
	const frac = h & 0x3ff;
	if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
	if (exp === 31) return frac ? NaN : sign * Infinity;
	return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

const num = (v: unknown): number =>
	typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0);

/** Extract bytes from either a `vector<UInt8>` (Uint8Array) or a `TypelessData` `{ size, data }`. */
function bytesOf(v: unknown): Uint8Array | null {
	if (v instanceof Uint8Array) return v;
	if (v && typeof v === 'object' && 'data' in v) {
		const d = (v as { data?: unknown }).data;
		if (d instanceof Uint8Array) return d;
		if (Array.isArray(d)) return Uint8Array.from(d as number[]);
	}
	if (Array.isArray(v)) return Uint8Array.from(v as number[]);
	return null;
}

/** `m_StreamData` reference for meshes whose vertex bytes live in a `.resS`. */
export interface UnityMeshStreamRef {
	path: string;
	offset: number;
	size: number;
}

/** The mesh's external vertex-data reference, or `null` when the data is inline. */
export function unityMeshStreamRef(mesh: Record<string, unknown>): UnityMeshStreamRef | null {
	const vd = mesh.m_VertexData as Record<string, unknown> | undefined;
	const inline = bytesOf(vd?.m_DataSize);
	if (inline && inline.length > 0) return null;
	const sd = mesh.m_StreamData as Record<string, unknown> | undefined;
	if (!sd || num(sd.size) === 0) return null;
	return {
		path: String(sd.path ?? '').replace(/\0+$/, ''),
		offset: num(sd.offset),
		size: num(sd.size),
	};
}

/**
 * Decode a TypeTree-parsed `Mesh` into flat typed arrays.
 *
 * @param mesh The decoded object value.
 * @param unityVersion The SerializedFile's Unity version string
 *   (e.g. `"2021.3.15f1"`). It selects the vertex-format enum.
 * @param streamData Vertex bytes from `m_StreamData`, when
 *   {@link unityMeshStreamRef} reports an external reference.
 */
export function extractUnityMesh(
	mesh: Record<string, unknown>,
	unityVersion: string,
	streamData?: Uint8Array,
): UnityMeshGeometry {
	const name = String(mesh.m_Name ?? '');
	const version = parseUnityVersion(unityVersion);
	const modernFormats = uvAtLeast(version, 2019);

	const compressed = num(mesh.m_MeshCompression);
	const cm = mesh.m_CompressedMesh as Record<string, unknown> | undefined;
	const cmVerts = num((cm?.m_Vertices as Record<string, unknown> | undefined)?.m_NumItems);
	const vd = mesh.m_VertexData as Record<string, unknown> | undefined;
	if (!vd) throw new Error('Mesh has no m_VertexData');
	const vertexCount = num(vd.m_VertexCount);
	if (compressed !== 0 && cmVerts > 0 && vertexCount === 0) {
		throw new Error('Mesh uses Unity mesh compression (m_CompressedMesh), which is not supported yet');
	}

	let data = bytesOf(vd.m_DataSize);
	if (!data || data.length === 0) data = streamData ?? null;
	if (!data || data.length === 0) {
		throw new Error(
			unityMeshStreamRef(mesh)
				? 'Mesh vertex data is streamed from a .resS that could not be resolved'
				: 'Mesh has no vertex data',
		);
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	const channels: Channel[] = ((vd.m_Channels as unknown[]) ?? []).map((c) => {
		const ch = c as Record<string, unknown>;
		return {
			stream: num(ch.stream),
			offset: num(ch.offset),
			format: num(ch.format),
			// Some versions pack flags into the high nibble.
			dimension: num(ch.dimension) & 0xf,
		};
	});
	const slots = channels.length >= 14 ? CH : CH_LEGACY;

	// Stream layout. Unity 5.x serialised `m_Streams` explicitly;
	// later versions derive it from the channels.
	const streamOffsets: number[] = [];
	const streamStrides: number[] = [];
	const explicitStreams = vd.m_Streams as unknown[] | undefined;
	if (Array.isArray(explicitStreams) && explicitStreams.length > 0) {
		for (const s of explicitStreams) {
			const st = s as Record<string, unknown>;
			streamOffsets.push(num(st.offset));
			streamStrides.push(num(st.stride));
		}
	} else {
		const streamCount = channels.reduce((m, c) => (c.dimension > 0 ? Math.max(m, c.stream + 1) : m), 0);
		let cursor = 0;
		for (let s = 0; s < streamCount; s++) {
			let stride = 0;
			for (const c of channels) {
				if (c.stream !== s || c.dimension === 0) continue;
				const fmt = componentFormat(c.format, modernFormats);
				if (fmt) stride = Math.max(stride, c.offset + fmt.size * c.dimension);
			}
			streamOffsets.push(cursor);
			streamStrides.push(stride);
			cursor += stride * vertexCount;
			cursor = (cursor + 15) & ~15;
		}
	}

	const readChannel = (slot: number, outDim: number): Float32Array | null => {
		const c = channels[slot];
		if (!c || c.dimension === 0) return null;
		const fmt = componentFormat(c.format, modernFormats);
		if (!fmt) return null;
		const base = streamOffsets[c.stream];
		const stride = streamStrides[c.stream];
		if (base === undefined || !stride) return null;
		if (base + stride * (vertexCount - 1) + c.offset + fmt.size * c.dimension > data!.length) {
			return null;
		}
		const out = new Float32Array(vertexCount * outDim);
		const n = Math.min(c.dimension, outDim);
		for (let i = 0; i < vertexCount; i++) {
			const o = base + i * stride + c.offset;
			for (let k = 0; k < n; k++) out[i * outDim + k] = fmt.read(view, o + k * fmt.size);
			// Missing alpha defaults to opaque.
			if (outDim === 4 && n < 4) out[i * outDim + 3] = 1;
		}
		return out;
	};

	const positions = readChannel(slots.position, 3);
	if (!positions) throw new Error('Mesh has no decodable position channel');
	const normals = readChannel(slots.normal, 3);
	const uv0 = readChannel(slots.uv0, 2);
	const colors = readChannel(slots.color, 4);
	const skin = readSkin(mesh, channels.length >= 14 ? readChannel(CH.blendWeight, 4) : null, channels.length >= 14 ? readChannel(CH.blendIndices, 4) : null, vertexCount);
	const bindPoses = ((mesh.m_BindPose as unknown[]) ?? []).map((m) => unityMatrixToColumnMajor(m as Record<string, unknown>));

	// Index buffer + sub-meshes.
	const ib = bytesOf(mesh.m_IndexBuffer) ?? new Uint8Array(0);
	const ibView = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
	const wide = num(mesh.m_IndexFormat) === 1;
	const indexSize = wide ? 4 : 2;
	const readIndex = (i: number) => (wide ? ibView.getUint32(i * 4, true) : ibView.getUint16(i * 2, true));
	const totalIndices = Math.floor(ib.length / indexSize);

	const out: number[] = [];
	const subMeshes: UnityMeshSubMesh[] = [];
	const rawSubMeshes = (mesh.m_SubMeshes as unknown[]) ?? [];
	const list = rawSubMeshes.length
		? rawSubMeshes.map((s) => s as Record<string, unknown>)
		: [{ firstByte: 0, indexCount: totalIndices, topology: 0, baseVertex: 0 }];
	for (const sm of list) {
		const first = Math.floor(num(sm.firstByte) / indexSize);
		const count = Math.min(num(sm.indexCount), Math.max(totalIndices - first, 0));
		const baseVertex = num(sm.baseVertex);
		const topology = num(sm.topology);
		const start = out.length;
		if (topology === 0) {
			for (let i = 0; i + 2 < count; i += 3) {
				out.push(
					readIndex(first + i) + baseVertex,
					readIndex(first + i + 1) + baseVertex,
					readIndex(first + i + 2) + baseVertex,
				);
			}
		} else if (topology === 2) {
			// Quads → two triangles each.
			for (let i = 0; i + 3 < count; i += 4) {
				const a = readIndex(first + i) + baseVertex;
				const b = readIndex(first + i + 1) + baseVertex;
				const c = readIndex(first + i + 2) + baseVertex;
				const d = readIndex(first + i + 3) + baseVertex;
				out.push(a, b, c, a, c, d);
			}
		}
		subMeshes.push({ firstIndex: start, indexCount: out.length - start });
	}
	const indices = Uint32Array.from(out);
	for (let i = 0; i < indices.length; i++) {
		if (indices[i]! >= vertexCount) throw new Error(`Mesh index ${indices[i]} out of range (${vertexCount} vertices)`);
	}

	return { name, vertexCount, positions, normals, uv0, colors, indices, subMeshes, skin, bindPoses };
}

/**
 * Skin weights from the vertex stream (2019+: `BlendWeight` /
 * `BlendIndices` channels, where a missing weight channel means a
 * single influence of 1), or from the legacy `m_Skin` array of
 * `BoneWeights4`.
 */
function readSkin(
	mesh: Record<string, unknown>,
	weightsCh: Float32Array | null,
	indicesCh: Float32Array | null,
	vertexCount: number,
): UnityMeshSkin | null {
	if (indicesCh) {
		const weights = new Float32Array(vertexCount * 4);
		const indices = new Uint16Array(vertexCount * 4);
		for (let i = 0; i < vertexCount * 4; i++) indices[i] = indicesCh[i]!;
		if (weightsCh) {
			weights.set(weightsCh);
			// Unity stores only as many weights as the dimension; the
			// channel reader pads alpha-style slots with 1, so zero
			// any slot beyond the stored dimension.
			const dim = weightsChannelDimension(mesh);
			if (dim < 4) for (let v = 0; v < vertexCount; v++) for (let k = dim; k < 4; k++) weights[v * 4 + k] = 0;
		} else {
			for (let v = 0; v < vertexCount; v++) weights[v * 4] = 1;
		}
		const dimI = indicesChannelDimension(mesh);
		if (dimI < 4) for (let v = 0; v < vertexCount; v++) for (let k = dimI; k < 4; k++) indices[v * 4 + k] = 0;
		return { weights, indices };
	}
	const legacy = mesh.m_Skin as unknown[] | undefined;
	if (Array.isArray(legacy) && legacy.length === vertexCount && vertexCount > 0) {
		const weights = new Float32Array(vertexCount * 4);
		const indices = new Uint16Array(vertexCount * 4);
		legacy.forEach((bw, v) => {
			const o = bw as Record<string, unknown>;
			for (let k = 0; k < 4; k++) {
				weights[v * 4 + k] = num(o[`weight[${k}]`]);
				indices[v * 4 + k] = num(o[`boneIndex[${k}]`]);
			}
		});
		return { weights, indices };
	}
	return null;
}

function channelDimension(mesh: Record<string, unknown>, slot: number): number {
	const vd = mesh.m_VertexData as Record<string, unknown> | undefined;
	const ch = ((vd?.m_Channels as unknown[]) ?? [])[slot] as Record<string, unknown> | undefined;
	return ch ? num(ch.dimension) & 0xf : 0;
}
const weightsChannelDimension = (m: Record<string, unknown>) => channelDimension(m, CH.blendWeight);
const indicesChannelDimension = (m: Record<string, unknown>) => channelDimension(m, CH.blendIndices);

/** Unity `Matrix4x4` (`eRC` fields) → column-major `Float32Array(16)`. */
export function unityMatrixToColumnMajor(m: Record<string, unknown>): Float32Array {
	const out = new Float32Array(16);
	for (let r = 0; r < 4; r++) {
		for (let c = 0; c < 4; c++) out[c * 4 + r] = num(m[`e${r}${c}`]);
	}
	return out;
}

/**
 * Mirror a column-major matrix across X (`S·M·S`, `S = diag(-1,1,1,1)`),
 * converting a transform between Unity's left-handed space and a
 * right-handed one.
 */
export function mirrorMatrixX(m: Float32Array): Float32Array {
	const out = new Float32Array(m);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			if ((r === 0) !== (c === 0)) out[c * 4 + r] = -out[c * 4 + r]!;
		}
	}
	return out;
}

/**
 * Convert Unity's left-handed geometry to right-handed (Three.js /
 * glTF) in place by mirroring X and reversing triangle winding.
 */
export function toRightHanded(geom: UnityMeshGeometry): UnityMeshGeometry {
	for (let i = 0; i < geom.positions.length; i += 3) geom.positions[i] = -geom.positions[i]!;
	if (geom.normals) for (let i = 0; i < geom.normals.length; i += 3) geom.normals[i] = -geom.normals[i]!;
	for (let i = 0; i + 2 < geom.indices.length; i += 3) {
		const t = geom.indices[i + 1]!;
		geom.indices[i + 1] = geom.indices[i + 2]!;
		geom.indices[i + 2] = t;
	}
	geom.bindPoses = geom.bindPoses.map(mirrorMatrixX);
	return geom;
}
