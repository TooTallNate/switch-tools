/**
 * PlatinumGames WMB3 model (NieR:Automata, Astral Chain, Bayonetta 3).
 *
 * Structure from Kerilk's `Nier Automata wmb base.bt` (credited there to
 * Delguoqing) and `wmb3.rb` in bayonetta_tools, verified on Bayonetta 3
 * (version 0x20200824). All little-endian; every table is located by an
 * (offset, count) pair in the header:
 *
 *   0x00 'WMB3', u32 version, i32 unknown, i16 flags (0x8: u32 indices),
 *   i16 reference bone, 24-byte bounding box, then pairs for: bones,
 *   bone index translate table, vertex groups, batches, LODs, collision
 *   tree, bone map, bone sets, materials, meshes, mesh/material pairs,
 *   unknown.
 *
 * - **Vertex groups** own a vertex buffer, an "extra data" buffer and an
 *   index buffer. `vertexFlags` selects the layout; see {@link layoutFor}.
 *   Half floats are IEEE binary16. Bayonetta 3 keeps the highest LOD's
 *   groups in a separate `.wme` stream (their offsets here are 0); we
 *   use the groups that have inline data.
 * - **Batches** slice a vertex group (index ranges are absolute in the
 *   group) and name a bone set.
 * - **LODs** list batch infos (vertex group, mesh, material) for a run of
 *   batches; LOD 0 is the full-detail model.
 * - **Skinning**: a vertex's bone index k → `boneSets[batch.boneSet][k]`
 *   → `boneMap[…]` → bone.
 * - **Bones** store local and world transforms; rotations are Euler
 *   angles applied X, then Y, then Z (matrix `Rz·Ry·Rx`). Animations
 *   address bones by id, resolved through the 3-level, 16-way bone index
 *   translate table (see `boneIndexForId`).
 */

export interface WmbBone {
	index: number;
	id: number;
	parent: number;
	localPosition: [number, number, number];
	localRotation: [number, number, number];
	localScale: [number, number, number];
	position: [number, number, number];
}

export interface WmbVertexGroup {
	index: number;
	vertexOffset: number;
	exOffset: number;
	vertexSize: number;
	exSize: number;
	numVertices: number;
	flags: number;
	indexOffset: number;
	numIndices: number;
	/** False when the buffers live in an external `.wme` stream. */
	inline: boolean;
}

export interface WmbBatch {
	vertexGroup: number;
	boneSet: number;
	vertexStart: number;
	indexStart: number;
	numVertices: number;
	numIndices: number;
}

export interface WmbBatchInfo {
	batch: number;
	vertexGroup: number;
	mesh: number;
	material: number;
}

export interface WmbLod {
	name: string;
	level: number;
	batches: WmbBatchInfo[];
}

export interface WmbMaterial {
	name: string;
	shader: string;
	technique: string;
	/** Sampler name (`g_AlbedoMap`, …) → texture id. */
	textures: { name: string; id: number }[];
	variables: Record<string, number>;
}

export interface WmbMesh {
	name: string;
	materials: number[];
}

export interface Wmb {
	version: number;
	flags: number;
	bones: WmbBone[];
	/** Bone id → bone index (−1 when unmapped). */
	boneIndexForId: (id: number) => number;
	vertexGroups: WmbVertexGroup[];
	batches: WmbBatch[];
	lods: WmbLod[];
	boneMap: number[];
	boneSets: number[][];
	materials: WmbMaterial[];
	meshes: WmbMesh[];
	/** External stream name (`pl/pl3031.wme`) when present. */
	externalStream?: string;
}

export function isWmb3(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x57 && head[1] === 0x4d && head[2] === 0x42 && head[3] === 0x33;
}

