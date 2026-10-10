/**
 * Structural supports for 3D printing.
 *
 * Game models are assemblies of separate rigid parts that only have to
 * *look* attached: a flame floating just past the tip of a tail, hair
 * spikes that touch the head along one edge, a sword hovering in a
 * hand. Printed as-is those pieces fall off (or print as loose bits).
 *
 * This pass finds the connected parts of the baked meshes, assembles
 * them starting from the largest, and attaches each remaining part to
 * the assembly at its nearest point:
 *
 *   - **attached**: enough of its vertices lie within the strut
 *     radius of the assembly (a real overlap), so nothing is added;
 *   - **weak**: it touches, but only at a few vertices (an edge or a
 *     point), so a short strut is added across the joint;
 *   - **floating**: there's a gap, so a strut bridges it.
 *
 * With a skeleton (`ExportMesh.skeleton`), a part is attached to the
 * piece of its parent bone, and the strut runs along the parent bone
 * through the joint, extending the parent piece into the child (a tail
 * into the flame at its tip) and sized to stay inside both. Without
 * one, it bridges the nearest points.
 *
 * Struts are closed cylinders that extend into both parts, so slicers
 * (which union overlapping solids per layer) fuse everything into one
 * piece. Each strut takes the colour of the surface it leaves from.
 * Work happens in print millimetres (after scaling).
 */

import type { ExportMaterial, ExportMesh } from './mesh-export';

export interface SupportOptions {
	/** Strut radius in mm. */
	radiusMm: number;
	/** Vertices within `radiusMm` of the assembly needed to count as attached. */
	minContacts?: number;
}

export interface SupportReport {
	/** Connected parts considered. */
	parts: number;
	/** Parts separated from the rest by a gap. */
	floating: number;
	/** Parts that touch the rest only at a few vertices. */
	weak: number;
	/** Struts added (floating + weak). */
	struts: number;
	/** True when the model has too many parts to analyse. */
	skipped?: boolean;
}

interface Part {
	/** Unique vertex positions (mm). */
	points: Float32Array;
	/** Triangles as indices into `points`. */
	tris: Uint32Array;
	/** Per point: source mesh + vertex index (for colour). */
	mesh: Uint32Array;
	vertex: Uint32Array;
	centroid: [number, number, number];
}

const MAX_PARTS = 400;
const SAMPLE = 256;

/**
 * Connected parts across all meshes. Triangles join across shared
 * (welded) edges; parts that only share a vertex stay separate, since
 * a single-point joint is exactly the kind that snaps.
 */
