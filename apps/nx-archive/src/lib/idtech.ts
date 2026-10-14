/**
 * DOOM 3 BFG Edition glue: compiled models from `.resources` open in the
 * mesh viewer, textured and (for MD5 meshes) animated.
 *
 * - `generated/rendermodels/**` static models (`BRMl`: `.blwo`, `.base`,
 *   `.bma`, …) and `.bmd5mesh` skinned models.
 * - `generated/maps/game/*.bproc`: the map's render world, every area
 *   merged into one level model.
 * - Textures: a surface names a material declared in the `.mtr` files of
 *   `_common.resources`; its `diffusemap` image is found as
 *   `generated/images/<image>#__<usage>.bimage` in the model's own
 *   `.resources` (each map's resources carry what the map uses), then in
 *   `_common.resources`.
 * - Animations: the `.bmd5anim` clips under the matching
 *   `generated/anim/…` directory (the md5mesh's own folder).
 *
 * Parsers: `@tootallnate/idtech-models`; images: `@tootallnate/bimage`.
 */
import {
	Md5Pose,
	parseBmd5anim,
	parseBmd5mesh,
	parseBproc,
	parseBrm,
	type IdMd5Anim,
	type IdMd5Model,
	type IdSurface,
} from '@tootallnate/idtech-models';
import { parseBimage } from '@tootallnate/bimage';

import type { RenderableMesh } from '~/components/mesh-viewer';
import type { Node } from './archive';
import { decodeBimageMip0 } from './bimage-decode';
import type { DecodedTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';

// ----- Resources registry -----

export interface ResourcesEntry {
	name: string;
	data: Blob;
}

/** `.resources` node id → its entries by lowercased, forward-slash path. */
const resources = new Map<string, Map<string, ResourcesEntry>>();

export function registerIdTechResources(id: string, entries: ResourcesEntry[]): void {
	const m = new Map<string, ResourcesEntry>();
	for (const e of entries) m.set(e.name.replace(/\\/g, '/').toLowerCase(), e);
	resources.set(id, m);
	imageIndex.delete(id);
}

async function resourcesById(id: string, root: Node | null): Promise<Map<string, ResourcesEntry> | null> {
	const known = resources.get(id);
	if (known) return known;
	if (!root) return null;
	const n = await findNodeById(root, id).catch(() => null);
	if (!n?.getChildren) return null;
	await n.getChildren();
	return resources.get(id) ?? null;
}

/** The `.resources` ancestor of a node id, and the path inside it. */
export function splitResourcesId(id: string): { resId: string; path: string } | null {
	const m = /^(.*?\.resources)\/(.*)$/i.exec(id);
	return m ? { resId: m[1]!, path: m[2]! } : null;
}

/** `_common.resources` for a resources id: the nearest ancestor folder holding one. */
function commonResourcesIds(resId: string): string[] {
	const parts = resId.split('/');
	const out: string[] = [];
	for (let i = parts.length - 1; i > 0; i--) out.push([...parts.slice(0, i), '_common.resources'].join('/'));
	return out;
}

// ----- Materials (.mtr) -----

/** Material name (lowercased) → diffuse image path (lowercased, no extension). */
let materialMap: Map<string, string> | null = null;
let materialMapFor: string | null = null;

/** Parse `.mtr` declarations for their diffuse image. */
export function parseMaterialDiffuse(text: string, out: Map<string, string>): void {
	const src = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
	const tokens = src.match(/"[^"]*"|[{}()]|[^\s{}()"]+/g) ?? [];
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i]!;
		if (t === '{' || t === '}') {
			i++;
			continue;
		}
		// `table foo { … }` / `material foo { … }` / `foo { … }`
		let name = t;
		if ((t === 'table' || t === 'material' || t === 'skin' || t === 'particle') && tokens[i + 1] !== '{') {
			if (t === 'table' || t === 'skin' || t === 'particle') {
				i = skipBlock(tokens, i + 2);
				continue;
			}
			name = tokens[i + 1]!;
			i++;
		}
		if (tokens[i + 1] !== '{') {
			i++;
			continue;
		}
		const start = i + 2;
		const end = skipBlock(tokens, i + 1);
		const body = tokens.slice(start, end - 1);
		const img = diffuseOf(body);
		if (img) out.set(name.toLowerCase().replace(/\\/g, '/'), img);
		i = end;
	}
}