export function parseWmb(bytes: Uint8Array): Wmb {
	if (!isWmb3(bytes)) throw new Error('Not a WMB3 model');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => dv.getUint32(o, true);
	const i32 = (o: number) => dv.getInt32(o, true);
	const f32 = (o: number) => dv.getFloat32(o, true);
	const vec = (o: number): [number, number, number] => [f32(o), f32(o + 4), f32(o + 8)];
	const cstr = (o: number) => {
		if (!o || o >= bytes.length) return '';
		let e = o;
		while (e < bytes.length && bytes[e] !== 0) e++;
		return new TextDecoder().decode(bytes.subarray(o, e));
	};
	const pair = (o: number) => [u32(o), u32(o + 4)] as const;
	const version = u32(4);
	const flags = dv.getUint16(0x0c, true);
	const H = 0x28;
	const [boneOff, boneN] = pair(H);
	const [ttOff] = pair(H + 8);
	const [vgOff, vgN] = pair(H + 16);
	const [batOff, batN] = pair(H + 24);
	const [lodOff, lodN] = pair(H + 32);
	const [bmOff, bmN] = pair(H + 48);
	const [bsOff, bsN] = pair(H + 56);
	const [matOff, matN] = pair(H + 64);
	const [meshOff, meshN] = pair(H + 72);

	const bones: WmbBone[] = [];
	for (let i = 0; i < boneN; i++) {
		const b = boneOff + i * 88;
		bones.push({
			index: i,
			id: dv.getInt16(b, true),
			parent: dv.getInt16(b + 2, true),
			localPosition: vec(b + 4),
			localRotation: vec(b + 16),
			localScale: vec(b + 28),
			position: vec(b + 40),
		});
	}

	// One i16 array of 16-entry blocks, each entry an absolute index into the
	// same array: t[t[t[(id >> 8) & 0xf] + ((id >> 4) & 0xf)] + (id & 0xf)].
	const ttCount = u32(H + 12);
	const tt = (i: number) => (i >= 0 && i < ttCount && ttOff + i * 2 + 2 <= bytes.length ? dv.getInt16(ttOff + i * 2, true) : -1);
	const boneIndexForId = (id: number): number => {
		if (!ttOff || id < 0 || id > 0xfff) return -1;
		const a = tt((id >> 8) & 0xf);
		if (a < 0) return -1;
		const b = tt(a + ((id >> 4) & 0xf));
		if (b < 0) return -1;
		const c = tt(b + (id & 0xf));
		return c < 0 || c >= bones.length ? -1 : c;
	};

	const vertexGroups: WmbVertexGroup[] = [];
	for (let i = 0; i < vgN; i++) {
		const b = vgOff + i * 48;
		const g: WmbVertexGroup = {
			index: i,
			vertexOffset: u32(b),
			exOffset: u32(b + 4),
			vertexSize: u32(b + 16),
			exSize: u32(b + 20),
			numVertices: i32(b + 32),
			flags: i32(b + 36),
			indexOffset: u32(b + 40),
			numIndices: i32(b + 44),
			inline: false,
		};
		g.inline = g.vertexOffset > 0 && g.indexOffset > 0 && g.vertexOffset + g.vertexSize * g.numVertices <= bytes.length;
		vertexGroups.push(g);
	}

	const batches: WmbBatch[] = [];
	for (let i = 0; i < batN; i++) {
		const b = batOff + i * 28;
		batches.push({
			vertexGroup: u32(b),
			boneSet: i32(b + 4),
			vertexStart: u32(b + 8),
			indexStart: u32(b + 12),
			numVertices: u32(b + 16),
			numIndices: u32(b + 20),
		});
	}

	const lods: WmbLod[] = [];
	for (let i = 0; i < lodN; i++) {
		const b = lodOff + i * 20;
		const start = u32(b + 8);
		const infoOff = u32(b + 12);
		const n = u32(b + 16);
		const infos: WmbBatchInfo[] = [];
		for (let j = 0; j < n; j++) {
			const o = infoOff + j * 24;
			infos.push({ batch: start + j, vertexGroup: u32(o), mesh: u32(o + 4), material: u32(o + 8) });
		}
		lods.push({ name: cstr(u32(b)), level: i32(b + 4), batches: infos });
	}

	const boneMap: number[] = [];
	for (let i = 0; i < bmN; i++) boneMap.push(i32(bmOff + i * 4));
	const boneSets: number[][] = [];
	for (let i = 0; i < bsN; i++) {
		const o = u32(bsOff + i * 8);
		const n = u32(bsOff + i * 8 + 4);
		const set: number[] = [];
		for (let j = 0; j < n; j++) set.push(dv.getInt16(o + j * 2, true));
		boneSets.push(set);
	}

	const materials: WmbMaterial[] = [];
	for (let i = 0; i < matN; i++) {
		const b = matOff + i * 48;
		const texOff = u32(b + 24);
		const texN = u32(b + 28);
		const varOff = u32(b + 40);
		const varN = u32(b + 44);
		const textures: WmbMaterial['textures'] = [];
		for (let j = 0; j < texN && j < 64; j++) textures.push({ name: cstr(u32(texOff + j * 8)), id: u32(texOff + j * 8 + 4) });
		const variables: Record<string, number> = {};
		for (let j = 0; j < varN && j < 1024; j++) variables[cstr(u32(varOff + j * 8))] = f32(varOff + j * 8 + 4);
		materials.push({ name: cstr(u32(b + 8)), shader: cstr(u32(b + 12)), technique: cstr(u32(b + 16)), textures, variables });
	}

	const meshes: WmbMesh[] = [];
	for (let i = 0; i < meshN; i++) {
		const b = meshOff + i * 44;
		const mo = u32(b + 28);
		const mn = u32(b + 32);
		const mats: number[] = [];
		for (let j = 0; j < mn && j < 1024; j++) mats.push(dv.getUint16(mo + j * 2, true));
		meshes.push({ name: cstr(u32(b)), materials: mats });
	}

	// Bayonetta 3: after the header pairs, (name length, stream size) and
	// at 0x98 the external stream's name.
	let externalStream: string | undefined;
	if (bytes.length > 0xb8 && version >= 0x20200000) {
		const s = cstr(0x98);
		if (/\.wme$/i.test(s)) externalStream = s;
	}

	return { version, flags, bones, boneIndexForId, vertexGroups, batches, lods, boneMap, boneSets, materials, meshes, externalStream };
}

