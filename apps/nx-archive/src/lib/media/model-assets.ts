/**
 * Headless model loading for the media library: turn a model item into
 * a single posed, textured {@link ModelAsset} without mounting a viewer,
 * so the library can render thumbnails and batch-export STL / 3MF.
 *
 * Every loader reuses the same parse / assemble code as the format's
 * preview, and poses the model the way the preview opens it (the
 * library's "rest / idle" pose): FF7 field models use a stored 1-frame
 * bind pose, FF7 battle and FF8 models frame 0 of their first
 * animation, Game Freak models their idle clip.
 *
 * Browser-only (some builders live in component modules); the scan
 * itself ({@link ./scanner}) stays DOM-free.
 */

import { GfbmdlPose, colorUvTransform, groupVisibility, materialValues } from '@tootallnate/gfbmdl';
import { isDummyMch, parseMch } from '@tootallnate/ff8-model';
import { parseDat } from '@tootallnate/ff8-battle';

import { inferAssetClassName, isUasset, parseStaticMesh, parseUasset, readExportProperties } from '@tootallnate/uasset';

import type { RenderableMesh, RenderableMeshLOD } from '~/components/mesh-viewer';
import { bakeBfresBindPose, loadBfresShapes } from '~/components/bfres-viewer';
import { decodeUnityObjectNode, loadUnityMeshData } from '~/components/preview-pane';
import { defaultClip as defaultUnityClip } from '~/components/unity-mesh-viewer';
import * as ff8Mch from '~/components/ff8-mch-preview';
import * as ff8Battle from '~/components/ff8-battle-preview';
import { adaptMesh as phyreLod, findPhyreTextureNode } from '~/components/phyre-mesh-viewer';

import type { Node } from '../archive';
import type { ExportMaterial, ExportMesh } from '../mesh-export';
import { assembleBattle, buildBattleRig, poseFf7BattleRest } from '../ff7-battle-rig';
import { assembleHrcCharacter, buildCompositeRig, poseFf7FieldRest } from '../ff7-field-rig';
import { bakeSectionUvs, parseGfbmdlForView } from '../gfbmdl-view';
import {
	decodePhyreTextureForMaterial,
	ff7ExtractTriangles,
	parseFf7HrcForView,
	parseFf7PForView,
	parseHsdModelForView,
	parseJ3dForView,
	parseN64ModelForView,
	parsePhyreMeshForView,
	type HsdModelRef,
	type HsdModelView,
	type J3dModelView,
	type N64ModelRef,
	type N64ModelView,
} from '../preview';
import {
	extractMaterialPathsFromProperties,
	pickDiffuseTexture,
	resolveMaterialTextures,
	type DecodedTexture,
} from '../uasset-material-chain';
import { createAssetResolver } from '../uasset-resolver';
import { loadHaloModelView, type HaloModelRef } from '../halo';
import { unityMeshDisplayColors } from '../unity-mesh';
import { findNodeById } from '../unity-external';

export interface ModelAsset {
	/** One LOD, already posed. Absent when {@link meshes} is set. */
	mesh?: RenderableMesh;
	/**
	 * Pre-baked world-space (Y-up) meshes, for formats that pose through
	 * their own Three.js scene graph (BFRES GPU skinning). Takes
	 * precedence over {@link mesh}.
	 */
	meshes?: ExportMesh[];
	/** Per material slot (section `materialIndex`). */
	textures: (DecodedTexture | null)[];
	/** Flat colours (sRGB 0–1) for slots without a texture. */
	baseColors?: ([number, number, number] | null)[];
	/** Pose used, for export file names (e.g. `fi01_wait01`). */
	pose?: string;
	triangles: number;
	vertices: number;
	/** `[found, wanted]` textures when known. */
	texturesFound?: [number, number];
	animations?: number;
}

