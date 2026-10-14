/**
 * Knights of the Old Republic (BioWare Aurora) glue: `chitin.key` names
 * the `data/*.bif` archives; ERF / RIM / MOD archives list themselves;
 * `.tpc` textures preview; `.mdl` models (with their `.mdx` vertex data)
 * open in the mesh viewer, textured from the game's `override/` folder,
 * `TexturePacks/*.erf` and the BIFs.
 *
 * Parsers: `@tootallnate/aurora`.
 */
import {
	bifHeaderSize,
	decodeTpc,
	erfTablesEnd,
	nameBifEntries,
	parseBif,
	parseErf,
	parseKey,
	parseKotorMdl,
	type AuroraResource,
	type KeyFile,
} from '@tootallnate/aurora';
import { decodeTga } from '@tootallnate/tga';

import type { RenderableMesh } from '~/components/mesh-viewer';
import type { Node } from './archive';
import type { DecodedTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';

// ----- KEY registry -----

/** Folder id → its `chitin.key` blob. */
const keys = new Map<string, { blob: Blob; parsed: Promise<KeyFile> | null }>();

export function registerAuroraKey(folderId: string, blob: Blob): void {
	keys.set(folderId, { blob, parsed: null });
}

/** The KEY governing a BIF, and the BIF's path relative to the KEY's folder. */
async function keyFor(bifId: string): Promise<{ key: KeyFile; rel: string } | null> {
	const parts = bifId.split('/');
	for (let i = parts.length - 1; i > 0; i--) {
		const dir = parts.slice(0, i).join('/');
		const k = keys.get(dir);
		if (!k) continue;
		k.parsed ??= k.blob.arrayBuffer().then((b) => parseKey(new Uint8Array(b)));
		try {
			return { key: await k.parsed, rel: parts.slice(i).join('/').toLowerCase() };
		} catch {
			return null;
		}
	}
	return null;
}

/** Resources of a BIF, named through its KEY when one is registered above it. */
export async function bifResources(bifId: string, blob: Blob): Promise<AuroraResource[]> {
	const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
	const table = new Uint8Array(await blob.slice(0, bifHeaderSize(head)).arrayBuffer());
	const entries = parseBif(table);
	const k = await keyFor(bifId);
	const index = k ? k.key.bifs.findIndex((b) => b.toLowerCase() === k.rel) : -1;
	return nameBifEntries(entries, k && index >= 0 ? k.key : null, index);
}

export async function erfResources(blob: Blob): Promise<AuroraResource[]> {
	const head = new Uint8Array(await blob.slice(0, 160).arrayBuffer());
	const end = erfTablesEnd(head);
	return parseErf(new Uint8Array(await blob.slice(0, Math.max(160, end)).arrayBuffer()));
}

// ----- Texture index -----

/** Game folder (the one holding `chitin.key`) for a node id. */
function gameFolder(id: string): string | null {
	const parts = id.split('/');
	for (let i = parts.length - 1; i > 0; i--) {
		const dir = parts.slice(0, i).join('/');
		if (keys.has(dir)) return dir;
	}
	return null;
}

const textureIndex = new Map<string, Promise<Map<string, Node>>>();

async function texturesOf(folder: string, root: Node): Promise<Map<string, Node>> {
	let p = textureIndex.get(folder);
	if (!p) {
		p = (async () => {
			const out = new Map<string, Node>();
			const add = (n: Node) => {
				const m = /^(.+)\.(tpc|tga)$/i.exec(n.name);
				if (!m) return;
				const ref = m[1]!.toLowerCase();
				// TPC beats TGA; first found wins otherwise.
				const prev = out.get(ref);
				if (!prev || (/\.tga$/i.test(prev.name) && /\.tpc$/i.test(n.name))) out.set(ref, n);
			};
			const walk = async (n: Node, depth: number): Promise<void> => {
				if (depth > 6 || !n.getChildren) return;
				for (const k of await n.getChildren().catch(() => [] as Node[])) {
					if (k.isContainer) await walk(k, depth + 1);
					else add(k);
				}
			};
			const game = await findNodeById(root, folder);
			for (const k of game?.getChildren ? await game.getChildren() : []) {
				const lower = k.name.toLowerCase();
				if (lower === 'override') await walk(k, 0);
			}
			// Texture packs: the high-quality pack first.
			const packs = game?.getChildren ? (await game.getChildren()).find((k) => k.name.toLowerCase() === 'texturepacks') : undefined;
			const erfs = packs?.getChildren ? (await packs.getChildren()).filter((k) => /\.erf$/i.test(k.name)) : [];
			erfs.sort((a, b) => (/tpa/i.test(a.name) ? -1 : /tpa/i.test(b.name) ? 1 : a.name.localeCompare(b.name)));
			for (const e of erfs) await walk(e, 0);
			return out;
		})();
		textureIndex.set(folder, p);
	}
	return p;
}

const textureCache = new Map<string, Promise<DecodedTexture | null>>();

async function textureFor(resref: string, idx: Map<string, Node>): Promise<DecodedTexture | null> {
	if (!resref || resref === 'null') return null;
	const n = idx.get(resref.toLowerCase());
	if (!n?.blob) return null;
	let p = textureCache.get(n.id);
	if (!p) {
		p = (async () => {
			const bytes = new Uint8Array(await (await n.blob!()).arrayBuffer());
			const img = /\.tga$/i.test(n.name) ? decodeTga(bytes) : decodeTpc(bytes);
			return {
				packagePath: n.name,
				width: img.width,
				height: img.height,
				pixels: img.pixels,
				pixelFormat: n.name.split('.').pop()!,
				normalReconstructed: false,
				// TPC rows run bottom-up relative to KotOR's UVs.
				flipY: true,
			} satisfies DecodedTexture;
		})().catch(() => null);
		textureCache.set(n.id, p);
		if (textureCache.size > 256) textureCache.delete(textureCache.keys().next().value!);
	}
	return p;
}

// ----- Model view -----

export interface KotorModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	materials: string[];
	texturesFound: number;
	triangles: number;
	superModel: string;
	nodes: number;
}

