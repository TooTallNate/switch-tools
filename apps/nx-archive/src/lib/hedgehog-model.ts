/**
 * Hedgehog Engine models (`.model`, `.terrain-model`) from Sonic
 * Frontiers / Forces pacs, for the viewer and the library.
 *
 * The model, its materials and its textures sit side by side in the
 * same pac (`@tootallnate/pacx`). Materials name their textures; a
 * texture is either a whole `.dds` or, in Frontiers, an `NTSI` stub
 * that the pac node resolves to a whole DDS (`hedgehog-textures.ts`).
 *
 * Variants: Frontiers materials list a second `diffuse` (`…_cyb_abd`)
 * for the Cyber Space look, which becomes a "Cyber Space" variant.
 * Inverted-hull outline meshes (`*_outline` materials) are left out;
 * the game draws them as a black rim.
 */

import { parseDds } from '@tootallnate/dds';
import {
	hhSkinMatrices,
	isPxdAnimation,
	parseHhMaterial,
	parseHhModel,
	parsePxdAnimation,
	parsePxdSkeleton,
	pxdWorldMatrices,
	sampleUncompressedPxd,
	type HhMaterial,
	type HhModel,
	type PxdSkeleton,
} from '@tootallnate/hedgehog';
import { getAclDecoder } from './acl';
import type { Node } from './archive';
import type { RenderableMesh } from '~/components/mesh-viewer';
import type { DecodedTexture } from './uasset-material-chain';
import { romfsFileFor } from './title-romfs';
import { findNodeById } from './unity-external';

export interface HhModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	model: HhModel;
	triangles: number;
	vertices: number;
	variants: string[];
	variant: number;
	texturesWanted: number;
	texturesFound: number;
	materialsMissing: string[];
	/** Clips for this model's skeleton (`<model>@<clip>.anm.pxd`), empty without one. */
	animations: { name: string; frames: number; fps: number }[];
	defaultAnimation: number;
	/** Pose a clip frame (-1 = bind pose) into `positions` / `normals`, skinned on the CPU. */
	pose(animation: number, frame: number, positions: Float32Array, normals?: Float32Array): void;
}

const parentIdOf = (id: string) => id.slice(0, id.lastIndexOf('/'));

async function kidsOf(n: Node | null): Promise<Node[]> {
	if (!n?.getChildren) return [];
	return n._children ?? (n._children = await n.getChildren());
}

const bytesOf = async (n: Node) => new Uint8Array(await (await n.blob!()).arrayBuffer());

async function decodeTexture(node: Node): Promise<DecodedTexture | null> {
	try {
		// Pac children already resolve texture-streaming stubs (see `hedgehog-textures.ts`).
		const d = parseDds(await bytesOf(node));
		return {
			packagePath: node.name,
			width: d.width,
			height: d.height,
			pixels: d.pixels,
			pixelFormat: d.formatLabel,
			normalReconstructed: false,
			// DDS rows are top-down and the UVs are Direct3D's (V=0 at the top).
			flipY: false,
		};
	} catch {
		return null;
	}
}

/**
 * The pac holding a model, then its parent pacs (`meta.pacxParents`,
 * RomFS paths under `raw/` without the extension), breadth first: a
 * stage's terrain pac takes its materials and textures from the
 * stage's `_trr_cmn` pac and the world's `_common` pac.
 */
async function pacChain(pac: Node | null): Promise<Map<string, Node>[]> {
	const out: Map<string, Node>[] = [];
	const seen = new Set<string>();
	let queue: Node[] = pac ? [pac] : [];
	for (let depth = 0; depth < 4 && queue.length; depth++) {
		const next: Node[] = [];
		for (const p of queue) {
			if (seen.has(p.id)) continue;
			seen.add(p.id);
			out.push(new Map((await kidsOf(p)).map((k) => [k.name.toLowerCase(), k])));
			for (const parent of (p.meta?.pacxParents as string[] | undefined) ?? []) {
				const path = parent.replace(/\\/g, '/');
				const n = (await romfsFileFor(p.id, `raw/${path}.pac`)) ?? (await romfsFileFor(p.id, `${path}.pac`));
				if (n) next.push(n);
			}
		}
		queue = next;
	}
	return out;
}

const isOutline = (material: string) => /outline/i.test(material);

