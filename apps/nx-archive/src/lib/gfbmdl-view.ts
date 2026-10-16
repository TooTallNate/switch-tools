/**
 * Game Freak GFBMDL (Pokémon: Let's Go) → mesh-viewer view.
 *
 * Parsing and skinning live in `@tootallnate/gfbmdl`; this module does
 * the archive-side work:
 *
 *  - **Companions.** A model's BNTX textures and GFBANM animations are
 *    separate files. Inside a GFPAK they're the pak's other entries
 *    (Pokémon and trainer paks hold model, textures and animations
 *    together); trainer variant paks borrow the base pak's animations
 *    (see `siblingVariantAnimations`). For loose models they're siblings, `../anm/` /
 *    `../anime/` directories, and — for field maps under
 *    `bin/field/model/<area>/` — the textures in
 *    `bin/archive/field/<area>.gfpak`.
 *  - **Textures.** Each material's albedo is decoded once. Texture
 *    alpha is kept where the material alpha-tests (`DiscardEnable`), and
 *    on alpha-blended materials (`BlendMode` ≠ 0) whose alpha is a real
 *    cut-out (eye highlights); elsewhere it's a shader mask and is
 *    forced opaque. Blended materials whose albedo is fully transparent
 *    are effect shells (the `ParasMask` layers over Paras' and
 *    Venomoth's eyes) and are hidden like shadow casters. Eyes composite
 *    the iris layer (`L1ColTex` on trainers, `LyCol0Tex` on Pokémon)
 *    under the eye texture's alpha cut-out, baked on the CPU.
 *  - **UVs.** The game samples at `scale · (uv + translate + base)` in
 *    V-flipped space. We bake that per vertex (every polygon owns its
 *    vertices, see `buildGfbmdlMesh`), and re-bake it when an animation
 *    moves a material's UVs (eye / mouth expressions).
 */

import * as g from '@tootallnate/gfbmdl';
import { applyUvTransform, invertUvTransform } from '@tootallnate/gfbmdl';
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

const isAnimationFile = (name: string) => /\.gfbanm(cfg)?$/i.test(name);

/** `tr0029_01_elitem.gfpak` → id `tr0029`, variant `01`, suffix `_elitem`. */
const VARIANT_PAK = /^([a-z]+\d+)_(\d+)(.*)\.gfpak$/i;

/**
 * Animations for a pak that has none, from sibling paks.
 *
 * - **Variants.** Trainer variants (`tr0029_01_elitem.gfpak`, `_02`, …)
 *   carry only a model and textures; the clips live in the base
 *   variant's pak (`tr0029_00_elitem.gfpak/anm/`). Pokémon variants
 *   don't need this: their rare / gender models sit inside the base
 *   pak itself.
 * - **Reskins.** Some trainers reuse another's rig without clips of
 *   their own (`tr0087_00_gostaff` is `tr0071`, as its texture names
 *   `tr0071_00_*` show); `relatedIds` lists such ids, tried after the
 *   pak's own.
 *
 * Same-id siblings with the same suffix come first, then the lowest
 * variant number. Clips are still filtered by bone names
 * (`clipMatchesModel`), so a wrong guess just adds nothing.
 */
export async function siblingVariantAnimations(pak: Node, dir: Node | undefined, relatedIds: readonly string[]): Promise<Node[]> {
	const m = VARIANT_PAK.exec(pak.name);
	if (!m || !dir) return [];
	const [, id, , suffix] = m;
	const ids = [id!.toLowerCase(), ...relatedIds.map((r) => r.toLowerCase()).filter((r) => r !== id!.toLowerCase())];
	const paks = (await childrenOf(dir))
		.map((k) => ({ k, m: VARIANT_PAK.exec(k.name) }))
		.filter((s) => s.k !== pak && s.m && ids.includes(s.m[1]!.toLowerCase()));
	const rank = (s: (typeof paks)[number]) => ids.indexOf(s.m![1]!.toLowerCase()) * 2 + (s.m![3] === suffix ? 0 : 1);
	paks.sort((a, b) => rank(a) - rank(b) || Number(a.m![2]) - Number(b.m![2]));
	for (const { k } of paks) {
		const anims = (await filesUnder(k)).filter((f) => isAnimationFile(f.name));
		if (anims.length) return anims;
	}
	return [];
}

