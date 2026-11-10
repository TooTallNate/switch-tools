/**
 * Turn a glyph's coverage bitmap into outline contours.
 *
 * Two strategies, because bitmap fonts come in two kinds:
 *
 *   - **smooth**: for large, anti-aliased glyphs (most console fonts,
 *     e.g. a 100 px BFFNT). The 50 % coverage iso-line is found with
 *     marching squares, which puts each edge to within ~0.1 px thanks
 *     to the anti-aliasing. Corners are found where the outline turns
 *     sharply over a short distance (and not over a longer one, which
 *     is what tells a corner from a tight curve), then snapped to the
 *     intersection of the two sides. Between corners, the points are
 *     fitted with chains of quadratic Béziers (least squares with
 *     Newton re-parameterisation, splitting until within tolerance,
 *     like Schneider's "An Algorithm for Automatically Fitting
 *     Digitized Curves", Graphics Gems 1990, but for TrueType's
 *     quadratics), joined smoothly.
 *   - **pixel**: for small or 1-bit glyphs (pixel fonts), where the
 *     square pixels *are* the design. Traces the pixel edges of every
 *     pixel at or above the threshold and merges straight runs.
 *
 * Coordinates are in pixels, y-down, with (0, 0) the bitmap's top-left
 * corner. Outer contours have positive shoelace area in these
 * coordinates and holes negative, which becomes TrueType's clockwise
 * outer / counter-clockwise hole once y is flipped up.
 */

export interface TracePoint {
	x: number;
	y: number;
	/** False for a quadratic control point. */
	on: boolean;
}

export type TraceContour = TracePoint[];

export type TraceMode = 'smooth' | 'pixel';

export interface TraceOptions {
	mode?: TraceMode;
	/** Coverage (0-255) at which a pixel counts as inside. Default 128. */
	threshold?: number;
	/** Max distance, in px, between the fitted curves and the iso-line. Default 0.2. */
	tolerance?: number;
	/** Contours enclosing less than this many px² are dropped as noise. Default 0.5. */
	minArea?: number;
}

type P = { x: number; y: number };

/** Trace a `width × height` coverage bitmap into contours. */
export function traceCoverage(
	coverage: Uint8Array,
	width: number,
	height: number,
	options: TraceOptions = {},
): TraceContour[] {
	const threshold = options.threshold ?? 128;
	const minArea = options.minArea ?? 0.5;
	if (options.mode === 'pixel') {
		return tracePixels(coverage, width, height, threshold).filter(
			(c) => Math.abs(area(c)) >= minArea,
		);
	}
	const tol = options.tolerance ?? 0.2;
	const out: TraceContour[] = [];
	for (const loop of isoLines(coverage, width, height, threshold)) {
		const pts = dedupe(loop);
		if (pts.length < 3 || Math.abs(area(pts)) < minArea) continue;
		const fitted = fitContour(pts, tol);
		if (fitted.length >= 2) out.push(fitted);
	}
	return out;
}

/** Shoelace area of a polygon (control points counted as vertices). */
export function area(pts: readonly P[]): number {
	let a = 0;
	for (let i = 0, n = pts.length; i < n; i++) {
		const p = pts[i]!;
		const q = pts[(i + 1) % n]!;
		a += p.x * q.y - q.x * p.y;
	}
	return a / 2;
}

// ----- pixel mode -----

