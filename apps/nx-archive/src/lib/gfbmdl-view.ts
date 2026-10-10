/**
 * Game Freak GFBMDL (Pokémon: Let's Go) → mesh-viewer view.
 *
 * Parsing and skinning live in `@tootallnate/gfbmdl`; this module does
 * the archive-side work:
 *
 *  - **Companions.** A model's BNTX textures and GFBANM animations are
 *    separate files. Inside a GFPAK they're the pak's other entries
 *    (Pokémon and trainer paks hold model, textures and animations
 *    together). For loose models they're siblings, `../anm/` /
 *    `../anime/` directories, and — for field maps under
 *    `bin/field/model/<area>/` — the textures in
 *    `bin/archive/field/<area>.gfpak`.
 *  - **Textures.** Each material's albedo is decoded once. Texture
 *    alpha is only kept where the material alpha-tests (`DiscardEnable`);
 *    elsewhere it's a shader mask and is forced opaque. Eyes composite
 *    the iris layer (`L1ColTex` on trainers, `LyCol0Tex` on Pokémon)
 *    under the eye texture's alpha cut-out, baked on the CPU.
 *  - **UVs.** The game samples at `base + scale · (uv + translate)` in
 *    V-flipped space. We bake that per vertex (every polygon owns its
 *    vertices, see `buildGfbmdlMesh`), and re-bake it when an animation
 *    moves a material's UVs (eye / mouth expressions).
 */

import * as g from '@tootallnate/gfbmdl';
import type {
	GfbanmAnimation,
	GfbmdlMaterial,
	GfbmdlModel,
	GfbmdlRenderMesh,
	GfbmdlUvTransform,
} from '@tootallnate/gfbmdl';
import { decodeBntxLayer, parseBntx } from '@tootallnate/bntx';

