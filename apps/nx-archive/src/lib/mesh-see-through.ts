/**
 * See-through "lids" for print export.
 *
 * Some engines hide geometry behind surfaces they never draw from the
 * outside: Let's Go builds an eye as a white bowl with the pupil at its
 * bottom, closed by an eye-white lid whose front faces *inward*. The
 * game culls back faces, so from outside you look straight through the
 * lid into the bowl. A print is solid, so the lid would cover the pupil.
 *
 * Instead the lid is painted with what the game shows through it. A
 * triangle of a back-face-culled material (`ExportMaterial.backFaceCulled`)
 * is a lid when:
 *
 *  - a ray out through its back side escapes the model, so its back
 *    faces the outside world, and
 *  - rays into its front side (straight in and tilted 45° four ways)
 *    all hit geometry within a short reach that faces back at the lid,
 *    so it closes a small cavity, rather than being a wing or a fin
 *    (whose front rays escape, or meet the back of the next layer).
 *
 * The painter then samples, for each point of a lid, the first surface
 * facing back along the view ray (see `mesh-export-3mf.ts`). The view
 * ray is shared by a whole lid patch (an eye): its mean normal. Everything
 * here works in the input mesh's own space and winding, before the
 * exporter re-orients or repairs anything.
 */
import type { ExportMesh } from './mesh-export';

/** How far behind a lid the cavity may extend, as a fraction of the model's size. */
const REACH = 0.08;
/**
 * Smallest lid patch kept. Let's Go eye lids are 130–160 triangles; the
 * few stray triangles that pass the cavity test elsewhere (where wing
 * layers meet the body) come in patches of under twenty.
 */
const MIN_PATCH = 24;

export interface SeeThrough {
	/** View direction through the lid: its front normal (into the cavity). */
	dir: [number, number, number];
	/**
	 * Triangles (input indices) a view ray through this lid can hit and
	 * see: near its view volume, facing back along `dir`, not lids.
	 */
	candidates: Int32Array;
	/** Maximum ray length. */
	reach: number;
}

/** A uniform grid over the mesh's triangles, for ray casting. */
class TriGrid {
	readonly lo: [number, number, number];
	readonly size: number;
	readonly n: number;
	readonly cells: number[][];
	constructor(
		readonly P: ArrayLike<number>,
		readonly I: ArrayLike<number>,
		readonly triCount: number,
	) {
		const lo: [number, number, number] = [Infinity, Infinity, Infinity];
		const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
		for (let i = 0; i < P.length; i += 3) {
			for (let c = 0; c < 3; c++) {
				lo[c] = Math.min(lo[c]!, P[i + c]!);
				hi[c] = Math.max(hi[c]!, P[i + c]!);
			}
		}
		this.lo = lo;
		const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
		this.n = Math.max(4, Math.min(96, Math.round(Math.cbrt(triCount) * 2)));
		this.size = (extent * 1.0001) / this.n;
		this.cells = Array.from({ length: this.n ** 3 }, () => []);
		for (let t = 0; t < triCount; t++) {
			const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
			const cl = [0, 1, 2].map((k) => this.cell(Math.min(P[a + k]!, P[b + k]!, P[c + k]!), k));
			const ch = [0, 1, 2].map((k) => this.cell(Math.max(P[a + k]!, P[b + k]!, P[c + k]!), k));
			for (let x = cl[0]!; x <= ch[0]!; x++)
				for (let y = cl[1]!; y <= ch[1]!; y++)
					for (let z = cl[2]!; z <= ch[2]!; z++) this.cells[(x * this.n + y) * this.n + z]!.push(t);
		}
	}
	cell(v: number, axis: number): number {
		return Math.max(0, Math.min(this.n - 1, Math.floor((v - this.lo[axis]!) / this.size)));
	}
	/** Diagonal of the grid's bounds. */
	get diagonal(): number {
		return this.size * this.n * Math.sqrt(3);
	}
	/**
	 * First hit along `o + t·d` for t in (eps, maxT]: the triangle and t,
	 * or null. Skips triangles in `skip`.
	 */
	cast(o: readonly number[], d: readonly number[], maxT: number, skip: (t: number) => boolean): { tri: number; t: number } | null {
		const seen = new Set<number>();
		let best: { tri: number; t: number } | null = null;
		// March along the ray a cell at a time (conservative: visit the
		// cells of sampled points along it).
		const step = this.size * 0.5;
		const steps = Math.min(4 * this.n, Math.ceil(maxT / step) + 1);
		for (let i = 0; i <= steps; i++) {
			const tt = Math.min(maxT, i * step);
			const cx = Math.floor((o[0]! + d[0]! * tt - this.lo[0]) / this.size);
			const cy = Math.floor((o[1]! + d[1]! * tt - this.lo[1]) / this.size);
			const cz = Math.floor((o[2]! + d[2]! * tt - this.lo[2]) / this.size);
			if (cx < 0 || cy < 0 || cz < 0 || cx >= this.n || cy >= this.n || cz >= this.n) {
				if (i > 0) break;
				continue;
			}
			for (const tri of this.cells[(cx * this.n + cy) * this.n + cz]!) {
				if (seen.has(tri) || skip(tri)) continue;
				seen.add(tri);
				const hit = rayTri(this.P, this.I, tri, o, d);
				if (hit !== null && hit > 1e-6 * this.diagonal && hit <= maxT && (!best || hit < best.t)) best = { tri, t: hit };
			}
			// Nothing in later cells can be nearer than a hit already found
			// before this cell's far edge.
			if (best && best.t < tt - this.size) break;
		}
		return best;
	}
}