function tracePixels(cov: Uint8Array, w: number, h: number, t: number): TraceContour[] {
	const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && cov[y * w + x]! >= t;
	// Directed boundary edges with the inside on the right (y-down):
	// top edges run +x, right edges +y, bottom −x, left −y.
	const W = w + 1;
	const key = (x: number, y: number) => y * W + x;
	const outgoing = new Map<number, number[]>();
	const add = (x0: number, y0: number, x1: number, y1: number) => {
		const k = key(x0, y0);
		let list = outgoing.get(k);
		if (!list) outgoing.set(k, (list = []));
		list.push(key(x1, y1));
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!inside(x, y)) continue;
			if (!inside(x, y - 1)) add(x, y, x + 1, y);
			if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
			if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
			if (!inside(x - 1, y)) add(x, y + 1, x, y);
		}
	}
	const out: TraceContour[] = [];
	for (const [start, list] of outgoing) {
		while (list.length) {
			const loop: number[] = [start];
			let prev = start;
			let cur = list.pop()!;
			while (cur !== start) {
				loop.push(cur);
				const next = outgoing.get(cur)!;
				let pick = 0;
				if (next.length > 1) {
					// Where two pixels touch diagonally, turn right so
					// each pixel's loop closes around itself.
					const dx = (cur % W) - (prev % W);
					const dy = Math.floor(cur / W) - Math.floor(prev / W);
					pick = next.findIndex((n) => {
						const ex = (n % W) - (cur % W);
						const ey = Math.floor(n / W) - Math.floor(cur / W);
						return ex === -dy && ey === dx;
					});
					if (pick < 0) pick = 0;
				}
				prev = cur;
				cur = next.splice(pick, 1)[0]!;
			}
			const pts = loop.map((k) => ({ x: k % W, y: Math.floor(k / W) }));
			out.push(mergeCollinear(pts).map((p) => ({ ...p, on: true })));
		}
	}
	return out;
}

function mergeCollinear(pts: P[]): P[] {
	const out: P[] = [];
	const n = pts.length;
	for (let i = 0; i < n; i++) {
		const a = pts[(i + n - 1) % n]!;
		const b = pts[i]!;
		const c = pts[(i + 1) % n]!;
		if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) out.push(b);
	}
	return out;
}

// ----- smooth mode: iso-lines -----

/**
 * Marching squares over the pixel centres (padded by one empty pixel
 * all round so every loop closes). Each crossing point is keyed by
 * the grid edge it lies on; every key starts one segment and ends
 * another, so following the segments yields closed loops.
 */
function isoLines(cov: Uint8Array, w: number, h: number, t: number): P[][] {
	const gw = w + 2;
	const gh = h + 2;
	const v = (i: number, j: number) => {
		const x = i - 1;
		const y = j - 1;
		return x < 0 || y < 0 || x >= w || y >= h ? 0 : cov[y * w + x]!;
	};
	// Edge keys: horizontal edge (i,j)-(i+1,j) = 2·(j·gw+i), vertical (i,j)-(i,j+1) = +1.
	const hKey = (i: number, j: number) => 2 * (j * gw + i);
	const vKey = (i: number, j: number) => 2 * (j * gw + i) + 1;
	const point = new Map<number, P>();
	const next = new Map<number, number>();
	const cross = (k: number, x0: number, y0: number, a: number, x1: number, y1: number, b: number) => {
		if (!point.has(k)) {
			const f = (t - a) / (b - a);
			// Grid sample (i, j) is pixel (i−1, j−1)'s centre.
			point.set(k, { x: x0 + (x1 - x0) * f - 0.5, y: y0 + (y1 - y0) * f - 0.5 });
		}
		return k;
	};
	for (let j = 0; j < gh - 1; j++) {
		for (let i = 0; i < gw - 1; i++) {
			const a = v(i, j);
			const b = v(i + 1, j);
			const c = v(i + 1, j + 1);
			const d = v(i, j + 1);
			const ia = a >= t;
			const ib = b >= t;
			const ic = c >= t;
			const id = d >= t;
			if (ia === ib && ib === ic && ic === id) continue;
			// Walk the cell clockwise on screen (a→b→c→d) collecting
			// crossings: "enter" goes outside→inside, "leave" the reverse.
			const xs: { k: number; enter: boolean }[] = [];
			if (ia !== ib) xs.push({ k: cross(hKey(i, j), i, j, a, i + 1, j, b), enter: ib });
			if (ib !== ic) xs.push({ k: cross(vKey(i + 1, j), i + 1, j, b, i + 1, j + 1, c), enter: ic });
			if (ic !== id) xs.push({ k: cross(hKey(i, j + 1), i + 1, j + 1, c, i, j + 1, d), enter: id });
			if (id !== ia) xs.push({ k: cross(vKey(i, j), i, j + 1, d, i, j, a), enter: ia });
			// A segment runs from a "leave" to an "enter", inside on its
			// right. Joined to the previous enter it cuts off an inside
			// corner; to the next, an outside corner. Two crossings make
			// both the same; at a saddle the centre value decides.
			const centreInside = (a + b + c + d) / 4 >= t;
			const n = xs.length;
			for (let m = 0; m < n; m++) {
				if (xs[m]!.enter) continue;
				const to = n === 4 && centreInside ? xs[(m + 1) % n]! : xs[(m + n - 1) % n]!;
				next.set(xs[m]!.k, to.k);
			}
		}
	}
	const loops: P[][] = [];
	const seen = new Set<number>();
	for (const start of next.keys()) {
		if (seen.has(start)) continue;
		const loop: P[] = [];
		let k: number | undefined = start;
		while (k !== undefined && !seen.has(k)) {
			seen.add(k);
			loop.push(point.get(k)!);
			k = next.get(k);
		}
		if (k === start) loops.push(loop);
	}
	return loops;
}

