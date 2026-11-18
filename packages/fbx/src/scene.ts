/**
 * FBX scene objects over the {@link parseFbxNodes} tree: models (the node
 * hierarchy, with FBX's full transform stack), meshes, materials and
 * textures, skins, and animation stacks. Objects live under `Objects`,
 * each `(id, "name\0\x01Class", subclass)`; `Connections` link them as
 * `C "OO" child parent` or `C "OP" child parent property`.
 *
 * Transforms follow the FBX SDK (`FbxNode` documentation, and Blender /
 * three.js FBXLoader which do the same): a node's local matrix is
 *
 *   T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹
 *
 * with column vectors and Euler rotations in degrees, `RotationOrder`
 * 0 = XYZ (X applied first). Mesh geometry also takes the node's
 * Geometric T/R/S, which don't propagate to children.
 *
 * Skinning: a skin's clusters each name a bone (the model connected to
 * the cluster) and `TransformLink`, the bone's world matrix at bind
 * time. A vertex moves by Σ wᵢ · Boneᵢ(t) · TransformLinkᵢ⁻¹ · Mesh,
 * with Mesh the mesh's world matrix in the bind pose (`Pose` objects),
 * as three.js' FBXLoader does. The clusters' own `Transform` isn't
 * trusted: the FBX SDK documents it as the mesh's bind matrix, but
 * AssetStudio (which exported most game rips, Pokémon GO's included)
 * writes TransformLink⁻¹ there.
 *
 * Animation: stacks own layers, layers own curve nodes, a curve node
 * drives one model property (`Lcl Translation` / `Rotation` / `Scaling`)
 * through up to three curves (`d|X`, `d|Y`, `d|Z`) of `KeyTime` (1/46186158000 s)
 * and `KeyValueFloat`, sampled here linearly.
 */

import { child, children, type FbxNode } from './binary.js';

export type Mat4 = Float64Array; // column-major

export const FBX_TICKS_PER_SECOND = 46186158000;

const ident = (): Mat4 => {
	const m = new Float64Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
};
export function mul(a: Mat4, b: Mat4): Mat4 {
	const o = new Float64Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
			o[c * 4 + r] = s;
		}
	return o;
}
export function invert(m: Mat4): Mat4 {
	const inv = new Float64Array(16);
	const a = m;
	inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
	inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
	inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
	inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
	inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
	inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
	inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
	inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
	inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
	inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
	inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
	inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
	inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
	inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
	inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
	inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
	const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
	if (!det) return ident();
	for (let i = 0; i < 16; i++) inv[i]! /= det;
	return inv;
}
const translate = (v: Vec3): Mat4 => {
	const m = ident();
	m[12] = v[0];
	m[13] = v[1];
	m[14] = v[2];
	return m;
};
const scale = (v: Vec3): Mat4 => {
	const m = ident();
	m[0] = v[0];
	m[5] = v[1];
	m[10] = v[2];
	return m;
};
/** Euler degrees → matrix for an FBX `RotationOrder` (0 XYZ … 5 ZYX: the first axis applies first). */
export function eulerMatrix(e: Vec3, order = 0): Mat4 {
	const r = (deg: number, axis: number): Mat4 => {
		const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), m = ident();
		if (axis === 0) {
			m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
		} else if (axis === 1) {
			m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
		} else {
			m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
		}
		return m;
	};
	const orders = [[0, 1, 2], [0, 2, 1], [1, 2, 0], [1, 0, 2], [2, 0, 1], [2, 1, 0]];
	const [a, b, c] = orders[order] ?? orders[0]!;
	return mul(r(e[c!]!, c!), mul(r(e[b!]!, b!), r(e[a!]!, a!)));
}

export type Vec3 = [number, number, number];

export interface FbxModel {
	id: bigint;
	name: string;
	/** `Null`, `LimbNode`, `Mesh`, … */
	type: string;
	parent: number;
	translation: Vec3;
	rotation: Vec3;
	scaling: Vec3;
	preRotation: Vec3;
	postRotation: Vec3;
	rotationOffset: Vec3;
	rotationPivot: Vec3;
	scalingOffset: Vec3;
	scalingPivot: Vec3;
	rotationOrder: number;
	geometric: Mat4;
}

export interface FbxMaterial {
	name: string;
	diffuseColor: Vec3;
	/** File name of the diffuse texture (or the first one connected), if any. */
	diffuseTexture: string | null;
	/** Every texture file connected, by property (`DiffuseColor`, …). */
	textures: { property: string; fileName: string }[];
}

