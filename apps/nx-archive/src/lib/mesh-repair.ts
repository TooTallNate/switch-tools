/**
 * Make game meshes printable: every connected part becomes a closed,
 * consistently wound, outward-facing surface.
 *
 * Game assets are built to *render*, not to enclose volume:
 *
 *   - Double-sided surfaces are often authored as two copies of every
 *     face with opposite winding (e.g. Echoes of Wisdom's Deku Tree
 *     canopies), so after welding each edge has four faces and the
 *     "solid" encloses nothing.
 *   - Surfaces nobody looks at are simply missing (canopy undersides,
 *     the bottom of a trunk, eye sockets).
 *   - Cards, fins and leaves are single open sheets.
 *
 * OrcaSlicer flags a mesh as needing repair when any directed edge
 * (a → b) lacks a neighbouring face with the opposite edge (b → a)
 * (`its_face_neighbors` / `its_num_open_edges`: holes, edges shared by
 * more than two faces, and inconsistent winding all count), and its
 * built-in fixer is Windows-only. Overlapping or intersecting closed
 * parts are fine — slicers union them per layer — so no boolean union
 * is needed. Pipeline:
 *
 *   1. Drop degenerate faces and duplicate faces (same vertex set,
 *      either winding).
 *   2. Cut the mesh into edge-manifold *patches*: faces join across
 *      edges with exactly two faces; edges with more become borders,
 *      and their vertices are split per patch.
 *   3. Orient each patch consistently (BFS across shared edges).
 *   4. Close each patch:
 *      - shells (e.g. a canopy dome): cap each boundary loop,
 *        ear-clipped on its best-fit plane (fan fallback);
 *      - sheets (capping would enclose ~no volume, e.g. a leaf card):
 *        thicken by `minThickness`, Blender-Solidify style.
 *   5. Flip any patch whose signed volume is negative.
 *
 * Provenance: the input may carry, per triangle, a source triangle and
 * the barycentric position of its corners in it (see
 * `mesh-export-3mf.ts`). Kept and copied faces keep theirs; new cap /
 * side faces get the source of the boundary edge they close, with all
 * three corners collapsed onto that edge's midpoint, so they take the
 * surface colour where they attach.
 */

import type { IndexedMesh } from './mesh-export';

export interface RepairInput extends IndexedMesh {
	/** Per triangle: source triangle id (provenance). Optional. */
	src?: Uint32Array;
	/** Per triangle: 3 corners × 3 barycentric weights in `src`. Optional. */
	bary?: Float32Array;
}

export interface RepairResult extends IndexedMesh {
	src: Uint32Array;
	bary: Float32Array;
	report: RepairReport;
}

export interface RepairReport {
	/** Open edges (Orca's count) before / after. */
	openEdgesBefore: number;
	openEdgesAfter: number;
	degenerateRemoved: number;
	duplicatesRemoved: number;
	/** Edges with > 2 faces that were cut apart. */
	nonManifoldEdgesCut: number;
	/** Closed parts in the output. */
	parts: number;
	/** Boundary loops capped. */
	holesFilled: number;
	/** Open sheets thickened into solids. */
	sheetsThickened: number;
	/** Closed zero-thickness parts (two-layer sheets) reduced to one layer and thickened. */
	zeroThicknessSplit: number;
	/** Parts flipped to face outward. */
	partsFlipped: number;
	/** Per-part breakdown (diagnostics). */
	partDetails: PartDetail[];
}

export interface PartDetail {
	faces: number;
	loops: number;
	action: 'closed' | 'capped' | 'thickened';
	/** Enclosed volume after repair and surface area of the original part. */
	volume: number;
	area: number;
}

export interface RepairOptions {
	/**
	 * Wall thickness for thickened sheets, in model units. Also the
	 * threshold for "sheet": an open part is thickened rather than
	 * capped when capping would give it an average thickness below this.
	 */
	minThickness: number;
}

/** Totals across several repaired meshes (for UI summaries). */
export interface RepairSummary {
	openEdgesBefore: number;
	openEdgesAfter: number;
	holesFilled: number;
	sheetsThickened: number;
	duplicatesRemoved: number;
	nonManifoldEdgesCut: number;
	partsFlipped: number;
}