/** Index just past the block opening at `open` (a `{`). */
function skipBlock(tokens: string[], open: number): number {
	if (tokens[open] !== '{') return open + 1;
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		if (tokens[i] === '{') depth++;
		else if (tokens[i] === '}' && --depth === 0) return i + 1;
	}
	return tokens.length;
}

function cleanImage(s: string | undefined): string | null {
	if (!s || s === '{' || s === '}' || s === '(' || /^(addnormals|heightmap|makealpha|makeintensity|downsize|scale)$/i.test(s)) return null;
	return s.replace(/^"|"$/g, '').replace(/\\/g, '/').replace(/\.(tga|png|jpg|dds)$/i, '').toLowerCase();
}

function diffuseOf(body: string[]): string | null {
	for (let i = 0; i < body.length; i++) {
		if (/^diffusemap$/i.test(body[i]!)) {
			const c = cleanImage(body[i + 1]);
			if (c) return c;
		}
	}
	// `{ blend diffusemap … map <image> }`
	for (let i = 0; i < body.length; i++) {
		if (/^blend$/i.test(body[i]!) && /^diffusemap$/i.test(body[i + 1] ?? '')) {
			for (let j = i + 2; j < Math.min(body.length, i + 24) && body[j] !== '}'; j++) {
				if (/^map$/i.test(body[j]!)) {
					const c = cleanImage(body[j + 1]);
					if (c) return c;
				}
			}
		}
	}
	for (let i = 0; i < body.length; i++) {
		if (/^qer_editorimage$/i.test(body[i]!)) {
			const c = cleanImage(body[i + 1]);
			if (c) return c;
		}
	}
	return null;
}

async function materials(resId: string, root: Node | null): Promise<Map<string, string>> {
	for (const cid of [resId, ...commonResourcesIds(resId)]) {
		if (materialMap && materialMapFor === cid) return materialMap;
		const res = await resourcesById(cid, root);
		if (!res) continue;
		const mtrs = [...res.values()].filter((e) => /\.mtr$/i.test(e.name));
		if (mtrs.length === 0) continue;
		const map = new Map<string, string>();
		for (const e of mtrs) {
			try {
				parseMaterialDiffuse(await e.data.text(), map);
			} catch {
				// one bad file doesn't sink the rest
			}
		}
		materialMap = map;
		materialMapFor = cid;
		return map;
	}
	return new Map();
}

// ----- Images -----

/** resources id → image base path (before `#__`) → entry. */
const imageIndex = new Map<string, Map<string, ResourcesEntry>>();