export async function loadHhModelView(node: Node, root: Node | null, variantIndex = 0): Promise<HhModelView> {
	const model = parseHhModel(await bytesOf(node), /\.terrain-model$/i.test(node.name) ? 'terrain' : 'skeletal');
	const dir = root ? await findNodeById(root, parentIdOf(node.id)) : null;
	const chain = await pacChain(dir);
	const lookup = (file: string) => {
		const key = file.toLowerCase();
		for (const m of chain) {
			const n = m.get(key);
			if (n) return n;
		}
		return undefined;
	};

	const materials = new Map<string, HhMaterial | null>();
	const missing: string[] = [];
	for (const m of model.meshes) {
		if (materials.has(m.material)) continue;
		const n = lookup(`${m.material}.material`);
		let mat: HhMaterial | null = null;
		if (n) {
			try {
				mat = parseHhMaterial(await bytesOf(n));
			} catch {
				mat = null;
			}
		}
		if (!mat && !isOutline(m.material)) missing.push(m.material);
		materials.set(m.material, mat);
	}
	const hasCyber = [...materials.values()].some((m) => (m?.textures.filter((t) => t.type === 'diffuse').length ?? 0) > 1);
	const variants = hasCyber ? ['Default', 'Cyber Space'] : ['Default'];
	const variant = Math.max(0, Math.min(variants.length - 1, variantIndex));

	const textureCache = new Map<string, Promise<DecodedTexture | null>>();
	const texture = (name: string) => {
		const key = name.toLowerCase();
		let p = textureCache.get(key);
		if (!p) {
			const n = lookup(`${key}.dds`);
			p = n ? decodeTexture(n) : Promise.resolve(null);
			textureCache.set(key, p);
		}
		return p;
	};

	const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
	const joints: number[] = [], weights: number[] = [];
	const sections: { materialIndex: number; firstIndex: number; numTriangles: number }[] = [];
	const slotTextures: Promise<DecodedTexture | null>[] = [];
	const slotFor = new Map<string, number>();
	let wanted = 0;
	let allNormals = true;
	for (const m of model.meshes) {
		if (isOutline(m.material)) continue;
		const mat = materials.get(m.material) ?? null;
		const diffuse = mat?.textures.filter((t) => t.type === 'diffuse') ?? [];
		const tex = (variant === 1 ? diffuse.find((t) => /_cyb_/i.test(t.texture)) : null) ?? diffuse.find((t) => !/_cyb_/i.test(t.texture)) ?? diffuse[0];
		const key = tex?.texture ?? `\0${m.material}`;
		let slot = slotFor.get(key);
		if (slot === undefined) {
			slot = slotTextures.length;
			slotFor.set(key, slot);
			slotTextures.push(tex ? texture(tex.texture) : Promise.resolve(null));
			if (tex) wanted++;
		}
		const base = positions.length / 3;
		const set = tex ? Math.min(tex.texcoord, m.uvs.length - 1) : 0;
		for (let i = 0; i < m.vertexCount; i++) {
			positions.push(m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!);
			if (m.normals) normals.push(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!);
			const u = m.uvs[set];
			uv.push(u ? u[i * 2]! : 0, u ? u[i * 2 + 1]! : 0);
			for (let k = 0; k < 4; k++) {
				joints.push(m.joints ? m.joints[i * 4 + k]! : -1);
				weights.push(m.weights ? m.weights[i * 4 + k]! : 0);
			}
		}
		if (!m.normals) allNormals = false;
		sections.push({ materialIndex: slot, firstIndex: indices.length, numTriangles: m.indices.length / 3 });
		for (const i of m.indices) indices.push(base + i);
	}
	if (!indices.length) throw new Error('This model has no drawable meshes');
	const textures = await Promise.all(slotTextures);
	const bindPositions = Float32Array.from(positions);
	const bindNormals = allNormals ? Float32Array.from(normals) : null;
	const anim = model.nodes.length ? await loadAnimations(node, dir, model, chain) : null;
	const animations = anim?.clips.map((c) => ({ name: c.name, frames: c.frames, fps: c.fps })) ?? [];
	const idle = animations.findIndex((a) => /@idle(_loop)?$/i.test(a.name));
	const defaultAnimation = animations.length ? Math.max(0, idle >= 0 ? idle : animations.findIndex((a) => /idle/i.test(a.name))) : -1;
	const J = Int16Array.from(joints), W = Float32Array.from(weights);
	const pose = (index: number, frame: number, pos: Float32Array, nrm?: Float32Array) => {
		if (!anim) return;
		const clip = index >= 0 ? anim.clips[index] : undefined;
		const data = clip ? clip.transforms() : null;
		const f = clip ? Math.max(0, Math.min(clip.frames - 1, Math.round(frame))) : 0;
		const skin = hhSkinMatrices(model.nodes, anim.skeleton, pxdWorldMatrices(anim.skeleton, data?.transforms ?? null, f, data?.tracks ?? 0));
		const n = bindPositions.length / 3;
		for (let v = 0; v < n; v++) {
			const px = bindPositions[v * 3]!, py = bindPositions[v * 3 + 1]!, pz = bindPositions[v * 3 + 2]!;
			let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, total = 0;
			const hasN = !!(nrm && bindNormals);
			const qx = hasN ? bindNormals![v * 3]! : 0, qy = hasN ? bindNormals![v * 3 + 1]! : 0, qz = hasN ? bindNormals![v * 3 + 2]! : 0;
			for (let k = 0; k < 4; k++) {
				const j = J[v * 4 + k]!, w = W[v * 4 + k]!;
				if (j < 0 || w <= 0 || !skin[j]) continue;
				const M = skin[j]!;
				x += w * (M[0]! * px + M[4]! * py + M[8]! * pz + M[12]!);
				y += w * (M[1]! * px + M[5]! * py + M[9]! * pz + M[13]!);
				z += w * (M[2]! * px + M[6]! * py + M[10]! * pz + M[14]!);
				if (hasN) {
					nx += w * (M[0]! * qx + M[4]! * qy + M[8]! * qz);
					ny += w * (M[1]! * qx + M[5]! * qy + M[9]! * qz);
					nz += w * (M[2]! * qx + M[6]! * qy + M[10]! * qz);
				}
				total += w;
			}
			if (total === 0) {
				x = px;
				y = py;
				z = pz;
				nx = qx;
				ny = qy;
				nz = qz;
			}
			pos[v * 3] = x;
			pos[v * 3 + 1] = y;
			pos[v * 3 + 2] = z;
			if (hasN) {
				const l = Math.hypot(nx, ny, nz) || 1;
				nrm![v * 3] = nx / l;
				nrm![v * 3 + 1] = ny / l;
				nrm![v * 3 + 2] = nz / l;
			}
		}
	};
	const outPositions = bindPositions.slice();
	const outNormals = bindNormals?.slice();
	if (defaultAnimation >= 0) {
		try {
			pose(defaultAnimation, 0, outPositions, outNormals);
		} catch {
			outPositions.set(bindPositions);
		}
	}
	return {
		mesh: {
			lods: [
				{
					numVertices: positions.length / 3,
					positions: outPositions,
					normals: outNormals,
					uv: Float32Array.from(uv),
					indices: Uint32Array.from(indices),
					sections,
				},
			],
			upAxis: 'y-up',
		},
		textures,
		model,
		triangles: indices.length / 3,
		vertices: positions.length / 3,
		variants,
		variant,
		texturesWanted: wanted,
		texturesFound: textures.filter(Boolean).length,
		materialsMissing: missing,
		animations,
		defaultAnimation,
		pose,
	};
}

