/**
 * Multi-colour 3MF export for FDM slicers that support per-triangle
 * filament painting (OrcaSlicer, Bambu Studio, and printers that use
 * them, e.g. Snapmaker U1).
 *
 * Slicers don't consume UV-mapped textures or vertex colours, so the
 * colour has to be baked into filament assignments. Input is the
 * viewer-agnostic {@link ExportMesh} that every viewer's bake step
 * produces:
 *
 *   1. Weld/subdivide geometry exactly like the STL path, but track,
 *      for every output triangle, which *source* triangle it came from
 *      and the barycentric position of its corners within it. Welding
 *      destroys UV / colour seams, so per-corner attributes are always
 *      looked up through the source triangle.
 *   2. Build an area-weighted colour histogram of the surface and
 *      reduce it to N colours (k-means in CIELAB). N = number of
 *      filaments / toolheads.
 *   3. For every triangle, build an Orca/Bambu "paint tree": the
 *      triangle is recursively split 4-ways (to ~1 texel for textures,
 *      or until a vertex-colour gradient resolves), each leaf takes the
 *      nearest palette colour, and uniform subtrees collapse back to a
 *      single leaf. This lets paint detail exceed the mesh resolution —
 *      the same mechanism the slicer's own brush uses.
 *      Leaves landing on alpha-cutout texels (which the viewers
 *      discard) take the triangle's dominant opaque colour instead of
 *      whatever junk RGB the transparent texels hold.
 *   4. Serialise as a 3MF whose `<triangle>` elements carry the
 *      `paint_color` attribute.
 *
 * # `paint_color` encoding
 *
 * Mirrors `TriangleSelector::serialize()` + `FacetsAnnotation::
 * get_triangle_as_string()` in OrcaSlicer (`src/libslic3r/
 * TriangleSelector.cpp`, `Model.cpp`). The bitstream is built from
 * 4-bit codes and the hex string is emitted in *reverse* nibble
 * order, which works out to this grammar (written left-to-right):
 *
 *   leaf(state)   = state < 3  ? hex(state << 2)          // "4", "8"
 *                 : state < 18 ? hex(state - 3) + "C"     // "0C".."EC"
 *   split4(c0..3) = enc(c0) enc(c1) enc(c2) enc(c3) "3"
 *
 * `state` 0 = "unpainted" (object's default filament), 1..N =
 * filament N. A 3-side split (code 3, special side 0) creates
 * children (see `TriangleSelector::perform_split`):
 *
 *   c0 = (v0,  m01, m20)    c1 = (m01, v1,  m12)
 *   c2 = (m12, v2,  m20)    c3 = (m01, m12, m20)   // centre
 *
 * Matches Orca's own colour-OBJ importer, which writes e.g.
 * `"4" + "8" + "0C" + "1C" + "3"` for filaments 1/2/3/4.
 *
 * Orca flips a volume's triangles on import if its signed volume is
 * negative, which would silently re-map every paint tree. We do that
 * flip ourselves beforehand so the trees stay aligned.
 */

import { strToU8, zipSync } from 'fflate';

import {
	loopSubdivide,
	weldByPositionTracked,
	type ExportMaterial,
	type ExportMesh,
	type ExportTexture,
	type ExportTextureWrap,
	type IndexedMesh,
} from './mesh-export';
import {
	defaultMinThickness,
	repairForPrinting,
	summarizeRepairs,
	type RepairReport,
	type RepairSummary,
} from './mesh-repair';

export type Rgb = readonly [number, number, number];

/** One non-empty bin of the area-weighted surface colour histogram. */
export interface ColorBin {
	rgb: Rgb;
	weight: number;
}

export interface Paint3mfOptions {
	/** Number of filaments to quantise to (1–16) for the default k-means palette. */
	colorCount: number;
	/** Painted-on overlays (from {@link splitDecals}) to paint onto the surfaces beneath. */
	decals?: readonly DecalTri[];
	/** Object and plate name shown in the slicer (default: `title`). */
	objectName?: string;
	/**
	 * Extra metadata. Standard 3MF names (Title, Designer, Description,
	 * Copyright, LicenseTerms, Rating, CreationDate, ModificationDate,
	 * Application) are written as-is; anything else is namespaced
	 * `nx:` (e.g. the source file, pose and export settings).
	 */
	metadata?: Record<string, string>;
	/**
	 * Replace the default k-means palette. Receives the area-weighted
	 * surface colours (alpha-cutout texels excluded) and returns the
	 * palette *in filament order*: entry i is painted as filament i + 1.
	 */
	choosePalette?: (bins: ColorBin[]) => Rgb[];
	/**
	 * When set, near-horizontal faces may only use the first N palette
	 * entries. Used for layer-alternation mixes (Snapmaker Full
	 * Spectrum), which can't show on flat tops/bottoms — only the
	 * outermost layer is visible there.
	 */
	flatSurfaceColors?: number;
	/**
	 * Extra archive entries, e.g. `Metadata/project_settings.config`.
	 * A function is called with the final palette.
	 */
	extraFiles?:
		| Record<string, string | Uint8Array>
		| ((palette: Rgb[]) => Record<string, string | Uint8Array>);
	/** Overrides the 3MF `Description` metadata (function: given the final palette). */
	description?: string | ((palette: Rgb[]) => string);
	/**
	 * Plate position (mm) to centre the model on in XY; the model is
	 * also dropped to Z = 0. OrcaSlicer re-centres geometry-only imports
	 * itself, but keeps file coordinates when a 3MF is opened as a
	 * project (e.g. one carrying `project_settings.config`), so the file
	 * has to be on the plate already. Default (128, 128): the centre of
	 * a 256 mm bed.
	 */
	bedCenter?: readonly [number, number];
	/** Loop-subdivision passes before painting (shape smoothing). */
	subdivisionPasses?: number;
	/**
	 * Make every part a closed, outward-facing solid before painting
	 * (see `mesh-repair.ts`). Default true. `minThickness` defaults to
	 * 1 % of the combined bounding-box diagonal.
	 */
	repair?: boolean | { minThickness?: number };
	/** Source axis convention. Default `'y-up'` (rotated to Z-up). */
	sourceAxis?: 'y-up' | 'z-up';
	/**
	 * Maximum paint-tree depth per triangle. Each level splits 4-ways,
	 * so depth 5 allows up to 1024 leaves per triangle. Default 5.
	 */
	maxPaintDepth?: number;
	/** Object name / 3MF title. */
	title?: string;
}

