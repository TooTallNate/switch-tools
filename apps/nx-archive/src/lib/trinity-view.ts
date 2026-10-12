/**
 * Game Freak Trinity models (Pokémon Legends: Arceus) → mesh-viewer
 * view.
 *
 * Parsing lives in `@tootallnate/trinity`; this module does the
 * archive-side work:
 *
 *  - **Companions.** A `.trmdl` names its mesh (per LOD), skeleton and
 *    material files; with the BNTX textures they sit beside it, e.g.
 *    `bin/archive/pokemon/pm0025_00_00.gfpak/mdl/`. GFPAK name recovery
 *    restores those names from the files' own references.
 *  - **Sections.** Each sub-mesh becomes a section with its material.
 *    A shape's sub-meshes share vertices but materials scale / offset
 *    UVs differently (`UVScaleOffset`), so vertices are split per
 *    section with the material's UV transform baked in.
 *  - **Textures.** `BaseColorMap` tinted by `LayerMaskMap` +
 *    `BaseColorLayer1–4` (see `bakeLayeredAlbedo`). The shiny palette
 *    is the `_rare.trmtr` material file.
 */

import {
	bakeLayeredAlbedo,
	buildTrinityMesh,
	parseTrmbf,
	parseTrmdl,
	parseTrmsh,
	parseTrmtr,
	parseTrskl,
	uvScaleOffset,
	type RgbaImage,
	type TrinityMaterial,
	type TrinityWrap,
	type TrsklSkeleton,
} from '@tootallnate/trinity';
import { decodeBntxLayer, parseBntx } from '@tootallnate/bntx';

import type { Node } from './archive';
import { getAstcBlockDecoder } from './astc';
import type { ExportSkeleton } from './mesh-export';
import type { DecodedTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';
import type { RenderableMesh } from '~/components/mesh-viewer';

export interface TrinityModelView {
	mesh: RenderableMesh;
	/** One per material (section `materialIndex`). */
	textures: (DecodedTexture | null)[];
	materials: TrinityMaterial[];
	triangles: number;
	vertices: number;
	bones: number;
	/** Whether a shiny (`_rare.trmtr`) material set exists. */
	hasRare: boolean;
	texturesFound: number;
	texturesWanted: number;
}

async function childrenOf(node: Node): Promise<Node[]> {
	if (!node.getChildren) return [];
	if (node._children) return node._children;
	try {
		const kids = await node.getChildren();
		node._children = kids;
		return kids;
	} catch {
		return [];
	}
}

/** The model's folder contents, by lower-cased name. */
async function siblingsOf(node: Node, root: Node | null): Promise<Map<string, Node>> {
	const out = new Map<string, Node>();
	const slash = node.id.lastIndexOf('/');
	const parent = root && slash > 0 ? await findNodeById(root, node.id.slice(0, slash)) : null;
	for (const k of parent ? await childrenOf(parent) : []) if (k.blob) out.set(k.name.toLowerCase(), k);
	return out;
}

const bytesOf = async (n: Node) => new Uint8Array(await (await n.blob!()).arrayBuffer());

async function decodeBntx(bytes: Uint8Array): Promise<RgbaImage | null> {
	try {
		const tex = parseBntx(bytes).textures[0];
		if (!tex) return null;
		const astcDecoder = tex.formatInfo.isAstc ? await getAstcBlockDecoder() : undefined;
		const d = decodeBntxLayer(bytes, tex, 0, { astcDecoder });
		return { width: d.width, height: d.height, pixels: d.pixels };
	} catch {
		return null;
	}
}

const WRAP: Record<TrinityWrap, 'repeat' | 'clamp' | 'mirror'> = {
	repeat: 'repeat',
	clamp: 'clamp',
	mirror: 'mirror',
	// Mirror once: mirrored about 0, then clamped. Mirror is the closest
	// sampler mode; in-range UVs sample identically.
	'mirror-once': 'mirror',
};

/** Node world matrices (column-major 4×4) from local TRS, `R = Rz·Ry·Rx`. */
function nodeWorldPositions(skel: TrsklSkeleton): Float32Array {
	const n = skel.nodes.length;
	const world = new Float64Array(n * 16);
	const done = new Uint8Array(n);
	const local = (i: number) => {
		const { scale: s, rotation: r, translation: t } = skel.nodes[i]!;
		const [cx, cy, cz] = [Math.cos(r[0]), Math.cos(r[1]), Math.cos(r[2])];
		const [sx, sy, sz] = [Math.sin(r[0]), Math.sin(r[1]), Math.sin(r[2])];
		// Rz·Ry·Rx, columns scaled by s.
		const m = [
			cz * cy, sz * cy, -sy, 0,
			cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx, 0,
			cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx, 0,
			t[0], t[1], t[2], 1,
		];
		for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) m[c * 4 + k]! *= s[c]!;
		return m;
	};
	const resolve = (i: number, depth = 0): void => {
		if (done[i]) return;
		const m = local(i);
		const p = skel.nodes[i]!.parent;
		if (p >= 0 && p < n && p !== i && depth < 256) {
			resolve(p, depth + 1);
			const a = world.subarray(p * 16, p * 16 + 16);
			for (let c = 0; c < 4; c++) {
				for (let r = 0; r < 4; r++) {
					let v = 0;
					for (let k = 0; k < 4; k++) v += a[k * 4 + r]! * m[c * 4 + k]!;
					world[i * 16 + c * 4 + r] = v;
				}
			}
		} else {
			world.set(m, i * 16);
		}
		done[i] = 1;
	};
	const out = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		resolve(i);
		out.set([world[i * 16 + 12]!, world[i * 16 + 13]!, world[i * 16 + 14]!], i * 3);
	}
	return out;
}