export function summarizeRepairs(reports: readonly RepairReport[]): RepairSummary {
	const s: RepairSummary = {
		openEdgesBefore: 0,
		openEdgesAfter: 0,
		holesFilled: 0,
		sheetsThickened: 0,
		duplicatesRemoved: 0,
		nonManifoldEdgesCut: 0,
		partsFlipped: 0,
	};
	for (const r of reports) {
		s.openEdgesBefore += r.openEdgesBefore;
		s.openEdgesAfter += r.openEdgesAfter;
		s.holesFilled += r.holesFilled;
		s.sheetsThickened += r.sheetsThickened + r.zeroThicknessSplit;
		s.duplicatesRemoved += r.duplicatesRemoved;
		s.nonManifoldEdgesCut += r.nonManifoldEdgesCut;
		s.partsFlipped += r.partsFlipped;
	}
	return s;
}

/** True when the summary records any change worth telling the user about. */
export function repairChangedAnything(s: RepairSummary): boolean {
	return s.holesFilled + s.sheetsThickened + s.duplicatesRemoved + s.nonManifoldEdgesCut > 0;
}

/**
 * Default wall thickness for thickened sheets: 1 % of the combined
 * bounding-box diagonal (≈ 1.2 mm when a model is printed ~120 mm
 * across). Model units are arbitrary game units and the user picks the
 * print scale in the slicer, so a relative thickness is the only
 * sensible default.
 */
export function defaultMinThickness(meshes: readonly IndexedMesh[]): number {
	let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
	for (const m of meshes) {
		const p = m.positions;
		for (let i = 0; i < m.indices.length; i++) {
			const o = m.indices[i]! * 3;
			const x = p[o]!, y = p[o + 1]!, z = p[o + 2]!;
			if (!Number.isFinite(x + y + z)) continue;
			if (x < mnx) mnx = x; if (x > mxx) mxx = x;
			if (y < mny) mny = y; if (y > mxy) mxy = y;
			if (z < mnz) mnz = z; if (z > mxz) mxz = z;
		}
	}
	const d = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
	return Number.isFinite(d) && d > 0 ? d * 0.01 : 1;
}

/**
 * Orca-equivalent open-edge count: directed edges with no opposite
 * directed edge among the faces.
 */
export function countOpenEdges(mesh: IndexedMesh): number {
	const idx = mesh.indices;
	const n = mesh.positions.length / 3;
	const dir = new Map<number, number>();
	const key = (a: number, b: number) => a * n + b;
	for (let i = 0; i < idx.length; i += 3) {
		for (let k = 0; k < 3; k++) {
			const a = idx[i + k]!, b = idx[i + ((k + 1) % 3)]!;
			const kk = key(a, b);
			dir.set(kk, (dir.get(kk) ?? 0) + 1);
		}
	}
	let open = 0;
	for (let i = 0; i < idx.length; i += 3) {
		for (let k = 0; k < 3; k++) {
			const a = idx[i + k]!, b = idx[i + ((k + 1) % 3)]!;
			if (!dir.has(key(b, a))) open++;
		}
	}
	return open;
}

