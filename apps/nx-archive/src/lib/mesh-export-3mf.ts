/**
 * Multi-colour 3MF export for FDM slicers that support per-triangle
 * filament painting (OrcaSlicer, Bambu Studio, and printers that use
 * them, e.g. Snapmaker U1).
 *
 * Slicers don't consume UV-mapped textures, so the texture has to be
 * baked into filament assignments:
 *
 *   1. Bake/weld/subdivide geometry exactly like the STL path, but
 *      track, for every output triangle, which *source* triangle it
 *      came from and the barycentric position of its corners within
 *      it. Welding destroys UV seams, so UVs are always looked up
 *      through the source triangle rather than the welded vertices.
 *   2. Build an area-weighted colour histogram of the textured surface
 *      and reduce it to N colours (k-means in CIELAB). N = number of
 *      filaments / toolheads.
 *   3. For every triangle, build an Orca/Bambu "paint tree": the
 *      triangle is recursively split 4-ways until each leaf covers
 *      about one texel, each leaf takes the nearest palette colour,
 *      and uniform subtrees collapse back to a single leaf. This lets
 *      paint detail exceed the mesh resolution — the same mechanism
 *      the slicer's own brush uses.
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
	type IndexedMesh,
} from './mesh-export';

export type Rgb = readonly [number, number, number];

export type PaintTextureWrap = 'repeat' | 'clamp' | 'mirror';

/** Decoded RGBA8 texture, row 0 at V = 0 (i.e. `flipY = false`). */
export interface PaintTexture {
	pixels: ArrayLike<number>;
	width: number;
	height: number;
	wrapS: PaintTextureWrap;
	wrapT: PaintTextureWrap;
}

/** One baked shape to export. */
export interface PaintMeshInput {
	/** World-space (posed) positions, packed XYZ. */
	positions: Float32Array;
	/** Triangle-list indices into `positions` / `uvs`. */
	indices: Uint32Array;
	/** Per-vertex UVs (parallel to `positions`). */
	uvs: Float32Array | null;
	/** Albedo. When absent (or `uvs` is absent) `baseColor` is used. */
	texture: PaintTexture | null;
	/** Flat colour for untextured shapes. Default mid-grey. */
	baseColor?: Rgb;
}

export interface Paint3mfOptions {
	/** Number of filaments to quantise to (1–16). */
	colorCount: number;
	/** Loop-subdivision passes before painting (shape smoothing). */
	subdivisionPasses?: number;
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
	/** Filament colours, index 0 = filament 1. Sorted by coverage. */
	palette: Rgb[];
	triangleCount: number;
	/** Total number of painted leaves written (diagnostic). */
	leafCount: number;
}

const DEFAULT_BASE: Rgb = [160, 160, 160];

// ---------------------------------------------------------------------------
// Paint-tree encoding
// ---------------------------------------------------------------------------

const HEX = '0123456789ABCDEF';

