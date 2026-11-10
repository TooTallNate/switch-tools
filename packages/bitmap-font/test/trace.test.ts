import { describe, expect, it } from 'vitest';
import { area, traceCoverage, type TraceContour } from '../src/index.js';
import { disc, rasterize, rect } from './helpers.js';

/** Sample a contour (with implied on-curve points) into a polyline. */
function sample(c: TraceContour, steps = 8): { x: number; y: number }[] {
	const n = c.length;
	const start = c.findIndex((p) => p.on);
	const pts = [...c.slice(start), ...c.slice(0, start)];
	const out: { x: number; y: number }[] = [];
	for (let i = 0; i < n; ) {
		const p = pts[i]!;
		const q = pts[(i + 1) % n]!;
		if (q.on) {
			out.push(p);
			i++;
			continue;
		}
		const r = pts[(i + 2) % n]!;
		const end = r.on ? r : { x: (q.x + r.x) / 2, y: (q.y + r.y) / 2, on: true };
		for (let s = 0; s < steps; s++) {
			const t = s / steps;
			out.push({
				x: (1 - t) ** 2 * p.x + 2 * t * (1 - t) * q.x + t * t * end.x,
				y: (1 - t) ** 2 * p.y + 2 * t * (1 - t) * q.y + t * t * end.y,
			});
		}
		if (r.on) i += 2;
		else {
			pts[(i + 1) % n] = { ...end };
			i++;
		}
	}
	return out;
}

describe('traceCoverage (smooth)', () => {
	it('traces an anti-aliased disc as a few curves close to the circle', () => {
		const cov = rasterize(40, 40, disc(20, 20, 15));
		const contours = traceCoverage(cov, 40, 40);
		expect(contours).toHaveLength(1);
		const c = contours[0]!;
		expect(area(c)).toBeGreaterThan(0);
		// A circle needs only a handful of quadratics, and no corners.
		expect(c.length).toBeLessThan(40);
		expect(c.filter((p) => !p.on).length).toBeGreaterThan(4);
		for (const p of sample(c)) {
			expect(Math.abs(Math.hypot(p.x - 20, p.y - 20) - 15)).toBeLessThan(0.35);
		}
	});

	it('keeps the corners of a square sharp', () => {
		const cov = rasterize(30, 30, rect(5.3, 4.7, 24.6, 25.2));
		const [c] = traceCoverage(cov, 30, 30);
		expect(c).toBeDefined();
		expect(c!.every((p) => p.on)).toBe(true);
		expect(c).toHaveLength(4);
		const xs = c!.map((p) => p.x).sort((a, b) => a - b);
		const ys = c!.map((p) => p.y).sort((a, b) => a - b);
		expect(xs[0]).toBeCloseTo(5.3, 0);
		expect(xs[3]).toBeCloseTo(24.6, 0);
		expect(ys[0]).toBeCloseTo(4.7, 0);
		expect(ys[3]).toBeCloseTo(25.2, 0);
		expect(area(c!)).toBeGreaterThan(0);
	});

	it('gives holes the opposite winding', () => {
		const cov = rasterize(40, 40, (x, y) => disc(20, 20, 16)(x, y) && !disc(20, 20, 8)(x, y));
		const contours = traceCoverage(cov, 40, 40);
		expect(contours).toHaveLength(2);
		const areas = contours.map((c) => area(sample(c, 16))).sort((a, b) => a - b);
		expect(areas[0]).toBeLessThan(0);
		expect(areas[1]).toBeGreaterThan(0);
		expect(areas[1]! + areas[0]!).toBeCloseTo(Math.PI * (16 ** 2 - 8 ** 2), -1);
	});

	it('drops specks smaller than minArea', () => {
		const cov = new Uint8Array(100);
		cov[55] = 200;
		expect(traceCoverage(cov, 10, 10)).toHaveLength(0);
	});
});

describe('traceCoverage (pixel)', () => {
	it('traces pixel edges and merges straight runs', () => {
		// An "L": 3 px tall stem, 3 px wide foot.
		const cov = new Uint8Array(16);
		for (const [x, y] of [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]]) cov[y! * 4 + x!] = 255;
		const contours = traceCoverage(cov, 4, 4, { mode: 'pixel' });
		expect(contours).toHaveLength(1);
		expect(contours[0]).toHaveLength(6);
		expect(area(contours[0]!)).toBe(5);
	});

	it('keeps diagonally touching pixels as separate squares', () => {
		const cov = new Uint8Array([255, 0, 0, 255]);
		const contours = traceCoverage(cov, 2, 2, { mode: 'pixel' });
		expect(contours).toHaveLength(2);
		for (const c of contours) {
			expect(c).toHaveLength(4);
			expect(area(c)).toBe(1);
		}
	});

	it('traces a hole', () => {
		const cov = new Uint8Array(9).fill(255);
		cov[4] = 0;
		const areas = traceCoverage(cov, 3, 3, { mode: 'pixel' }).map(area).sort((a, b) => a - b);
		expect(areas).toEqual([-1, 9]);
	});
});