/** Möller–Trumbore with barycentrics: weights of corners B (u) and C (v). */
export function rayTriHit(
	P: ArrayLike<number>,
	I: ArrayLike<number>,
	tri: number,
	o: readonly number[],
	d: readonly number[],
): { t: number; u: number; v: number } | null {
	const a = I[tri * 3]! * 3, b = I[tri * 3 + 1]! * 3, c = I[tri * 3 + 2]! * 3;
	const e1x = P[b]! - P[a]!, e1y = P[b + 1]! - P[a + 1]!, e1z = P[b + 2]! - P[a + 2]!;
	const e2x = P[c]! - P[a]!, e2y = P[c + 1]! - P[a + 1]!, e2z = P[c + 2]! - P[a + 2]!;
	const px = d[1]! * e2z - d[2]! * e2y, py = d[2]! * e2x - d[0]! * e2z, pz = d[0]! * e2y - d[1]! * e2x;
	const det = e1x * px + e1y * py + e1z * pz;
	if (Math.abs(det) < 1e-12) return null;
	const inv = 1 / det;
	const tx = o[0]! - P[a]!, ty = o[1]! - P[a + 1]!, tz = o[2]! - P[a + 2]!;
	const u = (tx * px + ty * py + tz * pz) * inv;
	if (u < 0 || u > 1) return null;
	const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
	const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
	if (v < 0 || u + v > 1) return null;
	return { t: (e2x * qx + e2y * qy + e2z * qz) * inv, u, v };
}