/** Repair a welded triangle mesh for printing. See the file header. */
export function repairForPrinting(input: RepairInput, options: RepairOptions): RepairResult {
	const P = input.positions;
	const inIdx = input.indices;
	const nIn = inIdx.length / 3;
	const nVertIn = P.length / 3;
	const openEdgesBefore = countOpenEdges(input);

	const srcIn = input.src ?? Uint32Array.from({ length: nIn }, (_, i) => i);
	let baryIn = input.bary;
	if (!baryIn) {
		baryIn = new Float32Array(nIn * 9);
		for (let t = 0; t < nIn; t++) {
			baryIn[t * 9] = 1;
			baryIn[t * 9 + 4] = 1;
			baryIn[t * 9 + 8] = 1;
		}
	}

	// Working face list (mutable copies).
	const faces: number[] = [];
	const fSrc: number[] = [];
	const fBary: number[] = [];

	// --- 1. Degenerate + duplicate faces. ---------------------------------
	let diag2 = 0;
	{
		let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
		for (let v = 0; v < nVertIn; v++) {
			const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
			if (x < mnx) mnx = x; if (x > mxx) mxx = x;
			if (y < mny) mny = y; if (y > mxy) mxy = y;
			if (z < mnz) mnz = z; if (z > mxz) mxz = z;
		}
		diag2 = (mxx - mnx) ** 2 + (mxy - mny) ** 2 + (mxz - mnz) ** 2;
	}
	const areaEps = diag2 * 1e-14;
	let degenerateRemoved = 0;
	let duplicatesRemoved = 0;
	const seenFaces = new Set<string>();
	for (let t = 0; t < nIn; t++) {
		const a = inIdx[t * 3]!, b = inIdx[t * 3 + 1]!, c = inIdx[t * 3 + 2]!;
		if (a === b || b === c || a === c || !(faceArea2(P, a, b, c) > areaEps)) {
			degenerateRemoved++;
			continue;
		}
		const s = [a, b, c].sort((x, y) => x - y).join(',');
		if (seenFaces.has(s)) {
			duplicatesRemoved++;
			continue;
		}
		seenFaces.add(s);
		faces.push(a, b, c);
		fSrc.push(srcIn[t]!);
		for (let i = 0; i < 9; i++) fBary.push(baryIn[t * 9 + i]!);
	}
	let nF = faces.length / 3;

	// --- 2. Edge-manifold patches. ------------------------------------------
	const ekey = (a: number, b: number) => (a < b ? a * nVertIn + b : b * nVertIn + a);
	const edgeFaces = new Map<number, number[]>();
	for (let f = 0; f < nF; f++) {
		for (let k = 0; k < 3; k++) {
			const kk = ekey(faces[f * 3 + k]!, faces[f * 3 + ((k + 1) % 3)]!);
			const list = edgeFaces.get(kk);
			if (list) list.push(f);
			else edgeFaces.set(kk, [f]);
		}
	}
	const parent = new Int32Array(nF).map((_, i) => i);
	const find = (x: number): number => {
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]!]!;
			x = parent[x]!;
		}
		return x;
	};
	let nonManifoldEdgesCut = 0;
	for (const list of edgeFaces.values()) {
		if (list.length === 2) {
			const ra = find(list[0]!), rb = find(list[1]!);
			if (ra !== rb) parent[rb] = ra;
		} else if (list.length > 2) {
			nonManifoldEdgesCut++;
		}
	}
	const patchOf = new Int32Array(nF);
	const patchIds = new Map<number, number>();
	for (let f = 0; f < nF; f++) {
		const r = find(f);
		let id = patchIds.get(r);
		if (id === undefined) {
			id = patchIds.size;
			patchIds.set(r, id);
		}
		patchOf[f] = id;
	}
	const nPatches = patchIds.size;

	// Split vertices per patch so patches no longer share edges/vertices.
	const positions: number[] = Array.from(P);
	const vertPatch = new Int32Array(nVertIn).fill(-1);
	const vertCopy = new Map<number, number>(); // (v * nPatches + patch) -> new index
	const faceV = new Uint32Array(faces.length);
	for (let f = 0; f < nF; f++) {
		const p = patchOf[f]!;
		for (let k = 0; k < 3; k++) {
			const v = faces[f * 3 + k]!;
			let out = v;
			if (vertPatch[v] === -1) vertPatch[v] = p;
			else if (vertPatch[v] !== p) {
				const ck = v * nPatches + p;
				let c = vertCopy.get(ck);
				if (c === undefined) {
					c = positions.length / 3;
					positions.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
					vertCopy.set(ck, c);
				}
				out = c;
			}
			faceV[f * 3 + k] = out;
		}
	}

	// Faces per patch.
	const patchFaces: number[][] = Array.from({ length: nPatches }, () => []);
	for (let f = 0; f < nF; f++) patchFaces[patchOf[f]!]!.push(f);

	const flipFace = (f: number) => {
		const t = faceV[f * 3 + 1]!;
		faceV[f * 3 + 1] = faceV[f * 3 + 2]!;
		faceV[f * 3 + 2] = t;
		// Keep the original-id copy in the same corner order: edge k must
		// mean the same edge in both arrays for the BFS below.
		const t1 = faces[f * 3 + 1]!;
		faces[f * 3 + 1] = faces[f * 3 + 2]!;
		faces[f * 3 + 2] = t1;
		for (let i = 0; i < 3; i++) {
			const t2 = fBary[f * 9 + 3 + i]!;
			fBary[f * 9 + 3 + i] = fBary[f * 9 + 6 + i]!;
			fBary[f * 9 + 6 + i] = t2;
		}
	};

	// --- 3. Consistent orientation within each patch. -----------------------
	const visited = new Uint8Array(nF);
	const hasDirected = (f: number, a: number, b: number) => {
		for (let k = 0; k < 3; k++) {
			if (faceV[f * 3 + k] === a && faceV[f * 3 + ((k + 1) % 3)] === b) return true;
		}
		return false;
	};
	for (const pf of patchFaces) {
		if (pf.length === 0) continue;
		const queue = [pf[0]!];
		visited[pf[0]!] = 1;
		for (let qi = 0; qi < queue.length; qi++) {
			const f = queue[qi]!;
			for (let k = 0; k < 3; k++) {
				const a = faces[f * 3 + k]!, b = faces[f * 3 + ((k + 1) % 3)]!;
				const list = edgeFaces.get(ekey(a, b))!;
				if (list.length !== 2) continue;
				const g = list[0] === f ? list[1]! : list[0]!;
				if (visited[g]) continue;
				visited[g] = 1;
				// Neighbour must traverse the shared edge the other way.
				const fa = faceV[f * 3 + k]!, fb = faceV[f * 3 + ((k + 1) % 3)]!;
				if (hasDirected(g, fa, fb)) flipFace(g);
				queue.push(g);
			}
		}
	}

	// --- 4/5. Close + orient each patch. --------------------------------------
	const outIdx: number[] = [];
	const outSrc: number[] = [];
	const outBary: number[] = [];
	const pushFace = (a: number, b: number, c: number, src: number, bary: ArrayLike<number>) => {
		outIdx.push(a, b, c);
		outSrc.push(src);
		for (let i = 0; i < 9; i++) outBary.push(bary[i]!);
	};

	let holesFilled = 0;
	let sheetsThickened = 0;
	let partsFlipped = 0;
	const partDetails: PartDetail[] = [];
	const h = options.minThickness;

	const dk = (a: number, b: number) => a * 4294967296 + b;
	interface BEdge { a: number; b: number; f: number; k: number }
	const boundaryOf = (pf: number[]) => {
		const dirSet = new Set<number>();
		for (const f of pf) {
			for (let k = 0; k < 3; k++) dirSet.add(dk(faceV[f * 3 + k]!, faceV[f * 3 + ((k + 1) % 3)]!));
		}
		const boundary: BEdge[] = [];
		for (const f of pf) {
			for (let k = 0; k < 3; k++) {
				const a = faceV[f * 3 + k]!, b = faceV[f * 3 + ((k + 1) % 3)]!;
				if (!dirSet.has(dk(b, a))) boundary.push({ a, b, f, k });
			}
		}
		return boundary;
	};
	let zeroThicknessSplit = 0;

	for (let pf of patchFaces) {
		if (pf.length === 0) continue;
		const start = outIdx.length / 3;
		const nV = () => positions.length / 3;

		// Boundary half-edges (a → b with no b → a in the patch).
		let boundary = boundaryOf(pf);

		// A closed part enclosing ~no volume is a two-layer sheet whose
		// sides are triangulated differently (so not caught as duplicate
		// faces) — e.g. a double-sided leaf card. Split it along its
		// fold edges (adjacent normals ~opposite), keep the larger layer
		// and treat that as an open sheet to thicken below.
		if (boundary.length === 0) {
			const a0 = patchAreaFaces(positions, faceV, pf);
			const v0 = signedVolumeFaces(positions, faceV, pf);
			if (Math.abs(v0) < a0 * h * 0.05) {
				const layer = largestLayer(pf, faceV, positions);
				if (layer.length < pf.length) {
					pf = layer;
					boundary = boundaryOf(pf);
					zeroThicknessSplit++;
				}
			}
		}

		for (const f of pf) {
			pushFace(faceV[f * 3]!, faceV[f * 3 + 1]!, faceV[f * 3 + 2]!, fSrc[f]!, fBary.slice(f * 9, f * 9 + 9));
		}

		let action: PartDetail['action'] = 'closed';
		let nLoops = 0;
		const origArea = patchArea(positions, outIdx, start, start + pf.length);
		if (boundary.length > 0) {
			const loops = buildLoops(boundary);
			nLoops = loops.length;
			const edgeColor = (e: BEdge) => {
				// Collapse all three corners onto the boundary edge midpoint.
				const o = e.f * 9;
				const k2 = (e.k + 1) % 3;
				const w = [0, 1, 2].map((i) => (fBary[o + e.k * 3 + i]! + fBary[o + k2 * 3 + i]!) / 2);
				return { src: fSrc[e.f]!, bary: [...w, ...w, ...w] };
			};

			// Tentative caps.
			const capStartIdx = outIdx.length;
			const capStartVert = nV();
			for (const loop of loops) {
				capLoop(loop, positions, (a, b, c, e) => {
					const col = edgeColor(e);
					pushFace(a, b, c, col.src, col.bary);
				});
			}
			const area = patchArea(positions, outIdx, start, capStartIdx / 3);
			const vol = signedVolume(positions, outIdx, start, outIdx.length / 3);
			if (Math.abs(vol) < area * h * 0.5) {
				// Sheet: discard caps, thicken instead.
				outIdx.length = capStartIdx;
				outSrc.length = capStartIdx / 3;
				outBary.length = capStartIdx * 3;
				positions.length = capStartVert * 3;
				solidify(pf, boundary, positions, faceV, h, (a, b, c, from, swap) => {
					if (typeof from === 'number') {
						// Back copy of a face.
						const bb = fBary.slice(from * 9, from * 9 + 9);
						if (swap) for (let i = 0; i < 3; i++) [bb[3 + i], bb[6 + i]] = [bb[6 + i]!, bb[3 + i]!];
						pushFace(a, b, c, fSrc[from]!, bb);
					} else {
						const col = edgeColor(from as BEdge);
						pushFace(a, b, c, col.src, col.bary);
					}
				});
				sheetsThickened++;
				action = 'thickened';
			} else {
				holesFilled += loops.length;
				action = 'capped';
			}
		}

		// Face outward.
		const end = outIdx.length / 3;
		const vol = signedVolume(positions, outIdx, start, end);
		partDetails.push({ faces: pf.length, loops: nLoops, action, volume: Math.abs(vol), area: origArea });
		if (vol < 0) {
			partsFlipped++;
			for (let t = start; t < end; t++) {
				const tmp = outIdx[t * 3 + 1]!;
				outIdx[t * 3 + 1] = outIdx[t * 3 + 2]!;
				outIdx[t * 3 + 2] = tmp;
				for (let i = 0; i < 3; i++) {
					const tb = outBary[t * 9 + 3 + i]!;
					outBary[t * 9 + 3 + i] = outBary[t * 9 + 6 + i]!;
					outBary[t * 9 + 6 + i] = tb;
				}
			}
		}
	}

	const result: RepairResult = {
		positions: new Float32Array(positions),
		indices: new Uint32Array(outIdx),
		src: new Uint32Array(outSrc),
		bary: new Float32Array(outBary),
		report: {
			openEdgesBefore,
			openEdgesAfter: 0,
			degenerateRemoved,
			duplicatesRemoved,
			nonManifoldEdgesCut,
			parts: nPatches,
			holesFilled,
			sheetsThickened,
			zeroThicknessSplit,
			partsFlipped,
			partDetails,
		},
	};
	result.report.openEdgesAfter = countOpenEdges(result);
	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function faceArea2(P: ArrayLike<number>, a: number, b: number, c: number): number {
	const e1x = P[b * 3]! - P[a * 3]!, e1y = P[b * 3 + 1]! - P[a * 3 + 1]!, e1z = P[b * 3 + 2]! - P[a * 3 + 2]!;
	const e2x = P[c * 3]! - P[a * 3]!, e2y = P[c * 3 + 1]! - P[a * 3 + 1]!, e2z = P[c * 3 + 2]! - P[a * 3 + 2]!;
	const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
	return nx * nx + ny * ny + nz * nz;
}