/** Preview kinds the library can load headlessly. */
export const HEADLESS_MODEL_KINDS = new Set([
	'gfbmdl-model',
	'hsd-model',
	'n64-model',
	'halo-model',
	'j3d-model',
	'ff7-hrc',
	'ff7-battle-skeleton',
	'ff7-pmesh',
	'ff8-mch',
	'ff8-battle-dat',
	'phyre-mesh',
	'bfres',
	'unity-object',
	'uasset-info',
]);

export function canLoadModelHeadless(previewKind: string): boolean {
	return HEADLESS_MODEL_KINDS.has(previewKind);
}

const bytesOf = async (node: Node) => new Uint8Array(await (await node.blob!()).arrayBuffer());

function asset(lod: RenderableMeshLOD, textures: (DecodedTexture | null)[], extra: Partial<ModelAsset> = {}, upAxis: RenderableMesh['upAxis'] = 'y-up'): ModelAsset {
	return {
		mesh: { lods: [lod], upAxis },
		textures,
		triangles: lod.indices.length / 3,
		vertices: lod.numVertices,
		...extra,
	};
}

// ---- adapters shared with the per-format viewers ----

export function hsdLod(view: HsdModelView): RenderableMeshLOD {
	const { mesh } = view;
	return {
		numVertices: mesh.numVertices,
		positions: mesh.positions,
		normals: mesh.normals,
		uv: mesh.uv,
		indices: mesh.indices,
		sections: mesh.sections.length
			? mesh.sections.map((s) => ({ materialIndex: s.materialIndex, firstIndex: s.indexOffset, numTriangles: s.indexCount / 3 }))
			: [{ materialIndex: -1, firstIndex: 0, numTriangles: mesh.indices.length / 3 }],
	};
}

export function n64Lod(view: N64ModelView): RenderableMeshLOD {
	const { mesh } = view;
	return {
		numVertices: mesh.positions.length / 3,
		positions: mesh.positions,
		// Only lit geometry has real normals (the viewer derives flat
		// ones otherwise); conversely, for lit geometry the colour bytes
		// held the normal, so vertex colours apply to unlit meshes only.
		normals: mesh.usesLighting ? mesh.normals : undefined,
		colors: mesh.usesLighting ? undefined : mesh.colors,
		uv: mesh.uvs.length > 0 ? mesh.uvs : undefined,
		indices: mesh.indices,
		sections: mesh.groups.map((g) => ({ materialIndex: g.materialIndex, firstIndex: g.firstIndex, numTriangles: g.numTriangles })),
	};
}

export function j3dLod(view: J3dModelView): RenderableMeshLOD {
	const { mesh } = view;
	return {
		numVertices: mesh.numVertices,
		positions: mesh.positions,
		normals: mesh.normals,
		colors: mesh.colors,
		uv: mesh.uv,
		indices: mesh.indices,
		sections: mesh.sections.map((s) => ({ materialIndex: s.materialIndex, firstIndex: s.firstIndex, numTriangles: s.numTriangles })),
	};
}

// ---- loaders ----

async function loadGfbmdl(node: Node, root: Node | null): Promise<ModelAsset> {
	const v = await parseGfbmdlForView(node, root);
	const positions = Float32Array.from(v.mesh.positions);
	const normals = v.mesh.normals ? Float32Array.from(v.mesh.normals) : undefined;
	const uv = v.uv ? Float32Array.from(v.uv) : undefined;
	const clip = v.clips[v.defaultClip] ?? null;
	if (clip) {
		const pose = new GfbmdlPose(v.model, v.mesh);
		pose.setPose(clip.anim, 0);
		pose.skin(positions, normals ?? null, groupVisibility(v.model, clip.anim, 0) ?? undefined);
		if (uv) {
			const over = materialValues(clip.anim, 0);
			const transforms = v.model.materials.map((m, i) =>
				over.has(m.name) ? colorUvTransform({ ...m, values: { ...m.values, ...over.get(m.name) } }) : v.uvTransforms[i]!,
			);
			bakeSectionUvs(v.mesh, transforms, uv);
		}
	}
	return asset(
		{ numVertices: v.mesh.numVertices, positions, normals, uv, indices: v.indices, sections: v.sections },
		v.textures,
		{
			baseColors: v.baseColors,
			pose: clip?.name,
			texturesFound: [v.textureNamesFound, v.textureNamesWanted],
			animations: v.clips.length,
		},
	);
}

