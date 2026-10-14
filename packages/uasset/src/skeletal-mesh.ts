/**
 * UE 4.24–4.27 cooked SkeletalMesh deserialiser: geometry, skin weights
 * and the reference skeleton (bind pose).
 *
 * After the export's property tags, `USkeletalMesh::Serialize` writes:
 *
 *   FStripDataFlags, FBoxSphereBounds,
 *   TArray<FSkeletalMaterial> (material, slot name, an
 *     "imported slot name" flag (+ name), FMeshUVChannelInfo),
 *   FReferenceSkeleton (bones: name + parent; pose: FTransform each;
 *     name → index map),
 *   bool bCooked, [int32 MinMobileLOD on some 4.27 builds],
 *   TArray<FSkeletalMeshLODRenderData> via `SerializeRenderItem`:
 *     strip flags, bIsLODCookedOut, bInlined, RequiredBones,
 *     sections (FSkelMeshRenderSection), ActiveBoneIndices,
 *     buffers size, then (inlined) `SerializeStreamedData`:
 *       strip flags, FMultisizeIndexContainer, position buffer,
 *       FStaticMeshVertexBuffer (tangents + UVs), FSkinWeightVertexBuffer,
 *       [colour buffer when `bHasVertexColors`], …
 *
 * From gildor2/UEViewer (`UnMesh4.cpp`: `USkeletalMesh4::Serialize`,
 * `FStaticLODModel4::SerializeRenderItem`, `FSkelMeshSection4`,
 * `FSkinWeightVertexBuffer`). Cooked packages carry no custom versions,
 * so the few fields that come and go between engine versions (the
 * tangent-mask channel byte, `bUse16BitBoneIndex`, MinMobileLOD) are
 * probed: each variant must parse to a consistent structure.
 *
 * Skin influences index the section's `BoneMap`, which indexes the
 * reference skeleton. Positions are UE units (cm), Z-up, left-handed.
 */
import type { ParsedUasset } from './index.js';
import { readExportProperties, type UProperty } from './properties.js';
import {
	readBoxSphereBounds,
	readColorVertexBuffer,
	readPositionVertexBuffer,
	readStaticMeshVertexBuffer,
	Reader,
	type FBoxSphereBounds,
} from './static-mesh.js';

export class SkeletalMeshParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SkeletalMeshParseError';
	}
}

export interface SkeletalBone {
	name: string;
	parent: number;
	/** Parent-relative bind pose: rotation quaternion (x, y, z, w), translation, scale. */
	rotation: [number, number, number, number];
	translation: [number, number, number];
	scale: [number, number, number];
}

export interface SkeletalMeshSection {
	materialIndex: number;
	firstIndex: number;
	numTriangles: number;
	baseVertexIndex: number;
	numVertices: number;
	/** Section-local bone index → reference-skeleton bone. */
	boneMap: number[];
}

export interface SkeletalMeshLOD {
	numVertices: number;
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array[];
	/** BGRA bytes, when the mesh has vertex colours. */
	colors: Uint8Array | null;
	indices: Uint32Array;
	sections: SkeletalMeshSection[];
	/** Up to 8 influences per vertex, as skeleton bone indices + 0..1 weights. */
	influences: number;
	boneIndices: Uint16Array;
	boneWeights: Float32Array;
}

export interface LoadedSkeletalMesh {
	bounds: FBoxSphereBounds;
	/** Material package index per slot (resolve through the package imports). */
	materials: { material: number; slotName: string }[];
	bones: SkeletalBone[];
	lods: SkeletalMeshLOD[];
}

export function parseSkeletalMesh(parsed: ParsedUasset, uexpBytes: Uint8Array, exportIndex: number): LoadedSkeletalMesh {
	const props = readExportProperties(parsed, uexpBytes, exportIndex);
	const hasVertexColors = boolProperty(props.properties, 'bHasVertexColors');
	const name = (i: number, n: number) => {
		const s = parsed.names[i]?.value ?? `name_${i}`;
		return n > 0 ? `${s}_${n - 1}` : s;
	};
	return parseSkeletalMeshFromTail(props.tail, { hasVertexColors, name });
}

function boolProperty(props: UProperty[], key: string): boolean {
	const p = props.find((x) => x.name === key);
	const v = p?.value as { kind?: string; value?: unknown } | undefined;
	return !!v && (v.value === true || v.value === 1);
}

export interface SkeletalTailOptions {
	hasVertexColors?: boolean;
	/** FName resolver (name-table index, number). */
	name?: (index: number, number: number) => string;
}