function patchAreaFaces(P: ArrayLike<number>, fv: Uint32Array, faces: number[]): number {
	let a = 0;
	for (const f of faces) a += Math.sqrt(faceArea2(P, fv[f * 3]!, fv[f * 3 + 1]!, fv[f * 3 + 2]!)) / 2;
	return a;
}

function signedVolumeFaces(P: ArrayLike<number>, fv: Uint32Array, faces: number[]): number {
	let v = 0;
	for (const f of faces) {
		const a = fv[f * 3]! * 3, b = fv[f * 3 + 1]! * 3, c = fv[f * 3 + 2]! * 3;
		v +=
			P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) -
			P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) +
			P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!);
	}
	return v / 6;
}

/**
 * Split a closed zero-thickness surface at fold edges (where the two
 * adjacent faces' normals point nearly opposite ways) and return the
 * largest-area connected layer.
 */
function largestLayer(faces: number[], fv: Uint32Array, P: ArrayLike<number>): number[] {
	const normal = (f: number): [number, number, number] => {
		const a = fv[f * 3]!, b = fv[f * 3 + 1]!, c = fv[f * 3 + 2]!;
		const e1x = P[b * 3]! - P[a * 3]!, e1y = P[b * 3 + 1]! - P[a * 3 + 1]!, e1z = P[b * 3 + 2]! - P[a * 3 + 2]!;
		const e2x = P[c * 3]! - P[a * 3]!, e2y = P[c * 3 + 1]! - P[a * 3 + 1]!, e2z = P[c * 3 + 2]! - P[a * 3 + 2]!;
		const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
		const l = Math.hypot(nx, ny, nz) || 1;
		return [nx / l, ny / l, nz / l];
	};
	const normals = new Map(faces.map((f) => [f, normal(f)]));
	const edgeOwner = new Map<number, number>();
	const parent = new Map(faces.map((f) => [f, f]));
	const find = (x: number): number => {
		while (parent.get(x) !== x) x = parent.get(x)!;
		return x;
	};
	for (const f of faces) {
		for (let k = 0; k < 3; k++) {
			const a = fv[f * 3 + k]!, b = fv[f * 3 + ((k + 1) % 3)]!;
			const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
			const g = edgeOwner.get(key);
			if (g === undefined) {
				edgeOwner.set(key, f);
				continue;
			}
			const n1 = normals.get(f)!, n2 = normals.get(g)!;
			if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < -0.5) continue; // fold
			const ra = find(f), rb = find(g);
			if (ra !== rb) parent.set(rb, ra);
		}
	}
	const groups = new Map<number, number[]>();
	for (const f of faces) {
		const r = find(f);
		const l = groups.get(r);
		if (l) l.push(f);
		else groups.set(r, [f]);
	}
	let best: number[] = faces;
	let bestArea = -1;
	for (const g of groups.values()) {
		const a = patchAreaFaces(P, fv, g);
		if (a > bestArea) {
			bestArea = a;
			best = g;
		}
	}
	return best;
}