function imagesOf(resId: string, res: Map<string, ResourcesEntry>): Map<string, ResourcesEntry> {
	let idx = imageIndex.get(resId);
	if (idx) return idx;
	idx = new Map();
	for (const [path, e] of res) {
		const m = /^generated\/images\/(.+?)(?:#__[0-9a-f]+)?\.bimage$/.exec(path);
		if (m && !idx.has(m[1]!)) idx.set(m[1]!, e);
	}
	imageIndex.set(resId, idx);
	return idx;
}

const textureCache = new Map<string, Promise<DecodedTexture | null>>();

async function textureFor(material: string, resId: string, root: Node | null): Promise<DecodedTexture | null> {
	const mat = material.toLowerCase().replace(/\\/g, '/');
	const mats = await materials(resId, root);
	const candidates = [mats.get(mat), `${mat}_d`, mat, mats.get(mat)?.replace(/_d$/, '')].filter((c): c is string => !!c);
	for (const rid of [resId, ...commonResourcesIds(resId)]) {
		const res = await resourcesById(rid, root);
		if (!res) continue;
		const imgs = imagesOf(rid, res);
		for (const c of candidates) {
			const e = imgs.get(c);
			if (!e) continue;
			const key = `${rid}|${c}`;
			let p = textureCache.get(key);
			if (!p) {
				p = (async () => {
					const img = await decodeBimageMip0(await parseBimage(e.data));
					return {
						packagePath: c,
						width: img.width,
						height: img.height,
						pixels: img.pixels,
						pixelFormat: 'bimage',
						normalReconstructed: false,
						// BFG images are top-down with t = 0 at the top.
						flipY: false,
					} satisfies DecodedTexture;
				})().catch(() => null);
				textureCache.set(key, p);
				if (textureCache.size > 256) textureCache.delete(textureCache.keys().next().value!);
			}
			const t = await p;
			if (t) return t;
		}
	}
	return null;
}

// ----- Views -----

/** Surfaces that never draw as colour: collision, caulk, shadow / portal helpers. */
const HIDDEN = /^textures\/(common|editor)\/|shadow|caulk|nodraw|collision|_portal|clip$|mflash|muzzle|_flare/i;

export interface IdTechClip {
	name: string;
	frameCount: number;
	fps: number;
	load: () => Promise<IdMd5Anim>;
}

export interface IdTechModelView {
	kind: 'static' | 'md5' | 'level';
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	materials: string[];
	texturesFound: number;
	texturesWanted: number;
	triangles: number;
	/** MD5: model + pose + per-mesh vertex offsets, for skinning. */
	md5?: { model: IdMd5Model; pose: Md5Pose; offsets: number[] };
	clips: IdTechClip[];
	/** Default clip (an idle) for the viewer and thumbnails, or −1. */
	defaultClip: number;
	areas?: number;
}

function merge(surfaces: IdSurface[]): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array; sections: { materialIndex: number; firstIndex: number; numTriangles: number }[]; materials: string[]; offsets: number[] } {
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
	const offsets: number[] = [];
	// Group by material so each material is one section.
	const order = surfaces.map((s, i) => i).sort((a, b) => surfaces[a]!.material.localeCompare(surfaces[b]!.material));
	const sections: { materialIndex: number; firstIndex: number; numTriangles: number }[] = [];
	let v = 0;
	let k = 0;
	const vbase: number[] = [];
	surfaces.forEach((s) => {
		vbase.push(v);
		positions.set(s.positions, v * 3);
		normals.set(s.normals, v * 3);
		uvs.set(s.uvs, v * 2);
		v += s.positions.length / 3;
	});
	offsets.push(...vbase);
	for (const si of order) {
		const s = surfaces[si]!;
		let mi = matIndex.get(s.material);
		if (mi === undefined) {
			mi = materials.length;
			materials.push(s.material);
			matIndex.set(s.material, mi);
		}
		const first = k;
		for (let j = 0; j < s.indices.length; j++) indices[k++] = s.indices[j]! + vbase[si]!;
		const last = sections[sections.length - 1];
		if (last && last.materialIndex === mi) last.numTriangles += s.indices.length / 3;
		else sections.push({ materialIndex: mi, firstIndex: first, numTriangles: s.indices.length / 3 });
	}
	return { positions, normals, uvs, indices, sections, materials, offsets };
}

async function bytesOf(node: Node): Promise<Uint8Array> {
	return new Uint8Array(await (await node.blob!()).arrayBuffer());
}

