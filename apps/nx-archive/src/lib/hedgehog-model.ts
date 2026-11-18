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
	HEIGHTFIELD_HOLE,
	parseHeightfield,
	parsePointCloud,
	parsePxdSkeleton,
	pointCloudMatrix,
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

/** The folder holding a pac (its parent directory node). */
async function findParentFolder(pac: Node): Promise<Node | null> {
	const at = pac.id.lastIndexOf('/');
	const id = pac.id.slice(0, at);
	const romfsPath = id.includes('/raw/') ? id.slice(id.indexOf('/raw/') + 1) : null;
	return romfsPath ? romfsFileFor(pac.id, romfsPath) : null;
}

const isOutline = (material: string) => /outline/i.test(material);
const isOccluder = (name: string) => /occlu|_occ(?:_|$)/i.test(name);

/**
 * Find a file for a model: its pac chain first, then, only when that
 * misses, the other pacs of the same stage folder (`w1f01_*.pac`), which
 * share textures without naming each other as parents.
 */
function stageLookup(dir: Node | null, chain: Map<string, Node>[]): (file: string) => Promise<Node | undefined> {
	let extra: Promise<Map<string, Node>[]> | null = null;
	const siblings = () =>
		(extra ??= (async () => {
			if (!dir || !/\/raw\/stage\//.test(dir.id)) return [];
			const folder = await findParentFolder(dir);
			const out: Map<string, Node>[] = [];
			for (const sib of await kidsOf(folder)) {
				if (sib === dir || sib.kind !== 'pacx') continue;
				out.push(new Map((await kidsOf(sib).catch(() => [] as Node[])).map((k) => [k.name.toLowerCase(), k])));
			}
			return out;
		})());
	return async (file) => {
		const key = file.toLowerCase();
		for (const m of chain) {
			const n = m.get(key);
			if (n) return n;
		}
		for (const m of await siblings()) {
			const n = m.get(key);
			if (n) return n;
		}
		return undefined;
	};
}

export interface HhModelViewOptions {
	/** Level of detail to read from Needle archives (default the highest). */
	lod?: 'highest' | 'lowest';
	/** Skip the rig and clips (static placement, e.g. stage layouts). */
	static?: boolean;
}

export async function loadHhModelView(node: Node, root: Node | null, variantIndex = 0, options: HhModelViewOptions = {}): Promise<HhModelView> {
	const model = parseHhModel(await bytesOf(node), /\.terrain-model$/i.test(node.name) ? 'terrain' : 'skeletal', options.lod);
	const dir = root ? await findNodeById(root, parentIdOf(node.id)) : null;
	const chain = await pacChain(dir);
	const lookup = stageLookup(dir, chain);

	const materials = new Map<string, HhMaterial | null>();
	const missing: string[] = [];
	for (const m of model.meshes) {
		if (materials.has(m.material)) continue;
		const n = await lookup(`${m.material}.material`);
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
			p = lookup(`${key}.dds`).then((n) => (n ? decodeTexture(n) : null));
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
	// Outline-only models (fishing minigame) draw their outlines.
	const skipOutlines = model.meshes.some((m) => !isOutline(m.material));
	for (const m of model.meshes) {
		if (skipOutlines && isOutline(m.material)) continue;
		const mat = materials.get(m.material) ?? null;
		const diffuse = mat?.textures.filter((t) => t.type === 'diffuse') ?? [];
		const tex = (variant === 1 ? diffuse.find((t) => /_cyb_/i.test(t.texture)) : null) ?? diffuse.find((t) => !/_cyb_/i.test(t.texture)) ?? diffuse[0];
		const key = tex?.texture ?? `\0${m.material}`;
		let slot = slotFor.get(key);
		if (slot === undefined) {
			slot = slotTextures.length;
			slotFor.set(key, slot);
			slotTextures.push(tex ? texture(tex.texture) : Promise.resolve(null));
			// Occluders are never drawn, and bind textures that don't ship.
			if (tex && !isOccluder(m.material)) wanted++;
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
	const anim = model.nodes.length && !options.static ? await loadAnimations(node, dir, model, chain) : null;
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
		texturesFound: Math.min(wanted, textures.filter(Boolean).length),
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
	const modelNames = model.nodes.map((n) => n.name);
	// Fraction of the model's nodes a skeleton has; below half it's another rig.
	const coverage = (sk: PxdSkeleton) => {
		const names = new Set(sk.bones.map((b) => b.name));
		return modelNames.filter((n) => names.has(n)).length / Math.max(1, modelNames.length);
	};
	const skeletonsIn = (pac: Map<string, Node>) => [...pac.values()].filter((k) => /\.skl\.pxd$/i.test(k.name));
	const tryRead = async (n: Node) => {
		try {
			return parsePxdSkeleton(await bytesOf(n));
		} catch {
			return null;
		}
	};
	// Skeleton search: the model's own name in its pac chain, then any
	// skeleton there that fits, then the pacs next to this one (Frontiers'
	// Koco variants share `kodamacommon.pac`'s rig).
	let found: { skeleton: PxdSkeleton; pac: Map<string, Node>; stem: string } | null = null;
	const consider = async (pac: Map<string, Node>, n: Node) => {
		const sk = await tryRead(n);
		if (!sk) return false;
		const c = coverage(sk);
		if (c < 0.5) return false;
		if (!found || c > coverage(found.skeleton)) found = { skeleton: sk, pac, stem: n.name.replace(/\.skl\.pxd$/i, '').toLowerCase() };
		return c > 0.95;
	};
	for (const pac of chain) {
		const exact = pac.get(`${stem}.skl.pxd`);
		if (exact && (await consider(pac, exact))) break;
	}
	if (!found) for (const pac of chain) for (const n of skeletonsIn(pac)) await consider(pac, n);
	const siblingPacs: Map<string, Node>[] = [];
	if (!found && dir) {
		const folder = await findParentFolder(dir);
		for (const sib of await kidsOf(folder)) {
			if (sib === dir || sib.kind !== 'pacx') continue;
			const map = new Map((await kidsOf(sib).catch(() => [] as Node[])).map((k) => [k.name.toLowerCase(), k]));
			siblingPacs.push(map);
			if (!found || coverage((found as { skeleton: PxdSkeleton }).skeleton) <= 0.95) for (const n of skeletonsIn(map)) if (await consider(map, n)) break;
		}
	}
	if (!found) return null;
	const { skeleton, pac: rigPac, stem: rigStem } = found as { skeleton: PxdSkeleton; pac: Map<string, Node>; stem: string };
	// A rig borrowed from a neighbouring pac: its clips may be spread over several.
	const rigPacs = siblingPacs.length ? [rigPac, ...siblingPacs.filter((p) => p !== rigPac && p.has(`${rigStem}.skl.pxd`))] : [rigPac];
	// Clips named after the model, then after its rig; else every clip in its pac that fits.
	const anims = (pac: Map<string, Node>) => [...pac.values()].filter((k) => /\.anm\.pxd$/i.test(k.name));
	const seen = new Set<string>();
	const named: Node[] = [];
	for (const [pac, prefix] of [[own, stem], ...rigPacs.flatMap((p) => [[p, stem], [p, rigStem]] as const)] as const)
		for (const k of anims(pac))
			if (k.name.toLowerCase().startsWith(`${prefix}@`) && !seen.has(k.name)) {
				seen.add(k.name);
				named.push(k);
			}
	const pick = named.length ? named : anims(own);
	const acl = await getAclDecoder().catch(() => null);
	const clips: ClipSource[] = [];
	for (const f of pick) {
		const bytes = await bytesOf(f);
		if (!isPxdAnimation(bytes)) continue;
		const a = parsePxdAnimation(bytes);
		if (a.trackCount > skeleton.bones.length || (!named.length && a.trackCount !== skeleton.bones.length)) continue;
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

export interface HhSceneView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	instances: number;
	placed: number;
	resources: number;
	resourcesMissing: string[];
	triangles: number;
	vertices: number;
	texturesWanted: number;
	texturesFound: number;
	/** Clusters of nearby instances, biggest first, then the whole layout. */
	groups: string[];
	group: number;
}

/**
 * Recently built model views, by node id, shared by stage layouts: a
 * stage's layouts reuse the same few hundred pieces. Small, since a view
 * holds its vertex buffers and textures.
 */
const sceneViewCache = new Map<string, Promise<HhModelView | null>>();
const SCENE_VIEW_CACHE = 48;

function cachedModelView(n: Node, root: Node | null, options: HhModelViewOptions = {}): Promise<HhModelView | null> {
	const key = `${n.id}\0${options.lod ?? ''}${options.static ? 's' : ''}`;
	let p = sceneViewCache.get(key);
	if (p) {
		sceneViewCache.delete(key);
		sceneViewCache.set(key, p);
		return p;
	}
	p = loadHhModelView(n, root, 0, options).catch(() => null);
	sceneViewCache.set(key, p);
	while (sceneViewCache.size > SCENE_VIEW_CACHE) sceneViewCache.delete(sceneViewCache.keys().next().value!);
	return p;
}

const CLUSTER_GAP = 250;

/** Single-link clusters of points (XZ distance), biggest first. */
function clusterInstances(points: [number, number, number][]): number[][] {
	const n = points.length;
	if (n > 4000) return [points.map((_, i) => i)];
	const parent = points.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++) {
			const a = points[i]!, b = points[j]!;
			if (Math.hypot(a[0] - b[0], a[2] - b[2]) < CLUSTER_GAP) parent[find(i)] = find(j);
		}
	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i);
	return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Instances past this are left out, to keep stage layouts loadable. */
const SCENE_MAX_VERTICES = 4_000_000;

/**
 * A point cloud (`.pcmodel`) assembled into one mesh: every instance's
 * model (from the same pac or its parents), placed with its transform.
 */
export async function loadHhSceneView(node: Node, root: Node | null, groupIndex = 0, options: HhModelViewOptions & { maxVertices?: number } = {}): Promise<HhSceneView> {
	const all = parsePointCloud(await bytesOf(node));
	// Layouts often place several far-apart sites (one tower per island
	// corner); one site at a time keeps each visible. Single-link clusters
	// of instances closer than CLUSTER_GAP.
	const clusters = clusterInstances(all.map((p) => p.position));
	const groups = clusters.length > 1 ? [...clusters.map((c, i) => `Site ${i + 1} (${c.length} pieces)`), 'Whole layout'] : ['Whole layout'];
	const group = Math.max(0, Math.min(groups.length - 1, groupIndex));
	const instances = clusters.length > 1 && group < clusters.length ? clusters[group]!.map((i) => all[i]!) : all;
	const dir = root ? await findNodeById(root, parentIdOf(node.id)) : null;
	const chain = await pacChain(dir);
	const lookup = stageLookup(dir, chain);
	const views = new Map<string, HhModelView | null>();
	const missing: string[] = [];
	const skipOccluders = instances.some((p) => !isOccluder(p.resource));
	for (const p of instances) {
		if (views.has(p.resource)) continue;
		// Occlusion volumes aren't drawn in game (unless that's all the layout has).
		if (skipOccluders && isOccluder(p.resource)) {
			views.set(p.resource, null);
			continue;
		}
		const n = (await lookup(`${p.resource}.terrain-model`)) ?? (await lookup(`${p.resource}.model`));
		const v = n ? await cachedModelView(n, root, options) : null;
		if (!v) missing.push(p.resource);
		views.set(p.resource, v);
	}

	const textures: (DecodedTexture | null)[] = [];
	const textureSlot = new Map<string, number>();
	const slotOf = (t: DecodedTexture | null, key: string) => {
		const k = t ? `t:${t.packagePath}` : `n:${key}`;
		let s = textureSlot.get(k);
		if (s === undefined) {
			s = textures.length;
			textureSlot.set(k, s);
			textures.push(t);
		}
		return s;
	};
	const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
	const sections: { materialIndex: number; firstIndex: number; numTriangles: number }[] = [];
	let placed = 0, allNormals = true;
	for (const p of instances) {
		const v = views.get(p.resource);
		if (!v) continue;
		const lod = v.mesh.lods[0]!;
		if (positions.length / 3 + lod.numVertices > (options.maxVertices ?? SCENE_MAX_VERTICES)) break;
		const M = pointCloudMatrix(p);
		const base = positions.length / 3;
		const src = lod.positions, nrm = lod.normals;
		for (let i = 0; i < lod.numVertices; i++) {
			const x = src[i * 3]!, y = src[i * 3 + 1]!, z = src[i * 3 + 2]!;
			positions.push(M[0]! * x + M[4]! * y + M[8]! * z + M[12]!, M[1]! * x + M[5]! * y + M[9]! * z + M[13]!, M[2]! * x + M[6]! * y + M[10]! * z + M[14]!);
			if (nrm) {
				const a = nrm[i * 3]!, b = nrm[i * 3 + 1]!, c = nrm[i * 3 + 2]!;
				const nx = M[0]! * a + M[4]! * b + M[8]! * c, ny = M[1]! * a + M[5]! * b + M[9]! * c, nz = M[2]! * a + M[6]! * b + M[10]! * c;
				const l = Math.hypot(nx, ny, nz) || 1;
				normals.push(nx / l, ny / l, nz / l);
			}
		}
		if (!nrm) allNormals = false;
		for (let i = 0; i < lod.numVertices * 2; i++) uv.push(lod.uv ? lod.uv[i]! : 0);
		for (const s of lod.sections) {
			const slot = slotOf(v.textures[s.materialIndex] ?? null, `${p.resource}/${s.materialIndex}`);
			const last = sections[sections.length - 1];
			const first = indices.length;
			for (let k = 0; k < s.numTriangles * 3; k++) indices.push(base + lod.indices[s.firstIndex + k]!);
			if (last && last.materialIndex === slot && last.firstIndex + last.numTriangles * 3 === first) last.numTriangles += s.numTriangles;
			else sections.push({ materialIndex: slot, firstIndex: first, numTriangles: s.numTriangles });
		}
		placed++;
	}
	if (!indices.length) throw new Error(missing.length ? `None of this layout's models were found (${missing.slice(0, 3).join(', ')}…)` : 'This layout places no models');
	let wanted = 0, found = 0;
	for (const v of views.values()) {
		if (!v) continue;
		wanted += v.texturesWanted;
		found += v.texturesFound;
	}
	return {
		mesh: {
			lods: [
				{
					numVertices: positions.length / 3,
					positions: Float32Array.from(positions),
					normals: allNormals ? Float32Array.from(normals) : undefined,
					uv: Float32Array.from(uv),
					indices: Uint32Array.from(indices),
					sections,
				},
			],
			upAxis: 'y-up',
		},
		textures,
		instances: instances.length,
		groups,
		group,
		placed,
		resources: views.size,
		resourcesMissing: missing,
		triangles: indices.length / 3,
		vertices: positions.length / 3,
		texturesWanted: wanted,
		texturesFound: found,
	};
}

/** Average linear colour of each material's base texture, by material entry. */
async function terrainPalette(node: Node, materials: number[]): Promise<([number, number, number] | null)[]> {
	if (!materials.length) return [];
	const pacId = parentIdOf(node.id);
	const folder = await findParentFolder({ id: pacId } as Node);
	const height = (await kidsOf(folder)).find((k) => /_trr_height\.pac$/i.test(k.name));
	const kids = await kidsOf(height ?? null).catch(() => [] as Node[]);
	const cache = new Map<number, Promise<[number, number, number] | null>>();
	const colour = (id: number) => {
		let p = cache.get(id);
		if (!p) {
			const suffix = `_${String(id).padStart(3, '0')}_terrain_base_abd.dds`;
			const n = kids.find((k) => k.name.toLowerCase().endsWith(suffix));
			p = (async () => {
				if (!n) return null;
				try {
					const d = parseDds(await bytesOf(n));
					let r = 0, g = 0, b = 0;
					const px = d.pixels, count = d.width * d.height;
					for (let i = 0; i < count; i++) {
						r += (px[i * 4]! / 255) ** 2.2;
						g += (px[i * 4 + 1]! / 255) ** 2.2;
						b += (px[i * 4 + 2]! / 255) ** 2.2;
					}
					return [r / count, g / count, b / count] as [number, number, number];
				} catch {
					return null;
				}
			})();
			cache.set(id, p);
		}
		return p;
	};
	return Promise.all(materials.map(colour));
}

export interface HeightfieldView {
	mesh: RenderableMesh;
	width: number;
	height: number;
	grid: number;
	triangles: number;
	vertices: number;
}

/**
 * An open-zone heightfield as a mesh: resampled to at most `grid` × `grid`
 * vertices (the islands are 4096², which would be 33M triangles), holes
 * left open. Each vertex takes the average colour of its cell's terrain
 * texture (`*_NNN_terrain_base_abd.dds` in the stage's `_trr_height`
 * pac), or a height-and-slope colour when that isn't there.
 */
export async function loadHeightfieldView(node: Node, grid = 512): Promise<HeightfieldView> {
	const hf = parseHeightfield(await bytesOf(node));
	const palette = await terrainPalette(node, hf.materials);
	const G = Math.min(grid, hf.width, hf.height);
	const sx = (hf.width - 1) / (G - 1), sz = (hf.height - 1) / (G - 1);
	const index = new Int32Array(G * G).fill(-1);
	const positions: number[] = [], normals: number[] = [], colors: number[] = [];
	const h = (x: number, z: number) => {
		const v = hf.heights[Math.min(hf.height - 1, Math.round(z)) * hf.width + Math.min(hf.width - 1, Math.round(x))]!;
		return v === HEIGHTFIELD_HOLE ? NaN : v * hf.heightScale;
	};
	for (let j = 0; j < G; j++)
		for (let i = 0; i < G; i++) {
			const y = h(i * sx, j * sz);
			if (Number.isNaN(y)) continue;
			index[j * G + i] = positions.length / 3;
			positions.push((i * sx - hf.width / 2) * hf.cellX, y, (j * sz - hf.height / 2) * hf.cellZ);
			const l = h(Math.max(0, i - 1) * sx, j * sz), r = h(Math.min(G - 1, i + 1) * sx, j * sz);
			const d = h(i * sx, Math.max(0, j - 1) * sz), u = h(i * sx, Math.min(G - 1, j + 1) * sz);
			const dx = (Number.isNaN(r) ? y : r) - (Number.isNaN(l) ? y : l), dz = (Number.isNaN(u) ? y : u) - (Number.isNaN(d) ? y : d);
			const nx = -dx, ny = 2 * sx * hf.cellX, nz = -dz * (sx * hf.cellX) / (sz * hf.cellZ);
			const len = Math.hypot(nx, ny, nz) || 1;
			normals.push(nx / len, ny / len, nz / len);
			const steep = 1 - ny / len;
			const cell = hf.splat ? hf.splat[Math.min(hf.height - 2, Math.round(j * sz)) * (hf.width - 1) + Math.min(hf.width - 2, Math.round(i * sx))] : undefined;
			const pc = cell !== undefined ? palette[cell] : undefined;
			if (pc) {
				colors.push(pc[0], pc[1], pc[2]);
				continue;
			}
			const c = y < 3 ? [0.82, 0.76, 0.56] : steep > 0.35 ? [0.45, 0.42, 0.38] : y > 450 ? [0.92, 0.93, 0.95] : [0.33 + 0.1 * (y / 450), 0.5, 0.25];
			// The viewer wants linear RGB.
			colors.push(c[0]! ** 2.2, c[1]! ** 2.2, c[2]! ** 2.2);
		}
	const indices: number[] = [];
	for (let j = 0; j + 1 < G; j++)
		for (let i = 0; i + 1 < G; i++) {
			const a = index[j * G + i]!, b = index[j * G + i + 1]!, c = index[(j + 1) * G + i]!, d = index[(j + 1) * G + i + 1]!;
			if (a >= 0 && c >= 0 && b >= 0) indices.push(a, c, b);
			if (b >= 0 && c >= 0 && d >= 0) indices.push(b, c, d);
		}
	if (!indices.length) throw new Error('This heightfield has no ground');
	return {
		mesh: {
			lods: [
				{
					numVertices: positions.length / 3,
					positions: Float32Array.from(positions),
					normals: Float32Array.from(normals),
					colors: Float32Array.from(colors),
					indices: Uint32Array.from(indices),
					sections: [{ materialIndex: 0, firstIndex: 0, numTriangles: indices.length / 3 }],
				},
			],
			upAxis: 'y-up',
		},
		width: hf.width,
		height: hf.height,
		grid: G,
		triangles: indices.length / 3,
		vertices: positions.length / 3,
	};
}

/**
 * A whole open-zone island: the heightfield plus every stage layout in
 * the stage's `_trr_s00` pac, at their lowest level of detail (the
 * layouts are in the heightfield's world space). Ground vertices keep
 * their splat colours; placed pieces are white so their textures show.
 */
export async function loadIslandView(node: Node, root: Node | null, grid = 512, maxVertices = 3_000_000): Promise<HeightfieldView & { textures: (DecodedTexture | null)[]; layouts: number; pieces: number }> {
	const ground = await loadHeightfieldView(node, grid);
	const g = ground.mesh.lods[0]!;
	const folder = await findParentFolder({ id: parentIdOf(node.id) } as Node);
	const trr = (await kidsOf(folder)).find((k) => /_trr_s00\.pac$/i.test(k.name));
	// The sea plane and distant backdrop would hide everything.
	const layouts = (await kidsOf(trr ?? null)).filter((k) => k.meta?.hhScene && !/ocean|water|_far\b|_far\.|sky|occlu/i.test(k.name));
	const textures: (DecodedTexture | null)[] = [null];
	const slot = new Map<string, number>();
	const positions = Array.from(g.positions), normals = Array.from(g.normals ?? []), colors = Array.from(g.colors ?? []);
	const uv: number[] = new Array(g.numVertices * 2).fill(0);
	const indices = Array.from(g.indices);
	const sections = g.sections.map((x) => ({ ...x }));
	let pieces = 0;
	for (const l of layouts) {
		const left = maxVertices - positions.length / 3;
		if (left <= 0) break;
		const v = await loadHhSceneView(l, root, Number.MAX_SAFE_INTEGER, { lod: 'lowest', static: true, maxVertices: left }).catch(() => null);
		if (!v) continue;
		pieces += v.placed;
		const lod = v.mesh.lods[0]!;
		const base = positions.length / 3;
		for (let i = 0; i < lod.numVertices; i++) {
			positions.push(lod.positions[i * 3]!, lod.positions[i * 3 + 1]!, lod.positions[i * 3 + 2]!);
			normals.push(lod.normals?.[i * 3] ?? 0, lod.normals?.[i * 3 + 1] ?? 1, lod.normals?.[i * 3 + 2] ?? 0);
			colors.push(1, 1, 1);
			uv.push(lod.uv?.[i * 2] ?? 0, lod.uv?.[i * 2 + 1] ?? 0);
		}
		for (const sec of lod.sections) {
			const t = v.textures[sec.materialIndex] ?? null;
			const key = t ? t.packagePath : `\0${l.id}/${sec.materialIndex}`;
			let m = slot.get(key);
			if (m === undefined) {
				m = textures.length;
				slot.set(key, m);
				textures.push(t);
			}
			const first = indices.length;
			for (let k = 0; k < sec.numTriangles * 3; k++) indices.push(base + lod.indices[sec.firstIndex + k]!);
			sections.push({ materialIndex: m, firstIndex: first, numTriangles: sec.numTriangles });
		}
	}
	return {
		...ground,
		mesh: {
			lods: [
				{
					numVertices: positions.length / 3,
					positions: Float32Array.from(positions),
					normals: Float32Array.from(normals),
					colors: Float32Array.from(colors),
					uv: Float32Array.from(uv),
					indices: Uint32Array.from(indices),
					sections,
				},
			],
			upAxis: 'y-up',
		},
		triangles: indices.length / 3,
		vertices: positions.length / 3,
		textures,
		layouts: layouts.length,
		pieces,
	};
}