export interface FbxSkin {
	/** Per control point: up to 4 (bone model index, weight). */
	bones: Int32Array;
	weights: Float32Array;
	/** Per cluster: bone model, its world matrix at bind (`TransformLink`), and TransformLink⁻¹ · Transform. */
	clusters: { bone: number; link: Mat4; bind: Mat4 }[];
}

export interface FbxMesh {
	name: string;
	model: number;
	/** Triangulated, one vertex per polygon corner. */
	positions: Float32Array;
	normals: Float32Array | null;
	uvs: Float32Array | null;
	/** Second UV set (`LayerElementUV` 1, or AssetStudio's `LayerElementNormalMapUV`), if any. */
	uvs1: Float32Array | null;
	colors: Float32Array | null;
	/** Control point each vertex came from (for skinning). */
	controlPoints: Uint32Array;
	controlPointPositions: Float64Array;
	controlPointCount: number;
	/** Material slot (index into the model's materials) per triangle. */
	triangleMaterials: Int32Array;
	/** Scene material index per slot. */
	materials: number[];
	skin: FbxSkin | null;
}

export interface FbxCurve {
	times: Float64Array; // seconds
	values: Float32Array;
}

export interface FbxAnimation {
	name: string;
	duration: number;
	/** Per model index: property → [x, y, z] curves (null = the model's static value). */
	tracks: Map<number, Partial<Record<'T' | 'R' | 'S', (FbxCurve | null)[]>>>;
}

export interface FbxScene {
	models: FbxModel[];
	meshes: FbxMesh[];
	materials: FbxMaterial[];
	/** File names of every texture object, connected to a material or not. */
	textureFiles: string[];
	animations: FbxAnimation[];
	upAxis: number;
	unitScale: number;
}

const nameOf = (n: FbxNode) => String(n.props[1] ?? '').split('\0')[0]!;
const idOf = (n: FbxNode) => BigInt(n.props[0] as bigint | number);

function props70(n: FbxNode | undefined): Map<string, unknown[]> {
	const out = new Map<string, unknown[]>();
	for (const p of children(child(n, 'Properties70'), 'P')) out.set(String(p.props[0]), p.props.slice(4));
	return out;
}
const vec = (p: Map<string, unknown[]>, k: string, d: Vec3): Vec3 => {
	const v = p.get(k);
	return v && v.length >= 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : d;
};
const toArray = (v: unknown): number[] =>
	ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number | bigint>, Number) : Array.isArray(v) ? v.map(Number) : [];