function findParts(meshes: readonly ExportMesh[]): Part[] {
	const key = new Map<string, number>();
	const pos: number[] = [];
	const srcMesh: number[] = [];
	const srcVertex: number[] = [];
	const tris: number[] = []; // global vertex ids
	meshes.forEach((m, mi) => {
		const local = new Int32Array(m.positions.length / 3).fill(-1);
		const idOf = (v: number): number => {
			if (local[v] >= 0) return local[v];
			const x = m.positions[v * 3], y = m.positions[v * 3 + 1], z = m.positions[v * 3 + 2];
			const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
			let id = key.get(k);
			if (id === undefined) {
				id = pos.length / 3;
				key.set(k, id);
				pos.push(x, y, z);
				srcMesh.push(mi);
				srcVertex.push(v);
			}
			local[v] = id;
			return id;
		};
		for (let t = 0; t + 2 < m.indices.length; t += 3) {
			const a = idOf(m.indices[t]), b = idOf(m.indices[t + 1]), c = idOf(m.indices[t + 2]);
			if (a !== b && b !== c && a !== c) tris.push(a, b, c);
		}
	});
	const nt = tris.length / 3;
	const parent = Array.from({ length: nt }, (_, i) => i);
	const find = (a: number): number => {
		while (parent[a] !== a) a = parent[a] = parent[parent[a]];
		return a;
	};
	const edgeOwner = new Map<string, number>();
	for (let t = 0; t < nt; t++) {
		for (let e = 0; e < 3; e++) {
			const a = tris[t * 3 + e], b = tris[t * 3 + ((e + 1) % 3)];
			const k = a < b ? `${a},${b}` : `${b},${a}`;
			const o = edgeOwner.get(k);
			if (o === undefined) edgeOwner.set(k, t);
			else {
				const ra = find(o), rb = find(t);
				if (ra !== rb) parent[ra] = rb;
			}
		}
	}
	const groups = new Map<number, number[]>();
	for (let t = 0; t < nt; t++) {
		const r = find(t);
		let g = groups.get(r);
		if (!g) groups.set(r, (g = []));
		g.push(t);
	}
	const parts: Part[] = [];
	for (const ts of groups.values()) {
		const remap = new Map<number, number>();
		const ids: number[] = [];
		const ptris = new Uint32Array(ts.length * 3);
		ts.forEach((t, i) => {
			for (let k = 0; k < 3; k++) {
				const g = tris[t * 3 + k];
				let l = remap.get(g);
				if (l === undefined) {
					l = ids.length;
					remap.set(g, l);
					ids.push(g);
				}
				ptris[i * 3 + k] = l;
			}
		});
		const points = new Float32Array(ids.length * 3);
		const mesh = new Uint32Array(ids.length);
		const vertex = new Uint32Array(ids.length);
		const c: [number, number, number] = [0, 0, 0];
		ids.forEach((id, i) => {
			for (let k = 0; k < 3; k++) {
				points[i * 3 + k] = pos[id * 3 + k];
				c[k] += pos[id * 3 + k] / ids.length;
			}
			mesh[i] = srcMesh[id];
			vertex[i] = srcVertex[id];
		});
		parts.push({ points, tris: ptris, mesh, vertex, centroid: c });
	}
	// Largest (most surface) first: it anchors the assembly.
	return parts.sort((a, b) => b.tris.length - a.tris.length);
}

function sampleIdx(n: number, max: number): number[] {
	const step = Math.max(1, Math.floor(n / max));
	const out: number[] = [];
	for (let i = 0; i < n; i += step) out.push(i);
	return out;
}

function d2(a: Float32Array, i: number, b: Float32Array, j: number): number {
	const x = a[i * 3] - b[j * 3], y = a[i * 3 + 1] - b[j * 3 + 1], z = a[i * 3 + 2] - b[j * 3 + 2];
	return x * x + y * y + z * z;
}

/** Closest vertex pair between two parts (exact for small parts, sampled for big ones). */
function closest(a: Part, b: Part, max = 4000): { i: number; j: number; dist: number } {
	const ia = sampleIdx(a.points.length / 3, max);
	const jb = sampleIdx(b.points.length / 3, max);
	let best = { i: 0, j: 0, dist: Infinity };
	for (const i of ia) {
		for (const j of jb) {
			const d = d2(a.points, i, b.points, j);
			if (d < best.dist) best = { i, j, dist: d };
		}
	}
	return { ...best, dist: Math.sqrt(best.dist) };
}

/** Squared distance from point p to triangle abc. */
function pointTri2(p: number[], a: number[], b: number[], c: number[]): number {
	// Ericson, Real-Time Collision Detection, 5.1.5.
	const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
	const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
	const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
	const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
	const at = (q: number[]) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
	const lerp = (u: number[], d: number[], t: number) => [u[0] + d[0] * t, u[1] + d[1] * t, u[2] + d[2] * t];
	const d1 = dot(ab, ap), d2 = dot(ac, ap);
	if (d1 <= 0 && d2 <= 0) return at(a);
	const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
	const d3 = dot(ab, bp), d4 = dot(ac, bp);
	if (d3 >= 0 && d4 <= d3) return at(b);
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(lerp(a, ab, d1 / (d1 - d3)));
	const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
	const d5 = dot(ab, cp), d6 = dot(ac, cp);
	if (d6 >= 0 && d5 <= d6) return at(c);
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(lerp(a, ac, d2 / (d2 - d6)));
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		const bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
		return at(lerp(b, bc, (d4 - d3) / (d4 - d3 + (d5 - d6))));
	}
	const denom = 1 / (va + vb + vc);
	const v = vb * denom, w = vc * denom;
	return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** Spatial hash of the assembly's triangles, for surface-contact tests. */