export async function loadKotorModelView(node: Node, root: Node | null): Promise<KotorModelView> {
	const mdlBytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const mdxId = node.id.replace(/\.mdl$/i, '.mdx');
	const mdxNode = root ? await findNodeById(root, mdxId).catch(() => null) : null;
	if (!mdxNode?.blob) throw new Error('The model’s .mdx vertex data was not found next to it');
	const model = parseKotorMdl(mdlBytes, new Uint8Array(await (await mdxNode.blob()).arrayBuffer()));
	const meshes = model.meshes.filter((m) => m.indices.length > 0);
	if (meshes.length === 0) throw new Error('No renderable meshes (a supermodel or animation-only model?)');

	const materials: string[] = [];
	const matIndex = new Map<string, number>();
	let nv = 0;
	let ni = 0;
	for (const m of meshes) {
		nv += m.positions.length / 3;
		ni += m.indices.length;
	}
	const positions = new Float32Array(nv * 3);
	const normals = new Float32Array(nv * 3);
	const uvs = new Float32Array(nv * 2);
	const indices = new Uint32Array(ni);
	const sections: RenderableMesh['lods'][number]['sections'] = [];
	let v = 0;
	let k = 0;
	const order = meshes.map((_, i) => i).sort((a, b) => meshes[a]!.texture.localeCompare(meshes[b]!.texture));
	const vbase: number[] = [];
	for (const m of meshes) {
		vbase.push(v);
		positions.set(m.positions, v * 3);
		normals.set(m.normals, v * 3);
		uvs.set(m.uvs, v * 2);
		v += m.positions.length / 3;
	}
	for (const i of order) {
		const m = meshes[i]!;
		let mi = matIndex.get(m.texture);
		if (mi === undefined) {
			mi = materials.length;
			materials.push(m.texture);
			matIndex.set(m.texture, mi);
		}
		const first = k;
		for (const idx of m.indices) indices[k++] = idx + vbase[i]!;
		const last = sections[sections.length - 1];
		if (last && last.materialIndex === mi) last.numTriangles += m.indices.length / 3;
		else sections.push({ materialIndex: mi, firstIndex: first, numTriangles: m.indices.length / 3 });
	}
	const folder = gameFolder(node.id);
	const idx = folder && root ? await texturesOf(folder, root) : new Map<string, Node>();
	const textures = await Promise.all(materials.map((t) => textureFor(t, idx)));
	const triangles = ni / 3;
	return {
		mesh: {
			lods: [{ numVertices: nv, positions, normals, uv: uvs, indices, sections, label: `${nv.toLocaleString()} verts, ${triangles.toLocaleString()} tris` }],
			upAxis: 'z-up',
		},
		textures,
		materials,
		texturesFound: textures.filter(Boolean).length,
		triangles,
		superModel: model.superModel,
		nodes: model.nodeCount,
	};
}
