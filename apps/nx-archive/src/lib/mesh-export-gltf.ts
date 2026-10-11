/**
 * Full-colour textured export as binary glTF 2.0 (`.glb`), for Blender
 * and other 3D apps, and for slicers that turn textures into filament
 * colours themselves (OrcaSlicer's texture import, with its own colour
 * and mixed-filament matching).
 *
 * The geometry goes through the same print pipeline as STL / 3MF
 * (scale, supports, repair, smoothing; see `model-export.ts`), using
 * the 3MF painter's source tracking: every output triangle knows the
 * source triangle it came from and where its corners sit inside it, so
 * repair caps, thickened walls and subdivided faces keep their colour.
 *
 * # Colour
 *
 * - **Textured surfaces** keep their original texture (re-encoded as
 *   PNG) and UVs, so detail stays at full resolution and the material
 *   stays editable in Blender.
 * - **Everything else** is baked into one generated atlas texture:
 *   vertex-coloured faces (a small gradient cell per triangle), flat
 *   colours (one shared swatch per colour) and faces under decals
 *   (painted-on eyes and the like, a detailed cell with the decal
 *   painted in). Decal geometry itself isn't exported.
 *
 * Slicer support (checked October 2026): OrcaSlicer added glTF / GLB
 * import with texture-to-filament matching in August 2026, so far only
 * in nightly builds (not v2.4.2, nor Snapmaker Orca 2.4.0, whose import
 * dialogs don't accept glTF). Released slicers colour models through
 * the painted 3MF instead.
 *
 * Baking matters for slicers: OrcaSlicer's glTF import (Assimp, see
 * `src/libslic3r/Format/AssimpImport.cpp`) reads base-colour textures
 * and material colours only, ignores vertex colours, and skips colour
 * entirely when a file has no texture at all. It also samples every
 * texture with repeat wrapping, so mirrored-repeat textures (common on
 * N64) are unrolled into a 2× tile with halved UVs; clamped faces whose
 * UVs leave [0, 1] are baked instead.
 *
 * # Units and axes
 *
 * One unit is one millimetre, as in STL and 3MF: slicers import at the
 * right size without a "too small, convert from metres?" prompt, and a
 * Blender scene round-trips back to STL at the same size (the usual
 * 3D-printing setup). glTF is Y-up; the model stands on Y = 0, centred
 * on the origin.
 */

import { encodePngSync } from './png';
import type { ExportMesh, ExportTexture } from './mesh-export';
import {
	KIND_FLAT,
	KIND_TEXTURE,
	KIND_VCOLOR,
	attachDecals,
	sampleSource,
	trackShape,
	triSourceOf,
	type DecalTri,
	type TriSource,
} from './mesh-export-3mf';
import { summarizeRepairs, type RepairReport, type RepairSummary } from './mesh-repair';

export interface GlbOptions {
	/** Painted-on overlays (from `splitDecals`) to bake onto the surfaces beneath. */
	decals?: readonly DecalTri[];
	/** Loop-subdivision passes (shape smoothing). */
	subdivisionPasses?: number;
	/** Make every part a closed solid first (see `mesh-repair.ts`). */
	repair?: false | { minThickness: number };
	/** Source axis convention. Default `'y-up'`. */
	sourceAxis?: 'y-up' | 'z-up';
	/** Node / mesh name. */
	objectName?: string;
	/** Stored as `asset.extras` (source file, pose, export settings). */
	metadata?: Record<string, string>;
}

export interface GlbResult {
	bytes: Uint8Array;
	triangleCount: number;
	/** Original textures carried over. */
	textureCount: number;
	/** Size of the generated colour atlas, if one was needed. */
	atlas: { width: number; height: number } | null;
	repair: RepairSummary | null;
}

// glTF constants.
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const REPEAT = 10497;
const CLAMP_TO_EDGE = 33071;

/** Largest atlas edge; detail cells shrink until the atlas fits. */
const MAX_ATLAS = 4096;
/** Cell edge (px) for a vertex-colour gradient triangle. */
const GRADIENT_CELL = 8;
/** Cell edge (px) for a flat-colour swatch shared by many triangles. */
const SWATCH_CELL = 4;

// ---------------------------------------------------------------------------
// Original textures
// ---------------------------------------------------------------------------