function dedupe(pts: P[]): P[] {
	const out: P[] = [];
	for (const p of pts) {
		const q = out[out.length - 1];
		if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.01) out.push(p);
	}
	while (out.length > 1 && Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) <= 0.01) {
		out.pop();
	}
	return out;
}

// ----- smooth mode: corners and curve fitting -----

/** A closed polyline with cumulative arc lengths, for "the point d px away" lookups. */
class Ring {
	readonly n: number;
	readonly s: Float64Array;
	readonly length: number;
	constructor(readonly pts: P[]) {
		this.n = pts.length;
		this.s = new Float64Array(this.n + 1);
		for (let i = 0; i < this.n; i++) {
			const p = pts[i]!;
			const q = pts[(i + 1) % this.n]!;
			this.s[i + 1] = this.s[i]! + Math.hypot(q.x - p.x, q.y - p.y);
		}
		this.length = this.s[this.n]!;
	}
	/** The point at arc length `d` from point `i` (negative = backwards). */
	at(i: number, d: number): P {
		const L = this.length;
		let target = (((this.s[i]! + d) % L) + L) % L;
		let lo = 0;
		let hi = this.n;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (this.s[mid]! <= target) lo = mid;
			else hi = mid;
		}
		const p = this.pts[lo]!;
		const q = this.pts[(lo + 1) % this.n]!;
		const seg = this.s[lo + 1]! - this.s[lo]!;
		const f = seg > 0 ? (target - this.s[lo]!) / seg : 0;
		return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
	}
	/** Turning angle at point `i`, measured with chords `d` px long. */
	turn(i: number, d: number): number {
		const p = this.pts[i]!;
		const a = this.at(i, -d);
		const b = this.at(i, d);
		const ux = p.x - a.x;
		const uy = p.y - a.y;
		const vx = b.x - p.x;
		const vy = b.y - p.y;
		return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
	}
	dist(i: number, j: number): number {
		const d = Math.abs(this.s[i]! - this.s[j]!);
		return Math.min(d, this.length - d);
	}
}

const CORNER_ANGLE = (35 * Math.PI) / 180;
const SHORT = 1.5;
const LONG = 3;

function findCorners(ring: Ring): number[] {
	const { n } = ring;
	if (ring.length < 4 * SHORT) return [];
	const short = new Float64Array(n);
	const candidates: number[] = [];
	for (let i = 0; i < n; i++) {
		short[i] = ring.turn(i, SHORT);
		// A corner turns as much over a short chord as a long one; a
		// curve turns in proportion to the chord length.
		if (short[i]! > CORNER_ANGLE && short[i]! > 0.7 * ring.turn(i, LONG)) candidates.push(i);
	}
	// Keep the sharpest point of each cluster.
	const corners: number[] = [];
	for (const i of candidates) {
		const beaten = candidates.some(
			(j) => j !== i && ring.dist(i, j) < SHORT && (short[j]! > short[i]! || (short[j]! === short[i]! && j < i)),
		);
		if (!beaten) corners.push(i);
	}
	return corners;
}