/** Byte offsets of the attributes we read, per vertex layout. −1 = absent. */
interface Layout {
	normal: number;
	normalInEx: boolean;
	color: number;
	colorInEx: boolean;
	bones: number;
	weights: number;
}

/**
 * Vertex layouts by `vertexFlags`. Every layout starts with position
 * (3 × f32), packed tangent (4 × u8) and UV0 (2 × f16); the rest differs.
 */
function layoutFor(flags: number): Layout | null {
	switch (flags) {
		case 0x0:
			return { normal: 20, normalInEx: false, color: -1, colorInEx: false, bones: -1, weights: -1 };
		case 0x1:
			return { normal: 0, normalInEx: true, color: -1, colorInEx: false, bones: -1, weights: -1 };
		case 0x3:
			return { normal: 0, normalInEx: true, color: 20, colorInEx: false, bones: -1, weights: -1 };
		case 0x4:
		case 0x5:
		case 0xc:
		case 0xe:
			return { normal: 0, normalInEx: true, color: 24, colorInEx: false, bones: -1, weights: -1 };
		case 0x7:
		case 0x8:
			return { normal: 4, normalInEx: true, color: -1, colorInEx: false, bones: 20, weights: 24 };
		case 0xa:
		case 0xb:
			return { normal: 8, normalInEx: true, color: 4, colorInEx: true, bones: 20, weights: 24 };
		default:
			return null;
	}
}

export function halfToFloat(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}

export interface WmbMeshData {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	/** RGBA 0..1, when any group has vertex colour. */
	colors?: Float32Array;
	indices: Uint32Array;
	/** Four bone indices (into `wmb.bones`) and weights per vertex; weights 0 when unskinned. */
	skinBones: Uint16Array;
	skinWeights: Float32Array;
	/** Triangle runs per material, in index-buffer order. */
	sections: { material: number; mesh: number; firstIndex: number; numTriangles: number }[];
	/** Batches skipped because their vertex group's data is external or its layout unknown. */
	skipped: number;
}

/**
 * Build one flat triangle mesh from a LOD (default: the most detailed
 * LOD with inline data). Vertices are emitted per batch, so each
 * batch's bone set resolves its own skin indices.
 */