async function loadFf7Field(node: Node, root: Node | null): Promise<ModelAsset> {
	const hrc = await parseFf7HrcForView(await node.blob!());
	const assembled = await assembleHrcCharacter(hrc, root, node);
	const rig = assembled.hasGeometry ? buildCompositeRig(assembled) : null;
	if (!rig) throw new Error(assembled.warnings[0] ?? 'No geometry resolved for this skeleton');
	const pose = await poseFf7FieldRest(assembled, rig);
	const wanted = assembled.bones.reduce((n, b) => n + b.meshes.reduce((m, x) => m + (x.rsd?.textures.length ?? 0), 0), 0);
	const found = assembled.bones.reduce((n, b) => n + b.meshes.reduce((m, x) => m + x.textures.filter(Boolean).length, 0), 0);
	return asset(rig.mesh.lods[0]!, rig.textures, {
		pose: pose ?? 'rest',
		texturesFound: [found, wanted],
		animations: assembled.availableAnims.length,
	});
}

async function loadFf7Battle(node: Node, root: Node | null): Promise<ModelAsset> {
	const assembled = await assembleBattle(node, root);
	const rig = buildBattleRig(assembled);
	if (!rig) throw new Error(assembled.warnings[0] ?? 'No geometry resolved for this battle model');
	const anims = await poseFf7BattleRest(assembled, rig);
	return asset(rig.mesh.lods[0]!, rig.textures, {
		pose: anims.length ? 'body-00' : 'rest',
		texturesFound: [assembled.textures.filter(Boolean).length, assembled.textures.length],
		animations: anims.length,
	});
}

async function loadFf7P(node: Node): Promise<ModelAsset> {
	const view = await parseFf7PForView(await node.blob!());
	let total = 0;
	for (const g of view.groups) total += g.numPolygons * 3;
	const positions = new Float32Array(total * 3);
	const normals = new Float32Array(total * 3);
	const colors = new Float32Array(total * 3);
	const indices = new Uint32Array(total);
	const sections: RenderableMeshLOD['sections'] = [];
	let v = 0;
	let i = 0;
	for (const g of view.groups) {
		const tris = ff7ExtractTriangles(view, g);
		positions.set(tris.positions, v * 3);
		normals.set(tris.normals, v * 3);
		colors.set(tris.colors, v * 3);
		for (let k = 0; k < tris.indices.length; k++) indices[i + k] = tris.indices[k]! + v;
		sections.push({ materialIndex: 0, firstIndex: i, numTriangles: Math.floor(tris.indices.length / 3) });
		v += tris.positions.length / 3;
		i += tris.indices.length;
	}
	// FF7 is −Y-up.
	return asset({ numVertices: v, positions, normals, colors, indices, sections }, [], {}, 'y-down');
}

async function loadFf8Mch(node: Node): Promise<ModelAsset> {
	const bytes = await bytesOf(node);
	if (isDummyMch(bytes)) throw new Error('Placeholder MCH (no geometry)');
	const parsed = parseMch(bytes);
	const rig = ff8Mch.buildRig(parsed, ff8Mch.sliceAndDecodeTims(bytes, parsed));
	const first = parsed.animations.find((a) => a.frames.length > 0);
	const f0 = first?.frames[0];
	ff8Mch.applySkinning(rig, ff8Mch.computeBoneMatrices(parsed, f0?.rootTranslation ?? null, f0?.boneRotations ?? null), null);
	return asset(rig.mesh.lods[0]!, rig.textures, { pose: first ? 'anim-00' : 'rest', animations: parsed.animations.length });
}