function patchArea(P: ArrayLike<number>, idx: ArrayLike<number>, t0: number, t1: number): number {
	let a = 0;
	for (let t = t0; t < t1; t++) a += Math.sqrt(faceArea2(P, idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!)) / 2;
	return a;
}

function signedVolume(P: ArrayLike<number>, idx: ArrayLike<number>, t0: number, t1: number): number {
	let v = 0;
	for (let t = t0; t < t1; t++) {
		const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
		v +=
			P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) -
			P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) +
			P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!);
	}
	return v / 6;
}

interface LoopEdge { a: number; b: number; f: number; k: number }

/** Chain boundary half-edges into closed loops (handles shared vertices). */
function buildLoops<E extends LoopEdge>(edges: E[]): E[][] {
	const out = new Map<number, E[]>();
	for (const e of edges) {
		const l = out.get(e.a);
		if (l) l.push(e);
		else out.set(e.a, [e]);
	}
	const loops: E[][] = [];
	for (const first of edges) {
		const list = out.get(first.a);
		if (!list || !list.includes(first)) continue; // already used
		const loop: E[] = [];
		let e: E | undefined = first;
		while (e) {
			const l = out.get(e.a)!;
			l.splice(l.indexOf(e), 1);
			if (l.length === 0) out.delete(e.a);
			loop.push(e);
			if (e.b === first.a) break;
			const nexts = out.get(e.b);
			e = nexts?.[0];
		}
		// Open chains can't happen for true boundaries; keep closed loops only.
		if (loop.length >= 3 && loop[loop.length - 1]!.b === first.a) loops.push(loop);
	}
	return loops;
}