/** Möller–Trumbore: ray parameter t of the hit, or null. */
export function rayTri(P: ArrayLike<number>, I: ArrayLike<number>, tri: number, o: readonly number[], d: readonly number[]): number | null {
	const a = I[tri * 3]! * 3, b = I[tri * 3 + 1]! * 3, c = I[tri * 3 + 2]! * 3;
	const e1x = P[b]! - P[a]!, e1y = P[b + 1]! - P[a + 1]!, e1z = P[b + 2]! - P[a + 2]!;
	const e2x = P[c]! - P[a]!, e2y = P[c + 1]! - P[a + 1]!, e2z = P[c + 2]! - P[a + 2]!;
	const px = d[1]! * e2z - d[2]! * e2y, py = d[2]! * e2x - d[0]! * e2z, pz = d[0]! * e2y - d[1]! * e2x;
	const det = e1x * px + e1y * py + e1z * pz;
	if (Math.abs(det) < 1e-12) return null;
	const inv = 1 / det;
	const tx = o[0]! - P[a]!, ty = o[1]! - P[a + 1]!, tz = o[2]! - P[a + 2]!;
	const u = (tx * px + ty * py + tz * pz) * inv;
	if (u < 0 || u > 1) return null;
	const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
	const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
	if (v < 0 || u + v > 1) return null;
	return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Unit normal of triangle `tri` (its front, by winding), or null if degenerate. */
export function triNormal(P: ArrayLike<number>, I: ArrayLike<number>, tri: number): [number, number, number] | null {
	const a = I[tri * 3]! * 3, b = I[tri * 3 + 1]! * 3, c = I[tri * 3 + 2]! * 3;
	const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
	const e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
	const n: [number, number, number] = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
	const l = Math.hypot(n[0], n[1], n[2]);
	return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null;
}

/** Find the see-through lids of `m`, keyed by input triangle index. */
export function findSeeThroughLids(m: ExportMesh): Map<number, SeeThrough> {
	const out = new Map<number, SeeThrough>();
	const mats = m.materials ?? [];
	if (!mats.some((x) => x.backFaceCulled)) return out;
	const P = m.positions, I = m.indices;
	const triCount = I.length / 3;
	const grid = new TriGrid(P, I, triCount);
	const reach = grid.diagonal * REACH;
	const far = grid.diagonal * 2;
	const culled = (t: number) => Boolean(mats[Number(m.triangleMaterials?.[t] ?? 0)]?.backFaceCulled);

	for (let t = 0; t < triCount; t++) {
		if (!culled(t)) continue;
		const n = triNormal(P, I, t);
		if (!n) continue;
		const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
		const o = [0, 1, 2].map((k) => (P[a + k]! + P[b + k]! + P[c + k]!) / 3);
		const self = (x: number) => x === t;
		// Back side must see the outside.
		if (grid.cast(o, [-n[0], -n[1], -n[2]], far, self)) continue;
		// Front side must be a closed, shallow cavity.
		const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
		const ex = norm(cross(up, n));
		const ey = cross(n, ex);
		const dirs = [n, ...[ex, neg(ex), ey, neg(ey)].map((e) => norm(add(n, e)))];
		// …whose walls face back at the lid (an eye bowl does; the next
		// layer of a stacked wing faces away).
		const facesBack = (d: readonly number[]) => {
			const hit = grid.cast(o, d, reach, self);
			if (!hit) return false;
			const hn = triNormal(P, I, hit.tri);
			return !!hn && hn[0] * d[0]! + hn[1] * d[1]! + hn[2] * d[2]! < 0;
		};
		if (!dirs.every(facesBack)) continue;
		out.set(t, { dir: n, candidates: new Int32Array(0), reach });
	}

	// One view direction per lid patch (an eye): its area-weighted mean
	// normal. Per-triangle normals tilt inward on a domed lid, so near the
	// rim they'd all look at the pupil instead of the white around it.
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		let r = x;
		while (parent.get(r)! !== r) r = parent.get(r)!;
		parent.set(x, r);
		return r;
	};
	const byVertex = new Map<string, number>();
	const q = Math.max(grid.size * 1e-3, 1e-9);
	for (const t of out.keys()) parent.set(t, t);
	for (const t of out.keys()) {
		for (let k = 0; k < 3; k++) {
			const v = I[t * 3 + k]! * 3;
			const key = `${Math.round(P[v]! / q)},${Math.round(P[v + 1]! / q)},${Math.round(P[v + 2]! / q)}`;
			const other = byVertex.get(key);
			if (other === undefined) byVertex.set(key, t);
			else parent.set(find(t), find(other));
		}
	}
	const sums = new Map<number, [number, number, number]>();
	for (const t of out.keys()) {
		const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
		const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
		const e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
		const n = cross(e1, e2); // length = 2 × area
		const r = find(t);
		const acc = sums.get(r) ?? [0, 0, 0];
		sums.set(r, [acc[0] + n[0], acc[1] + n[1], acc[2] + n[2]]);
	}
	const patchSize = new Map<number, number>();
	for (const t of out.keys()) patchSize.set(find(t), (patchSize.get(find(t)) ?? 0) + 1);
	for (const t of [...out.keys()]) if (patchSize.get(find(t))! < MIN_PATCH) out.delete(t);
	for (const [t, info] of out) info.dir = norm(sums.get(find(t))!);

	// Candidates per lid: triangles near the lid's view volume (not lids).
	for (const [t, info] of out) {
		const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
		const corners = [a, b, c].flatMap((v) => [[P[v]!, P[v + 1]!, P[v + 2]!], [0, 1, 2].map((k) => P[v + k]! + info.dir[k]! * reach)]);
		const pad = grid.size * 0.1;
		const lo = [0, 1, 2].map((k) => Math.min(...corners.map((q) => q[k]!)) - pad);
		const hi = [0, 1, 2].map((k) => Math.max(...corners.map((q) => q[k]!)) + pad);
		const set = new Set<number>();
		const cl = [0, 1, 2].map((k) => grid.cell(lo[k]!, k));
		const ch = [0, 1, 2].map((k) => grid.cell(hi[k]!, k));
		for (let x = cl[0]!; x <= ch[0]!; x++)
			for (let y = cl[1]!; y <= ch[1]!; y++)
				for (let z = cl[2]!; z <= ch[2]!; z++) for (const q of grid.cells[(x * grid.n + y) * grid.n + z]!) if (!out.has(q)) set.add(q);
		const d = info.dir;
		info.candidates = Int32Array.from([...set].filter((q) => {
			const n = triNormal(P, I, q);
			return !!n && n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0;
		}));
	}
	return out;
}

const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
	a[1]! * b[2]! - a[2]! * b[1]!,
	a[2]! * b[0]! - a[0]! * b[2]!,
	a[0]! * b[1]! - a[1]! * b[0]!,
];
const add = (a: readonly number[], b: readonly number[]) => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const neg = (a: readonly number[]) => [-a[0]!, -a[1]!, -a[2]!];
const norm = (a: readonly number[]): [number, number, number] => {
	const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
	return [a[0]! / l, a[1]! / l, a[2]! / l];
};