export function readFbxScene(nodes: FbxNode[]): FbxScene {
	const objects = nodes.find((n) => n.name === 'Objects');
	const conns = nodes.find((n) => n.name === 'Connections');
	if (!objects) throw new Error('FBX has no Objects');
	const byId = new Map<bigint, FbxNode>();
	for (const o of objects.children) if (o.props.length >= 2) byId.set(idOf(o), o);

	// Connections: child → parents (with property for OP).
	const parentsOf = new Map<bigint, { id: bigint; prop?: string }[]>();
	const childrenOf = new Map<bigint, { id: bigint; prop?: string }[]>();
	for (const c of conns?.children ?? []) {
		if (c.name !== 'C') continue;
		const kind = String(c.props[0]);
		const ch = BigInt(c.props[1] as bigint), pa = BigInt(c.props[2] as bigint);
		const prop = kind === 'OP' ? String(c.props[3]) : undefined;
		(parentsOf.get(ch) ?? parentsOf.set(ch, []).get(ch)!).push({ id: pa, prop });
		(childrenOf.get(pa) ?? childrenOf.set(pa, []).get(pa)!).push({ id: ch, prop });
	}
	const kids = (id: bigint, type?: string) => (childrenOf.get(id) ?? []).filter((c) => !type || byId.get(c.id)?.name === type);

	const settings = props70(nodes.find((n) => n.name === 'GlobalSettings'));
	const upAxis = Number(settings.get('UpAxis')?.[0] ?? 1);
	const unitScale = Number(settings.get('UnitScaleFactor')?.[0] ?? 1);

	// Models.
	const modelNodes = objects.children.filter((o) => o.name === 'Model');
	const modelIndex = new Map<bigint, number>();
	modelNodes.forEach((m, i) => modelIndex.set(idOf(m), i));
	const models: FbxModel[] = modelNodes.map((m) => {
		const p = props70(m);
		const parent = (parentsOf.get(idOf(m)) ?? []).map((x) => modelIndex.get(x.id)).find((x) => x !== undefined) ?? -1;
		const gT = vec(p, 'GeometricTranslation', [0, 0, 0]), gR = vec(p, 'GeometricRotation', [0, 0, 0]), gS = vec(p, 'GeometricScaling', [1, 1, 1]);
		return {
			id: idOf(m),
			name: nameOf(m),
			type: String(m.props[2] ?? ''),
			parent,
			translation: vec(p, 'Lcl Translation', [0, 0, 0]),
			rotation: vec(p, 'Lcl Rotation', [0, 0, 0]),
			scaling: vec(p, 'Lcl Scaling', [1, 1, 1]),
			preRotation: vec(p, 'PreRotation', [0, 0, 0]),
			postRotation: vec(p, 'PostRotation', [0, 0, 0]),
			rotationOffset: vec(p, 'RotationOffset', [0, 0, 0]),
			rotationPivot: vec(p, 'RotationPivot', [0, 0, 0]),
			scalingOffset: vec(p, 'ScalingOffset', [0, 0, 0]),
			scalingPivot: vec(p, 'ScalingPivot', [0, 0, 0]),
			rotationOrder: Number(p.get('RotationOrder')?.[0] ?? 0),
			geometric: mul(translate(gT), mul(eulerMatrix(gR), scale(gS))),
		};
	});

	// Materials and their textures.
	const materialNodes = objects.children.filter((o) => o.name === 'Material');
	const materialIndex = new Map<bigint, number>();
	const materials: FbxMaterial[] = materialNodes.map((m, i) => {
		materialIndex.set(idOf(m), i);
		const p = props70(m);
		const textures = kids(idOf(m), 'Texture').map((t) => {
			const tex = byId.get(t.id)!;
			const file = String(child(tex, 'RelativeFilename')?.props[0] ?? child(tex, 'FileName')?.props[0] ?? nameOf(tex));
			return { property: t.prop ?? '', fileName: file.split(/[\\/]/).pop()! };
		});
		const diffuse = textures.find((t) => /diffuse|base/i.test(t.property)) ?? textures[0];
		return { name: nameOf(m), diffuseColor: vec(p, 'DiffuseColor', [1, 1, 1]), diffuseTexture: diffuse?.fileName ?? null, textures };
	});

	// Bind poses: model id → world matrix at bind time.
	const bindPose = new Map<bigint, Mat4>();
	for (const p of objects.children) {
		if (p.name !== 'Pose') continue;
		for (const pn of children(p, 'PoseNode')) {
			const id = child(pn, 'Node')?.props[0];
			const m = toArray(child(pn, 'Matrix')?.props[0]);
			if (id !== undefined && m.length === 16 && !bindPose.has(BigInt(id as bigint))) bindPose.set(BigInt(id as bigint), Float64Array.from(m));
		}
	}

	// Meshes.
	const meshes: FbxMesh[] = [];
	for (const g of objects.children) {
		if (g.name !== 'Geometry' || g.props[2] !== 'Mesh') continue;
		const owner = (parentsOf.get(idOf(g)) ?? []).map((x) => modelIndex.get(x.id)).find((x) => x !== undefined);
		if (owner === undefined) continue;
		meshes.push(readMesh(g, owner));
	}

	function readMesh(g: FbxNode, model: number): FbxMesh {
		const cp = (child(g, 'Vertices')?.props[0] as Float64Array | undefined) ?? new Float64Array(0);
		const pvi = (child(g, 'PolygonVertexIndex')?.props[0] as Int32Array | undefined) ?? new Int32Array(0);
		const cpCount = cp.length / 3;

		// Layer element readers: value index for polygon-vertex k (corner), control point c, polygon p.
		const layer = (name: string, dataKey: string, indexKey: string, stride: number, nth = 0) => {
			const el = children(g, name)[nth];
			if (!el) return null;
			const data = toArray(child(el, dataKey)?.props[0] as unknown);
			const index = toArray(child(el, indexKey)?.props[0]);
			const mapping = String(child(el, 'MappingInformationType')?.props[0] ?? '');
			const ref = String(child(el, 'ReferenceInformationType')?.props[0] ?? 'Direct');
			const direct = ref === 'Direct';
			return (k: number, c: number, p: number): number[] => {
				let i = mapping === 'ByPolygonVertex' ? k : mapping === 'ByPolygon' ? p : mapping === 'AllSame' ? 0 : c;
				if (!direct) i = index[i] ?? 0;
				return data.slice(i * stride, i * stride + stride);
			};
		};
		const normalAt = layer('LayerElementNormal', 'Normals', 'NormalsIndex', 3);
		const uvAt = layer('LayerElementUV', 'UV', 'UVIndex', 2);
		const uv1At = layer('LayerElementUV', 'UV', 'UVIndex', 2, 1) ?? layer('LayerElementNormalMapUV', 'UV', 'UVIndex', 2);
		const colorAt = layer('LayerElementColor', 'Colors', 'ColorIndex', 4);
		const matEl = child(g, 'LayerElementMaterial');
		const matData = toArray(child(matEl, 'Materials')?.props[0]);
		const matAllSame = String(child(matEl, 'MappingInformationType')?.props[0] ?? '') === 'AllSame';

		const pos: number[] = [], nrm: number[] = [], uv: number[] = [], uv1: number[] = [], col: number[] = [], cps: number[] = [], triMat: number[] = [];
		let start = 0, polygon = 0;
		for (let k = 0; k < pvi.length; k++) {
			if (pvi[k]! >= 0) continue;
			const corners: { k: number; c: number }[] = [];
			for (let j = start; j <= k; j++) corners.push({ k: j, c: j === k ? ~pvi[j]! : pvi[j]! });
			const slot = matAllSame ? (matData[0] ?? 0) : (matData[polygon] ?? 0);
			// Fan triangulation.
			for (let t = 1; t + 1 < corners.length; t++) {
				for (const cn of [corners[0]!, corners[t]!, corners[t + 1]!]) {
					pos.push(cp[cn.c * 3]!, cp[cn.c * 3 + 1]!, cp[cn.c * 3 + 2]!);
					cps.push(cn.c);
					if (normalAt) nrm.push(...normalAt(cn.k, cn.c, polygon));
					if (uvAt) uv.push(...uvAt(cn.k, cn.c, polygon));
					if (uv1At) uv1.push(...uv1At(cn.k, cn.c, polygon));
					if (colorAt) col.push(...colorAt(cn.k, cn.c, polygon));
				}
				triMat.push(slot);
			}
			start = k + 1;
			polygon++;
		}

		// Materials of the owning model, in connection order = slot order.
		const slots = kids(models[model]!.id, 'Material').map((m) => materialIndex.get(m.id)!).filter((x) => x !== undefined);

		// Skin.
		let skin: FbxSkin | null = null;
		const skinNode = kids(idOf(g), 'Deformer').map((d) => byId.get(d.id)!).find((d) => d.props[2] === 'Skin');
		if (skinNode) {
			const bones = new Int32Array(cpCount * 4).fill(-1);
			const weights = new Float32Array(cpCount * 4);
			const clusters: FbxSkin['clusters'] = [];
			for (const c of kids(idOf(skinNode), 'Deformer')) {
				const cl = byId.get(c.id)!;
				if (cl.props[2] !== 'Cluster') continue;
				const bone = kids(c.id, 'Model').map((m) => modelIndex.get(m.id)).find((x) => x !== undefined);
				if (bone === undefined) continue;
				const link = Float64Array.from(toArray(child(cl, 'TransformLink')?.props[0]));
				const ci = clusters.length;
				const linkM = link.length === 16 ? link : ident();
				const meshBind = bindPose.get(models[model]!.id) ?? ident();
				clusters.push({ bone, link: linkM, bind: mul(invert(linkM), mul(meshBind, models[model]!.geometric)) });
				const idx = toArray(child(cl, 'Indexes')?.props[0]);
				const w = toArray(child(cl, 'Weights')?.props[0]);
				for (let i = 0; i < idx.length; i++) {
					const v = idx[i]!, wt = w[i] ?? 0;
					if (v < 0 || v >= cpCount || wt <= 0) continue;
					// Keep the 4 heaviest influences.
					let slot = -1, min = Infinity;
					for (let s = 0; s < 4; s++) {
						if (bones[v * 4 + s] === -1) {
							slot = s;
							break;
						}
						if (weights[v * 4 + s]! < min) {
							min = weights[v * 4 + s]!;
							slot = s;
						}
					}
					if (bones[v * 4 + slot] !== -1 && weights[v * 4 + slot]! >= wt) continue;
					bones[v * 4 + slot] = ci;
					weights[v * 4 + slot] = wt;
				}
			}
			// Normalise.
			for (let v = 0; v < cpCount; v++) {
				let s = 0;
				for (let j = 0; j < 4; j++) s += weights[v * 4 + j]!;
				if (s > 0) for (let j = 0; j < 4; j++) weights[v * 4 + j]! /= s;
			}
			if (clusters.length) skin = { bones, weights, clusters };
		}

		return {
			name: nameOf(g),
			model,
			positions: Float32Array.from(pos),
			normals: nrm.length ? Float32Array.from(nrm) : null,
			uvs: uv.length ? Float32Array.from(uv) : null,
			uvs1: uv1.length ? Float32Array.from(uv1) : null,
			colors: col.length ? Float32Array.from(col) : null,
			controlPoints: Uint32Array.from(cps),
			controlPointPositions: cp,
			controlPointCount: cpCount,
			triangleMaterials: Int32Array.from(triMat),
			materials: slots,
			skin,
		};
	}

	// Animations.
	const animations: FbxAnimation[] = [];
	for (const s of objects.children) {
		if (s.name !== 'AnimationStack') continue;
		const tracks: FbxAnimation['tracks'] = new Map();
		let duration = 0;
		const sp = props70(s);
		const stop = sp.get('LocalStop')?.[0] ?? sp.get('ReferenceStop')?.[0];
		for (const l of kids(idOf(s), 'AnimationLayer')) {
			for (const cn of kids(l.id, 'AnimationCurveNode')) {
				const target = (parentsOf.get(cn.id) ?? []).find((p) => p.prop && modelIndex.has(p.id));
				if (!target) continue;
				const key = target.prop === 'Lcl Translation' ? 'T' : target.prop === 'Lcl Rotation' ? 'R' : target.prop === 'Lcl Scaling' ? 'S' : null;
				if (!key) continue;
				const curves: (FbxCurve | null)[] = [null, null, null];
				for (const c of kids(cn.id, 'AnimationCurve')) {
					const axis = c.prop === 'd|X' ? 0 : c.prop === 'd|Y' ? 1 : c.prop === 'd|Z' ? 2 : -1;
					if (axis < 0) continue;
					const cv = byId.get(c.id)!;
					const t = child(cv, 'KeyTime')?.props[0];
					const v = child(cv, 'KeyValueFloat')?.props[0];
					if (!t || !v) continue;
					const times = Float64Array.from(toArray(t), (x) => x / FBX_TICKS_PER_SECOND);
					const values = v instanceof Float32Array ? v : Float32Array.from(toArray(v));
					if (times.length) duration = Math.max(duration, times[times.length - 1]!);
					curves[axis] = { times, values };
				}
				const mi = modelIndex.get(target.id)!;
				const tr = tracks.get(mi) ?? tracks.set(mi, {}).get(mi)!;
				tr[key] = curves;
			}
		}
		if (stop !== undefined) duration = Math.max(duration, Number(stop) / FBX_TICKS_PER_SECOND);
		animations.push({ name: nameOf(s), duration, tracks });
	}

	const textureFiles = objects.children
		.filter((o) => o.name === 'Texture')
		.map((t) => String(child(t, 'RelativeFilename')?.props[0] ?? child(t, 'FileName')?.props[0] ?? nameOf(t)).split(/[\\/]/).pop()!);
	return { models, meshes, materials, textureFiles, animations: animations.filter((a) => a.tracks.size > 0), upAxis, unitScale };
}