/** Snap a corner to where its two sides, extended, meet. */
function sharpen(ring: Ring, i: number): P {
	const p = ring.pts[i]!;
	const a0 = ring.at(i, -LONG);
	const a1 = ring.at(i, -1);
	const b0 = ring.at(i, 1);
	const b1 = ring.at(i, LONG);
	const hit = intersect(a0, a1, b0, b1);
	if (hit && Math.hypot(hit.x - p.x, hit.y - p.y) < 1.5) return hit;
	return p;
}

function intersect(a0: P, a1: P, b0: P, b1: P): P | null {
	const dx1 = a1.x - a0.x;
	const dy1 = a1.y - a0.y;
	const dx2 = b1.x - b0.x;
	const dy2 = b1.y - b0.y;
	const den = dx1 * dy2 - dy1 * dx2;
	if (Math.abs(den) < 1e-9 * (Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) || 1)) return null;
	const t = ((b0.x - a0.x) * dy2 - (b0.y - a0.y) * dx2) / den;
	return { x: a0.x + dx1 * t, y: a0.y + dy1 * t };
}

/** A fitted piece: a line to `end`, or a quadratic through `ctrl` to `end`. */
interface Piece {
	ctrl: P | null;
	end: P;
}

function fitContour(pts: P[], tol: number): TraceContour {
	const ring = new Ring(pts);
	const corners = findCorners(ring);
	const out: TraceContour = [];
	if (!corners.length) {
		// A closed smooth loop: fit it as two halves (a single run would
		// start and end on the same point), smoothing the seam too.
		let far = 1;
		for (let i = 1; i < pts.length; i++) {
			if (Math.hypot(pts[i]!.x - pts[0]!.x, pts[i]!.y - pts[0]!.y) > Math.hypot(pts[far]!.x - pts[0]!.x, pts[far]!.y - pts[0]!.y)) far = i;
		}
		const pieces = [...fitRun(pts.slice(0, far + 1), tol), ...fitRun([...pts.slice(far), pts[0]!], tol)];
		smoothJoins(pieces, tol, true);
		out.push({ ...pieces[pieces.length - 1]!.end, on: true });
		emitPieces(out, pieces);
		return out;
	}
	const sharp = new Map(corners.map((i) => [i, sharpen(ring, i)]));
	for (let c = 0; c < corners.length; c++) {
		const from = corners[c]!;
		const to = corners[(c + 1) % corners.length]!;
		const run: P[] = [sharp.get(from)!];
		for (let i = (from + 1) % pts.length; i !== to; i = (i + 1) % pts.length) run.push(pts[i]!);
		run.push(sharp.get(to)!);
		const pieces = fitRun(run, tol);
		smoothJoins(pieces, tol, false);
		out.push({ ...run[0]!, on: true });
		emitPieces(out, pieces);
	}
	return out;
}

/** Push each piece's control point and every end but the last (the next run's start). */
function emitPieces(out: TraceContour, pieces: Piece[]): void {
	for (let k = 0; k < pieces.length; k++) {
		const piece = pieces[k]!;
		if (piece.ctrl) out.push({ ...piece.ctrl, on: false });
		if (k < pieces.length - 1) out.push({ ...piece.end, on: true });
	}
}

/**
 * Remove the kinks where two fitted curves meet: move the join onto
 * the line through their control points. A join that would move more
 * than `tol` is a real bend and stays. On a closed loop the seam (the
 * last piece's end) is smoothed too.
 */
function smoothJoins(pieces: Piece[], tol: number, closed: boolean): void {
	const n = pieces.length;
	for (let k = 0; k < (closed ? n : n - 1); k++) {
		const a = pieces[k]!;
		const b = pieces[(k + 1) % n]!;
		if (!a.ctrl || !b.ctrl || a === b) continue;
		const j = a.end;
		const dx = b.ctrl.x - a.ctrl.x;
		const dy = b.ctrl.y - a.ctrl.y;
		const len2 = dx * dx + dy * dy;
		if (!len2) continue;
		const t = ((j.x - a.ctrl.x) * dx + (j.y - a.ctrl.y) * dy) / len2;
		if (t < 0.05 || t > 0.95) continue;
		const moved = { x: a.ctrl.x + dx * t, y: a.ctrl.y + dy * t };
		if (Math.hypot(moved.x - j.x, moved.y - j.y) <= tol) a.end = moved;
	}
}

