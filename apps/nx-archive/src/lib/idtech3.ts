/**
 * id Tech 3-family glue (Star Wars Jedi Knight II / Jedi Academy; Quake
 * III layouts): `.md3` models, Ghoul2 `.glm` meshes and `.bsp` levels
 * open in the mesh viewer, textured.
 *
 * Game data spans several `.pk3` (zip) archives in one folder, so the
 * glue indexes every file in the sibling `.pk3`s by path. A surface's
 * shader resolves to an image through the `.shader` scripts' first
 * `map` stage (else the shader name itself), tried as `.tga`, `.jpg`
 * and `.png`. Ghoul2 meshes take their per-surface textures from the
 * folder's `model_default.skin`, which also hides `*off` surfaces.
 *
 * JPEG decoding needs a canvas (browser); headless callers can supply a
 * decoder with {@link setJpegDecoder}.
 */
import { isGlmHelperSurface, parseBsp, parseGlm, parseMd3, parseSkin, type Q3Surface } from '@tootallnate/idtech3';
import { decodeTga } from '@tootallnate/tga';

import type { RenderableMesh } from '~/components/mesh-viewer';
import type { Node } from './archive';
import type { DecodedTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';

type Rgba = { width: number; height: number; pixels: Uint8Array };
let jpegDecoder: ((bytes: Uint8Array) => Promise<Rgba | null>) | null = null;

/** Override JPEG decoding (headless tools without a canvas). */
export function setJpegDecoder(fn: (bytes: Uint8Array) => Promise<Rgba | null>): void {
	jpegDecoder = fn;
}

async function decodeImage(bytes: Uint8Array, name: string): Promise<Rgba | null> {
	if (/\.tga$/i.test(name)) return decodeTga(bytes);
	if (jpegDecoder) return jpegDecoder(bytes);
	if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
	const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
	const c = new OffscreenCanvas(bmp.width, bmp.height);
	const ctx = c.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(bmp, 0, 0);
	const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
	bmp.close();
	return { width: data.width, height: data.height, pixels: new Uint8Array(data.data.buffer) };
}

// ----- Game file index -----

interface GameFiles {
	files: Map<string, Node>;
	shaders: Map<string, string> | null;
}

const gameIndex = new Map<string, Promise<GameFiles>>();

/**
 * The game's search-path folder: the parent of the content root holding
 * the node (`…/base/assets0.pk3/models/…` → `…/base`; Switch ports ship
 * the archives unpacked, `…/base/assets0/models/…` → `…/base`).
 */
function searchFolder(id: string): string | null {
	const m = /^(.*)\/[^/]+\/(?:models|maps|textures|gfx|shaders)\//i.exec(id);
	return m ? m[1]! : null;
}

async function gameFiles(id: string, root: Node | null): Promise<GameFiles | null> {
	const dir = searchFolder(id);
	if (!dir || !root) return null;
	let p = gameIndex.get(dir);
	if (!p) {
		p = (async () => {
			const files = new Map<string, Node>();
			const folder = await findNodeById(root, dir);
			const roots = folder?.getChildren ? (await folder.getChildren()).filter((k) => /\.pk3$/i.test(k.name) || k.kind === 'directory') : [];
			// Later archives override earlier ones, like the engine's search path.
			roots.sort((a, b) => a.name.localeCompare(b.name));
			const walk = async (n: Node, prefix: string, depth: number): Promise<void> => {
				if (depth > 12) return;
				for (const k of n.getChildren ? await n.getChildren() : []) {
					const path = prefix ? `${prefix}/${k.name}` : k.name;
					if (k.kind === 'directory' || k.kind === 'htdocs') await walk(k, path, depth + 1);
					else files.set(path.toLowerCase(), k);
				}
			};
			for (const r of roots) await walk(r, '', 0);
			return { files, shaders: null };
		})();
		gameIndex.set(dir, p);
	}
	return p;
}

/** Shader name → image path, from the first non-`$` `map` / `clampmap` of each `.shader` script. */
async function shaderMap(g: GameFiles): Promise<Map<string, string>> {
	if (g.shaders) return g.shaders;
	const out = new Map<string, string>();
	for (const [path, node] of g.files) {
		if (!path.endsWith('.shader')) continue;
		try {
			const text = (await (await node.blob!()).text()).replace(/\/\/[^\n]*/g, '');
			const tokens = text.match(/[{}]|[^\s{}]+/g) ?? [];
			let i = 0;
			while (i < tokens.length) {
				const name = tokens[i]!;
				if (tokens[i + 1] !== '{') {
					i++;
					continue;
				}
				let depth = 0;
				let j = i + 1;
				let img: string | null = null;
				let editor: string | null = null;
				for (; j < tokens.length; j++) {
					const t = tokens[j]!;
					if (t === '{') depth++;
					else if (t === '}') {
						if (--depth === 0) break;
					} else if (!img && /^(map|clampmap)$/i.test(t) && tokens[j + 1] && !tokens[j + 1]!.startsWith('$')) img = tokens[j + 1]!;
					else if (!editor && /^qer_editorimage$/i.test(t)) editor = tokens[j + 1] ?? null;
				}
				const pick = img ?? editor;
				if (pick && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), pick.toLowerCase());
				i = j + 1;
			}
		} catch {
			// skip unreadable scripts
		}
	}
	g.shaders = out;
	return out;
}

const textureCache = new Map<string, Promise<DecodedTexture | null>>();