export async function loadTrinityModelView(
	node: Node,
	root: Node | null,
	opts: { rare?: boolean; lod?: number } = {},
): Promise<TrinityModelView> {
	const mdl = parseTrmdl(await bytesOf(node));
	const sib = await siblingsOf(node, root);
	const get = (name: string | null | undefined) => (name ? sib.get(name.toLowerCase()) : undefined);
	const meshFile = mdl.meshes[Math.min(opts.lod ?? 0, mdl.meshes.length - 1)];
	if (!meshFile) {
		throw new Error(
			mdl.skeleton
				? 'This model has no meshes: it is a base skeleton that other models (outfits, character-creator parts) attach to.'
				: 'This model has no meshes.',
		);
	}
	const meshNode = get(meshFile);
	if (!meshNode) throw new Error(`Mesh ${meshFile} not found next to the model`);
	const msh = parseTrmsh(await bytesOf(meshNode));
	const bufNode = get(msh.bufferFile);
	if (!bufNode) throw new Error(`Buffer ${msh.bufferFile} not found next to the model`);
	const render = buildTrinityMesh(msh, parseTrmbf(await bytesOf(bufNode)));

	const matFile = mdl.materials[0];
	const rareFile = matFile?.replace(/\.trmtr$/i, '_rare.trmtr');
	const matNode = (opts.rare ? get(rareFile) : undefined) ?? get(matFile);
	const materials = matNode ? parseTrmtr(await bytesOf(matNode)).materials : [];
	const matIndex = new Map(materials.map((m, i) => [m.name, i]));

	// Split vertices per section, baking each material's UV transform.
	const P: number[] = [], N: number[] = [], U: number[] = [], C: number[] = [];
	const J: number[] = [], W: number[] = [];
	const I: number[] = [];
	const sections: RenderableMesh['lods'][number]['sections'] = [];
	const extraMats: string[] = [];
	for (const s of render.sections) {
		let mi = matIndex.get(s.material);
		if (mi === undefined) {
			// Material not in the .trmtr: an untextured slot after the real ones.
			let e = extraMats.indexOf(s.material);
			if (e < 0) e = extraMats.push(s.material) - 1;
			mi = materials.length + e;
		}
		const [su, sv, ou, ov] = mi < materials.length ? uvScaleOffset(materials[mi]!) : [1, 1, 0, 0];
		const remap = new Map<number, number>();
		const first = I.length;
		for (let k = 0; k < s.indexCount; k++) {
			const v = render.indices[s.firstIndex + k]!;
			let nv = remap.get(v);
			if (nv === undefined) {
				nv = P.length / 3;
				remap.set(v, nv);
				P.push(render.positions[v * 3]!, render.positions[v * 3 + 1]!, render.positions[v * 3 + 2]!);
				if (render.normals) N.push(render.normals[v * 3]!, render.normals[v * 3 + 1]!, render.normals[v * 3 + 2]!);
				if (render.uv0) U.push(render.uv0[v * 2]! * su + ou, render.uv0[v * 2 + 1]! * sv + ov);
				if (render.colors) C.push(render.colors[v * 4]!, render.colors[v * 4 + 1]!, render.colors[v * 4 + 2]!);
				if (render.joints && render.weights) {
					for (let q = 0; q < 4; q++) {
						J.push(render.joints[v * 4 + q]!);
						W.push(render.weights[v * 4 + q]!);
					}
				}
			}
			I.push(nv);
		}
		// Materials sit in their own UV tiles (Pikachu: body_a v ∈ [0, 1],
		// body_b [1, 2], body_c [2.5, 3] → ×2 = [5, 6]) but sample with
		// clamping, so the tile number is ignored: move a clamped axis's
		// range into [0, 1] when it fits in one tile.
		if (U.length && mi < materials.length) {
			const mat = materials[mi]!;
			const ref = mat.textures.find((t) => t.binding === 'BaseColorMap') ?? mat.textures.find((t) => t.binding === 'LayerMaskMap');
			const smp = ref ? mat.samplers[ref.slot] : undefined;
			const firstV = remap.size ? Math.min(...remap.values()) : 0;
			const lastV = P.length / 3;
			for (const [axis, wrap] of [[0, smp?.wrapU], [1, smp?.wrapV]] as const) {
				if (wrap !== 'clamp') continue;
				let lo = Infinity, hi = -Infinity;
				for (let v = firstV; v < lastV; v++) {
					lo = Math.min(lo, U[v * 2 + axis]!);
					hi = Math.max(hi, U[v * 2 + axis]!);
				}
				const tile = Math.floor(lo);
				if (tile !== 0 && hi - tile <= 1 + 1e-4) for (let v = firstV; v < lastV; v++) U[v * 2 + axis]! -= tile;
			}
		}
		sections.push({ materialIndex: mi, firstIndex: first, numTriangles: s.indexCount / 3 });
	}

	// Textures (decoded once per file).
	const decoded = new Map<string, Promise<RgbaImage | null>>();
	const image = (file: string | undefined) => {
		if (!file) return Promise.resolve(null);
		const key = file.toLowerCase();
		let p = decoded.get(key);
		if (!p) {
			const n = get(file);
			p = n ? bytesOf(n).then(decodeBntx) : Promise.resolve(null);
			decoded.set(key, p);
		}
		return p;
	};
	let wanted = 0, found = 0;
	const textures = await Promise.all(
		materials.map(async (mat): Promise<DecodedTexture | null> => {
			const albRef = mat.textures.find((t) => t.binding === 'BaseColorMap');
			const lymRef = mat.textures.find((t) => t.binding === 'LayerMaskMap');
			if (!albRef && !lymRef) return null;
			wanted++;
			const [alb, lym] = await Promise.all([image(albRef?.file), image(lymRef?.file)]);
			const img = bakeLayeredAlbedo(mat, alb, lym);
			if (!img) return null;
			found++;
			const sampler = mat.samplers[(albRef ?? lymRef)!.slot];
			return {
				packagePath: (albRef ?? lymRef)!.file,
				width: img.width,
				height: img.height,
				pixels: img.pixels,
				pixelFormat: 'RGBA8',
				normalReconstructed: false,
				// BNTX rows are top-down but Trinity UVs put V = 0 at the bottom.
				flipY: true,
				wrapS: WRAP[sampler?.wrapU ?? 'repeat'],
				wrapT: WRAP[sampler?.wrapV ?? 'repeat'],
			};
		}),
	);
	for (let i = 0; i < extraMats.length; i++) textures.push(null);

	// Skeleton hints for print supports: each vertex's dominant bone.
	let skeleton: ExportSkeleton | undefined;
	let bones = 0;
	const sklNode = get(mdl.skeleton);
	if (sklNode && J.length) {
		try {
			const skl = parseTrskl(await bytesOf(sklNode));
			bones = skl.boneCount;
			const rigToNode = new Map<number, number>();
			skl.nodes.forEach((n, i) => {
				if (n.rigIndex >= 0) rigToNode.set(n.rigIndex + skl.rigOffset, i);
			});
			const vertexBone = new Uint16Array(P.length / 3);
			for (let v = 0; v < vertexBone.length; v++) {
				let best = 0;
				for (let q = 1; q < 4; q++) if (W[v * 4 + q]! > W[v * 4 + best]!) best = q;
				vertexBone[v] = rigToNode.get(J[v * 4 + best]!) ?? 0;
			}
			skeleton = {
				vertexBone,
				parent: Int16Array.from(skl.nodes.map((n) => n.parent)),
				joints: nodeWorldPositions(skl),
			};
		} catch {
			// skeleton is optional
		}
	}

	const numVertices = P.length / 3;
	return {
		mesh: {
			lods: [
				{
					numVertices,
					positions: new Float32Array(P),
					normals: N.length ? new Float32Array(N) : undefined,
					uv: U.length ? new Float32Array(U) : undefined,
					indices: new Uint32Array(I),
					sections,
					label: `${numVertices.toLocaleString()} verts, ${(I.length / 3).toLocaleString()} tris`,
					...(skeleton && { skeleton }),
				},
			],
			upAxis: 'y-up',
		},
		textures,
		materials,
		triangles: I.length / 3,
		vertices: numVertices,
		bones,
		hasRare: !!get(rareFile),
		texturesFound: found,
		texturesWanted: wanted,
	};
}