export async function loadIdTechModelView(node: Node, root: Node | null): Promise<IdTechModelView> {
	const kind = node.meta?.idtechModel as IdTechModelView['kind'];
	const bytes = await bytesOf(node);
	const where = splitResourcesId(node.id);
	let surfaces: IdSurface[];
	let md5: IdTechModelView['md5'];
	let areas: number | undefined;
	if (kind === 'md5') {
		const model = parseBmd5mesh(bytes);
		surfaces = model.meshes;
		md5 = { model, pose: new Md5Pose(model), offsets: [] };
	} else if (kind === 'level') {
		const proc = parseBproc(bytes);
		surfaces = proc.models.flatMap((m) => m.surfaces);
		areas = proc.models.filter((m) => /^_area\d+$/i.test(m.entryName)).length;
	} else {
		surfaces = parseBrm(bytes).surfaces;
	}
	surfaces = surfaces.filter((s) => s.indices.length > 0 && s.positions.length > 0 && !HIDDEN.test(s.material));
	if (surfaces.length === 0) throw new Error('Model has no visible geometry');
	const m = merge(surfaces);
	if (md5) md5.offsets = m.offsets;

	// Textures, one per material slot.
	let texturesFound = 0;
	const textures = where ? await Promise.all(m.materials.map((mat) => textureFor(mat, where.resId, root))) : m.materials.map(() => null);
	texturesFound = textures.filter(Boolean).length;

	// Clips from the matching anim folder.
	const clips: IdTechClip[] = [];
	if (md5 && where) {
		const res = await resourcesById(where.resId, root);
		const dir = where.path.toLowerCase().replace(/^generated\/rendermodels\//, 'generated/anim/').replace(/[^/]+$/, '');
		if (res) {
			for (const [path, e] of res) {
				if (!path.startsWith(dir) || !path.endsWith('.bmd5anim') || path.slice(dir.length).includes('/')) continue;
				let parsed: Promise<IdMd5Anim> | null = null;
				const head = new Uint8Array(await e.data.slice(0, 0x1c).arrayBuffer());
				const dv = new DataView(head.buffer);
				const frames = head.length >= 0x14 ? dv.getInt32(0x0c, false) : 0;
				const fps = head.length >= 0x14 ? dv.getInt32(0x10, false) : 24;
				if (frames < 1) continue;
				clips.push({
					name: path.slice(dir.length).replace(/\.bmd5anim$/, ''),
					frameCount: frames,
					fps: fps > 0 ? fps : 24,
					load: () => (parsed ??= e.data.arrayBuffer().then((b) => parseBmd5anim(new Uint8Array(b)))),
				});
			}
		}
		clips.sort((a, b) => a.name.localeCompare(b.name));
	}
	const defaultClip = clips.findIndex((c) => /^idle/.test(c.name));

	const nv = m.positions.length / 3;
	const triangles = m.indices.length / 3;
	const mesh: RenderableMesh = {
		lods: [
			{
				numVertices: nv,
				positions: Float32Array.from(m.positions),
				normals: Float32Array.from(m.normals),
				uv: m.uvs,
				indices: m.indices,
				sections: m.sections,
				label: `${nv.toLocaleString()} verts, ${triangles.toLocaleString()} tris`,
			},
		],
		// idTech is Z-up.
		upAxis: 'z-up',
	};
	return {
		kind,
		mesh,
		textures,
		materials: m.materials,
		texturesFound,
		texturesWanted: m.materials.length,
		triangles,
		md5,
		clips,
		defaultClip,
		areas,
	};
}

/** Skin the view's MD5 meshes at a clip frame into `positions` / `normals`. */
export function poseIdTechView(view: IdTechModelView, anim: IdMd5Anim | null, frame: number, positions: Float32Array, normals: Float32Array | null): void {
	const md5 = view.md5;
	if (!md5) return;
	md5.pose.setPose(anim, frame);
	const visible = md5.model.meshes.filter((s) => s.indices.length > 0 && s.positions.length > 0 && !HIDDEN.test(s.material));
	visible.forEach((mesh, i) => md5.pose.skin(mesh, positions, normals, md5.offsets[i] ?? 0));
}