async function loadFf8Battle(node: Node): Promise<ModelAsset> {
	const dat = parseDat(await bytesOf(node));
	const rig = ff8Battle.buildRig(dat);
	if (!rig) throw new Error('No skeleton / geometry in this battle DAT');
	const f0 = dat.animations?.find((a) => a.frames.length > 0)?.frames[0];
	ff8Battle.applySkinningToTypedArrays(rig, ff8Battle.computeBoneMatrices(dat, f0?.rootTranslation ?? null, f0?.boneRotations ?? null));
	return asset(rig.mesh.lods[0]!, rig.textures, { pose: f0 ? 'anim-00' : 'rest', animations: dat.animations?.length ?? 0 });
}

async function loadPhyre(node: Node, root: Node | null): Promise<ModelAsset> {
	const view = await parsePhyreMeshForView(await node.blob!());
	const lod = phyreLod(view);
	// FFX HD meshes are +Y-down (the viewer defaults "Flip Y" on):
	// mirror Y and reverse winding so faces still point outward.
	for (let k = 1; k < lod.positions.length; k += 3) lod.positions[k] = -lod.positions[k]!;
	if (lod.normals) for (let k = 1; k < lod.normals.length; k += 3) lod.normals[k] = -lod.normals[k]!;
	for (let k = 0; k < lod.indices.length; k += 3) {
		const t = lod.indices[k + 1]!;
		lod.indices[k + 1] = lod.indices[k + 2]!;
		lod.indices[k + 2] = t;
	}
	let primary: DecodedTexture | null = null;
	const refs = view.assetRefs.filter((r) => r.isTexture);
	if (root) {
		for (const ref of refs) {
			const texNode = await findPhyreTextureNode(root, node, ref.name.replace(/\.dds$/i, ''));
			if (!texNode?.blob) continue;
			primary = await decodePhyreTextureForMaterial(await texNode.blob(), ref.path);
			if (primary) break;
		}
	}
	const slots = Math.max(1, ...lod.sections.map((s) => s.materialIndex + 1));
	return asset(lod, new Array(slots).fill(primary), { texturesFound: [primary ? 1 : 0, refs.length ? 1 : 0] });
}

async function loadBfres(node: Node, root: Node | null): Promise<ModelAsset> {
	const loaded = await loadBfresShapes(node, root);
	const visible = loaded.records.filter((r) => r.visible);
	const meshes = bakeBfresBindPose(loaded);
	let triangles = 0;
	let vertices = 0;
	for (const m of meshes) {
		triangles += m.indices.length / 3;
		vertices += m.positions.length / 3;
	}
	return {
		meshes,
		textures: [],
		pose: 'bind',
		triangles,
		vertices,
		texturesFound: [visible.filter((r) => r.hasAlbedo).length, visible.length],
		animations: loaded.animations.skeletal.length,
	};
}

const UNITY_IDLE = ['idle', 'wait', 'stand'];