interface TextureEntry {
	source: ExportTexture;
	/** Final image, top row first (glTF orientation). */
	width: number;
	height: number;
	rgba: Uint8Array;
	/** UV multipliers from mirror unrolling (0.5 on unrolled axes). */
	su: number;
	sv: number;
	clampS: boolean;
	clampT: boolean;
	cutout: boolean;
	/** Output primitive: per corner, global vertex + UV. */
	corners: number[];
	uvs: number[];
}

/**
 * Copy an export texture into glTF orientation (row 0 at V = 0), unroll
 * mirrored-repeat axes into a doubled tile, and bleed opaque colours
 * into cut-out texels (they hold junk RGB that filtering and slicers
 * would otherwise pick up).
 */
function prepareTexture(tex: ExportTexture): Omit<TextureEntry, 'corners' | 'uvs'> {
	const w = tex.width, h = tex.height;
	const mirrorS = tex.wrapS === 'mirror';
	const mirrorT = tex.wrapT === 'mirror';
	const W = mirrorS ? w * 2 : w;
	const H = mirrorT ? h * 2 : h;
	const out = new Uint8Array(W * H * 4);
	let cutout = false;
	for (let y = 0; y < H; y++) {
		const ty = y < h ? y : 2 * h - 1 - y;
		const sy = tex.flipY ? h - 1 - ty : ty;
		for (let x = 0; x < W; x++) {
			const sx = x < w ? x : 2 * w - 1 - x;
			const i = (sy * w + sx) * 4;
			const o = (y * W + x) * 4;
			out[o] = tex.pixels[i]!;
			out[o + 1] = tex.pixels[i + 1]!;
			out[o + 2] = tex.pixels[i + 2]!;
			const a = tex.pixels[i + 3] ?? 255;
			out[o + 3] = a;
			if (a < 128) cutout = true;
		}
	}
	if (cutout) bleedOpaque(out, W, H);
	return {
		source: tex,
		width: W,
		height: H,
		rgba: out,
		su: mirrorS ? 0.5 : 1,
		sv: mirrorT ? 0.5 : 1,
		clampS: tex.wrapS === 'clamp',
		clampT: tex.wrapT === 'clamp',
		cutout,
	};
}

/** Give every cut-out texel the RGB of its nearest opaque texel (BFS); alpha is kept. */
function bleedOpaque(rgba: Uint8Array, w: number, h: number): void {
	const n = w * h;
	const done = new Uint8Array(n);
	const queue = new Int32Array(n);
	let head = 0, tail = 0;
	for (let i = 0; i < n; i++) {
		if (rgba[i * 4 + 3]! >= 128) {
			done[i] = 1;
			queue[tail++] = i;
		}
	}
	if (tail === 0) return;
	while (head < tail) {
		const i = queue[head++]!;
		const x = i % w, y = (i - x) / w;
		for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
			if (j < 0 || done[j]) continue;
			done[j] = 1;
			rgba[j * 4] = rgba[i * 4]!;
			rgba[j * 4 + 1] = rgba[i * 4 + 1]!;
			rgba[j * 4 + 2] = rgba[i * 4 + 2]!;
			queue[tail++] = j;
		}
	}
}

// ---------------------------------------------------------------------------
// Colour atlas
// ---------------------------------------------------------------------------

interface AtlasCell {
	/** Requested edge in px (power of two). */
	size: number;
	/** Shared flat colour, or the triangle's colour source. */
	flat?: readonly [number, number, number];
	src?: TriSource;
	x: number;
	y: number;
}

const pow2ceil = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));

/** Texels per unit area of a texture as mapped onto a triangle. */
function texelDensity(uv: ArrayLike<number>, uo: number, tex: ExportTexture, worldArea: number): number {
	const uvArea = Math.abs((uv[uo + 2]! - uv[uo]!) * (uv[uo + 5]! - uv[uo + 1]!) - (uv[uo + 4]! - uv[uo]!) * (uv[uo + 3]! - uv[uo + 1]!)) / 2;
	return worldArea > 0 ? (uvArea * tex.width * tex.height) / worldArea : 0;
}

function triArea(p: ArrayLike<number>): number {
	const e1 = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
	const e2 = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
	return 0.5 * Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!);
}

/**
 * Cell edge for a triangle baked in detail (decals, out-of-range clamped
 * textures): enough texels to match the densest source mapped onto it.
 */
