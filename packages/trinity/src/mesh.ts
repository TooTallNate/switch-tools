/**
 * Decode a Trinity mesh (`.trmsh` + `.trmbf`) into flat render
 * buffers: every shape's vertices concatenated, indices rebased, one
 * section per sub-mesh. Positions / normals stay in the file's model
 * space (Y-up, bind pose); blend indices are rig indices (see
 * {@link TrinityNode.rigIndex}).
 */

import {
	TrinityAttribute,
	TrinityFormat,
	type TrinityShape,
	type TrinityShapeBuffers,
	type TrmbfBuffers,
	type TrmshMesh,
} from './model.js';

export interface TrinityRenderSection {
	/** Material name (matches a `.trmtr` material). */
	material: string;
	shape: string;
	firstIndex: number;
	indexCount: number;
}

export interface TrinityRenderMesh {
	numVertices: number;
	positions: Float32Array;
	normals?: Float32Array;
	uv0?: Float32Array;
	uv1?: Float32Array;
	/** Vertex colour, RGBA 0–1. */
	colors?: Float32Array;
	/** Four rig indices per vertex. */
	joints?: Uint16Array;
	/** Four weights per vertex, summing to ~1. */
	weights?: Float32Array;
	indices: Uint32Array;
	sections: TrinityRenderSection[];
}

const BYTES: Partial<Record<TrinityFormat, number>> = {
	[TrinityFormat.Rgba8Unorm]: 4,
	[TrinityFormat.Rgba8Uint]: 4,
	[TrinityFormat.R32Uint]: 4,
	[TrinityFormat.R32Int]: 4,
	[TrinityFormat.Rgba16Unorm]: 8,
	[TrinityFormat.Rgba16Float]: 8,
	[TrinityFormat.Rg32Float]: 8,
	[TrinityFormat.Rgb32Float]: 12,
	[TrinityFormat.Rgba32Float]: 16,
};