interface ClipSource {
	name: string;
	frames: number;
	fps: number;
	/** Decoded on first use: `frames × tracks` transforms, 12 floats each. */
	transforms(): { transforms: Float32Array; tracks: number } | null;
}

/**
 * The model's skeleton (`<model>.skl.pxd`, else the pac's only one) and
 * its clips: `<model>@*.anm.pxd` in the same pac, or, when none are
 * named after the model, every clip with as many tracks as the skeleton
 * has bones. Compressed clips need the ACL decoder, loaded up front so
 * that posing stays synchronous.
 */
async function loadAnimations(
	node: Node,
	dir: Node | null,
	model: HhModel,
	chain: Map<string, Node>[],
): Promise<{ skeleton: PxdSkeleton; clips: ClipSource[] } | null> {
	const stem = node.name.replace(/\.(terrain-)?model$/i, '').toLowerCase();
	const own = chain[0] ?? new Map<string, Node>();
	let sklNode = own.get(`${stem}.skl.pxd`);
	if (!sklNode) {
		const all = [...own.values()].filter((k) => /\.skl\.pxd$/i.test(k.name));
		if (all.length === 1) sklNode = all[0];
	}
	if (!sklNode) return null;
	let skeleton: PxdSkeleton;
	try {
		skeleton = parsePxdSkeleton(await bytesOf(sklNode));
	} catch {
		return null;
	}
	// Every model node needs a skeleton bone or a parent chain to one.
	const names = new Set(skeleton.bones.map((b) => b.name));
	if (!model.nodes.some((n) => names.has(n.name))) return null;
	const files = [...own.values()].filter((k) => /\.anm\.pxd$/i.test(k.name));
	const named = files.filter((k) => k.name.toLowerCase().startsWith(`${stem}@`));
	const pick = named.length ? named : files;
	const acl = await getAclDecoder().catch(() => null);
	const clips: ClipSource[] = [];
	for (const f of pick.sort((a, b) => a.name.localeCompare(b.name))) {
		const bytes = await bytesOf(f);
		if (!isPxdAnimation(bytes)) continue;
		const a = parsePxdAnimation(bytes);
		if (!named.length && a.trackCount !== skeleton.bones.length) continue;
		if (a.additive || !a.main || a.frameCount < 1) continue;
		if (a.compressed && !acl) continue;
		let cache: { transforms: Float32Array; tracks: number } | null | undefined;
		clips.push({
			name: f.name.replace(/\.anm\.pxd$/i, ''),
			frames: a.frameCount,
			fps: a.fps,
			transforms: () => {
				if (cache !== undefined) return cache;
				try {
					if (a.compressed) {
						const c = acl!.decompress(a.main!);
						cache = { transforms: c.transforms, tracks: c.tracks };
					} else cache = { transforms: sampleUncompressedPxd(bytes, a, skeleton), tracks: a.trackCount };
				} catch {
					cache = null;
				}
				return cache;
			},
		});
	}
	return { skeleton, clips };
}