async function loadUnityMesh(node: Node, root: Node | null): Promise<ModelAsset> {
	if (node.meta?.unityClass !== 'Mesh') throw new Error('Not a Unity Mesh object');
	const { parsed, decoded } = await decodeUnityObjectNode(node);
	const data = await loadUnityMeshData(decoded, parsed, node, root, node.meta?.unitySerializedFileNodeId as string | undefined);
	const g = data.geometry;
	const positions = Float32Array.from(g.positions);
	const normals = g.normals ? Float32Array.from(g.normals) : undefined;
	let pose: string | undefined;
	const anim = data.animation;
	if (anim && anim.bodyClips.length) {
		// Same default as the viewer: an idle-ish clip, else the first.
		const clip = anim.bodyClips[Math.max(0, defaultUnityClip(anim.bodyClips, UNITY_IDLE))]!;
		anim.player.setLayer(0, clip, 0);
		anim.player.apply(positions, normals ?? null);
		pose = clip.clip.name;
	}
	const display = unityMeshDisplayColors(g.colors, g.vertexCount, data.baseColors);
	return asset(
		{
			numVertices: g.vertexCount,
			positions,
			normals,
			uv: g.uv0 ?? undefined,
			colors: display.colors,
			indices: g.indices,
			sections: g.subMeshes.map((sm, i) => ({ materialIndex: i, firstIndex: sm.firstIndex, numTriangles: sm.indexCount / 3 })),
		},
		data.textures,
		{
			baseColors: display.baseColors,
			pose,
			// Vertex-coloured meshes with no textures at all (e.g. Pokémon
			// Quest) aren't missing anything.
			texturesFound:
				display.colors && !data.textures.some(Boolean)
					? undefined
					: [data.textures.filter(Boolean).length, g.subMeshes.length],
			animations: anim ? anim.bodyClips.length + anim.overlayClips.length : 0,
		},
	);
}

async function loadUeMesh(node: Node, root: Node | null): Promise<ModelAsset> {
	const bytes = await bytesOf(node);
	if (!isUasset(bytes)) throw new Error('Not a legacy .uasset (Zen packages are not supported yet)');
	const parsed = parseUasset(bytes);
	const cls = inferAssetClassName(parsed);
	if (cls !== 'StaticMesh') throw new Error(`${cls ?? 'This'} geometry is not supported yet (only StaticMesh)`);
	const uexpNode = root ? await findNodeById(root, node.id.replace(/\.uasset$/i, '.uexp')) : null;
	if (!uexpNode?.blob) throw new Error('Missing the .uexp companion with the mesh data');
	const uexp = await bytesOf(uexpNode);
	let exportIdx = -1;
	for (let i = 0; i < parsed.exports.length; i++) {
		const exp = parsed.exports[i]!;
		if (exp.classIndex >= 0) continue;
		const imp = parsed.imports[-exp.classIndex - 1];
		if (imp && parsed.names[imp.objectName.nameIndex]?.value === 'StaticMesh') {
			exportIdx = i;
			break;
		}
	}
	if (exportIdx < 0) throw new Error('No StaticMesh export found');
	const mesh = parseStaticMesh(parsed, uexp, exportIdx);
	const lod = mesh.lods[0];
	if (!lod) throw new Error('StaticMesh has no LODs');
	let textures: (DecodedTexture | null)[] = [];
	try {
		const { properties } = readExportProperties(parsed, uexp, exportIdx);
		const prop = properties.find((p) => p.name === 'StaticMaterials');
		if (prop && prop.value.kind === 'array') {
			const paths = extractMaterialPathsFromProperties(prop.value.values, parsed);
			const sets = await resolveMaterialTextures(paths, createAssetResolver(root, node.id));
			textures = sets.map((set) => (set ? pickDiffuseTexture(set) : null));
		}
	} catch {
		// untextured is still a model
	}
	const slots = Math.max(0, ...lod.sections.map((s) => s.materialIndex + 1));
	return asset(
		{
			numVertices: lod.numVertices,
			positions: lod.positions,
			normals: lod.normals,
			uv: lod.uvs[0],
			colors: undefined,
			indices: lod.indices,
			sections: lod.sections.map((sec) => ({ materialIndex: sec.materialIndex, firstIndex: sec.firstIndex, numTriangles: sec.numTriangles })),
		},
		textures,
		{ texturesFound: [textures.filter(Boolean).length, slots] },
		// UE is left-handed Z-up; the viewer rotates −90° about X.
		'z-up',
	);
}