class TriGrid {
	private cells = new Map<string, number[][][]>();
	constructor(
		private readonly size: number,
		private readonly pad: number,
	) {}
	add(part: Part) {
		const P = part.points;
		for (let t = 0; t < part.tris.length; t += 3) {
			const v = [0, 1, 2].map((k) => {
				const i = part.tris[t + k] * 3;
				return [P[i], P[i + 1], P[i + 2]];
			});
			const lo = [0, 1, 2].map((k) => Math.floor((Math.min(v[0][k], v[1][k], v[2][k]) - this.pad) / this.size));
			const hi = [0, 1, 2].map((k) => Math.floor((Math.max(v[0][k], v[1][k], v[2][k]) + this.pad) / this.size));
			// Skip absurdly large triangles' cell spans (they're found from neighbours).
			if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096) continue;
			for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
				const k = `${x},${y},${z}`;
				let c = this.cells.get(k);
				if (!c) this.cells.set(k, (c = []));
				c.push(v);
			}
		}
	}
	/** True when the point lies within `r` (≤ pad) of a stored triangle. */
	near(p: number[], r: number): boolean {
		const k = `${Math.floor(p[0] / this.size)},${Math.floor(p[1] / this.size)},${Math.floor(p[2] / this.size)}`;
		const r2 = r * r;
		for (const [a, b, c] of this.cells.get(k) ?? []) if (pointTri2(p, a, b, c) <= r2) return true;
		return false;
	}
}

/** Sample points on a part's surface: vertices plus points every `step` along edges. */
function surfaceSamples(part: Part, step: number): number[][] {
	const P = part.points;
	const out: number[][] = [];
	for (let i = 0; i < P.length; i += 3) out.push([P[i], P[i + 1], P[i + 2]]);
	const seen = new Set<string>();
	for (let t = 0; t < part.tris.length; t += 3) {
		for (let e = 0; e < 3; e++) {
			const a = part.tris[t + e], b = part.tris[t + ((e + 1) % 3)];
			const k = a < b ? `${a},${b}` : `${b},${a}`;
			if (seen.has(k)) continue;
			seen.add(k);
			const len = Math.sqrt(d2(P, a, P, b));
			const n = Math.min(32, Math.floor(len / step));
			for (let s = 1; s < n; s++) {
				const f = s / n;
				out.push([P[a * 3] + (P[b * 3] - P[a * 3]) * f, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * f, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * f]);
			}
		}
	}
	return out;
}

/** sRGB colour of a source vertex: texture texel, vertex colour or material colour. */
function vertexColor(m: ExportMesh, v: number): readonly [number, number, number] {
	let tri = -1;
	for (let t = 0; t < m.indices.length; t++) {
		if (m.indices[t] === v) {
			tri = Math.floor(t / 3);
			break;
		}
	}
	const material: ExportMaterial | undefined = m.materials?.[tri >= 0 ? Number(m.triangleMaterials?.[tri] ?? 0) : 0];
	const tex = material?.texture;
	if (tex && m.uvs) {
		const wrap = (u: number) => u - Math.floor(u);
		let u = wrap(m.uvs[v * 2]);
		let w = wrap(m.uvs[v * 2 + 1]);
		if (tex.flipY) w = 1 - w;
		const x = Math.min(tex.width - 1, Math.floor(u * tex.width));
		const y = Math.min(tex.height - 1, Math.floor(w * tex.height));
		const o = (y * tex.width + x) * 4;
		return [tex.pixels[o], tex.pixels[o + 1], tex.pixels[o + 2]];
	}
	if (m.colors && (material?.useVertexColors ?? !material)) {
		const s = m.colorStride ?? 3;
		const enc = (c: number) => {
			const lin = m.colorSpace === 'srgb' ? c : c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
			return Math.max(0, Math.min(255, Math.round(lin * 255)));
		};
		return [enc(m.colors[v * s]), enc(m.colors[v * s + 1]), enc(m.colors[v * s + 2])];
	}
	return material?.baseColor ?? [200, 200, 200];
}