/** Encode one leaf `state` (0 = unpainted, 1.. = filament). */
export function encodePaintLeaf(state: number): string {
	if (state < 3) return HEX[state << 2]!;
	if (state < 18) return HEX[state - 3]! + 'C';
	throw new RangeError(`paint state ${state} out of range (max 17)`);
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

function rgbToLab(r: number, g: number, b: number, out: Float64Array, o: number): void {
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
// Texture sampling
// ---------------------------------------------------------------------------

function wrapIndex(i: number, n: number, mode: PaintTextureWrap): number {
	if (mode === 'clamp') return i < 0 ? 0 : i >= n ? n - 1 : i;
	if (mode === 'mirror') {
		const p = 2 * n;
		let m = ((i % p) + p) % p;
		return m < n ? m : p - 1 - m;
	}
	return ((i % n) + n) % n;
}

/** Nearest-texel fetch; returns the RGBA byte offset into `pixels`. */
function texelOffset(tex: PaintTexture, u: number, v: number): number {
	const x = wrapIndex(Math.floor(u * tex.width), tex.width, tex.wrapS);
	const y = wrapIndex(Math.floor(v * tex.height), tex.height, tex.wrapT);
	return (y * tex.width + x) * 4;
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
	input: PaintMeshInput;
	mesh: IndexedMesh;
	/** Per output triangle: source triangle index in `input.indices`. */
	src: Uint32Array;
	/** Per output triangle: 3 corners × 3 barycentric weights in `src`. */
	bary: Float32Array;
}

function trackShape(input: PaintMeshInput, passes: number): TrackedShape {
	const welded = weldByPositionTracked({
		positions: input.positions,
		indices: input.indices,
	});
	let mesh = welded.mesh;
	let src = welded.keptTriangles;
	let bary = new Float32Array(src.length * 9);
	for (let t = 0; t < src.length; t++) {
		bary[t * 9 + 0] = 1;
		bary[t * 9 + 4] = 1;
		bary[t * 9 + 8] = 1;
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
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build an OrcaSlicer / Bambu Studio compatible multi-colour 3MF.
 * All shapes are merged into a single object so the slicer keeps them
 * together (separate objects would be auto-arranged apart on the bed).
 */
export function buildPainted3MF(
	inputs: PaintMeshInput[],
	options: Paint3mfOptions,
): Paint3mfResult {
	const colorCount = Math.max(1, Math.min(16, Math.floor(options.colorCount)));
	const passes = options.subdivisionPasses ?? 0;
	const flipToZUp = (options.sourceAxis ?? 'y-up') === 'y-up';
	const maxDepth = options.maxPaintDepth ?? 5;

	// --- 1. Merge shapes, keeping per-triangle source tracking. ----------
	const shapes = inputs.map((inp) => trackShape(inp, passes));

	let vertTotal = 0;
	let triTotal = 0;
	for (const s of shapes) {
		vertTotal += s.mesh.positions.length / 3;
		triTotal += s.mesh.indices.length / 3;
	}
	const positions = new Float32Array(vertTotal * 3);
	const tris: number[] = [];
	/** Per kept triangle: shape index. */
	const triShape: number[] = [];
	/** Per kept triangle: 3 corner UVs (u0 v0 u1 v1 u2 v2), NaN if none. */
	const triUv: number[] = [];

	let vBase = 0;
	shapes.forEach((s, si) => {
		const p = s.mesh.positions;
		for (let v = 0; v < p.length / 3; v++) {
			const x = p[v * 3]!;
			const y = p[v * 3 + 1]!;
			const z = p[v * 3 + 2]!;
			const o = (vBase + v) * 3;
			if (flipToZUp) {
				positions[o] = x;
				positions[o + 1] = -z;
				positions[o + 2] = y;
			} else {
				positions[o] = x;
				positions[o + 1] = y;
				positions[o + 2] = z;
			}
		}
		const uvs = s.input.uvs;
		const srcIdx = s.input.indices;
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
			const nx = e1y * e2z - e1z * e2y;
			const ny = e1z * e2x - e1x * e2z;
			const nz = e1x * e2y - e1y * e2x;
			if (nx === 0 && ny === 0 && nz === 0) continue;

			tris.push(a, b, c);
			triShape.push(si);
			if (uvs && s.input.texture) {
				const st = s.src[t]!;
				const i0 = srcIdx[st * 3]!, i1 = srcIdx[st * 3 + 1]!, i2 = srcIdx[st * 3 + 2]!;
				const u0 = uvs[i0 * 2]!, v0 = uvs[i0 * 2 + 1]!;
				const u1 = uvs[i1 * 2]!, v1 = uvs[i1 * 2 + 1]!;
				const u2 = uvs[i2 * 2]!, v2 = uvs[i2 * 2 + 1]!;
				for (let k = 0; k < 3; k++) {
					const o = t * 9 + k * 3;
					const w0 = s.bary[o]!, w1 = s.bary[o + 1]!, w2 = s.bary[o + 2]!;
					triUv.push(w0 * u0 + w1 * u1 + w2 * u2, w0 * v0 + w1 * v1 + w2 * v2);
				}
			} else {
				triUv.push(NaN, NaN, NaN, NaN, NaN, NaN);
			}
		}
		vBase += p.length / 3;
	});
	const triCount = triShape.length;

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
			const o = t * 6;
			const tu = triUv[o + 2]!, tv = triUv[o + 3]!;
			triUv[o + 2] = triUv[o + 4]!;
			triUv[o + 3] = triUv[o + 5]!;
			triUv[o + 4] = tu;
			triUv[o + 5] = tv;
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
		hist[o] += r * w;
		hist[o + 1] += g * w;
		hist[o + 2] += b * w;
		hist[o + 3] += w;
	};
	const SAMPLES = 200_000;
	const rand = mulberry32(0x3d3f);
	let carry = 0;
	for (let t = 0; t < triCount; t++) {
		const want = totalArea > 0 ? (triArea[t]! / totalArea) * SAMPLES : 0;
		const shape = shapes[triShape[t]!]!;
		const tex = shape.input.texture;
		const o = t * 6;
		if (!tex || Number.isNaN(triUv[o]!)) {
			const c = shape.input.baseColor ?? DEFAULT_BASE;
			addHist(c[0], c[1], c[2], want);
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
			const r0 = 1 - r1 - r2;
			const u = r0 * triUv[o]! + r1 * triUv[o + 2]! + r2 * triUv[o + 4]!;
			const v = r0 * triUv[o + 1]! + r1 * triUv[o + 3]! + r2 * triUv[o + 5]!;
			const px = texelOffset(tex, u, v);
			// Fully/mostly transparent texels usually hold junk RGB;
			// keep them from claiming a filament slot.
			if (tex.pixels[px + 3]! < 128) continue;
			addHist(tex.pixels[px]!, tex.pixels[px + 1]!, tex.pixels[px + 2]!, 1);
		}
	}
	const palette = reducePalette(hist, colorCount);
	const quantize = makeQuantizer(palette);

	// --- 4. Paint trees. ---------------------------------------------------
	let leafCount = 0;
	const paint: string[] = new Array(triCount);
	for (let t = 0; t < triCount; t++) {
		const shape = shapes[triShape[t]!]!;
		const tex = shape.input.texture;
		const o = t * 6;
		if (!tex || Number.isNaN(triUv[o]!)) {
			const c = shape.input.baseColor ?? DEFAULT_BASE;
			const state = quantize(c[0], c[1], c[2]) + 1;
			paint[t] = state === 1 ? '' : encodePaintLeaf(state);
			leafCount++;
			continue;
		}
		const u0 = triUv[o]!, v0 = triUv[o + 1]!;
		const u1 = triUv[o + 2]!, v1 = triUv[o + 3]!;
		const u2 = triUv[o + 4]!, v2 = triUv[o + 5]!;
		const texelArea =
			(Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2) *
			tex.width *
			tex.height;
		const depth =
			texelArea <= 1
				? 0
				: Math.min(maxDepth, Math.ceil(Math.log(texelArea) / Math.log(4)));

		const sample = (u: number, v: number): number => {
			const px = texelOffset(tex, u, v);
			return quantize(tex.pixels[px]!, tex.pixels[px + 1]!, tex.pixels[px + 2]!) + 1;
		};
		// Returns a leaf state (number) or an encoded split subtree.
		const rec = (
			au: number, av: number,
			bu: number, bv: number,
			cu: number, cv: number,
			d: number,
		): number | string => {
			if (d === 0) {
				leafCount++;
				return sample((au + bu + cu) / 3, (av + bv + cv) / 3);
			}
			const abu = (au + bu) / 2, abv = (av + bv) / 2;
			const bcu = (bu + cu) / 2, bcv = (bv + cv) / 2;
			const cau = (cu + au) / 2, cav = (cv + av) / 2;
			const k0 = rec(au, av, abu, abv, cau, cav, d - 1);
			const k1 = rec(abu, abv, bu, bv, bcu, bcv, d - 1);
			const k2 = rec(bcu, bcv, cu, cv, cau, cav, d - 1);
			const k3 = rec(abu, abv, bcu, bcv, cau, cav, d - 1);
			if (typeof k0 === 'number' && k0 === k1 && k0 === k2 && k0 === k3) {
				leafCount -= 3;
				return k0;
			}
			const enc = (k: number | string) => (typeof k === 'number' ? encodePaintLeaf(k) : k);
			return enc(k0) + enc(k1) + enc(k2) + enc(k3) + '3';
		};
		const root = rec(u0, v0, u1, v1, u2, v2, depth);
		paint[t] = root === 1 ? '' : typeof root === 'number' ? encodePaintLeaf(root) : root;
	}

	// --- 5. Serialise. -----------------------------------------------------
	const title = options.title ?? 'model';
	const hex = rgbToHex;
	const fmt = (x: number) => String(Math.round(x * 1e5) / 1e5);

	const parts: string[] = [];
	parts.push(
		'<?xml version="1.0" encoding="UTF-8"?>\n',
		'<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
		` <metadata name="Title">${xmlEscape(title)}</metadata>\n`,
		` <metadata name="Designer">nx-archive</metadata>\n`,
		` <metadata name="Description">${xmlEscape(
			`Filaments: ${palette.map((c, i) => `${i + 1}=${hex(c)}`).join(' ')}`,
		)}</metadata>\n`,
		' <resources>\n',
		`  <object id="1" type="model" name="${xmlEscape(title)}">\n`,
		'   <mesh>\n    <vertices>\n',
	);
	for (let v = 0; v < vertTotal; v++) {
		parts.push(
			`     <vertex x="${fmt(positions[v * 3]!)}" y="${fmt(positions[v * 3 + 1]!)}" z="${fmt(positions[v * 3 + 2]!)}"/>\n`,
		);
	}
	parts.push('    </vertices>\n    <triangles>\n');
	for (let t = 0; t < triCount; t++) {
		const p = paint[t]!;
		parts.push(
			`     <triangle v1="${tris[t * 3]}" v2="${tris[t * 3 + 1]}" v3="${tris[t * 3 + 2]}"${
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

	const bytes = zipSync(
		{
			'[Content_Types].xml': strToU8(contentTypes),
			'_rels/.rels': strToU8(rels),
			'3D/3dmodel.model': strToU8(parts.join('')),
		},
		{ level: 6 },
	);

	return { bytes, palette, triangleCount: triCount, leafCount };
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