export interface Paint3mfResult {
	bytes: Uint8Array;
	/** Filament colours, index 0 = filament 1. */
	palette: Rgb[];
	triangleCount: number;
	/** Paint-tree leaves sampled, before uniform subtrees collapse (diagnostic). */
	leafCount: number;
	/** Summed repair report across inputs (null when repair is off). */
	repair: RepairSummary | null;
}

const DEFAULT_BASE: Rgb = [160, 160, 160];

// ---------------------------------------------------------------------------
// Paint-tree encoding
// ---------------------------------------------------------------------------

const HEX = '0123456789ABCDEF';

/**
 * Encode one leaf `state` (0 = unpainted, 1.. = filament).
 *
 * States ≥ 3 are the code `0b1100` followed by 4-bit chunks of
 * `state − 3`, where a `0xF` chunk means "add 15, another chunk
 * follows" (Snapmaker Orca's `TriangleSelector::serialize`). Upstream
 * OrcaSlicer / Bambu use the same layout up to state 32, which covers
 * every physical-filament case; higher states are only meaningful to
 * Snapmaker Orca's virtual (mixed) filaments.
 */
export function encodePaintLeaf(state: number): string {
	if (!Number.isInteger(state) || state < 0 || state > 255) {
		throw new RangeError(`paint state ${state} out of range (0–255)`);
	}
	if (state < 3) return HEX[state << 2]!;
	// Nibbles are emitted in reverse, so the final chunk comes first.
	let n = state - 3;
	let continuation = '';
	while (n >= 15) {
		continuation += 'F';
		n -= 15;
	}
	return HEX[n]! + continuation + 'C';
}

/**
 * A paint tree node: a leaf state number, or a 4-way split given as
 * `[c0, c1, c2, c3]` (child layout documented at the top of file).
 */
export type PaintNode = number | readonly [PaintNode, PaintNode, PaintNode, PaintNode];

/** Encode a paint tree as an Orca/Bambu `paint_color` string. */
export function encodePaintTree(node: PaintNode): string {
	if (typeof node === 'number') return encodePaintLeaf(node);
	return (
		encodePaintTree(node[0]) +
		encodePaintTree(node[1]) +
		encodePaintTree(node[2]) +
		encodePaintTree(node[3]) +
		'3'
	);
}

// ---------------------------------------------------------------------------
// Colour science (sRGB bytes <-> CIELAB, D65)
// ---------------------------------------------------------------------------

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
	const c = i / 255;
	SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function labF(t: number): number {
	return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}
function labFInv(t: number): number {
	const t3 = t * t * t;
	return t3 > 216 / 24389 ? t3 : (116 * t - 16) / (24389 / 27);
}

/** sRGB bytes → CIELAB (D65), written to `out[o..o+2]`. */
export function rgbToLab(r: number, g: number, b: number, out: Float64Array, o: number): void {
	const lr = SRGB_TO_LINEAR[r]!;
	const lg = SRGB_TO_LINEAR[g]!;
	const lb = SRGB_TO_LINEAR[b]!;
	const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
	const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
	const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
	const fx = labF(x);
	const fy = labF(y);
	const fz = labF(z);
	out[o] = 116 * fy - 16;
	out[o + 1] = 500 * (fx - fy);
	out[o + 2] = 200 * (fy - fz);
}

function labToRgb(L: number, a: number, bb: number): Rgb {
	const fy = (L + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - bb / 200;
	const x = labFInv(fx) * 0.95047;
	const y = labFInv(fy);
	const z = labFInv(fz) * 1.08883;
	const lin = [
		3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
		-0.969266 * x + 1.8760108 * y + 0.041556 * z,
		0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
	];
	const enc = (c: number) => {
		c = Math.min(1, Math.max(0, c));
		const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
		return Math.round(s * 255);
	};
	return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!)];
}

/** 15-bit RGB bin key (5 bits per channel). */
function binKey(r: number, g: number, b: number): number {
	return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}
const BIN_COUNT = 1 << 15;

// ---------------------------------------------------------------------------
// Palette reduction (weighted k-means over a 15-bit histogram)
// ---------------------------------------------------------------------------

/**
 * Reduce a weighted colour histogram to at most `k` colours.
 * `sums` holds, per 15-bit bin, `[Σr, Σg, Σb, Σweight]`.
 * Deterministic: seeding is greedy farthest-point (k-means++ without
 * randomness), followed by weighted Lloyd iterations in CIELAB.
 */