/** Fit an open run of points (ends fixed) with lines and quadratics. */
function fitRun(run: P[], tol: number): Piece[] {
	const a = run[0]!;
	const b = run[run.length - 1]!;
	if (run.length <= 2) return [{ ctrl: null, end: b }];
	// Straight within tolerance: one line.
	let maxLine = 0;
	for (let i = 1; i < run.length - 1; i++) maxLine = Math.max(maxLine, distToSegment(run[i]!, a, b));
	if (maxLine <= tol) return [{ ctrl: null, end: b }];

	const fit = fitQuad(run);
	if (fit.error <= tol) return [{ ctrl: fit.ctrl, end: b }];
	if (run.length <= 4) {
		// Too few points to split well: a polyline is exact.
		return run.slice(1).map((p) => ({ ctrl: null, end: p }));
	}
	const split = Math.min(run.length - 3, Math.max(2, fit.worst));
	return [...fitRun(run.slice(0, split + 1), tol), ...fitRun(run.slice(split), tol)];
}

/** Least-squares quadratic through the run, with its ends fixed. */
function fitQuad(run: P[]): { ctrl: P; error: number; worst: number } {
	const n = run.length;
	const a = run[0]!;
	const b = run[n - 1]!;
	const t = new Float64Array(n);
	for (let i = 1; i < n; i++) t[i] = t[i - 1]! + Math.hypot(run[i]!.x - run[i - 1]!.x, run[i]!.y - run[i - 1]!.y);
	const total = t[n - 1]! || 1;
	for (let i = 0; i < n; i++) t[i] = t[i]! / total;

	let ctrl: P = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	for (let iter = 0; iter < 4; iter++) {
		// Least-squares control point with the ends fixed:
		// B(t) = (1−t)²A + 2t(1−t)C + t²B.
		let sx = 0;
		let sy = 0;
		let sw = 0;
		for (let i = 1; i < n - 1; i++) {
			const ti = t[i]!;
			const w = 2 * ti * (1 - ti);
			const u = (1 - ti) * (1 - ti);
			const v = ti * ti;
			sx += w * (run[i]!.x - u * a.x - v * b.x);
			sy += w * (run[i]!.y - u * a.y - v * b.y);
			sw += w * w;
		}
		if (sw > 0) ctrl = { x: sx / sw, y: sy / sw };
		// Newton step on each parameter toward its point's nearest curve point.
		for (let i = 1; i < n - 1; i++) {
			const ti = t[i]!;
			const px = quad(a.x, ctrl.x, b.x, ti) - run[i]!.x;
			const py = quad(a.y, ctrl.y, b.y, ti) - run[i]!.y;
			const d1x = 2 * ((1 - ti) * (ctrl.x - a.x) + ti * (b.x - ctrl.x));
			const d1y = 2 * ((1 - ti) * (ctrl.y - a.y) + ti * (b.y - ctrl.y));
			const d2x = 2 * (a.x - 2 * ctrl.x + b.x);
			const d2y = 2 * (a.y - 2 * ctrl.y + b.y);
			const den = d1x * d1x + d1y * d1y + px * d2x + py * d2y;
			if (den > 1e-12) t[i] = Math.min(1, Math.max(0, ti - (px * d1x + py * d1y) / den));
		}
	}
	let error = 0;
	let worst = n >> 1;
	for (let i = 1; i < n - 1; i++) {
		const e = Math.hypot(quad(a.x, ctrl.x, b.x, t[i]!) - run[i]!.x, quad(a.y, ctrl.y, b.y, t[i]!) - run[i]!.y);
		if (e > error) {
			error = e;
			worst = i;
		}
	}
	// A control point far outside the run means a bad fit even if the
	// sampled points happen to lie close to the curve.
	const chord = Math.hypot(b.x - a.x, b.y - a.y);
	if (distToSegment(ctrl, a, b) > Math.max(2, chord * 2)) error = Infinity;
	return { ctrl, error, worst };
}

const quad = (a: number, c: number, b: number, t: number) => (1 - t) * (1 - t) * a + 2 * t * (1 - t) * c + t * t * b;

function distToSegment(p: P, a: P, b: P): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
	return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}