function detailCellSize(src: TriSource, pos: Float64Array): number {
	const area = triArea(pos);
	let density = 0;
	if (src.kind === KIND_TEXTURE) density = texelDensity(src.attr, 0, src.texture!, area);
	for (const d of src.decals ?? []) density = Math.max(density, texelDensity(d.uv, 0, d.texture, triArea(d.p)));
	// The triangle fills half its square cell.
	return Math.min(64, Math.max(8, pow2ceil(Math.sqrt(2 * area * density) + 2)));
}

/** Shelf-pack power-of-two cells (largest first); returns the atlas size or null if too tall. */
function packCells(cells: AtlasCell[], width: number): number | null {
	const order = cells.map((_, i) => i).sort((a, b) => cells[b]!.size - cells[a]!.size);
	let x = 0, y = 0, rowH = 0;
	for (const i of order) {
		const c = cells[i]!;
		const s = Math.min(c.size, width);
		if (x + s > width) {
			y += rowH;
			x = 0;
			rowH = 0;
		}
		c.x = x;
		c.y = y;
		x += s;
		rowH = Math.max(rowH, s);
	}
	const height = Math.ceil((y + rowH) / 4) * 4;
	return height <= MAX_ATLAS ? Math.max(4, height) : null;
}

/** Lay out and paint the atlas. Cell sizes may shrink to fit {@link MAX_ATLAS}. */
function buildAtlas(cells: AtlasCell[]): { width: number; height: number; rgba: Uint8Array } {
	for (;;) {
		const area = cells.reduce((n, c) => n + c.size * c.size, 0);
		const width = Math.min(MAX_ATLAS, Math.max(16, pow2ceil(Math.sqrt(area))));
		const height = packCells(cells, width);
		if (height !== null) return { width, height, rgba: paintAtlas(cells, width, height) };
		let shrunk = false;
		for (const c of cells) {
			if (c.size > 4) {
				c.size /= 2;
				shrunk = true;
			}
		}
		if (!shrunk) throw new Error('Too many colored faces to bake into a texture');
	}
}

const MARGIN = 1;