interface Strut {
	from: [number, number, number];
	to: [number, number, number];
	color: readonly [number, number, number];
	radius: number;
}

/** Bones of a part: (mesh, bone) → vertex count, plus the dominant one. */
function partBones(part: Part, meshes: readonly ExportMesh[]): { counts: Map<string, number>; dominant: [number, number] | null } {
	const counts = new Map<string, number>();
	let best: [number, number] | null = null;
	let bestN = 0;
	for (let i = 0; i < part.mesh.length; i++) {
		const sk = meshes[part.mesh[i]]?.skeleton;
		if (!sk) continue;
		const b = sk.vertexBone[part.vertex[i]];
		const k = `${part.mesh[i]}:${b}`;
		const n = (counts.get(k) ?? 0) + 1;
		counts.set(k, n);
		if (n > bestN) {
			bestN = n;
			best = [part.mesh[i], b];
		}
	}
	return { counts, dominant: best };
}

/** Median distance of a part's vertices from the line through `p` along unit `d`. */
function radiusAround(part: Part, p: readonly number[], d: readonly number[]): number {
	const P = part.points;
	const ds: number[] = [];
	for (let i = 0; i < P.length; i += 3) {
		const v = [P[i] - p[0], P[i + 1] - p[1], P[i + 2] - p[2]];
		const along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
		ds.push(Math.sqrt(Math.max(0, v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - along * along)));
	}
	ds.sort((a, b) => a - b);
	return ds[Math.floor(ds.length / 2)] ?? 0;
}

/** Distance from `p` to the nearest vertex of a part. */
function nearestDist(part: Part, p: readonly number[]): number {
	let best = Infinity;
	const P = part.points;
	for (let i = 0; i < P.length; i += 3) best = Math.min(best, (P[i] - p[0]) ** 2 + (P[i + 1] - p[1]) ** 2 + (P[i + 2] - p[2]) ** 2);
	return Math.sqrt(best);
}

/** Ray-parity inside test against a set of triangles (+X ray). */
function insideTris(p: readonly number[], tris: number[][][]): boolean {
	let hits = 0;
	for (const [a, b, c] of tris) {
		// Project onto the YZ plane; ray along +X.
		const y = p[1], z = p[2];
		const d = (b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2]);
		if (Math.abs(d) < 1e-12) continue;
		const u = ((y - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (z - a[2])) / d;
		const v = ((b[1] - a[1]) * (z - a[2]) - (y - a[1]) * (b[2] - a[2])) / d;
		if (u < 0 || v < 0 || u + v > 1) continue;
		const x = a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]);
		if (x > p[0]) hits++;
	}
	return (hits & 1) === 1;
}

function partTris(part: Part): number[][][] {
	const P = part.points;
	const out: number[][][] = [];
	for (let t = 0; t < part.tris.length; t += 3) {
		out.push([0, 1, 2].map((k) => {
			const i = part.tris[t + k] * 3;
			return [P[i], P[i + 1], P[i + 2]];
		}));
	}
	return out;
}

const MAX_INSIDE_TRIS = 50_000;

/** Principal axis of a part's vertices and how elongated it is (λ1 / λ2). */
function principalAxis(part: Part): { axis: number[]; elongation: number } {
	const P = part.points;
	const c = part.centroid;
	const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	for (let i = 0; i < P.length; i += 3) {
		const v = [P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]];
		for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += v[a] * v[b];
	}
	const power = (M: number[], start: number[]): { v: number[]; l: number } => {
		let v = start;
		let l = 0;
		for (let k = 0; k < 32; k++) {
			const w = [0, 1, 2].map((a) => M[a * 3] * v[0] + M[a * 3 + 1] * v[1] + M[a * 3 + 2] * v[2]);
			l = Math.hypot(w[0], w[1], w[2]);
			if (l < 1e-12) return { v, l: 0 };
			v = w.map((x) => x / l);
		}
		return { v, l };
	};
	const e1 = power(C, [0.57, 0.58, 0.59]);
	// Deflate for the second eigenvalue, starting orthogonal to the first
	// axis (an isotropic blob would otherwise collapse to zero).
	const D = C.map((x, i) => x - e1.l * e1.v[Math.floor(i / 3)] * e1.v[i % 3]);
	const v = e1.v;
	const helper = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
	const ortho = [v[1] * helper[2] - v[2] * helper[1], v[2] * helper[0] - v[0] * helper[2], v[0] * helper[1] - v[1] * helper[0]];
	const ol = Math.hypot(ortho[0], ortho[1], ortho[2]) || 1;
	const e2 = power(D, ortho.map((x) => x / ol));
	return { axis: e1.v, elongation: e2.l > 1e-12 ? e1.l / e2.l : Infinity };
}