/** Character ids named by a model's textures (`tr0071_00_eye_col` → `tr0071`), most used first. */
function textureIds(model: GfbmdlModel): string[] {
	const counts = new Map<string, number>();
	for (const mat of model.materials) {
		for (const t of mat.textures) {
			const id = /^([a-z]+\d+)_\d+_/i.exec(t.texture)?.[1];
			if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}
	return [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * The pak named after a model pak's folder, next to that folder:
 * field maps keep geometry in `archive/field/area01/road023_00.gfpak`
 * and the area's shared textures in `archive/field/area01.gfpak`.
 */
export async function folderPak(dir: Node | undefined, parent: Node | undefined): Promise<Node[]> {
	if (!dir || !parent || dir.kind !== 'directory') return [];
	const want = `${dir.name}.gfpak`.toLowerCase();
	const hit = (await childrenOf(parent)).find((k) => k.name.toLowerCase() === want);
	return hit ? [hit] : [];
}

/** Companion files for `node`: the enclosing GFPAK, or nearby loose files. */
async function findCompanions(
	root: Node | null,
	node: Node,
	relatedIds: readonly string[] = [],
): Promise<{ files: Node[]; extraPaks: Node[] }> {
	if (!root) return { files: [], extraPaks: [] };
	const ancestors = await ancestorsOf(root, node);
	const pakIndex = ancestors.findIndex((a) => a.kind === 'gfpak');
	if (pakIndex >= 0) {
		const pak = ancestors[pakIndex]!;
		const files = await filesUnder(pak);
		const dir = ancestors[pakIndex + 1];
		if (!files.some((f) => isAnimationFile(f.name))) {
			files.push(...(await siblingVariantAnimations(pak, dir, relatedIds)));
		}
		return { files, extraPaks: await folderPak(dir, ancestors[pakIndex + 2]) };
	}

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
				// Back to the stored UV, then into layer space.
				const s = unwrap((x + 0.5) / l0.width, period[0]);
				const t = unwrap((y + 0.5) / l0.height, period[1]);
				const [u, w] = invertUvTransform(t0, s, t);
				const [ls, lt] = applyUvTransform(t1, u, w);
				const s1 = wrapCoord(ls, wrap1[0]);
				const t1v = wrapCoord(lt, wrap1[1]);
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

/**
 * How a blended material's albedo alpha behaves: `none` when it's
 * transparent everywhere (an effect shell), `cutout` when it has both
 * clear and solid regions (a highlight decal), else `soft` (uniformly
 * translucent: drawn opaque, which also suits printing).
 */
function alphaCoverage(pixels: Uint8Array): 'none' | 'cutout' | 'soft' {
	let max = 0, clear = 0, solid = 0;
	const n = pixels.length / 4;
	for (let k = 3; k < pixels.length; k += 4) {
		const a = pixels[k]!;
		if (a > max) max = a;
		if (a < 16) clear++;
		else if (a > 240) solid++;
	}
	if (max < 8) return 'none';
	return clear > n * 0.02 && solid > n * 0.002 ? 'cutout' : 'soft';
}

/**
 * Whether material `mi` is an overlay shell: almost all of its vertices
 * lie close (3% of the model's size) to other drawn geometry, and it's
 * a small part of the surface (under a tenth), unlike a wing or a fin.
 */
function isOverlay(
	mesh: GfbmdlRenderMesh,
	drawn: { materialIndex: number; firstVertex: number; numVertices: number; firstIndex: number; numTriangles: number }[],
	mi: number,
): boolean {
	const P = mesh.positions;
	const box = (secs: typeof drawn) => {
		const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (const s of secs) for (let v = s.firstVertex; v < s.firstVertex + s.numVertices; v++) for (let c = 0; c < 3; c++) {
			lo[c] = Math.min(lo[c]!, P[v * 3 + c]!);
			hi[c] = Math.max(hi[c]!, P[v * 3 + c]!);
		}
		return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
	};
	const mine = drawn.filter((s) => s.materialIndex === mi);
	const others = drawn.filter((s) => s.materialIndex !== mi);
	if (mine.length === 0 || others.length === 0) return false;
	const size = box(drawn);
	const area = (secs: typeof drawn) => {
		let sum = 0;
		for (const s of secs) {
			for (let t = 0; t < s.numTriangles; t++) {
				const a = mesh.indices[s.firstIndex + t * 3]! * 3, b = mesh.indices[s.firstIndex + t * 3 + 1]! * 3, c = mesh.indices[s.firstIndex + t * 3 + 2]! * 3;
				const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
				const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
				sum += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
			}
		}
		return sum;
	};
	if (!(size > 0) || area(mine) > area(drawn) * 0.1) return false;
	const r2 = (size * 0.03) ** 2;
	let near = 0, total = 0;
	for (const s of mine) {
		for (let a = s.firstVertex; a < s.firstVertex + s.numVertices; a++, total++) {
			const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
			search: for (const o of others) {
				for (let b = o.firstVertex; b < o.firstVertex + o.numVertices; b++) {
					const dx = P[b * 3]! - ax, dy = P[b * 3 + 1]! - ay, dz = P[b * 3 + 2]! - az;
					if (dx * dx + dy * dy + dz * dz < r2) {
						near++;
						break search;
					}
				}
			}
		}
	}
	return near >= total * 0.9;
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
			const [ss, st] = applyUvTransform(t, u, w);
			uv[v * 2] = ss;
			uv[v * 2 + 1] = st;
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

	const hints = model.materials.map((m) => g.materialHints(m));
	const visible = mesh.sections.filter((s) => !hints[s.materialIndex]?.hidden);

	const uvTransforms = model.materials.map((m) => g.colorUvTransform(m));
	const uv = mesh.uv0 ? new Float32Array(mesh.uv0.length) : undefined;
	if (uv) bakeSectionUvs(mesh, uvTransforms, uv);

	// ---- companions ----
	const { files, extraPaks } = await findCompanions(root, node, textureIds(model));
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
	const invisible = new Set<number>();
	const cutouts = new Set<number>();
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
			const blended = (mat.common.values.BlendMode ?? 0) !== 0;
			const alpha = blended ? alphaCoverage(pixels) : null;
			if (alpha === 'cutout') cutouts.add(i);
			if (alpha === 'none') {
				// A blended layer that draws nothing: an effect shell.
				invisible.add(i);
				found--;
				return null;
			}
			const l1 = g.layer1TextureMap(mat);
			const l1d = l1 ? await decodeByName(l1.texture) : null;
			if (l1 && l1d && uv) {
				const [ms, mt] = meanSample(mesh, uv, i);
				pixels = bakeLayer1(d, l1d, uvTransforms[i], g.layer1UvTransform(mat), [l1.wrapS, l1.wrapT], [
					periodOf(ms, map.wrapS),
					periodOf(mt, map.wrapT),
				]);
			} else if (!hints[i].alphaTest && alpha !== 'cutout') {
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
				// CullMode 0 culls back faces in the game (it's what reveals
				// the pupils behind the inward-facing eye-white shells).
				...((mat.common.values.CullMode ?? 0) === 0 && { backFaceCulled: true }),
			};
		}),
	);
	// Visible sections (minus invisible effect shells) + compacted index buffer.
	const drawn = visible.filter((s) => !invisible.has(s.materialIndex));
	let total = 0;
	for (const s of drawn) total += s.numTriangles * 3;
	const indices = new Uint32Array(total);
	const sections: GfbmdlModelView['sections'] = [];
	let o = 0;
	for (const s of drawn) {
		indices.set(mesh.indices.subarray(s.firstIndex, s.firstIndex + s.numTriangles * 3), o);
		sections.push({ materialIndex: s.materialIndex, firstIndex: o, numTriangles: s.numTriangles });
		o += s.numTriangles * 3;
	}
	if (invisible.size > 0) wanted -= invisible.size;
	// Small blended cut-outs hugging other geometry are overlays (eye
	// highlights): decals, so exports paint them onto what's beneath.
	for (const i of cutouts) if (textures[i] && isOverlay(mesh, drawn, i)) textures[i] = { ...textures[i]!, decal: true };

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
		hiddenMaterials: model.materials.filter((_, i) => (hints[i].hidden || invisible.has(i)) && mesh.sections.some((s) => s.materialIndex === i)).length,
		textureNamesWanted: wanted,
		textureNamesFound: found,
	};
}