function paintAtlas(cells: AtlasCell[], width: number, height: number): Uint8Array {
	const rgba = new Uint8Array(width * height * 4);
	const rgb = new Uint8Array(3);
	for (const c of cells) {
		const n = c.size;
		const span = n - 2 * MARGIN;
		// Colour for cut-out texels inside a baked triangle.
		let fallback: readonly [number, number, number] = c.flat ?? [160, 160, 160];
		if (c.src && sampleSource(c.src, 1 / 3, 1 / 3, rgb)) fallback = [rgb[0]!, rgb[1]!, rgb[2]!];
		for (let py = 0; py < n; py++) {
			for (let px = 0; px < n; px++) {
				let r = fallback[0], g = fallback[1], b = fallback[2];
				if (c.src && span > 0) {
					// Pixel centre in the triangle's (s, t) space, clamped onto
					// the triangle so margins repeat its edge colours.
					let s = (px + 0.5 - MARGIN) / span;
					let t = (py + 0.5 - MARGIN) / span;
					s = Math.max(0, s);
					t = Math.max(0, t);
					if (s + t > 1) {
						const k = s + t;
						s /= k;
						t /= k;
					}
					if (sampleSource(c.src, s, t, rgb)) {
						r = rgb[0]!;
						g = rgb[1]!;
						b = rgb[2]!;
					}
				}
				const o = ((c.y + py) * width + c.x + px) * 4;
				rgba[o] = r;
				rgba[o + 1] = g;
				rgba[o + 2] = b;
				rgba[o + 3] = 255;
			}
		}
	}
	return rgba;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function buildTexturedGlb(inputs: readonly ExportMesh[], options: GlbOptions = {}): GlbResult {
	const passes = options.subdivisionPasses ?? 0;
	const repair = options.repair || null;
	const reports: RepairReport[] = [];
	const zUp = options.sourceAxis === 'z-up';

	// Global vertex pool (glTF axes, mm) shared by every primitive.
	const pos: number[] = [];
	const textures = new Map<ExportTexture, TextureEntry>();
	const cells: AtlasCell[] = [];
	const swatches = new Map<number, number>();
	/** Atlas triangles: global corners + cell index (UVs assigned after packing). */
	const atlasTris: { corners: [number, number, number]; cell: number; swatch: boolean }[] = [];
	const rgb = new Uint8Array(3);
	let triangleCount = 0;

	const swatchCell = (c: readonly [number, number, number]): number => {
		const key = (c[0] << 16) | (c[1] << 8) | c[2];
		let i = swatches.get(key);
		if (i === undefined) {
			i = cells.length;
			cells.push({ size: SWATCH_CELL, flat: c, x: 0, y: 0 });
			swatches.set(key, i);
		}
		return i;
	};

	for (const inp of inputs) {
		const shape = trackShape(inp, passes, repair, reports);
		const P = shape.mesh.positions;
		const base = pos.length / 3;
		for (let v = 0; v < P.length / 3; v++) {
			const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
			if (zUp) pos.push(x, z, -y);
			else pos.push(x, y, z);
		}
		const idx = shape.mesh.indices;
		for (let t = 0; t < idx.length / 3; t++) {
			const ia = idx[t * 3]!, ib = idx[t * 3 + 1]!, ic = idx[t * 3 + 2]!;
			const tp = Float64Array.of(P[ia * 3]!, P[ia * 3 + 1]!, P[ia * 3 + 2]!, P[ib * 3]!, P[ib * 3 + 1]!, P[ib * 3 + 2]!, P[ic * 3]!, P[ic * 3 + 1]!, P[ic * 3 + 2]!);
			let finite = true;
			for (let k = 0; k < 9; k++) if (!Number.isFinite(tp[k]!)) finite = false;
			if (!finite || !(triArea(tp) > 0)) continue;
			triangleCount++;
			const corners: [number, number, number] = [base + ia, base + ib, base + ic];
			const src = triSourceOf(shape.input, shape.src[t]!, shape.bary, t * 9);
			if (options.decals?.length) attachDecals(src, tp, options.decals);

			if (src.kind === KIND_TEXTURE && !src.decals) {
				const tex = src.texture!;
				let e = textures.get(tex);
				if (!e) {
					e = { ...prepareTexture(tex), corners: [], uvs: [] };
					textures.set(tex, e);
				}
				const a = src.attr;
				const outOfRange = (o: number) => [a[o]!, a[o + 2]!, a[o + 4]!].some((v) => v < -1e-3 || v > 1 + 1e-3);
				if (!((e.clampS && outOfRange(0)) || (e.clampT && outOfRange(1)))) {
					for (let k = 0; k < 3; k++) {
						e.corners.push(corners[k]!);
						e.uvs.push(a[k * 2]! * e.su, a[k * 2 + 1]! * e.sv);
					}
					continue;
				}
				// Clamped texture sampled outside [0, 1]: bake instead.
				cells.push({ size: detailCellSize(src, tp), src, x: 0, y: 0 });
				atlasTris.push({ corners, cell: cells.length - 1, swatch: false });
				continue;
			}
			if (src.decals) {
				cells.push({ size: detailCellSize(src, tp), src, x: 0, y: 0 });
				atlasTris.push({ corners, cell: cells.length - 1, swatch: false });
				continue;
			}
			if (src.kind === KIND_VCOLOR) {
				// Uniform vertex colour → shared swatch; gradients get a cell.
				const cs: number[] = [];
				for (const [s, tt] of [[0, 0], [1, 0], [0, 1]] as const) {
					sampleSource(src, s, tt, rgb);
					cs.push(rgb[0]!, rgb[1]!, rgb[2]!);
				}
				const uniform = cs.every((v, i) => Math.abs(v - cs[i % 3]!) <= 1);
				if (uniform) {
					atlasTris.push({ corners, cell: swatchCell([cs[0]!, cs[1]!, cs[2]!]), swatch: true });
				} else {
					cells.push({ size: GRADIENT_CELL, src, x: 0, y: 0 });
					atlasTris.push({ corners, cell: cells.length - 1, swatch: false });
				}
				continue;
			}
			if (src.kind === KIND_FLAT) {
				atlasTris.push({ corners, cell: swatchCell(src.flat), swatch: true });
			}
		}
	}

	// --- Placement: centred on the origin, standing on Y = 0. ------------
	const used = new Uint8Array(pos.length / 3);
	for (const e of textures.values()) for (const v of e.corners) used[v] = 1;
	for (const t of atlasTris) for (const v of t.corners) used[v] = 1;
	const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let v = 0; v < used.length; v++) {
		if (!used[v]) continue;
		for (let k = 0; k < 3; k++) {
			mn[k] = Math.min(mn[k]!, pos[v * 3 + k]!);
			mx[k] = Math.max(mx[k]!, pos[v * 3 + k]!);
		}
	}
	const shift = Number.isFinite(mn[0]!) ? [-(mn[0]! + mx[0]!) / 2, -mn[1]!, -(mn[2]! + mx[2]!) / 2] : [0, 0, 0];

	// Inside-out sources (mirrored formats) would shade dark in Blender.
	let vol = 0;
	const forEachTri = (fn: (c: number[], o: number) => void) => {
		for (const e of textures.values()) for (let o = 0; o < e.corners.length; o += 3) fn(e.corners, o);
		for (const t of atlasTris) fn(t.corners, 0);
	};
	forEachTri((c, o) => {
		const a = c[o]! * 3, b = c[o + 1]! * 3, d = c[o + 2]! * 3;
		vol += pos[a]! * (pos[b + 1]! * pos[d + 2]! - pos[b + 2]! * pos[d + 1]!) - pos[a + 1]! * (pos[b]! * pos[d + 2]! - pos[b + 2]! * pos[d]!) + pos[a + 2]! * (pos[b]! * pos[d + 1]! - pos[b + 1]! * pos[d]!);
	});
	const flip = vol < 0;

	// --- Atlas. -------------------------------------------------------------
	const atlas = cells.length ? buildAtlas(cells) : null;

	// --- Primitives. --------------------------------------------------------
	interface Prim {
		name: string;
		positions: Float32Array;
		uvs: Float32Array;
		indices: Uint32Array;
		image: { width: number; height: number; rgba: Uint8Array };
		clampS: boolean;
		clampT: boolean;
		cutout: boolean;
	}
	const prims: Prim[] = [];
	/** Weld corners sharing a vertex and UV into one glTF vertex. */
	const emit = (corners: ArrayLike<number>, uvs: ArrayLike<number>) => {
		const map = new Map<string, number>();
		const P: number[] = [];
		const U: number[] = [];
		const I: number[] = [];
		const n = corners.length / 3;
		for (let t = 0; t < n; t++) {
			const order = flip ? [0, 2, 1] : [0, 1, 2];
			for (const k of order) {
				const c = t * 3 + k;
				const v = corners[c]!;
				const u = uvs[c * 2]!, w = uvs[c * 2 + 1]!;
				const key = `${v}|${u}|${w}`;
				let i = map.get(key);
				if (i === undefined) {
					i = P.length / 3;
					map.set(key, i);
					P.push(pos[v * 3]! + shift[0]!, pos[v * 3 + 1]! + shift[1]!, pos[v * 3 + 2]! + shift[2]!);
					U.push(u, w);
				}
				I.push(i);
			}
		}
		return { positions: new Float32Array(P), uvs: new Float32Array(U), indices: Uint32Array.from(I) };
	};
	let texNo = 0;
	for (const e of textures.values()) {
		if (!e.corners.length) continue;
		prims.push({ name: `texture_${++texNo}`, ...emit(e.corners, e.uvs), image: e, clampS: e.clampS, clampT: e.clampT, cutout: e.cutout });
	}
	if (atlas) {
		const corners: number[] = [];
		const uvs: number[] = [];
		for (const t of atlasTris) {
			const c = cells[t.cell]!;
			for (let k = 0; k < 3; k++) {
				corners.push(t.corners[k]!);
				let px: number, py: number;
				if (t.swatch) {
					px = c.x + c.size / 2;
					py = c.y + c.size / 2;
				} else {
					// Corner k of the triangle's (s, t) parameterisation.
					const span = c.size - 2 * MARGIN;
					px = c.x + MARGIN + (k === 1 ? span : 0);
					py = c.y + MARGIN + (k === 2 ? span : 0);
				}
				uvs.push(px / atlas.width, py / atlas.height);
			}
		}
		prims.push({ name: 'baked_colors', ...emit(corners, uvs), image: atlas, clampS: true, clampT: true, cutout: false });
	}

	const bytes = writeGlb(prims, options);
	return {
		bytes,
		triangleCount,
		textureCount: texNo,
		atlas: atlas ? { width: atlas.width, height: atlas.height } : null,
		repair: repair ? summarizeRepairs(reports) : null,
	};

	// -----------------------------------------------------------------------
	function writeGlb(primitives: Prim[], opts: GlbOptions): Uint8Array {
		const chunks: Uint8Array[] = [];
		let binLength = 0;
		const bufferViews: Record<string, unknown>[] = [];
		const addView = (data: Uint8Array, target?: number): number => {
			const pad = (4 - (binLength % 4)) % 4;
			if (pad) {
				chunks.push(new Uint8Array(pad));
				binLength += pad;
			}
			bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, ...(target && { target }) });
			chunks.push(data);
			binLength += data.byteLength;
			return bufferViews.length - 1;
		};
		const bytesOf = (a: Float32Array | Uint32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
		const accessors: Record<string, unknown>[] = [];
		const images: Record<string, unknown>[] = [];
		const samplers: Record<string, unknown>[] = [];
		const texturesJson: Record<string, unknown>[] = [];
		const materials: Record<string, unknown>[] = [];
		const gltfPrims: Record<string, unknown>[] = [];
		for (const p of primitives) {
			const vcount = p.positions.length / 3;
			const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
			for (let i = 0; i < vcount; i++) {
				for (let k = 0; k < 3; k++) {
					lo[k] = Math.min(lo[k]!, p.positions[i * 3 + k]!);
					hi[k] = Math.max(hi[k]!, p.positions[i * 3 + k]!);
				}
			}
			accessors.push({ bufferView: addView(bytesOf(p.positions), ARRAY_BUFFER), componentType: FLOAT, count: vcount, type: 'VEC3', min: lo, max: hi });
			const posAcc = accessors.length - 1;
			accessors.push({ bufferView: addView(bytesOf(p.uvs), ARRAY_BUFFER), componentType: FLOAT, count: vcount, type: 'VEC2' });
			const uvAcc = accessors.length - 1;
			accessors.push({ bufferView: addView(bytesOf(p.indices), ELEMENT_ARRAY_BUFFER), componentType: UNSIGNED_INT, count: p.indices.length, type: 'SCALAR' });
			const idxAcc = accessors.length - 1;
			images.push({ name: p.name, mimeType: 'image/png', bufferView: addView(encodePngSync(p.image.width, p.image.height, p.image.rgba)) });
			samplers.push({ wrapS: p.clampS ? CLAMP_TO_EDGE : REPEAT, wrapT: p.clampT ? CLAMP_TO_EDGE : REPEAT });
			texturesJson.push({ sampler: samplers.length - 1, source: images.length - 1 });
			materials.push({
				name: p.name,
				pbrMetallicRoughness: { baseColorTexture: { index: texturesJson.length - 1 }, metallicFactor: 0, roughnessFactor: 1 },
				doubleSided: true,
				...(p.cutout && { alphaMode: 'MASK', alphaCutoff: 0.5 }),
			});
			gltfPrims.push({ attributes: { POSITION: posAcc, TEXCOORD_0: uvAcc }, indices: idxAcc, material: materials.length - 1 });
		}
		const name = opts.objectName ?? 'model';
		const json: Record<string, unknown> = {
			asset: { version: '2.0', generator: 'nx-archive', ...(opts.metadata && { extras: opts.metadata }) },
			scene: 0,
			scenes: [{ name, nodes: [0] }],
			nodes: [{ name, mesh: 0 }],
			meshes: [{ name, primitives: gltfPrims }],
			materials,
			textures: texturesJson,
			images,
			samplers,
			accessors,
			bufferViews,
			buffers: [{ byteLength: binLength }],
		};
		if (!gltfPrims.length) {
			// glTF requires at least one primitive per mesh.
			delete json.meshes;
			json.nodes = [{ name }];
			for (const k of ['materials', 'textures', 'images', 'samplers', 'accessors', 'bufferViews', 'buffers']) delete json[k];
		}
		const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
		const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
		const binPad = (4 - (binLength % 4)) % 4;
		const hasBin = binLength > 0;
		const total = 12 + 8 + jsonBytes.length + jsonPad + (hasBin ? 8 + binLength + binPad : 0);
		const out = new Uint8Array(total);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, 0x46546c67, true); // "glTF"
		dv.setUint32(4, 2, true);
		dv.setUint32(8, total, true);
		dv.setUint32(12, jsonBytes.length + jsonPad, true);
		dv.setUint32(16, 0x4e4f534a, true); // "JSON"
		out.set(jsonBytes, 20);
		out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
		if (hasBin) {
			let o = 20 + jsonBytes.length + jsonPad;
			dv.setUint32(o, binLength + binPad, true);
			dv.setUint32(o + 4, 0x004e4942, true); // "BIN\0"
			o += 8;
			for (const c of chunks) {
				out.set(c, o);
				o += c.byteLength;
			}
		}
		return out;
	}
}