import type { Node } from './archive';
import { getAstcBlockDecoder } from './astc';
import type { DecodedTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';

export interface GfbmdlClip {
	/** State name from the model's `.gfbanmcfg` (e.g. `fi01_wait01`), or the file stem. */
	name: string;
	file: string;
	anim: GfbanmAnimation;
}

export interface GfbmdlModelView {
	model: GfbmdlModel;
	mesh: GfbmdlRenderMesh;
	/** Index buffer with hidden (shadow / collision / FX-mask) materials removed. */
	indices: Uint32Array;
	sections: { materialIndex: number; firstIndex: number; numTriangles: number }[];
	/** Final (transformed) UVs; mutated by the material-animation driver. */
	uv: Float32Array | undefined;
	/** One per material; `null` when no albedo resolved. */
	textures: (DecodedTexture | null)[];
	/** Flat colours for untextured materials (sRGB 0–1). */
	baseColors: ([number, number, number] | null)[];
	/** Base UV transform per material. */
	uvTransforms: GfbmdlUvTransform[];
	clips: GfbmdlClip[];
	/** Clip to open on (an idle / wait clip), or -1 for the bind pose. */
	defaultClip: number;
	hiddenMaterials: number;
	textureNamesWanted: number;
	textureNamesFound: number;
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

/** All ancestors of `node` (nearest first), resolved through the tree. */
async function ancestorsOf(root: Node, node: Node): Promise<Node[]> {
	const out: Node[] = [];
	let id = node.id;
	while (id && id !== root.id) {
		const slash = id.lastIndexOf('/');
		if (slash <= 0) break;
		id = id.slice(0, slash);
		const n = await findNodeById(root, id);
		if (n) out.push(n);
	}
	if (out[out.length - 1]?.id !== root.id) out.push(root);
	return out;
}

/** Leaf files under `dir`, descending plain directories only. */
async function filesUnder(dir: Node, depth = 6): Promise<Node[]> {
	const out: Node[] = [];
	for (const k of await childrenOf(dir)) {
		if (k.kind === 'directory') {
			if (depth > 0) out.push(...(await filesUnder(k, depth - 1)));
		} else if (k.blob) {
			out.push(k);
		}
	}
	return out;
}

async function childNamed(dir: Node | undefined, name: string): Promise<Node | undefined> {
	if (!dir) return undefined;
	return (await childrenOf(dir)).find((k) => k.name === name);
}

/** Companion files for `node`: the enclosing GFPAK, or nearby loose files. */
async function findCompanions(root: Node | null, node: Node): Promise<{ files: Node[]; extraPaks: Node[] }> {
	if (!root) return { files: [], extraPaks: [] };
	const ancestors = await ancestorsOf(root, node);
	const pak = ancestors.find((a) => a.kind === 'gfpak');
	if (pak) return { files: await filesUnder(pak), extraPaks: [] };

	const parent = ancestors[0];
	const files: Node[] = [];
	if (parent) files.push(...(await childrenOf(parent)).filter((k) => k.blob && !k.isContainer));
	// Loose layouts keep animations next door: `<x>/model/` + `<x>/anm/`.
	const grand = ancestors[1];
	if (grand) {
		for (const k of await childrenOf(grand)) {
			if (k.kind === 'directory' && k !== parent && /^(anm|anime|anim|motion|model|tex|texture)$/i.test(k.name)) {
				files.push(...(await childrenOf(k)).filter((f) => f.blob && !f.isContainer));
			}
		}
	}
	// Field maps: `bin/field/model/<area>/x.gfbmdl` ↔ `bin/archive/field/**/<area>.gfpak`.
	const extraPaks: Node[] = [];
	const bin = ancestors.find((a) => a.name === 'bin');
	if (bin && parent) {
		const field = await childNamed(await childNamed(bin, 'archive'), 'field');
		if (field) {
			const want = `${parent.name}.gfpak`.toLowerCase();
			const direct = (await childrenOf(field)).find((k) => k.name.toLowerCase() === want);
			if (direct) extraPaks.push(direct);
			else {
				for (const sub of await childrenOf(field)) {
					if (sub.kind !== 'directory') continue;
					const hit = (await childrenOf(sub)).find((k) => k.name.toLowerCase() === want);
					if (hit) {
						extraPaks.push(hit);
						break;
					}
				}
			}
		}
	}
	return { files, extraPaks };
}

async function readBytes(n: Node): Promise<Uint8Array | null> {
	try {
		return new Uint8Array(await (await n.blob!()).arrayBuffer());
	} catch {
		return null;
	}
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

interface TextureSource {
	name: string;
	read: () => Promise<Uint8Array | null>;
}

/** Index BNTX companions by texture name (file stem, which GFPAK name recovery restores). */
async function indexTextures(files: Node[], extraPaks: Node[]): Promise<Map<string, TextureSource>> {
	const byName = new Map<string, TextureSource>();
	const addNode = (n: Node) => {
		if (!/\.bntx$/i.test(n.name)) return;
		const s = stem(n.name);
		if (!byName.has(s)) byName.set(s, { name: s, read: () => readBytes(n) });
	};
	for (const f of files) addNode(f);
	for (const pak of extraPaks) for (const f of await filesUnder(pak)) addNode(f);
	return byName;
}

/** Decode the first texture of a BNTX to RGBA8. */
async function decodeBntx(bytes: Uint8Array): Promise<{ width: number; height: number; pixels: Uint8Array; format: string } | null> {
	try {
		const parsed = parseBntx(bytes);
		const tex = parsed.textures[0];
		if (!tex) return null;
		const astcDecoder = tex.formatInfo.isAstc ? await getAstcBlockDecoder() : undefined;
		const d = decodeBntxLayer(bytes, tex, 0, { astcDecoder });
		return { width: d.width, height: d.height, pixels: d.pixels, format: tex.formatInfo.name };
	} catch {
		return null;
	}
}

function wrapCoord(t: number, mode: 'repeat' | 'clamp' | 'mirror'): number {
	if (mode === 'clamp') return Math.min(1, Math.max(0, t));
	if (mode === 'mirror') {
		const f = ((t % 2) + 2) % 2;
		return f > 1 ? 2 - f : f;
	}
	return ((t % 1) + 1) % 1;
}

type Wrap = 'repeat' | 'clamp' | 'mirror';

/**
 * Which texture period a material samples. Wrapped UVs make texel →
 * sample-coordinate ambiguous (Pokémon eyes sample around s ∈ [2, 3]
 * with a mirrored wrap), so we take the period of the material's mean
 * sample coordinate and whether that period is mirrored.
 */
interface Period {
	k: number;
	mirrored: boolean;
}

function periodOf(mean: number, wrap: Wrap): Period {
	if (wrap === 'clamp' || !Number.isFinite(mean)) return { k: 0, mirrored: false };
	const k = Math.floor(mean);
	return { k, mirrored: wrap === 'mirror' && (k & 1) !== 0 };
}

/** Texel coordinate (0..1) → sample coordinate within `p`. */
const unwrap = (tex: number, p: Period) => (p.mirrored ? p.k + 1 - tex : p.k + tex);

/**
 * Composite a second colour layer under the albedo: the layer (an
 * iris) shows through where the albedo's alpha is 0. Both layers are
 * affine in the stored UV, so each albedo texel maps — within the
 * period the material samples — to one layer coordinate.
 */
function bakeLayer1(
	l0: { width: number; height: number; pixels: Uint8Array },
	l1: { width: number; height: number; pixels: Uint8Array },
	t0: GfbmdlUvTransform,
	t1: GfbmdlUvTransform,
	wrap1: [Wrap, Wrap],
	period: [Period, Period],
): Uint8Array {
	const out = new Uint8Array(l0.pixels.length);
	for (let y = 0; y < l0.height; y++) {
		for (let x = 0; x < l0.width; x++) {
			const i = (y * l0.width + x) * 4;
			const a = l0.pixels[i + 3] / 255;
			let r = l0.pixels[i], g = l0.pixels[i + 1], b = l0.pixels[i + 2];
			if (a < 1) {
				// Back to the stored (V-flipped) UV, then into layer space.
				const s = unwrap((x + 0.5) / l0.width, period[0]);
				const t = unwrap((y + 0.5) / l0.height, period[1]);
				const u = (s - t0.baseU) / (t0.scaleU || 1) - t0.translateU;
				const vf = (t - t0.baseV) / (t0.scaleV || 1) - t0.translateV;
				const s1 = wrapCoord(t1.baseU + t1.scaleU * (u + t1.translateU), wrap1[0]);
				const t1v = wrapCoord(t1.baseV + t1.scaleV * (vf + t1.translateV), wrap1[1]);
				const lx = Math.min(l1.width - 1, Math.floor(s1 * l1.width));
				const ly = Math.min(l1.height - 1, Math.floor(t1v * l1.height));
				const j = (ly * l1.width + lx) * 4;
				r = r * a + l1.pixels[j] * (1 - a);
				g = g * a + l1.pixels[j + 1] * (1 - a);
				b = b * a + l1.pixels[j + 2] * (1 - a);
			}
			out[i] = r;
			out[i + 1] = g;
			out[i + 2] = b;
			out[i + 3] = 255;
		}
	}
	return out;
}

/** Mean baked sample coordinate (s, t) of a material's vertices. */
function meanSample(mesh: GfbmdlRenderMesh, uv: Float32Array, materialIndex: number): [number, number] {
	let su = 0, sv = 0, n = 0;
	for (const sec of mesh.sections) {
		if (sec.materialIndex !== materialIndex) continue;
		for (let v = sec.firstVertex; v < sec.firstVertex + sec.numVertices; v++) {
			su += uv[v * 2];
			sv += uv[v * 2 + 1];
			n++;
		}
	}
	return n ? [su / n, sv / n] : [0.5, 0.5];
}

/** Write each section's transformed UVs for `transforms` into `uv`. */
export function bakeSectionUvs(
	mesh: GfbmdlRenderMesh,
	transforms: GfbmdlUvTransform[],
	uv: Float32Array,
	onlyMaterial?: number,
): void {
	const raw = mesh.uv0;
	if (!raw) return;
	for (const s of mesh.sections) {
		if (onlyMaterial !== undefined && s.materialIndex !== onlyMaterial) continue;
		const t = transforms[s.materialIndex];
		const end = s.firstVertex + s.numVertices;
		for (let v = s.firstVertex; v < end; v++) {
			const u = raw[v * 2], w = raw[v * 2 + 1];
			if (!t) {
				uv[v * 2] = u;
				uv[v * 2 + 1] = 1 - w;
				continue;
			}
			uv[v * 2] = t.baseU + t.scaleU * (u + t.translateU);
			uv[v * 2 + 1] = t.baseV + t.scaleV * (1 - w + t.translateV);
		}
	}
}

/** Whether a clip's bone / material tracks belong to `model`. */
function clipMatchesModel(model: GfbmdlModel, anim: GfbanmAnimation): boolean {
	const bones = new Set(model.bones.map((b) => b.name));
	const mats = new Set(model.materials.map((m) => m.name));
	const boneHits = anim.bones.filter((b) => bones.has(b.name)).length;
	if (anim.bones.length > 0) return boneHits >= Math.max(1, anim.bones.length * 0.5);
	return anim.materials.some((m) => mats.has(m.name));
}

const IDLE_CLIP = [/^fi01_wait/, /^kw01_wait/, /^ba10_wait/, /wait/i, /idle/i];

export async function parseGfbmdlForView(node: Node, root: Node | null): Promise<GfbmdlModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const model = g.parseGfbmdl(bytes);
	const mesh = g.buildGfbmdlMesh(model);
	if (mesh.numVertices === 0) throw new Error('This GFBMDL contains no drawable geometry');

	// Visible sections + compacted index buffer.
	const hints = model.materials.map((m) => g.materialHints(m));
	const visible = mesh.sections.filter((s) => !hints[s.materialIndex]?.hidden);
	let total = 0;
	for (const s of visible) total += s.numTriangles * 3;
	const indices = new Uint32Array(total);
	const sections: GfbmdlModelView['sections'] = [];
	let o = 0;
	for (const s of visible) {
		indices.set(mesh.indices.subarray(s.firstIndex, s.firstIndex + s.numTriangles * 3), o);
		sections.push({ materialIndex: s.materialIndex, firstIndex: o, numTriangles: s.numTriangles });
		o += s.numTriangles * 3;
	}

	const uvTransforms = model.materials.map((m) => g.colorUvTransform(m));
	const uv = mesh.uv0 ? new Float32Array(mesh.uv0.length) : undefined;
	if (uv) bakeSectionUvs(mesh, uvTransforms, uv);

	// ---- companions ----
	const { files, extraPaks } = await findCompanions(root, node);
	const texIndex = await indexTextures(files, extraPaks);
	const decodedCache = new Map<string, Promise<Awaited<ReturnType<typeof decodeBntx>>>>();
	const decodeByName = (name: string) => {
		let p = decodedCache.get(name);
		if (!p) {
			const src = texIndex.get(name);
			p = src ? src.read().then((b) => (b ? decodeBntx(b) : null)) : Promise.resolve(null);
			decodedCache.set(name, p);
		}
		return p;
	};

	const usedMaterials = new Set(visible.map((s) => s.materialIndex));
	let wanted = 0, found = 0;
	const textures: (DecodedTexture | null)[] = await Promise.all(
		model.materials.map(async (mat: GfbmdlMaterial, i): Promise<DecodedTexture | null> => {
			if (!usedMaterials.has(i)) return null;
			const map = g.albedoTextureMap(mat);
			if (!map) return null;
			wanted++;
			const d = await decodeByName(map.texture);
			if (!d) return null;
			found++;
			let pixels = d.pixels;
			const l1 = g.layer1TextureMap(mat);
			const l1d = l1 ? await decodeByName(l1.texture) : null;
			if (l1 && l1d && uv) {
				const [ms, mt] = meanSample(mesh, uv, i);
				pixels = bakeLayer1(d, l1d, uvTransforms[i], g.layer1UvTransform(mat), [l1.wrapS, l1.wrapT], [
					periodOf(ms, map.wrapS),
					periodOf(mt, map.wrapT),
				]);
			} else if (!hints[i].alphaTest) {
				// Alpha is a shader mask here, not coverage.
				pixels = Uint8Array.from(pixels);
				for (let k = 3; k < pixels.length; k += 4) pixels[k] = 255;
			}
			return {
				packagePath: map.texture,
				width: d.width,
				height: d.height,
				pixels,
				pixelFormat: d.format,
				normalReconstructed: false,
				// BNTX rows are top-down and the baked UVs are already
				// in the game's V-flipped sample space.
				flipY: false,
				wrapS: map.wrapS,
				wrapT: map.wrapT,
			};
		}),
	);
	const baseColors = model.materials.map((m, i): [number, number, number] | null => {
		if (textures[i]) return null;
		const c = m.colors.ConstantColor ?? m.colors.ConstantColor0;
		return c ? [c[0], c[1], c[2]] : null;
	});

	// ---- animations ----
	const stateNames = new Map<string, string>();
	const animNodes: Node[] = [];
	for (const f of files) {
		if (/\.gfbanmcfg$/i.test(f.name)) {
			const b = await readBytes(f);
			if (!b) continue;
			try {
				for (const a of g.parseGfbanmcfg(b).animations) if (a.file && !stateNames.has(a.file)) stateNames.set(a.file, a.name);
			} catch {
				// ignore malformed configs
			}
		} else if (/\.gfbanm$/i.test(f.name)) {
			animNodes.push(f);
		}
	}
	const clips: GfbmdlClip[] = [];
	for (const n of animNodes) {
		const b = await readBytes(n);
		if (!b) continue;
		try {
			const anim = g.parseGfbanm(b);
			if (anim.frameCount < 1 || !clipMatchesModel(model, anim)) continue;
			clips.push({ name: stateNames.get(n.name) ?? stem(n.name), file: n.name, anim });
		} catch {
			// camera / unsupported layouts
		}
	}
	clips.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	let defaultClip = -1;
	for (const re of IDLE_CLIP) {
		const i = clips.findIndex((c) => re.test(c.name) && c.anim.bones.length > 0);
		if (i >= 0) {
			defaultClip = i;
			break;
		}
	}

	return {
		model,
		mesh,
		indices,
		sections,
		uv,
		textures,
		baseColors,
		uvTransforms,
		clips,
		defaultClip,
		hiddenMaterials: model.materials.filter((_, i) => hints[i].hidden && mesh.sections.some((s) => s.materialIndex === i)).length,
		textureNamesWanted: wanted,
		textureNamesFound: found,
	};
}