export function parseSkeletalMeshFromTail(tail: Uint8Array, options: SkeletalTailOptions = {}): LoadedSkeletalMesh {
	const nameOf = options.name ?? ((i: number) => `bone_${i}`);
	const r = new Reader(tail);
	if (r.boolU32()) r.skip(16); // object guid
	r.skipStripFlags();
	const bounds = readBoxSphereBounds(r);

	const nMat = r.i32();
	if (nMat < 0 || nMat > 1024) throw new SkeletalMeshParseError(`Bad material count ${nMat}`);
	const materials: LoadedSkeletalMesh['materials'] = [];
	for (let i = 0; i < nMat; i++) {
		const material = r.i32();
		const slot = nameOf(r.i32(), r.i32());
		if (r.boolU32()) r.skip(8); // imported slot name
		r.skip(24); // FMeshUVChannelInfo
		materials.push({ material, slotName: slot });
	}

	const nBones = r.i32();
	if (nBones < 0 || nBones > 65535) throw new SkeletalMeshParseError(`Bad bone count ${nBones}`);
	const bones: SkeletalBone[] = [];
	for (let i = 0; i < nBones; i++) {
		const nm = nameOf(r.i32(), r.i32());
		bones.push({ name: nm, parent: r.i32(), rotation: [0, 0, 0, 1], translation: [0, 0, 0], scale: [1, 1, 1] });
	}
	const nPose = r.i32();
	if (nPose !== nBones) throw new SkeletalMeshParseError(`Bone pose count ${nPose} ≠ ${nBones} bones`);
	for (let i = 0; i < nPose; i++) {
		const b = bones[i]!;
		b.rotation = [r.f32(), r.f32(), r.f32(), r.f32()];
		b.translation = [r.f32(), r.f32(), r.f32()];
		b.scale = [r.f32(), r.f32(), r.f32()];
	}
	const nMap = r.i32();
	r.skip(nMap * 12);

	if (!r.boolU32()) throw new SkeletalMeshParseError('Uncooked SkeletalMesh not supported');
	const afterCooked = r.pos;
	let lods: SkeletalMeshLOD[] | null = null;
	let firstErr: unknown = null;
	// [MinMobileLOD int32] × [tangent-mask byte] × [16-bit bone index flag]
	for (const minMobile of [false, true]) {
		for (const maskChannel of [true, false]) {
			for (const use16Flag of [true, false]) {
				r.pos = afterCooked;
				try {
					if (minMobile) r.i32();
					lods = readLods(r, { maskChannel, use16Flag, hasVertexColors: !!options.hasVertexColors, nBones });
					if (lods.length > 0) break;
				} catch (e) {
					firstErr ??= e;
					lods = null;
				}
			}
			if (lods) break;
		}
		if (lods) break;
	}
	if (!lods || lods.length === 0) {
		throw firstErr instanceof Error ? firstErr : new SkeletalMeshParseError('No inlined LODs');
	}
	return { bounds, materials, bones, lods };
}

interface Variant {
	maskChannel: boolean;
	use16Flag: boolean;
	hasVertexColors: boolean;
	nBones: number;
}

function readLods(r: Reader, v: Variant): SkeletalMeshLOD[] {
	const nLods = r.i32();
	if (nLods < 0 || nLods > 16) throw new SkeletalMeshParseError(`Bad LOD count ${nLods}`);
	const out: SkeletalMeshLOD[] = [];
	for (let l = 0; l < nLods; l++) {
		const strip = r.stripFlags();
		const cookedOut = r.boolU32();
		const inlined = r.boolU32();
		const required = r.i32();
		if (required < 0 || required > 65535) throw new SkeletalMeshParseError(`Bad RequiredBones ${required}`);
		r.skip(required * 2);
		if (strip.serverStripped || cookedOut) continue;
		const nSec = r.i32();
		if (nSec < 0 || nSec > 1024) throw new SkeletalMeshParseError(`Bad section count ${nSec}`);
		const sections: SkeletalMeshSection[] = [];
		for (let s = 0; s < nSec; s++) sections.push(readSection(r, v));
		const active = r.i32();
		if (active < 0 || active > 65535) throw new SkeletalMeshParseError(`Bad ActiveBoneIndices ${active}`);
		r.skip(active * 2);
		r.u32(); // buffers size
		if (!inlined) {
			// Streamed LOD (bulk data in the .ubulk): the inlined LODs follow
			// only after its metadata, which varies by version — stop here.
			break;
		}
		out.push(readStreamed(r, sections, v));
		// Only LOD 0 is needed; later LODs carry trailing per-buffer data we don't model.
		break;
	}
	return out;
}

