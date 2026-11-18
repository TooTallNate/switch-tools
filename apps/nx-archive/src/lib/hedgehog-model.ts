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
import { parseHhMaterial, parseHhModel, type HhMaterial, type HhModel } from '@tootallnate/hedgehog';
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
		}
		if (!m.normals) allNormals = false;
		sections.push({ materialIndex: slot, firstIndex: indices.length, numTriangles: m.indices.length / 3 });
		for (const i of m.indices) indices.push(base + i);
	}
	if (!indices.length) throw new Error('This model has no drawable meshes');
	const textures = await Promise.all(slotTextures);
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
		model,
		triangles: indices.length / 3,
		vertices: positions.length / 3,
		variants,
		variant,
		texturesWanted: wanted,
		texturesFound: textures.filter(Boolean).length,
		materialsMissing: missing,
	};
}