/**
 * Strut axis at junction J between a loose part and its target: along
 * the part if it's limb-like, else extending the target piece (a tail
 * into the flame at its tip), else straight from J into the part.
 */
function strutAxis(part: Part, target: Part, J: readonly number[]): { axis: number[]; through: number[] | null } | null {
	const c = part.centroid;
	const toPart = [c[0] - J[0], c[1] - J[1], c[2] - J[2]];
	const orient = (v: number[], ref: number[]) => {
		const sign = v[0] * ref[0] + v[1] * ref[1] + v[2] * ref[2] < 0 ? -1 : 1;
		return v.map((x) => x * sign);
	};
	const mine = principalAxis(part);
	const theirs = principalAxis(target);
	let axis: number[];
	// The strut runs along this piece's centre line (null: through J).
	let through: number[] | null = null;
	if (mine.elongation > 2) {
		axis = orient(mine.axis, toPart);
		through = part.centroid;
	} else if (theirs.elongation > 2) {
		const t = target.centroid;
		axis = orient(theirs.axis, [J[0] - t[0], J[1] - t[1], J[2] - t[2]]);
		through = t;
	} else {
		// Two blobs: the line between their centres passes through both.
		const t = target.centroid;
		axis = [c[0] - t[0], c[1] - t[1], c[2] - t[2]];
		if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-9) axis = toPart;
		else through = t;
	}
	const len = Math.hypot(axis[0], axis[1], axis[2]);
	return len < 1e-9 ? null : { axis: axis.map((v) => v / len), through };
}

/** Depth of a bone in its skeleton (roots are 0). */
function boneDepth(parent: Int16Array, b: number): number {
	let d = 0;
	for (let a = parent[b]; a >= 0 && d < 256; a = parent[a]) d++;
	return d;
}