/**
 * Cap one boundary loop. Boundary half-edges run a → b; cap faces must
 * contain b → a, so the cap polygon is the loop in reverse.
 */
function capLoop<E extends LoopEdge>(
	loop: E[],
	positions: number[],
	emit: (a: number, b: number, c: number, edge: E) => void,
): void {
	// Reverse order: vertices v[n-1] … v[0] where v[i] = loop[i].a.
	const n = loop.length;
	const verts = loop.map((e) => e.a).reverse();
	const edgeFor = (i: number) => loop[(n - 1 - i + n) % n]!; // edge adjacent to verts[i]

	// Best-fit plane (Newell normal) for projection.
	let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
	for (let i = 0; i < n; i++) {
		const p = verts[i]! * 3, q = verts[(i + 1) % n]! * 3;
		nx += (positions[p + 1]! - positions[q + 1]!) * (positions[p + 2]! + positions[q + 2]!);
		ny += (positions[p + 2]! - positions[q + 2]!) * (positions[p]! + positions[q]!);
		nz += (positions[p]! - positions[q]!) * (positions[p + 1]! + positions[q + 1]!);
		cx += positions[p]!;
		cy += positions[p + 1]!;
		cz += positions[p + 2]!;
	}
	cx /= n;
	cy /= n;
	cz /= n;
	const nl = Math.hypot(nx, ny, nz);
	let tris: number[] | null = null;
	if (nl > 0) {
		nx /= nl; ny /= nl; nz /= nl;
		// Orthonormal basis (u, v) with u × v = n, so projected CCW ⇔ n.
		let ux = 0, uy = 0, uz = 0;
		if (Math.abs(nx) < 0.9) { ux = 0; uy = -nz; uz = ny; } else { ux = nz; uy = 0; uz = -nx; }
		const ul = Math.hypot(ux, uy, uz);
		ux /= ul; uy /= ul; uz /= ul;
		const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
		const xy = new Float64Array(n * 2);
		for (let i = 0; i < n; i++) {
			const p = verts[i]! * 3;
			const dx = positions[p]! - cx, dy = positions[p + 1]! - cy, dz = positions[p + 2]! - cz;
			xy[i * 2] = dx * ux + dy * uy + dz * uz;
			xy[i * 2 + 1] = dx * vx + dy * vy + dz * vz;
		}
		tris = n <= 2000 ? earClip(xy) : null;
	}
	if (tris) {
		for (let t = 0; t < tris.length; t += 3) {
			const i = tris[t]!, j = tris[t + 1]!, k = tris[t + 2]!;
			emit(verts[i]!, verts[j]!, verts[k]!, edgeFor(i));
		}
		return;
	}
	// Fallback: fan around the centroid.
	const c = positions.length / 3;
	positions.push(cx, cy, cz);
	for (let i = 0; i < n; i++) emit(c, verts[i]!, verts[(i + 1) % n]!, edgeFor(i));
}