export function reducePalette(sums: Float64Array, k: number): Rgb[] {
	const bins: number[] = [];
	for (let i = 0; i < BIN_COUNT; i++) if (sums[i * 4 + 3]! > 0) bins.push(i);
	if (bins.length === 0) return [DEFAULT_BASE];

	const n = bins.length;
	const lab = new Float64Array(n * 3);
	const w = new Float64Array(n);
	for (let j = 0; j < n; j++) {
		const o = bins[j]! * 4;
		const wt = sums[o + 3]!;
		w[j] = wt;
		rgbToLab(
			Math.round(sums[o]! / wt),
			Math.round(sums[o + 1]! / wt),
			Math.round(sums[o + 2]! / wt),
			lab,
			j * 3,
		);
	}
	k = Math.max(1, Math.min(k, n));

	// Seed: heaviest bin, then repeatedly the bin maximising w·D².
	const centers = new Float64Array(k * 3);
	let heaviest = 0;
	for (let j = 1; j < n; j++) if (w[j]! > w[heaviest]!) heaviest = j;
	centers.set(lab.subarray(heaviest * 3, heaviest * 3 + 3), 0);
	const d2 = new Float64Array(n).fill(Infinity);
	for (let c = 1; c < k; c++) {
		let best = -1;
		let bestScore = -1;
		for (let j = 0; j < n; j++) {
			const dl = lab[j * 3]! - centers[(c - 1) * 3]!;
			const da = lab[j * 3 + 1]! - centers[(c - 1) * 3 + 1]!;
			const db = lab[j * 3 + 2]! - centers[(c - 1) * 3 + 2]!;
			const d = dl * dl + da * da + db * db;
			if (d < d2[j]!) d2[j] = d;
			const score = w[j]! * d2[j]!;
			if (score > bestScore) {
				bestScore = score;
				best = j;
			}
		}
		if (bestScore <= 0) {
			k = c;
			break;
		}
		centers.set(lab.subarray(best * 3, best * 3 + 3), c * 3);
	}

	const assign = new Int32Array(n);
	const acc = new Float64Array(k * 4);
	for (let iter = 0; iter < 24; iter++) {
		acc.fill(0);
		let changed = false;
		for (let j = 0; j < n; j++) {
			let best = 0;
			let bestD = Infinity;
			for (let c = 0; c < k; c++) {
				const dl = lab[j * 3]! - centers[c * 3]!;
				const da = lab[j * 3 + 1]! - centers[c * 3 + 1]!;
				const db = lab[j * 3 + 2]! - centers[c * 3 + 2]!;
				const d = dl * dl + da * da + db * db;
				if (d < bestD) {
					bestD = d;
					best = c;
				}
			}
			if (assign[j] !== best) changed = true;
			assign[j] = best;
			acc[best * 4] += lab[j * 3]! * w[j]!;
			acc[best * 4 + 1] += lab[j * 3 + 1]! * w[j]!;
			acc[best * 4 + 2] += lab[j * 3 + 2]! * w[j]!;
			acc[best * 4 + 3] += w[j]!;
		}
		for (let c = 0; c < k; c++) {
			const wt = acc[c * 4 + 3]!;
			if (wt > 0) {
				centers[c * 3] = acc[c * 4]! / wt;
				centers[c * 3 + 1] = acc[c * 4 + 1]! / wt;
				centers[c * 3 + 2] = acc[c * 4 + 2]! / wt;
			}
		}
		if (!changed && iter > 0) break;
	}

	const out: { rgb: Rgb; weight: number }[] = [];
	for (let c = 0; c < k; c++) {
		const wt = acc[c * 4 + 3]!;
		if (wt <= 0) continue;
		out.push({
			rgb: labToRgb(centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!),
			weight: wt,
		});
	}
	out.sort((a, b) => b.weight - a.weight);
	// Drop exact duplicates that can appear after rounding to bytes.
	const seen = new Set<string>();
	return out
		.map((e) => e.rgb)
		.filter((c) => {
			const key = c.join(',');
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

/** Lazily-filled nearest-palette lookup keyed by 15-bit bin. */
function makeQuantizer(palette: Rgb[]): (r: number, g: number, b: number) => number {
	const palLab = new Float64Array(palette.length * 3);
	palette.forEach((c, i) => rgbToLab(c[0], c[1], c[2], palLab, i * 3));
	const cache = new Int16Array(BIN_COUNT).fill(-1);
	const tmp = new Float64Array(3);
	return (r, g, b) => {
		const key = binKey(r, g, b);
		let hit = cache[key]!;
		if (hit >= 0) return hit;
		rgbToLab(((r >> 3) << 3) | 4, ((g >> 3) << 3) | 4, ((b >> 3) << 3) | 4, tmp, 0);
		let bestD = Infinity;
		hit = 0;
		for (let i = 0; i < palette.length; i++) {
			const dl = tmp[0]! - palLab[i * 3]!;
			const da = tmp[1]! - palLab[i * 3 + 1]!;
			const db = tmp[2]! - palLab[i * 3 + 2]!;
			const d = dl * dl + da * da + db * db;
			if (d < bestD) {
				bestD = d;
				hit = i;
			}
		}
		cache[key] = hit;
		return hit;
	};
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function wrapIndex(i: number, n: number, mode: ExportTextureWrap): number {
	if (mode === 'clamp') return i < 0 ? 0 : i >= n ? n - 1 : i;
	if (mode === 'mirror') {
		const p = 2 * n;
		const m = ((i % p) + p) % p;
		return m < n ? m : p - 1 - m;
	}
	return ((i % n) + n) % n;
}

/** Nearest-texel fetch; returns the RGBA byte offset into `pixels`. */
function texelOffset(tex: ExportTexture, u: number, v: number): number {
	const x = wrapIndex(Math.floor(u * tex.width), tex.width, tex.wrapS);
	let y = wrapIndex(Math.floor(v * tex.height), tex.height, tex.wrapT);
	if (tex.flipY) y = tex.height - 1 - y;
	return (y * tex.width + x) * 4;
}

function linearToSrgbByte(c: number): number {
	c = c <= 0 ? 0 : c >= 1 ? 1 : c;
	const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
	return Math.round(s * 255);
}

/** Tiny deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// Geometry tracking through weld + subdivide
// ---------------------------------------------------------------------------

interface TrackedShape {
	input: ExportMesh;
	mesh: IndexedMesh;
	/** Per output triangle: source triangle index in `input.indices`. */
	src: Uint32Array;
	/** Per output triangle: 3 corners × 3 barycentric weights in `src`. */
	bary: Float32Array;
}

function trackShape(
	input: ExportMesh,
	passes: number,
	repair: { minThickness: number } | null,
	reports: RepairReport[],
): TrackedShape {
	const welded = weldByPositionTracked({
		positions: input.positions,
		indices: input.indices,
	});
	let mesh = welded.mesh;
	let src = welded.keptTriangles;
	let bary: Float32Array = new Float32Array(src.length * 9);
	for (let t = 0; t < src.length; t++) {
		bary[t * 9 + 0] = 1;
		bary[t * 9 + 4] = 1;
		bary[t * 9 + 8] = 1;
	}
	if (repair) {
		// Before subdivision: smoothing then treats caps / walls as part
		// of the surface instead of creasing open rims.
		const r = repairForPrinting({ ...mesh, src, bary }, repair);
		mesh = { positions: r.positions, indices: r.indices };
		src = r.src;
		bary = r.bary;
		reports.push(r.report);
	}
	for (let p = 0; p < passes; p++) {
		mesh = loopSubdivide(mesh);
		// `loopSubdivide` emits, per parent (a, b, c), children in the
		// order (a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca).
		const triCount = src.length;
		const nSrc = new Uint32Array(triCount * 4);
		const nBary = new Float32Array(triCount * 36);
		const A = new Float32Array(3);
		const B = new Float32Array(3);
		const C = new Float32Array(3);
		const AB = new Float32Array(3);
		const BC = new Float32Array(3);
		const CA = new Float32Array(3);
		for (let t = 0; t < triCount; t++) {
			const o = t * 9;
			for (let i = 0; i < 3; i++) {
				A[i] = bary[o + i]!;
				B[i] = bary[o + 3 + i]!;
				C[i] = bary[o + 6 + i]!;
				AB[i] = (A[i]! + B[i]!) / 2;
				BC[i] = (B[i]! + C[i]!) / 2;
				CA[i] = (C[i]! + A[i]!) / 2;
			}
			const children = [
				[A, AB, CA],
				[B, BC, AB],
				[C, CA, BC],
				[AB, BC, CA],
			] as const;
			for (let k = 0; k < 4; k++) {
				const ct = t * 4 + k;
				nSrc[ct] = src[t]!;
				const corners = children[k]!;
				for (let c = 0; c < 3; c++) nBary.set(corners[c]!, ct * 9 + c * 3);
			}
		}
		src = nSrc;
		bary = nBary;
	}
	return { input, mesh, src, bary };
}

// ---------------------------------------------------------------------------
// Decals (painted-on overlays such as eyes)
// ---------------------------------------------------------------------------

/** One decal triangle, in the same space as the meshes it overlays. */
export interface DecalTri {
	/** Corner positions (9). */
	p: Float64Array;
	/** Corner UVs (6). */
	uv: Float64Array;
	texture: ExportTexture;
	/** Unit plane normal. */
	n: [number, number, number];
	lo: [number, number, number];
	hi: [number, number, number];
}

/**
 * Pull decal triangles (`ExportMaterial.decal`) out of the meshes: the
 * geometry that remains is printed, the decals are painted onto it.
 */
export function splitDecals(meshes: readonly ExportMesh[]): { meshes: ExportMesh[]; decals: DecalTri[] } {
	const decals: DecalTri[] = [];
	const out = meshes.map((m) => {
		const mats = m.materials ?? [];
		if (!mats.some((x) => x.decal)) return m;
		const keep: number[] = [];
		const keepMat: number[] = [];
		const P = m.positions;
		for (let t = 0; t < m.indices.length / 3; t++) {
			const mi = Number(m.triangleMaterials?.[t] ?? 0);
			const mat = mats[mi];
			const ia = m.indices[t * 3]!, ib = m.indices[t * 3 + 1]!, ic = m.indices[t * 3 + 2]!;
			if (mat?.decal && mat.texture && m.uvs) {
				const p = new Float64Array(9);
				const uv = new Float64Array(6);
				[ia, ib, ic].forEach((v, k) => {
					for (let c = 0; c < 3; c++) p[k * 3 + c] = P[v * 3 + c]!;
					uv[k * 2] = m.uvs![v * 2]!;
					uv[k * 2 + 1] = m.uvs![v * 2 + 1]!;
				});
				const e1 = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
				const e2 = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
				const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
				const len = Math.hypot(n[0]!, n[1]!, n[2]!);
				if (len > 0) {
					decals.push({
						p,
						uv,
						texture: mat.texture,
						n: [n[0]! / len, n[1]! / len, n[2]! / len],
						lo: [0, 1, 2].map((c) => Math.min(p[c]!, p[3 + c]!, p[6 + c]!)) as [number, number, number],
						hi: [0, 1, 2].map((c) => Math.max(p[c]!, p[3 + c]!, p[6 + c]!)) as [number, number, number],
					});
				}
				continue;
			}
			keep.push(ia, ib, ic);
			keepMat.push(mi);
		}
		return { ...m, indices: Uint32Array.from(keep), triangleMaterials: Int32Array.from(keepMat) };
	});
	return { meshes: out, decals };
}

/** How far (along the decal normal) a surface may sit from a decal and still receive it. */
const DECAL_REACH = 0.6;

/** Colour of the decals at point q, or false where none is opaque. */
function sampleDecals(decals: readonly DecalTri[], q: readonly number[], out: Uint8Array): boolean {
	for (const d of decals) {
		const p = d.p;
		const dist = (q[0]! - p[0]!) * d.n[0] + (q[1]! - p[1]!) * d.n[1] + (q[2]! - p[2]!) * d.n[2];
		if (Math.abs(dist) > DECAL_REACH) continue;
		// Barycentric of q's projection onto the decal plane.
		const e1 = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
		const e2 = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
		const w = [q[0]! - p[0]! - d.n[0] * dist, q[1]! - p[1]! - d.n[1] * dist, q[2]! - p[2]! - d.n[2] * dist];
		const d00 = e1[0]! * e1[0]! + e1[1]! * e1[1]! + e1[2]! * e1[2]!;
		const d01 = e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!;
		const d11 = e2[0]! * e2[0]! + e2[1]! * e2[1]! + e2[2]! * e2[2]!;
		const d20 = w[0]! * e1[0]! + w[1]! * e1[1]! + w[2]! * e1[2]!;
		const d21 = w[0]! * e2[0]! + w[1]! * e2[1]! + w[2]! * e2[2]!;
		const den = d00 * d11 - d01 * d01;
		if (den === 0) continue;
		const s = (d11 * d20 - d01 * d21) / den;
		const t = (d00 * d21 - d01 * d20) / den;
		if (s < -1e-4 || t < -1e-4 || s + t > 1 + 1e-4) continue;
		const r = 1 - s - t;
		const uv = d.uv;
		const px = texelOffset(d.texture, r * uv[0]! + s * uv[2]! + t * uv[4]!, r * uv[1]! + s * uv[3]! + t * uv[5]!);
		if ((d.texture.pixels[px + 3] ?? 0) < 128) continue;
		out[0] = d.texture.pixels[px]!;
		out[1] = d.texture.pixels[px + 1]!;
		out[2] = d.texture.pixels[px + 2]!;
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Per-triangle colour sources
// ---------------------------------------------------------------------------

const KIND_FLAT = 0;
const KIND_TEXTURE = 1;
const KIND_VCOLOR = 2;

/**
 * Colour source of one output triangle, parameterised over the
 * triangle as `P(s, t) = A + s·(B − A) + t·(C − A)` with corners
 * A = (0,0), B = (1,0), C = (0,1). Paint-tree subdivision happens in
 * that (s, t) space and only maps to UV / colour at sample time.
 */
interface TriSource {
	kind: number;
	texture: ExportTexture | null;
	/** Flat colour (sRGB bytes). */
	flat: Rgb;
	/** Corner attributes: UV pairs (6) or linear-or-sRGB RGB (9). */
	attr: Float64Array;
	/** Vertex colours need linear → sRGB encoding at sample time. */
	linear: boolean;
	/** Decals overlapping this triangle, painted over its own colour. */
	decals?: DecalTri[];
	/** Corner positions (9), for decal lookups. */
	pos?: Float64Array;
}

/**
 * Write the colour at (s, t) as sRGB bytes into `out`. Returns false
 * for alpha-cutout texels (alpha < 0.5, matching the viewers'
 * `alphaTest`).
 */
function sampleSource(src: TriSource, s: number, t: number, out: Uint8Array): boolean {
	const a = src.attr;
	const r = 1 - s - t;
	if (src.decals && src.pos) {
		const p = src.pos;
		const q = [r * p[0]! + s * p[3]! + t * p[6]!, r * p[1]! + s * p[4]! + t * p[7]!, r * p[2]! + s * p[5]! + t * p[8]!];
		if (sampleDecals(src.decals, q, out)) return true;
	}
	if (src.kind === KIND_TEXTURE) {
		const tex = src.texture!;
		const u = r * a[0]! + s * a[2]! + t * a[4]!;
		const v = r * a[1]! + s * a[3]! + t * a[5]!;
		const px = texelOffset(tex, u, v);
		out[0] = tex.pixels[px]!;
		out[1] = tex.pixels[px + 1]!;
		out[2] = tex.pixels[px + 2]!;
		return tex.pixels[px + 3]! >= 128;
	}
	if (src.kind === KIND_VCOLOR) {
		for (let c = 0; c < 3; c++) {
			const v = r * a[c]! + s * a[3 + c]! + t * a[6 + c]!;
			out[c] = src.linear ? linearToSrgbByte(v) : Math.round(Math.min(1, Math.max(0, v)) * 255);
		}
		return true;
	}
	out[0] = src.flat[0];
	out[1] = src.flat[1];
	out[2] = src.flat[2];
	return true;
}

const IDENTITY_BARY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * Colour source of source triangle `st` of `inp`, for an output
 * triangle whose corners sit at barycentric `bary[bo … bo + 8]` within
 * it (identity = the source triangle itself).
 */
function triSourceOf(inp: ExportMesh, st: number, bary: ArrayLike<number> = IDENTITY_BARY, bo = 0): TriSource {
	const materials: ExportMaterial[] = inp.materials?.length ? inp.materials : [{ texture: null }];
	const mat = materials[inp.triangleMaterials?.[st] ?? 0] ?? materials[0]!;
	const uvs = inp.uvs;
	const colors = inp.colors;
	const cStride = inp.colorStride ?? 3;
	const idx = inp.indices;
	const i0 = idx[st * 3]!, i1 = idx[st * 3 + 1]!, i2 = idx[st * 3 + 2]!;
	const src: TriSource = {
		kind: KIND_FLAT,
		texture: null,
		flat: mat.baseColor ?? DEFAULT_BASE,
		attr: new Float64Array(0),
		linear: (inp.colorSpace ?? 'linear') === 'linear',
	};
	if (mat.texture && uvs) {
		src.kind = KIND_TEXTURE;
		src.texture = mat.texture;
		src.attr = new Float64Array(6);
		for (let k = 0; k < 3; k++) {
			const w0 = bary[bo + k * 3]!, w1 = bary[bo + k * 3 + 1]!, w2 = bary[bo + k * 3 + 2]!;
			src.attr[k * 2] = w0 * uvs[i0 * 2]! + w1 * uvs[i1 * 2]! + w2 * uvs[i2 * 2]!;
			src.attr[k * 2 + 1] = w0 * uvs[i0 * 2 + 1]! + w1 * uvs[i1 * 2 + 1]! + w2 * uvs[i2 * 2 + 1]!;
		}
	} else if (mat.useVertexColors && colors) {
		src.kind = KIND_VCOLOR;
		src.attr = new Float64Array(9);
		for (let k = 0; k < 3; k++) {
			const w0 = bary[bo + k * 3]!, w1 = bary[bo + k * 3 + 1]!, w2 = bary[bo + k * 3 + 2]!;
			for (let ch = 0; ch < 3; ch++) {
				src.attr[k * 3 + ch] =
					w0 * colors[i0 * cStride + ch]! + w1 * colors[i1 * cStride + ch]! + w2 * colors[i2 * cStride + ch]!;
			}
		}
	}
	return src;
}

/**
 * Area-weighted colours of the meshes' surfaces as displayed (texture,
 * vertex colour or flat colour per material slot), as non-empty
 * 15-bit histogram bins. Alpha-cutout texels are skipped, as in the
 * export. Cheap enough to run interactively: no welding, repair or
 * paint trees.
 */
export function surfaceColorBins(meshes: readonly ExportMesh[], samples = 50_000): ColorBin[] {
	const tris: { mesh: ExportMesh; t: number; area: number }[] = [];
	let total = 0;
	for (const m of meshes) {
		const p = m.positions, idx = m.indices;
		for (let t = 0; t < idx.length / 3; t++) {
			const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
			const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
			const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
			const area = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
			if (!(area > 0)) continue;
			tris.push({ mesh: m, t, area });
			total += area;
		}
	}
	const hist = new Float64Array(BIN_COUNT * 4);
	const add = (r: number, g: number, b: number, w: number) => {
		const o = binKey(r, g, b) * 4;
		hist[o] = hist[o]! + r * w;
		hist[o + 1] = hist[o + 1]! + g * w;
		hist[o + 2] = hist[o + 2]! + b * w;
		hist[o + 3] = hist[o + 3]! + w;
	};
	const rand = mulberry32(0x5eed);
	const rgb = new Uint8Array(3);
	let carry = 0;
	for (const { mesh, t, area } of tris) {
		const src = triSourceOf(mesh, t);
		const want = (area / total) * samples;
		if (src.kind === KIND_FLAT) {
			add(src.flat[0], src.flat[1], src.flat[2], want);
			continue;
		}
		carry += want;
		while (carry >= 1) {
			carry -= 1;
			let r1 = rand(), r2 = rand();
			if (r1 + r2 > 1) {
				r1 = 1 - r1;
				r2 = 1 - r2;
			}
			if (sampleSource(src, r1, r2, rgb)) add(rgb[0]!, rgb[1]!, rgb[2]!, 1);
		}
	}
	const bins: ColorBin[] = [];
	for (let i = 0; i < BIN_COUNT; i++) {
		const w = hist[i * 4 + 3]!;
		if (w > 0) bins.push({ rgb: [Math.round(hist[i * 4]! / w), Math.round(hist[i * 4 + 1]! / w), Math.round(hist[i * 4 + 2]! / w)], weight: w });
	}
	return bins;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build an OrcaSlicer / Bambu Studio compatible multi-colour 3MF.
 * All meshes are merged into a single object so the slicer keeps them
 * together (separate objects would be auto-arranged apart on the bed).
 */
export function buildPainted3MF(
	inputs: ExportMesh[],
	options: Paint3mfOptions,
): Paint3mfResult {
	const colorCount = Math.max(1, Math.min(16, Math.floor(options.colorCount)));
	const passes = options.subdivisionPasses ?? 0;
	const flipToZUp = (options.sourceAxis ?? 'y-up') === 'y-up';
	const maxDepth = options.maxPaintDepth ?? 5;
	/** Depth used to resolve vertex-colour gradients inside a triangle. */
	const vcolorDepth = Math.min(maxDepth, 3);

	// --- 1. Merge meshes, keeping per-triangle source tracking. ----------
	const repairOpt =
		options.repair === false
			? null
			: {
					minThickness:
						(typeof options.repair === 'object' ? options.repair.minThickness : undefined) ??
						defaultMinThickness(inputs),
				};
	const reports: RepairReport[] = [];
	const shapes = inputs.map((inp) => trackShape(inp, passes, repairOpt, reports));

	let vertTotal = 0;
	for (const s of shapes) vertTotal += s.mesh.positions.length / 3;
	const positions = new Float32Array(vertTotal * 3);
	const tris: number[] = [];
	const sources: TriSource[] = [];

	let vBase = 0;
	for (const s of shapes) {
		const p = s.mesh.positions;
		for (let v = 0; v < p.length / 3; v++) {
			const x = p[v * 3]!;
			const y = p[v * 3 + 1]!;
			const z = p[v * 3 + 2]!;
			const o = (vBase + v) * 3;
			positions[o] = x;
			positions[o + 1] = flipToZUp ? -z : y;
			positions[o + 2] = flipToZUp ? y : z;
		}
		const inp = s.input;
		const idx = s.mesh.indices;
		for (let t = 0; t < idx.length / 3; t++) {
			const a = vBase + idx[t * 3]!;
			const b = vBase + idx[t * 3 + 1]!;
			const c = vBase + idx[t * 3 + 2]!;
			// Drop non-finite or zero-area triangles: they confuse the
			// slicer's mesh repair and carry no paint.
			const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
			const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!;
			const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!;
			if (!Number.isFinite(ax + ay + az + bx + by + bz + cx + cy + cz)) continue;
			const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
			const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
			if (
				e1y * e2z - e1z * e2y === 0 &&
				e1z * e2x - e1x * e2z === 0 &&
				e1x * e2y - e1y * e2x === 0
			) {
				continue;
			}
			tris.push(a, b, c);

			const st = s.src[t]!;
			const src = triSourceOf(inp, st, s.bary, t * 9);
			if (options.decals?.length) {
				// Decals are in input space; so are the shape's positions.
				const sp = s.mesh.positions;
				const ia = idx[t * 3]! * 3, ib = idx[t * 3 + 1]! * 3, ic = idx[t * 3 + 2]! * 3;
				const pos = Float64Array.of(sp[ia]!, sp[ia + 1]!, sp[ia + 2]!, sp[ib]!, sp[ib + 1]!, sp[ib + 2]!, sp[ic]!, sp[ic + 1]!, sp[ic + 2]!);
				const lo = [0, 1, 2].map((k) => Math.min(pos[k]!, pos[3 + k]!, pos[6 + k]!) - DECAL_REACH);
				const hi = [0, 1, 2].map((k) => Math.max(pos[k]!, pos[3 + k]!, pos[6 + k]!) + DECAL_REACH);
				const e1 = [pos[3]! - pos[0]!, pos[4]! - pos[1]!, pos[5]! - pos[2]!];
				const e2 = [pos[6]! - pos[0]!, pos[7]! - pos[1]!, pos[8]! - pos[2]!];
				const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
				const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
				const near = options.decals.filter(
					(d) =>
						d.lo[0] <= hi[0]! && d.hi[0] >= lo[0]! && d.lo[1] <= hi[1]! && d.hi[1] >= lo[1]! && d.lo[2] <= hi[2]! && d.hi[2] >= lo[2]! &&
						// Same surface orientation (either winding).
						Math.abs((d.n[0] * n[0]! + d.n[1] * n[1]! + d.n[2] * n[2]!) / nl) > 0.5,
				);
				if (near.length) {
					src.decals = near;
					src.pos = pos;
				}
			}
			sources.push(src);
		}
		vBase += p.length / 3;
	}
	const triCount = sources.length;

	// --- 2. Orient so Orca won't flip (and re-map) the triangles. --------
	let signedVol = 0;
	for (let t = 0; t < triCount; t++) {
		const a = tris[t * 3]! * 3, b = tris[t * 3 + 1]! * 3, c = tris[t * 3 + 2]! * 3;
		const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
		const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
		const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
		signedVol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
	}
	if (signedVol < 0) {
		for (let t = 0; t < triCount; t++) {
			const tmp = tris[t * 3 + 1]!;
			tris[t * 3 + 1] = tris[t * 3 + 2]!;
			tris[t * 3 + 2] = tmp;
			// Swap the B and C corner attributes (and decal positions) to match.
			const pos = sources[t]!.pos;
			if (pos) for (let k = 0; k < 3; k++) {
				const tv = pos[3 + k]!;
				pos[3 + k] = pos[6 + k]!;
				pos[6 + k] = tv;
			}
			const a = sources[t]!.attr;
			const n = a.length / 3;
			for (let k = 0; k < n; k++) {
				const tv = a[n + k]!;
				a[n + k] = a[2 * n + k]!;
				a[2 * n + k] = tv;
			}
		}
	}

	// --- 3. Area-weighted colour histogram → palette. ---------------------
	const triArea = new Float64Array(triCount);
	let totalArea = 0;
	for (let t = 0; t < triCount; t++) {
		const a = tris[t * 3]! * 3, b = tris[t * 3 + 1]! * 3, c = tris[t * 3 + 2]! * 3;
		const e1x = positions[b]! - positions[a]!;
		const e1y = positions[b + 1]! - positions[a + 1]!;
		const e1z = positions[b + 2]! - positions[a + 2]!;
		const e2x = positions[c]! - positions[a]!;
		const e2y = positions[c + 1]! - positions[a + 1]!;
		const e2z = positions[c + 2]! - positions[a + 2]!;
		const area =
			0.5 *
			Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
		triArea[t] = area;
		totalArea += area;
	}

	const hist = new Float64Array(BIN_COUNT * 4);
	const addHist = (r: number, g: number, b: number, w: number) => {
		const o = binKey(r, g, b) * 4;
		hist[o] = hist[o]! + r * w;
		hist[o + 1] = hist[o + 1]! + g * w;
		hist[o + 2] = hist[o + 2]! + b * w;
		hist[o + 3] = hist[o + 3]! + w;
	};
	const SAMPLES = 200_000;
	const rand = mulberry32(0x3d3f);
	const rgb = new Uint8Array(3);
	let carry = 0;
	for (let t = 0; t < triCount; t++) {
		const want = totalArea > 0 ? (triArea[t]! / totalArea) * SAMPLES : 0;
		const src = sources[t]!;
		if (src.kind === KIND_FLAT) {
			addHist(src.flat[0], src.flat[1], src.flat[2], want);
			continue;
		}
		carry += want;
		while (carry >= 1) {
			carry -= 1;
			let r1 = rand();
			let r2 = rand();
			if (r1 + r2 > 1) {
				r1 = 1 - r1;
				r2 = 1 - r2;
			}
			// Transparent texels usually hold junk RGB; keep them from
			// claiming a filament slot.
			if (!sampleSource(src, r1, r2, rgb)) continue;
			addHist(rgb[0]!, rgb[1]!, rgb[2]!, 1);
		}
	}
	let palette: Rgb[];
	if (options.choosePalette) {
		const bins: ColorBin[] = [];
		for (let i = 0; i < BIN_COUNT; i++) {
			const w = hist[i * 4 + 3]!;
			if (w > 0) {
				bins.push({
					rgb: [
						Math.round(hist[i * 4]! / w),
						Math.round(hist[i * 4 + 1]! / w),
						Math.round(hist[i * 4 + 2]! / w),
					],
					weight: w,
				});
			}
		}
		palette = options.choosePalette(bins);
		if (palette.length === 0) palette = [DEFAULT_BASE];
	} else {
		palette = reducePalette(hist, colorCount);
	}
	const fullQuantize = makeQuantizer(palette);
	const flatCount = Math.min(palette.length, Math.max(1, options.flatSurfaceColors ?? palette.length));
	const flatQuantize =
		flatCount < palette.length ? makeQuantizer(palette.slice(0, flatCount)) : fullQuantize;
	/** |normal·Z| above which a face counts as a flat top / bottom (~18°). */
	const FLAT_NZ = 0.95;

	// --- 4. Paint trees. ---------------------------------------------------
	const TRANSPARENT = -1;
	const counts = new Int32Array(palette.length + 2);
	let leafCount = 0;
	const paint: string[] = new Array(triCount);
	for (let t = 0; t < triCount; t++) {
		const src = sources[t]!;
		let quantize = fullQuantize;
		if (flatQuantize !== fullQuantize) {
			const a = tris[t * 3]! * 3, b = tris[t * 3 + 1]! * 3, c = tris[t * 3 + 2]! * 3;
			const e1x = positions[b]! - positions[a]!, e1y = positions[b + 1]! - positions[a + 1]!;
			const e1z = positions[b + 2]! - positions[a + 2]!;
			const e2x = positions[c]! - positions[a]!, e2y = positions[c + 1]! - positions[a + 1]!;
			const e2z = positions[c + 2]! - positions[a + 2]!;
			const nz = e1x * e2y - e1y * e2x;
			const len = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, nz);
			if (len > 0 && Math.abs(nz) / len > FLAT_NZ) quantize = flatQuantize;
		}
		let depth = 0;
		if (src.decals) {
			// Decal detail lives inside this triangle; resolve it fully.
			depth = maxDepth;
		} else if (src.kind === KIND_TEXTURE) {
			const a = src.attr;
			const tex = src.texture!;
			const texelArea =
				(Math.abs((a[2]! - a[0]!) * (a[5]! - a[1]!) - (a[4]! - a[0]!) * (a[3]! - a[1]!)) / 2) *
				tex.width *
				tex.height;
			depth =
				texelArea <= 1 ? 0 : Math.min(maxDepth, Math.ceil(Math.log(texelArea) / Math.log(4)));
		} else if (src.kind === KIND_VCOLOR) {
			// Only subdivide when the corners disagree.
			const q = [0, 0, 0].map((_, k) => {
				const s = k === 1 ? 1 : 0;
				const tt = k === 2 ? 1 : 0;
				sampleSource(src, s, tt, rgb);
				return quantize(rgb[0]!, rgb[1]!, rgb[2]!);
			});
			depth = q[0] === q[1] && q[0] === q[2] ? 0 : vcolorDepth;
		}

		counts.fill(0);
		const sample = (s: number, tt: number): number => {
			leafCount++;
			if (!sampleSource(src, s, tt, rgb)) return TRANSPARENT;
			const state = quantize(rgb[0]!, rgb[1]!, rgb[2]!) + 1;
			counts[state]!++;
			return state;
		};
		// Build the raw tree over (s, t) space; children follow the
		// Orca 3-side split layout documented at the top of the file.
		const build = (
			as: number, at: number,
			bs: number, bt: number,
			cs: number, ct: number,
			d: number,
		): PaintNode => {
			if (d === 0) return sample((as + bs + cs) / 3, (at + bt + ct) / 3);
			const abs = (as + bs) / 2, abt = (at + bt) / 2;
			const bcs = (bs + cs) / 2, bct = (bt + ct) / 2;
			const cas = (cs + as) / 2, cat = (ct + at) / 2;
			const k0 = build(as, at, abs, abt, cas, cat, d - 1);
			const k1 = build(abs, abt, bs, bt, bcs, bct, d - 1);
			const k2 = build(bcs, bct, cs, ct, cas, cat, d - 1);
			const k3 = build(abs, abt, bcs, bct, cas, cat, d - 1);
			if (typeof k0 === 'number' && k0 === k1 && k0 === k2 && k0 === k3) return k0;
			return [k0, k1, k2, k3];
		};
		const tree = build(0, 0, 1, 0, 0, 1, depth);

		// Cutout leaves take the triangle's dominant opaque colour
		// (filament 1 — the model's dominant colour — if fully cut out).
		let fill = 1;
		for (let st = 2; st < counts.length; st++) if (counts[st]! > counts[fill]!) fill = st;
		const finalize = (n: PaintNode): number | string => {
			if (typeof n === 'number') return n === TRANSPARENT ? fill : n;
			const k0 = finalize(n[0]);
			const k1 = finalize(n[1]);
			const k2 = finalize(n[2]);
			const k3 = finalize(n[3]);
			if (typeof k0 === 'number' && k0 === k1 && k0 === k2 && k0 === k3) return k0;
			const enc = (k: number | string) => (typeof k === 'number' ? encodePaintLeaf(k) : k);
			return enc(k0) + enc(k1) + enc(k2) + enc(k3) + '3';
		};
		const root = finalize(tree);
		// Filament 1 is the object's default, so whole-triangle filament
		// 1 needs no attribute.
		paint[t] = root === 1 ? '' : typeof root === 'number' ? encodePaintLeaf(root) : root;
	}

	// --- 5. Place on the plate. ---------------------------------------------
	// Only referenced vertices count (orphans are dropped below).
	{
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = -Infinity, maxY = -Infinity;
		for (let i = 0; i < tris.length; i++) {
			const o = tris[i]! * 3;
			const x = positions[o]!, y = positions[o + 1]!, z = positions[o + 2]!;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			if (z < minZ) minZ = z;
		}
		if (Number.isFinite(minX + maxX + minY + maxY + minZ)) {
			const [cx, cy] = options.bedCenter ?? [128, 128];
			const dx = cx - (minX + maxX) / 2;
			const dy = cy - (minY + maxY) / 2;
			const dz = -minZ;
			for (let v = 0; v < vertTotal; v++) {
				positions[v * 3] = positions[v * 3]! + dx;
				positions[v * 3 + 1] = positions[v * 3 + 1]! + dy;
				positions[v * 3 + 2] = positions[v * 3 + 2]! + dz;
			}
		}
	}

	// --- 6. Serialise. -----------------------------------------------------
	const title = options.title ?? 'model';
	const objectName = options.objectName ?? title;
	const fmt = (x: number) => String(Math.round(x * 1e5) / 1e5);
	const extraMeta = Object.entries(options.metadata ?? {})
		.filter(([k]) => k !== 'Title' && k !== 'Designer' && k !== 'Description')
		.map(([k, v]) => ` <metadata name="${STANDARD_METADATA.has(k) ? k : `nx:${k}`}">${xmlEscape(v)}</metadata>\n`)
		.join('');

	const parts: string[] = [];
	parts.push(
		'<?xml version="1.0" encoding="UTF-8"?>\n',
		`<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${
			extraMeta.includes('"nx:') ? ` xmlns:nx="${NX_NAMESPACE}"` : ''
		}>\n`,
		` <metadata name="Title">${xmlEscape(title)}</metadata>\n`,
		` <metadata name="Designer">nx-archive</metadata>\n`,
		extraMeta,
		` <metadata name="Description">${xmlEscape(
			(typeof options.description === 'function'
				? options.description(palette)
				: options.description) ??
				`Filaments: ${palette.map((c, i) => `${i + 1}=${rgbToHex(c)}`).join(' ')}`,
		)}</metadata>\n`,
		' <resources>\n',
		`  <object id="1" type="model" name="${xmlEscape(objectName)}">\n`,
		'   <mesh>\n    <vertices>\n',
	);
	// Only write vertices that a kept triangle references. Source
	// buffers carry unused vertices, and dropped (non-finite /
	// degenerate) triangles leave orphans behind. Slicers compute the
	// bounding box from *every* vertex, so one stray NaN breaks the
	// object's size and plate placement.
	const remap = new Int32Array(vertTotal).fill(-1);
	let written = 0;
	for (let i = 0; i < tris.length; i++) {
		const v = tris[i]!;
		if (remap[v] === -1) {
			remap[v] = written++;
			parts.push(
				`     <vertex x="${fmt(positions[v * 3]!)}" y="${fmt(positions[v * 3 + 1]!)}" z="${fmt(positions[v * 3 + 2]!)}"/>\n`,
			);
		}
	}
	parts.push('    </vertices>\n    <triangles>\n');
	for (let t = 0; t < triCount; t++) {
		const p = paint[t]!;
		parts.push(
			`     <triangle v1="${remap[tris[t * 3]!]}" v2="${remap[tris[t * 3 + 1]!]}" v3="${remap[tris[t * 3 + 2]!]}"${
				p ? ` paint_color="${p}"` : ''
			}/>\n`,
		);
	}
	parts.push(
		'    </triangles>\n   </mesh>\n  </object>\n </resources>\n',
		' <build>\n  <item objectid="1"/>\n </build>\n</model>\n',
	);

	const contentTypes =
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
		'</Types>\n';
	const rels =
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		'<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
		'</Relationships>\n';

	const files: Record<string, Uint8Array> = {
		'[Content_Types].xml': strToU8(contentTypes),
		'_rels/.rels': strToU8(rels),
		'3D/3dmodel.model': strToU8(parts.join('')),
	};
	const extra =
		typeof options.extraFiles === 'function' ? options.extraFiles(palette) : options.extraFiles;
	// Orca / Bambu Studio name objects and plates from their own config
	// (without it the plate shows "Untitled").
	files['Metadata/model_settings.config'] = strToU8(modelSettingsConfig(objectName));
	for (const [name, data] of Object.entries(extra ?? {})) {
		files[name] = typeof data === 'string' ? strToU8(data) : data;
	}
	const bytes = zipSync(files, { level: 6 });

	return {
		bytes,
		palette,
		triangleCount: triCount,
		leafCount,
		repair: repairOpt ? summarizeRepairs(reports) : null,
	};
}

const STANDARD_METADATA = new Set([
	'Title',
	'Designer',
	'Description',
	'Copyright',
	'LicenseTerms',
	'Rating',
	'CreationDate',
	'ModificationDate',
	'Application',
]);

/** Namespace for nx-archive's own 3MF metadata (export settings, pose, source). */
export const NX_NAMESPACE = 'https://github.com/TooTallNate/switch-tools/nx-archive/3mf';

/** Orca / Bambu Studio object + plate names for the single object. */
function modelSettingsConfig(name: string): string {
	const n = xmlEscape(name);
	return (
		'<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
		`  <object id="1">\n    <metadata key="name" value="${n}"/>\n    <metadata key="extruder" value="1"/>\n  </object>\n` +
		'  <plate>\n    <metadata key="plater_id" value="1"/>\n' +
		`    <metadata key="plater_name" value="${n}"/>\n    <metadata key="locked" value="false"/>\n` +
		'    <model_instance>\n      <metadata key="object_id" value="1"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n' +
		'  </plate>\n</config>\n'
	);
}

function xmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** `#RRGGBB` for a palette entry. */
export function rgbToHex(c: Rgb): string {
	return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}