/** Plan struts without building geometry (for the export dialog's summary). */
export function planSupports(meshes: readonly ExportMesh[], opts: SupportOptions): { report: SupportReport; struts: Strut[] } {
	const parts = findParts(meshes);
	const report: SupportReport = { parts: parts.length, floating: 0, weak: 0, struts: 0 };
	if (parts.length <= 1) return { report, struts: [] };
	if (parts.length > MAX_PARTS) return { report: { ...report, skipped: true }, struts: [] };
	const r = opts.radiusMm;
	const minContacts = opts.minContacts ?? 3;
	// A sample within half a strut radius of the assembly's surface is in contact.
	const touch = r / 2;
	const grid = new TriGrid(Math.max(r * 4, 1e-3), touch);
	const bones = parts.map((p) => partBones(p, meshes));
	const skeletal = bones.some((b) => b.dominant);
	if (skeletal) {
		// Anchor on the root-most piece so attachment follows the hierarchy.
		const depth = (i: number) => {
			const d = bones[i].dominant;
			return d ? boneDepth(meshes[d[0]].skeleton!.parent, d[1]) : 1e9;
		};
		let anchor = 0;
		for (let i = 1; i < parts.length; i++) {
			if (depth(i) < depth(anchor) || (depth(i) === depth(anchor) && parts[i].tris.length > parts[anchor].tris.length)) anchor = i;
		}
		[parts[0], parts[anchor]] = [parts[anchor], parts[0]];
		[bones[0], bones[anchor]] = [bones[anchor], bones[0]];
	}
	const attachedFlag = parts.map(() => false);
	const attachedTris: number[][][] = [];
	const attach = (i: number) => {
		attachedFlag[i] = true;
		grid.add(parts[i]);
		if (attachedTris.length < MAX_INSIDE_TRIS) attachedTris.push(...partTris(parts[i]));
	};
	attach(0);
	// Best sampled distance from each waiting part to the assembly.
	const best = parts.map(() => ({ dist: Infinity, to: -1 }));
	const update = (p: number, c: number) => {
		const s = closest(parts[p], parts[c], SAMPLE);
		if (s.dist < best[p].dist) best[p] = { dist: s.dist, to: c };
	};
	const waiting = new Set(parts.map((_, i) => i).filter((i) => i > 0));
	for (const p of waiting) update(p, 0);

	/**
	 * Skeleton route from a part to the assembly: an attached piece of
	 * the same bone, else of the nearest attached ancestor bone, and the
	 * joint + axis to strut along.
	 */
	const skeletonTarget = (p: number): { target: number; joint: number[] | null; axis: number[] | null } | null => {
		const dom = bones[p].dominant;
		if (!dom) return null;
		const [mi, b0] = dom;
		const sk = meshes[mi].skeleton!;
		const holder = (bone: number) => {
			let target = -1;
			let n = 0;
			for (let q = 0; q < parts.length; q++) {
				if (!attachedFlag[q] || q === p) continue;
				const c = bones[q].counts.get(`${mi}:${bone}`) ?? 0;
				if (c > n) {
					n = c;
					target = q;
				}
			}
			return target;
		};
		// Another piece of the same bone: brace the two directly.
		const same = holder(b0);
		if (same >= 0) return { target: same, joint: null, axis: null };
		let child = b0;
		let a = sk.parent[b0];
		const origin = (b: number) => [sk.joints[b * 3], sk.joints[b * 3 + 1], sk.joints[b * 3 + 2]];
		for (let guard = 0; a >= 0 && guard < 256; guard++) {
			const target = holder(a);
			if (target >= 0) {
				// The junction: whichever nearby bone origin sits closest to both pieces.
				const candidates = [b0, child, a, sk.parent[a]].filter((b) => b >= 0).map(origin);
				let J = candidates[0];
				let bestGap = Infinity;
				for (const c of candidates) {
					const gap = nearestDist(parts[p], c) + nearestDist(parts[target], c);
					if (gap < bestGap) {
						bestGap = gap;
						J = c;
					}
				}
				return { target, joint: J, axis: null };
			}
			child = a;
			a = sk.parent[a];
		}
		return null;
	};

	const struts: Strut[] = [];
	while (waiting.size) {
		// Prim: the waiting part nearest to the assembly. With a skeleton,
		// prefer parts whose ancestor bone is already attached.
		let next = -1;
		let route: ReturnType<typeof skeletonTarget> = null;
		if (skeletal) {
			for (const p of waiting) {
				const rt = skeletonTarget(p);
				if (rt && (next < 0 || best[p].dist < best[next].dist)) {
					next = p;
					route = rt;
				}
			}
		}
		if (next < 0) for (const p of waiting) if (next < 0 || best[p].dist < best[next].dist) next = p;
		waiting.delete(next);
		const part = parts[next];
		let contacts = 0;
		for (const p of surfaceSamples(part, r)) {
			if (grid.near(p, touch) && ++contacts >= minContacts) break;
		}
		if (contacts < minContacts && attachedTris.length) {
			// Sunk into the assembly (e.g. a limb inside the torso)?
			const P = part.points;
			for (let i = 0; i < P.length && contacts < minContacts; i += 3 * Math.max(1, Math.floor(P.length / 3 / 32))) {
				if (insideTris([P[i], P[i + 1], P[i + 2]], attachedTris)) contacts++;
			}
		}
		if (contacts < minContacts) {
			const target = parts[route ? route.target : best[next].to];
			const pair = closest(part, target);
			const color = vertexColor(meshes[part.mesh[pair.i]], part.vertex[pair.i]);
			if (pair.dist > r * 0.5) report.floating++;
			else report.weak++;
			// Junction: the bone joint when the skeleton gives one, else the
			// midpoint of the closest points.
			const a = [part.points[pair.i * 3], part.points[pair.i * 3 + 1], part.points[pair.i * 3 + 2]];
			const b = [target.points[pair.j * 3], target.points[pair.j * 3 + 1], target.points[pair.j * 3 + 2]];
			let J = route?.joint ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
			const ax = strutAxis(part, target, J);
			const d = ax?.axis ?? [0, 1, 0];
			if (ax?.through) {
				// Centre the strut inside the limb-like piece: project J onto its centre line.
				const c = ax.through;
				const t = (J[0] - c[0]) * d[0] + (J[1] - c[1]) * d[1] + (J[2] - c[2]) * d[2];
				J = [c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t];
			}
			// Reach far enough into both pieces, and stay inside the thinner one.
			const reachChild = Math.max(r * 3, nearestDist(part, J) + r * 2);
			const reachParent = Math.max(r * 3, nearestDist(target, J) + r * 2);
			const fit = Math.min(radiusAround(part, J, d), radiusAround(target, J, d)) * 0.6;
			struts.push({
				from: [J[0] - d[0] * reachParent, J[1] - d[1] * reachParent, J[2] - d[2] * reachParent],
				to: [J[0] + d[0] * reachChild, J[1] + d[1] * reachChild, J[2] + d[2] * reachChild],
				color,
				radius: Math.max(Math.min(r, fit), Math.min(r, 0.4)),
			});
		}
		attach(next);
		for (const p of waiting) update(p, next);
	}
	report.struts = struts.length;
	return { report, struts };
}