/** Load a model item headlessly. Throws when the format has no headless path. */
export async function loadModelAsset(node: Node, previewKind: string, root: Node | null): Promise<ModelAsset> {
	switch (previewKind) {
		case 'gfbmdl-model':
			return loadGfbmdl(node, root);
		case 'hsd-model': {
			const v = await parseHsdModelForView(await node.blob!(), node.meta?.hsdModel as HsdModelRef);
			return asset(hsdLod(v), v.textures);
		}
		case 'n64-model': {
			const v = await parseN64ModelForView(await node.blob!(), node.meta?.n64Model as N64ModelRef);
			return asset(n64Lod(v), v.texturedMaterials > 0 ? v.textures : []);
		}
		case 'halo-model': {
			const v = await loadHaloModelView(node.meta?.haloModel as HaloModelRef);
			return asset(v.mesh.lods[0], v.textures, {}, 'z-up');
		}
		case 'j3d-model': {
			const v = await parseJ3dForView(await node.blob!());
			return asset(j3dLod(v), v.texturedMaterials > 0 ? v.textures : []);
		}
		case 'ff7-hrc':
			return loadFf7Field(node, root);
		case 'ff7-battle-skeleton':
			return loadFf7Battle(node, root);
		case 'ff7-pmesh':
			return loadFf7P(node);
		case 'ff8-mch':
			return loadFf8Mch(node);
		case 'ff8-battle-dat':
			return loadFf8Battle(node);
		case 'phyre-mesh':
			return loadPhyre(node, root);
		case 'bfres':
			return loadBfres(node, root);
		case 'unity-object':
			return loadUnityMesh(node, root);
		case 'uasset-info':
			return loadUeMesh(node, root);
		default:
			throw new Error(`No headless loader for ${previewKind}`);
	}
}

// ---- export ----

/** Apply the mesh's up-axis convention so exports are Y-up like the viewer's scene. */
function upAxisPositions(positions: Float32Array, upAxis: RenderableMesh['upAxis']): Float32Array {
	if (!upAxis || upAxis === 'y-up') return positions;
	const out = new Float32Array(positions.length);
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
		if (upAxis === 'z-up') {
			out[i] = x;
			out[i + 1] = z;
			out[i + 2] = -y;
		} else {
			out[i] = x;
			out[i + 1] = -y;
			out[i + 2] = -z;
		}
	}
	return out;
}

/**
 * Bake a {@link ModelAsset} into the exporters' {@link ExportMesh},
 * choosing each slot's colour source exactly as the viewer does:
 * texture, else flat base colour, else vertex colours.
 */
export function modelAssetToExportMeshes(a: ModelAsset): ExportMesh[] {
	if (a.meshes) return a.meshes;
	const lod = a.mesh?.lods[0];
	if (!lod || lod.indices.length === 0) return [];
	const slotCount = Math.max(1, a.textures.length, ...lod.sections.map((s) => s.materialIndex + 1));
	const materials: ExportMaterial[] = [];
	for (let i = 0; i < slotCount; i++) {
		const t = a.textures[i];
		if (t) {
			materials.push({
				texture: { pixels: t.pixels, width: t.width, height: t.height, wrapS: t.wrapS ?? 'repeat', wrapT: t.wrapT ?? 'repeat', flipY: t.flipY ?? true },
			});
			continue;
		}
		const c = a.baseColors?.[i];
		if (c) materials.push({ texture: null, baseColor: [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)] });
		else materials.push({ texture: null, useVertexColors: Boolean(lod.colors) });
	}
	const triangleMaterials = new Int32Array(lod.indices.length / 3);
	for (const s of lod.sections) {
		triangleMaterials.fill(Math.max(0, s.materialIndex), Math.floor(s.firstIndex / 3), Math.floor(s.firstIndex / 3) + s.numTriangles);
	}
	return [
		{
			positions: upAxisPositions(lod.positions, a.mesh!.upAxis),
			indices: lod.indices instanceof Uint32Array ? lod.indices : Uint32Array.from(lod.indices),
			uvs: lod.uv ?? null,
			colors: lod.colors ?? null,
			colorStride: 3,
			colorSpace: 'linear',
			materials,
			triangleMaterials,
		},
	];
}