/**
 * Ear-clipping triangulation of a simple polygon given as interleaved
 * 2D points. Output triangles follow the input vertex order's
 * orientation. Returns null if the polygon isn't simple enough to clip.
 */
export function earClip(xy: ArrayLike<number>): number[] | null {
	const n = xy.length / 2;
	if (n < 3) return null;
	let area = 0;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += xy[i * 2]! * xy[j * 2 + 1]! - xy[j * 2]! * xy[i * 2 + 1]!;
	}
	const sign = area >= 0 ? 1 : -1;
	const cross = (a: number, b: number, c: number) =>
		(xy[b * 2]! - xy[a * 2]!) * (xy[c * 2 + 1]! - xy[a * 2 + 1]!) -
		(xy[b * 2 + 1]! - xy[a * 2 + 1]!) * (xy[c * 2]! - xy[a * 2]!);
	const inside = (p: number, a: number, b: number, c: number) =>
		sign * cross(a, b, p) >= 0 && sign * cross(b, c, p) >= 0 && sign * cross(c, a, p) >= 0;

	const prev = new Int32Array(n), next = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		prev[i] = (i - 1 + n) % n;
		next[i] = (i + 1) % n;
	}
	const out: number[] = [];
	let remaining = n;
	let i = 0;
	let stall = 0;
	while (remaining > 3) {
		const a = prev[i]!, c = next[i]!;
		let ear = sign * cross(a, i, c) > 0;
		if (ear) {
			for (let p = next[c]!; p !== a; p = next[p]!) {
				if (inside(p, a, i, c)) {
					// Points coincident with the ear's corners don't block it.
					const same =
						(xy[p * 2] === xy[a * 2] && xy[p * 2 + 1] === xy[a * 2 + 1]) ||
						(xy[p * 2] === xy[c * 2] && xy[p * 2 + 1] === xy[c * 2 + 1]);
					if (!same) {
						ear = false;
						break;
					}
				}
			}
		}
		if (ear) {
			out.push(a, i, c);
			next[a] = c;
			prev[c] = a;
			remaining--;
			stall = 0;
			i = c;
		} else {
			i = next[i]!;
			if (++stall > remaining) return null;
		}
	}
	out.push(prev[i]!, i, next[i]!);
	return out;
}