async function textureFor(shader: string, g: GameFiles): Promise<DecodedTexture | null> {
	const key = shader.toLowerCase().replace(/\\/g, '/');
	if (!key || key === '*off' || key === 'noshader') return null;
	const shaders = await shaderMap(g);
	const bases = [shaders.get(key.replace(/\.(tga|jpg|png)$/, '')), key].filter((b): b is string => !!b).map((b) => b.replace(/\.(tga|jpg|png)$/, ''));
	for (const base of bases) {
		for (const ext of ['.tga', '.jpg', '.png']) {
			const node = g.files.get(base + ext);
			if (!node) continue;
			let p = textureCache.get(base + ext);
			if (!p) {
				p = (async () => {
					const img = await decodeImage(new Uint8Array(await (await node.blob!()).arrayBuffer()), ext);
					if (!img) return null;
					return { packagePath: base + ext, width: img.width, height: img.height, pixels: img.pixels, pixelFormat: ext.slice(1), normalReconstructed: false, flipY: false } satisfies DecodedTexture;
				})().catch(() => null);
				textureCache.set(base + ext, p);
				if (textureCache.size > 512) textureCache.delete(textureCache.keys().next().value!);
			}
			const t = await p;
			if (t) return t;
		}
	}
	return null;
}

// ----- Views -----

/** BSP shaders that never draw as colour (collision, hints, sky, …). */
const HIDDEN_SHADER = /^textures\/(system|common)\/|noshader|caulk|nodraw|clip$|hint|skip|trigger|sky/i;

export interface Idtech3ModelView {
	kind: 'md3' | 'glm' | 'bsp';
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	materials: string[];
	texturesFound: number;
	triangles: number;
	detail: string;
}

export async function loadIdtech3ModelView(node: Node, root: Node | null): Promise<Idtech3ModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const lower = node.name.toLowerCase();
	let surfaces: Q3Surface[];
	let kind: Idtech3ModelView['kind'];
	let detail = '';
	const g = await gameFiles(node.id, root);
	if (lower.endsWith('.glm')) {
		kind = 'glm';
		const glm = parseGlm(bytes);
		// The folder's default skin assigns textures per surface.
		const skinPath = node.id.replace(/[^/]+$/, 'model_default.skin');
		let skin = new Map<string, string>();
		if (root) {
			const sk = await findNodeById(root, skinPath).catch(() => null);
			if (sk?.blob) skin = parseSkin(await (await sk.blob()).text());
		}
		surfaces = glm.surfaces
			.filter((s) => !isGlmHelperSurface(s) && skin.get(s.name.toLowerCase()) !== '*off')
			.map((s) => ({ ...s, shader: skin.get(s.name.toLowerCase()) ?? s.shader }));
		detail = `${glm.numBones} bones (${glm.animName.split('/').pop()}) · ${glm.numLods} LODs`;
	} else if (lower.endsWith('.bsp')) {
		kind = 'bsp';
		const bsp = parseBsp(bytes);
		surfaces = bsp.surfaces.filter((s) => !HIDDEN_SHADER.test(s.shader));
		detail = `${bsp.variant} level · ${bsp.shaders.length} shaders`;
	} else {
		kind = 'md3';
		const md3 = parseMd3(bytes);
		surfaces = md3.surfaces;
		detail = `${md3.numFrames} frame${md3.numFrames === 1 ? '' : 's'}`;
	}
	surfaces = surfaces.filter((s) => s.indices.length > 0);
	if (surfaces.length === 0) throw new Error('No visible geometry');

	// Merge, one section per shader.
	const materials: string[] = [];
	const matIndex = new Map<string, number>();
	let nv = 0;
	let ni = 0;
	for (const s of surfaces) {
		nv += s.positions.length / 3;
		ni += s.indices.length;
	}
	const positions = new Float32Array(nv * 3);
	const normals = new Float32Array(nv * 3);
	const uvs = new Float32Array(nv * 2);
	const indices = new Uint32Array(ni);
	const order = surfaces.map((_, i) => i).sort((a, b) => surfaces[a]!.shader.localeCompare(surfaces[b]!.shader));
	const vbase: number[] = [];
	let v = 0;
	for (const s of surfaces) {
		vbase.push(v);
		positions.set(s.positions, v * 3);
		normals.set(s.normals, v * 3);
		uvs.set(s.uvs, v * 2);
		v += s.positions.length / 3;
	}
	const sections: RenderableMesh['lods'][number]['sections'] = [];
	let k = 0;
	for (const si of order) {
		const s = surfaces[si]!;
		let mi = matIndex.get(s.shader);
		if (mi === undefined) {
			mi = materials.length;
			materials.push(s.shader);
			matIndex.set(s.shader, mi);
		}
		const first = k;
		for (const idx of s.indices) indices[k++] = idx + vbase[si]!;
		const last = sections[sections.length - 1];
		if (last && last.materialIndex === mi) last.numTriangles += s.indices.length / 3;
		else sections.push({ materialIndex: mi, firstIndex: first, numTriangles: s.indices.length / 3 });
	}
	const textures = g ? await Promise.all(materials.map((m) => textureFor(m, g))) : materials.map(() => null);
	const triangles = ni / 3;
	return {
		kind,
		mesh: {
			lods: [{ numVertices: nv, positions, normals, uv: uvs, indices, sections, label: `${nv.toLocaleString()} verts, ${triangles.toLocaleString()} tris` }],
			// Quake III is Z-up.
			upAxis: 'z-up',
		},
		textures,
		materials,
		texturesFound: textures.filter(Boolean).length,
		triangles,
		detail,
	};
}