/** A closed cylinder from `a` to `b`. */
function cylinder(a: readonly number[], b: readonly number[], r: number, segments = 12): { positions: Float32Array; indices: Uint32Array } {
	const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
	const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
	const w = axis.map((v) => v / len);
	// Any vector not parallel to the axis gives the cross-section basis.
	const tmp = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
	const u = [w[1] * tmp[2] - w[2] * tmp[1], w[2] * tmp[0] - w[0] * tmp[2], w[0] * tmp[1] - w[1] * tmp[0]];
	const ul = Math.hypot(u[0], u[1], u[2]);
	for (let k = 0; k < 3; k++) u[k] /= ul;
	const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
	const positions = new Float32Array((segments * 2 + 2) * 3);
	for (let i = 0; i < segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		const cx = Math.cos(t) * r, cy = Math.sin(t) * r;
		for (let k = 0; k < 3; k++) {
			positions[i * 3 + k] = a[k] + u[k] * cx + v[k] * cy;
			positions[(segments + i) * 3 + k] = b[k] + u[k] * cx + v[k] * cy;
		}
	}
	const ca = segments * 2, cb = segments * 2 + 1;
	positions.set(a.slice(0, 3), ca * 3);
	positions.set(b.slice(0, 3), cb * 3);
	const idx: number[] = [];
	for (let i = 0; i < segments; i++) {
		const j = (i + 1) % segments;
		// Outward-facing sides and caps (counter-clockwise seen from outside).
		idx.push(i, j, segments + j, i, segments + j, segments + i);
		idx.push(ca, j, i);
		idx.push(cb, segments + i, segments + j);
	}
	return { positions, indices: Uint32Array.from(idx) };
}

/** Add struts for floating / weakly attached parts; returns the meshes plus one strut mesh per support. */
export function addStructuralSupports(meshes: readonly ExportMesh[], opts: SupportOptions): { meshes: ExportMesh[]; report: SupportReport } {
	const { report, struts } = planSupports(meshes, opts);
	const extra: ExportMesh[] = struts.map((s) => {
		const c = cylinder(s.from, s.to, s.radius);
		return { ...c, materials: [{ texture: null, baseColor: s.color }] };
	});
	return { meshes: [...meshes, ...extra], report };
}