/**
 * Thicken an open patch (already in `outIdx[start…]`) into a closed
 * shell: offset copy along −normal by `h` with reversed winding, plus
 * side walls along the boundary.
 */
function solidify<E extends LoopEdge>(
	pf: number[],
	boundary: E[],
	positions: number[],
	faceV: Uint32Array,
	h: number,
	emit: (a: number, b: number, c: number, from: number | E, swap: boolean) => void,
): void {
	// Area-weighted vertex normals of the patch.
	const normals = new Map<number, [number, number, number]>();
	for (const f of pf) {
		const a = faceV[f * 3]!, b = faceV[f * 3 + 1]!, c = faceV[f * 3 + 2]!;
		const e1x = positions[b * 3]! - positions[a * 3]!, e1y = positions[b * 3 + 1]! - positions[a * 3 + 1]!, e1z = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
		const e2x = positions[c * 3]! - positions[a * 3]!, e2y = positions[c * 3 + 1]! - positions[a * 3 + 1]!, e2z = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
		const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
		for (const v of [a, b, c]) {
			const acc = normals.get(v) ?? [0, 0, 0];
			acc[0] += nx; acc[1] += ny; acc[2] += nz;
			normals.set(v, acc);
		}
	}
	const offset = new Map<number, number>();
	for (const [v, nrm] of normals) {
		const l = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
		offset.set(v, positions.length / 3);
		positions.push(
			positions[v * 3]! - (nrm[0] / l) * h,
			positions[v * 3 + 1]! - (nrm[1] / l) * h,
			positions[v * 3 + 2]! - (nrm[2] / l) * h,
		);
	}
	// Back faces (reversed winding).
	for (const f of pf) {
		const a = offset.get(faceV[f * 3]!)!, b = offset.get(faceV[f * 3 + 1]!)!, c = offset.get(faceV[f * 3 + 2]!)!;
		emit(a, c, b, f, true);
	}
	// Side walls: boundary a → b gets quad (b, a, a', b').
	for (const e of boundary) {
		const a2 = offset.get(e.a)!, b2 = offset.get(e.b)!;
		emit(e.b, e.a, a2, e, false);
		emit(e.b, a2, b2, e, false);
	}
}