function sampleCurve(c: FbxCurve, t: number): number {
	const { times, values } = c;
	if (!times.length) return 0;
	if (t <= times[0]!) return values[0]!;
	if (t >= times[times.length - 1]!) return values[values.length - 1]!;
	let lo = 0, hi = times.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (times[mid]! <= t) lo = mid;
		else hi = mid;
	}
	const f = (t - times[lo]!) / (times[hi]! - times[lo]! || 1);
	return values[lo]! + (values[hi]! - values[lo]!) * f;
}

/** Every model's world matrix, at the bind pose or at `time` (seconds) in `animation`. */
export function fbxWorldMatrices(scene: FbxScene, animation?: FbxAnimation | null, time = 0): Mat4[] {
	const out: (Mat4 | undefined)[] = new Array(scene.models.length);
	const local = (i: number): Mat4 => {
		const m = scene.models[i]!;
		const tr = animation?.tracks.get(i);
		const pick = (key: 'T' | 'R' | 'S', base: Vec3): Vec3 => {
			const cs = tr?.[key];
			if (!cs) return base;
			return [0, 1, 2].map((a) => (cs[a] ? sampleCurve(cs[a]!, time) : base[a]!)) as Vec3;
		};
		const T = pick('T', m.translation), R = pick('R', m.rotation), S = pick('S', m.scaling);
		const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
		const rp = translate(m.rotationPivot), sp = translate(m.scalingPivot);
		let mat = translate(T);
		mat = mul(mat, translate(m.rotationOffset));
		mat = mul(mat, rp);
		mat = mul(mat, eulerMatrix(m.preRotation));
		mat = mul(mat, eulerMatrix(R, m.rotationOrder));
		mat = mul(mat, invert(eulerMatrix(m.postRotation)));
		mat = mul(mat, translate(neg(m.rotationPivot)));
		mat = mul(mat, translate(m.scalingOffset));
		mat = mul(mat, sp);
		mat = mul(mat, scale(S));
		mat = mul(mat, translate(neg(m.scalingPivot)));
		return mat;
	};
	const world = (i: number): Mat4 => {
		const cached = out[i];
		if (cached) return cached;
		const p = scene.models[i]!.parent;
		const w = p >= 0 ? mul(world(p), local(i)) : local(i);
		out[i] = w;
		return w;
	};
	for (let i = 0; i < scene.models.length; i++) world(i);
	return out as Mat4[];
}