function half(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Read up to `n` components of one element as floats. */
function readElement(dv: DataView, p: number, format: TrinityFormat, out: number[]): number {
	switch (format) {
		case TrinityFormat.Rgb32Float:
			for (let i = 0; i < 3; i++) out[i] = dv.getFloat32(p + i * 4, true);
			return 3;
		case TrinityFormat.Rgba32Float:
			for (let i = 0; i < 4; i++) out[i] = dv.getFloat32(p + i * 4, true);
			return 4;
		case TrinityFormat.Rg32Float:
			for (let i = 0; i < 2; i++) out[i] = dv.getFloat32(p + i * 4, true);
			return 2;
		case TrinityFormat.Rgba16Float:
			for (let i = 0; i < 4; i++) out[i] = half(dv.getUint16(p + i * 2, true));
			return 4;
		case TrinityFormat.Rgba16Unorm:
			for (let i = 0; i < 4; i++) out[i] = dv.getUint16(p + i * 2, true) / 65535;
			return 4;
		case TrinityFormat.Rgba8Unorm:
			for (let i = 0; i < 4; i++) out[i] = dv.getUint8(p + i) / 255;
			return 4;
		case TrinityFormat.Rgba8Uint:
			for (let i = 0; i < 4; i++) out[i] = dv.getUint8(p + i);
			return 4;
		case TrinityFormat.R32Uint:
			out[0] = dv.getUint32(p, true);
			return 1;
		case TrinityFormat.R32Int:
			out[0] = dv.getInt32(p, true);
			return 1;
		default:
			return 0;
	}
}

function vertexCount(shape: TrinityShape, bufs: TrinityShapeBuffers): number {
	let n = Infinity;
	shape.streams.forEach((s, i) => {
		const b = bufs.vertices[i];
		if (b && s.stride > 0) n = Math.min(n, Math.floor(b.length / s.stride));
	});
	return Number.isFinite(n) ? n : 0;
}

const INDEX_SIZE = [1, 2, 4, 8];

export function buildTrinityMesh(mesh: TrmshMesh, buffers: TrmbfBuffers): TrinityRenderMesh {
	const shapes = mesh.shapes.map((shape, i) => ({ shape, bufs: buffers.buffers[i] })).filter((s) => s.bufs);
	let total = 0;
	let totalIdx = 0;
	const has = new Set<string>();
	for (const { shape, bufs } of shapes) {
		total += vertexCount(shape, bufs!);
		for (const sm of shape.subMeshes) totalIdx += sm.indexCount;
		for (const st of shape.streams) {
			for (const e of st.elements) has.add(`${e.semantic}:${e.semanticIndex}`);
		}
	}
	const positions = new Float32Array(total * 3);
	const normals = has.has(`${TrinityAttribute.Normal}:0`) ? new Float32Array(total * 3) : undefined;
	const uv0 = has.has(`${TrinityAttribute.Texcoord}:0`) ? new Float32Array(total * 2) : undefined;
	const uv1 = has.has(`${TrinityAttribute.Texcoord}:1`) ? new Float32Array(total * 2) : undefined;
	const colors = has.has(`${TrinityAttribute.Color}:0`) ? new Float32Array(total * 4).fill(1) : undefined;
	const joints = has.has(`${TrinityAttribute.BlendIndices}:0`) ? new Uint16Array(total * 4) : undefined;
	const weights = has.has(`${TrinityAttribute.BlendWeights}:0`) ? new Float32Array(total * 4) : undefined;
	const indices = new Uint32Array(totalIdx);
	const sections: TrinityRenderSection[] = [];

	let vBase = 0;
	let iOut = 0;
	const tmp: number[] = [0, 0, 0, 0];
	for (const { shape, bufs } of shapes) {
		const n = vertexCount(shape, bufs!);
		shape.streams.forEach((stream, si) => {
			const b = bufs!.vertices[si];
			if (!b || stream.stride <= 0) return;
			const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
			for (const e of stream.elements) {
				const size = BYTES[e.format];
				if (!size || e.offset + size > stream.stride) continue;
				const key = `${e.semantic}:${e.semanticIndex}`;
				for (let v = 0; v < n; v++) {
					const c = readElement(dv, v * stream.stride + e.offset, e.format, tmp);
					const o = vBase + v;
					switch (key) {
						case `${TrinityAttribute.Position}:0`:
							positions.set(tmp.slice(0, 3), o * 3);
							break;
						case `${TrinityAttribute.Normal}:0`:
							normals!.set(tmp.slice(0, 3), o * 3);
							break;
						case `${TrinityAttribute.Texcoord}:0`:
							uv0![o * 2] = tmp[0]!;
							uv0![o * 2 + 1] = tmp[1]!;
							break;
						case `${TrinityAttribute.Texcoord}:1`:
							uv1![o * 2] = tmp[0]!;
							uv1![o * 2 + 1] = tmp[1]!;
							break;
						case `${TrinityAttribute.Color}:0`:
							for (let k = 0; k < Math.min(4, c); k++) colors![o * 4 + k] = tmp[k]!;
							break;
						case `${TrinityAttribute.BlendIndices}:0`:
							for (let k = 0; k < Math.min(4, c); k++) joints![o * 4 + k] = tmp[k]!;
							break;
						case `${TrinityAttribute.BlendWeights}:0`:
							for (let k = 0; k < Math.min(4, c); k++) weights![o * 4 + k] = tmp[k]!;
							break;
					}
				}
			}
		});

		const ib = bufs!.indices[0];
		const isz = INDEX_SIZE[shape.indexFormat] ?? 2;
		const idv = ib ? new DataView(ib.buffer, ib.byteOffset, ib.byteLength) : null;
		for (const sm of shape.subMeshes) {
			const first = iOut;
			for (let k = 0; k < sm.indexCount; k++) {
				const p = (sm.indexOffset + k) * isz;
				let ix = 0;
				if (idv && p + isz <= idv.byteLength) {
					ix = isz === 1 ? idv.getUint8(p) : isz === 2 ? idv.getUint16(p, true) : idv.getUint32(p, true);
				}
				indices[iOut++] = vBase + (ix < n ? ix : 0);
			}
			sections.push({ material: sm.material, shape: shape.name, firstIndex: first, indexCount: iOut - first });
		}
		vBase += n;
	}
	return { numVertices: total, positions, normals, uv0, uv1, colors, joints, weights, indices, sections };
}
