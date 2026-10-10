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

interface Strut {
	from: [number, number, number];
	to: [number, number, number];
	color: readonly [number, number, number];
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
	grid.add(parts[0]);
	const attached = [0];
	// Best sampled distance from each waiting part to the assembly.
	const best = parts.map(() => ({ dist: Infinity, to: -1 }));
	const update = (p: number, c: number) => {
		const s = closest(parts[p], parts[c], SAMPLE);
		if (s.dist < best[p].dist) best[p] = { dist: s.dist, to: c };
	};
	const waiting = new Set(parts.map((_, i) => i).filter((i) => i > 0));
	for (const p of waiting) update(p, 0);
	const struts: Strut[] = [];
	while (waiting.size) {
		// Prim: attach the waiting part nearest to the assembly next.
		let next = -1;
		for (const p of waiting) if (next < 0 || best[p].dist < best[next].dist) next = p;
		waiting.delete(next);
		const part = parts[next];
		const target = parts[best[next].to];
		let contacts = 0;
		for (const p of surfaceSamples(part, r)) {
			if (grid.near(p, touch) && ++contacts >= minContacts) break;
		}
		if (contacts < minContacts) {
			const pair = closest(part, target);
			const a: [number, number, number] = [part.points[pair.i * 3], part.points[pair.i * 3 + 1], part.points[pair.i * 3 + 2]];
			const b: [number, number, number] = [target.points[pair.j * 3], target.points[pair.j * 3 + 1], target.points[pair.j * 3 + 2]];
			let dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
			let len = Math.hypot(dir[0], dir[1], dir[2]);
			if (len < r * 0.5) {
				// Touching: brace across the joint, centroid to centroid.
				dir = [target.centroid[0] - part.centroid[0], target.centroid[1] - part.centroid[1], target.centroid[2] - part.centroid[2]];
				len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
			}
			const n = dir.map((v) => v / len);
			// Extend into both parts so the slicer fuses them.
			const ext = r * 2;
			struts.push({
				from: [a[0] - n[0] * ext, a[1] - n[1] * ext, a[2] - n[2] * ext],
				to: [b[0] + n[0] * ext, b[1] + n[1] * ext, b[2] + n[2] * ext],
				color: vertexColor(meshes[part.mesh[pair.i]], part.vertex[pair.i]),
			});
			if (pair.dist > r * 0.5) report.floating++;
			else report.weak++;
		}
		grid.add(part);
		attached.push(next);
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
		const c = cylinder(s.from, s.to, opts.radiusMm);
		return { ...c, materials: [{ texture: null, baseColor: s.color }] };
	});
	return { meshes: [...meshes, ...extra], report };
}