export function buildWmbMesh(bytes: Uint8Array, wmb: Wmb, lodIndex?: number): WmbMeshData {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const usable = (bi: WmbBatchInfo) => {
		const g = wmb.vertexGroups[wmb.batches[bi.batch]?.vertexGroup ?? -1];
		return !!g && g.inline && !!layoutFor(g.flags);
	};
	let lod = lodIndex !== undefined ? wmb.lods[lodIndex] : undefined;
	if (!lod) {
		lod = wmb.lods.find((l) => l.batches.length > 0 && l.batches.every(usable)) ?? wmb.lods.find((l) => l.batches.some(usable)) ?? wmb.lods[0];
	}
	const infos = lod ? lod.batches : wmb.batches.map((b, i) => ({ batch: i, vertexGroup: b.vertexGroup, mesh: 0, material: 0 }));
	let skipped = 0;
	let nv = 0;
	let ni = 0;
	for (const bi of infos) {
		const b = wmb.batches[bi.batch];
		if (!b || !usable(bi)) {
			skipped++;
			continue;
		}
		nv += b.numVertices;
		ni += b.numIndices;
	}
	const positions = new Float32Array(nv * 3);
	const normals = new Float32Array(nv * 3);
	const uvs = new Float32Array(nv * 2);
	const colors = new Float32Array(nv * 4);
	let anyColor = false;
	const skinBones = new Uint16Array(nv * 4);
	const skinWeights = new Float32Array(nv * 4);
	const indices = new Uint32Array(ni);
	const sections: WmbMeshData['sections'] = [];
	const wide = (wmb.flags & 0x8) !== 0;
	let vBase = 0;
	let iBase = 0;
	for (const bi of infos) {
		const b = wmb.batches[bi.batch];
		if (!b || !usable(bi)) continue;
		const g = wmb.vertexGroups[b.vertexGroup]!;
		const L = layoutFor(g.flags)!;
		const set = b.boneSet >= 0 ? wmb.boneSets[b.boneSet] : undefined;
		for (let k = 0; k < b.numVertices; k++) {
			const v = b.vertexStart + k;
			const vo = g.vertexOffset + v * g.vertexSize;
			const eo = g.exOffset + v * g.exSize;
			const o = vBase + k;
			positions[o * 3] = dv.getFloat32(vo, true);
			positions[o * 3 + 1] = dv.getFloat32(vo + 4, true);
			positions[o * 3 + 2] = dv.getFloat32(vo + 8, true);
			uvs[o * 2] = halfToFloat(dv.getUint16(vo + 16, true));
			uvs[o * 2 + 1] = halfToFloat(dv.getUint16(vo + 18, true));
			const no = (L.normalInEx ? eo : vo) + L.normal;
			if (L.normalInEx && !g.exOffset) {
				// No extra buffer: fall back to the packed tangent's frame.
				normals[o * 3 + 1] = 1;
			} else {
				normals[o * 3] = halfToFloat(dv.getUint16(no, true));
				normals[o * 3 + 1] = halfToFloat(dv.getUint16(no + 2, true));
				normals[o * 3 + 2] = halfToFloat(dv.getUint16(no + 4, true));
			}
			if (L.color >= 0) {
				const co = (L.colorInEx ? eo : vo) + L.color;
				for (let c = 0; c < 4; c++) colors[o * 4 + c] = bytes[co + c]! / 255;
				anyColor = true;
			} else {
				colors.fill(1, o * 4, o * 4 + 4);
			}
			if (L.bones >= 0) {
				let total = 0;
				for (let j = 0; j < 4; j++) {
					const local = bytes[vo + L.bones + j]!;
					const w = bytes[vo + L.weights + j]! / 255;
					const mapped = set ? set[local] : local;
					const bone = mapped !== undefined && mapped >= 0 ? (wmb.boneMap[mapped] ?? mapped) : 0;
					skinBones[o * 4 + j] = bone >= 0 && bone < wmb.bones.length ? bone : 0;
					skinWeights[o * 4 + j] = w;
					total += w;
				}
				if (total > 0) for (let j = 0; j < 4; j++) skinWeights[o * 4 + j] /= total;
			}
		}
		for (let k = 0; k < b.numIndices; k++) {
			const io = g.indexOffset + (b.indexStart + k) * (wide ? 4 : 2);
			const idx = wide ? dv.getUint32(io, true) : dv.getUint16(io, true);
			indices[iBase + k] = vBase + (idx - b.vertexStart);
		}
		const last = sections[sections.length - 1];
		if (last && last.material === bi.material && last.mesh === bi.mesh && last.firstIndex + last.numTriangles * 3 === iBase) {
			last.numTriangles += Math.floor(b.numIndices / 3);
		} else {
			sections.push({ material: bi.material, mesh: bi.mesh, firstIndex: iBase, numTriangles: Math.floor(b.numIndices / 3) });
		}
		vBase += b.numVertices;
		iBase += b.numIndices;
	}
	return { positions, normals, uvs, colors: anyColor ? colors : undefined, indices, skinBones, skinWeights, sections, skipped };
}