/**
 * Pose a mesh into world space: skinned through its clusters, or rigidly
 * with its model's world matrix (and Geometric transform). Writes
 * `positions` (and `normals` when both are given) per triangle corner.
 */
export function poseFbxMesh(scene: FbxScene, mesh: FbxMesh, worlds: Mat4[], positions: Float32Array, normals?: Float32Array | null): void {
	const cpOut = new Float32Array(mesh.controlPointCount * 3);
	const cpN = new Float32Array(mesh.controlPointCount * 9); // 3x3 per control point (for normals)
	const src = mesh.controlPointPositions;
	if (mesh.skin) {
		const skin = mesh.skin;
		const mats = skin.clusters.map((c) => mul(worlds[c.bone]!, c.bind));
		for (let v = 0; v < mesh.controlPointCount; v++) {
			const x = src[v * 3]!, y = src[v * 3 + 1]!, z = src[v * 3 + 2]!;
			let ox = 0, oy = 0, oz = 0;
			const n = new Float64Array(9);
			let total = 0;
			for (let j = 0; j < 4; j++) {
				const ci = skin.bones[v * 4 + j]!, w = skin.weights[v * 4 + j]!;
				if (ci < 0 || w <= 0) continue;
				const m = mats[ci]!;
				ox += w * (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!);
				oy += w * (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!);
				oz += w * (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
				for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) n[c * 3 + r]! += w * m[c * 4 + r]!;
				total += w;
			}
			if (total === 0) {
				// Unweighted: follow the mesh's own model.
				const m = mul(worlds[mesh.model]!, scene.models[mesh.model]!.geometric);
				ox = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
				oy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
				oz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
				for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) n[c * 3 + r] = m[c * 4 + r]!;
			}
			cpOut[v * 3] = ox;
			cpOut[v * 3 + 1] = oy;
			cpOut[v * 3 + 2] = oz;
			cpN.set(n, v * 9);
		}
	} else {
		const m = mul(worlds[mesh.model]!, scene.models[mesh.model]!.geometric);
		for (let v = 0; v < mesh.controlPointCount; v++) {
			const x = src[v * 3]!, y = src[v * 3 + 1]!, z = src[v * 3 + 2]!;
			cpOut[v * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
			cpOut[v * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
			cpOut[v * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
			for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cpN[v * 9 + c * 3 + r] = m[c * 4 + r]!;
		}
	}
	const cps = mesh.controlPoints;
	for (let i = 0; i < cps.length; i++) {
		const c = cps[i]!;
		positions[i * 3] = cpOut[c * 3]!;
		positions[i * 3 + 1] = cpOut[c * 3 + 1]!;
		positions[i * 3 + 2] = cpOut[c * 3 + 2]!;
		if (normals && mesh.normals) {
			const nx = mesh.normals[i * 3]!, ny = mesh.normals[i * 3 + 1]!, nz = mesh.normals[i * 3 + 2]!;
			const n = cpN.subarray(c * 9, c * 9 + 9);
			const a = n[0]! * nx + n[3]! * ny + n[6]! * nz, b = n[1]! * nx + n[4]! * ny + n[7]! * nz, d = n[2]! * nx + n[5]! * ny + n[8]! * nz;
			const l = Math.hypot(a, b, d) || 1;
			normals[i * 3] = a / l;
			normals[i * 3 + 1] = b / l;
			normals[i * 3 + 2] = d / l;
		}
	}
}