function readSection(r: Reader, v: Variant): SkeletalMeshSection {
	const strip = r.stripFlags();
	const materialIndex = r.u16();
	const firstIndex = r.u32();
	const numTriangles = r.u32();
	r.boolU32(); // bRecomputeTangent
	if (v.maskChannel) r.u8();
	r.boolU32(); // bCastShadow
	const baseVertexIndex = r.u32();
	const cloth = r.i32();
	if (cloth < 0 || cloth > 1_000_000) throw new SkeletalMeshParseError(`Bad cloth mapping count ${cloth}`);
	// FMeshToMeshVertData: 4 × FVector4 + 4 × u16 + f32 weight… (UE 4.26: 76 bytes)
	if (cloth > 0) throw new SkeletalMeshParseError('Cloth sections are not supported');
	const nMap = r.i32();
	if (nMap < 0 || nMap > 65535) throw new SkeletalMeshParseError(`Bad bone map ${nMap}`);
	const boneMap: number[] = [];
	for (let i = 0; i < nMap; i++) {
		const b = r.u16();
		if (b >= v.nBones) throw new SkeletalMeshParseError(`Bone map entry ${b} ≥ ${v.nBones} bones`);
		boneMap.push(b);
	}
	const numVertices = r.i32();
	const maxInfluences = r.i32();
	if (numVertices < 0 || maxInfluences < 0 || maxInfluences > 12) throw new SkeletalMeshParseError(`Bad section counts ${numVertices}/${maxInfluences}`);
	r.skip(2); // CorrespondClothAssetIndex
	r.skip(20); // FClothingSectionData: GUID + LOD index
	if (!strip.classBit(1)) {
		// FDuplicatedVerticesBuffer: TArray<u32> DupVertData, then one
		// FIndexLengthPair (2 × u32) per section vertex.
		const dup = r.i32();
		if (dup < 0 || dup > 16_000_000) throw new SkeletalMeshParseError('Bad duplicated-vertices buffer');
		r.skip(dup * 4);
		const pairs = r.i32();
		if (pairs < 0 || pairs > 16_000_000) throw new SkeletalMeshParseError('Bad duplicated-vertices index');
		r.skip(pairs * 8);
	}
	r.boolU32(); // bDisabled
	return { materialIndex, firstIndex, numTriangles, baseVertexIndex, numVertices, boneMap };
}

function readStreamed(r: Reader, sections: SkeletalMeshSection[], v: Variant): SkeletalMeshLOD {
	r.skipStripFlags();
	// FMultisizeIndexContainer: data size byte, then a bulk array.
	const dataSize = r.u8();
	const elt = r.i32();
	const count = r.i32();
	if ((dataSize !== 2 && dataSize !== 4) || elt !== dataSize || count < 0) throw new SkeletalMeshParseError(`Bad index container (${dataSize}/${elt})`);
	const indices = new Uint32Array(count);
	if (dataSize === 2) {
		const a = r.u16Array(count);
		for (let i = 0; i < count; i++) indices[i] = a[i]!;
	} else {
		indices.set(r.u32Array(count));
	}
	const pos = readPositionVertexBuffer(r);
	const vb = readStaticMeshVertexBuffer(r);
	if (vb.numVertices !== pos.numVertices) throw new SkeletalMeshParseError('Vertex count mismatch');
	const nv = pos.numVertices;

	// FSkinWeightVertexBuffer (UE 4.25+ "unlimited influences" layout).
	r.skipStripFlags();
	const variable = r.boolU32();
	const maxInf = r.i32();
	r.i32(); // NumBones
	const numW = r.i32();
	const use16 = v.use16Flag ? r.boolU32() : false;
	if (numW !== nv || maxInf < 1 || maxInf > 12 || variable) throw new SkeletalMeshParseError(`Bad skin weights (${numW} for ${nv} verts, ${maxInf} influences)`);
	const dEl = r.i32();
	const dCount = r.i32();
	const influences = maxInf > 4 ? 8 : 4;
	const stride = influences * (use16 ? 3 : 2);
	if (dEl !== 1 || dCount !== nv * stride) throw new SkeletalMeshParseError(`Skin weight data size ${dCount} ≠ ${nv} × ${stride}`);
	const data = r.bytesView(dCount);
	r.skipStripFlags();
	const lookup = r.i32();
	if (lookup !== 0 && lookup !== nv) throw new SkeletalMeshParseError('Bad skin-weight lookup');
	const lEl = r.i32();
	const lCount = r.i32();
	r.skip(lEl * lCount);

	const colors = v.hasVertexColors ? readColorVertexBuffer(r) : null;

	// Influences → skeleton bones, through each section's bone map.
	const boneIndices = new Uint16Array(nv * influences);
	const boneWeights = new Float32Array(nv * influences);
	const sectionOf = new Int32Array(nv).fill(-1);
	sections.forEach((s, i) => {
		for (let k = s.baseVertexIndex; k < Math.min(nv, s.baseVertexIndex + s.numVertices); k++) sectionOf[k] = i;
	});
	for (let i = 0; i < nv; i++) {
		const o = i * stride;
		const map = sections[sectionOf[i]!]?.boneMap;
		let total = 0;
		for (let k = 0; k < influences; k++) {
			const local = use16 ? data[o + k * 2]! | (data[o + k * 2 + 1]! << 8) : data[o + k]!;
			const w = data[o + influences * (use16 ? 2 : 1) + k]! / 255;
			boneIndices[i * influences + k] = map?.[local] ?? 0;
			boneWeights[i * influences + k] = w;
			total += w;
		}
		if (total > 0) for (let k = 0; k < influences; k++) boneWeights[i * influences + k] /= total;
	}
	return {
		numVertices: nv,
		positions: pos.positions,
		normals: vb.normals,
		uvs: vb.uvs,
		colors,
		indices,
		sections,
		influences,
		boneIndices,
		boneWeights,
	};
}
