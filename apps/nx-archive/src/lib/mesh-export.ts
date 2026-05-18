/**
 * Shared geometry-processing helpers for the 3D viewers.
 *
 * Originally lived inside `components/bfres-viewer.tsx`; lifted
 * here so the BFRES, UE StaticMesh, and PhyreEngine viewers can
 * all reuse the same welding / subdivision / STL-emit pipeline.
 *
 * Everything in this module is format-agnostic — it operates on
 * a tiny {@link IndexedMesh} struct (positions + indices) and
 * returns the same struct.
 *
 * # Pipeline
 *
 *   bakeMeshes (per format)
 *     → weldByPosition (collapse duplicate-position vertices)
 *     → loopSubdivide (N passes, optional — for STL print smoothing)
 *     → emitBinarySTL (with Y-up → Z-up rotation for slicers)
 *     → triggerDownload
 *
 * Format-specific "bake" steps (sampling positions out of three.js
 * scenes with skinning / scene-graph transforms applied) live in
 * the per-format viewers; this module starts from already-baked
 * world-space positions.
 */

/**
 * Minimal indexed triangle mesh. Used as the common currency
 * between bake → weld → subdivide → STL.
 *
 * Positions are packed `[x, y, z, x, y, z, …]` in mesh-local or
 * world space (the caller's choice — STL emit just trusts the
 * coordinates as-is and applies the standard Y-up → Z-up flip).
 * Indices are triangle-list triples; we always normalise to
 * Uint32Array on the way in so downstream passes don't need to
 * branch on index width.
 */
export interface IndexedMesh {
	/** Packed XYZ positions, length = 3 × vertex count. */
	positions: Float32Array;
	/** Packed triangle indices, length = 3 × triangle count. */
	indices: Uint32Array;
}

/**
 * Weld vertices that share the same world-space position.
 *
 * Source meshes often duplicate a position at material / UV /
 * normal seams; without welding, those duplicates look like
 * cracks to the subdivision algorithm and prevent it from
 * smoothing across the seam (each side becomes a "boundary"
 * edge with no neighbour triangle, halving its smoothing
 * weight).
 *
 * We bin vertices by quantised `(x, y, z)` — coordinates
 * rounded to `1 / WELD_SCALE` units. The original vertices at
 * a seam are bit-exact duplicates so any reasonable scale
 * catches them; `WELD_SCALE = 1e5` (= 0.00001 unit tolerance,
 * sub-millimetre for typical model scales) is conservative.
 *
 * Triangles that collapse to <3 unique vertices after welding
 * are dropped (they were degenerate even before welding).
 */
export function weldByPosition(mesh: IndexedMesh): IndexedMesh {
	const WELD_SCALE = 1e5;
	const remap = new Uint32Array(mesh.positions.length / 3);
	const seen = new Map<string, number>();
	const out: number[] = [];
	for (let i = 0; i < mesh.positions.length; i += 3) {
		const x = mesh.positions[i]!;
		const y = mesh.positions[i + 1]!;
		const z = mesh.positions[i + 2]!;
		const key =
			Math.round(x * WELD_SCALE) +
			'_' +
			Math.round(y * WELD_SCALE) +
			'_' +
			Math.round(z * WELD_SCALE);
		let idx = seen.get(key);
		if (idx === undefined) {
			idx = out.length / 3;
			seen.set(key, idx);
			out.push(x, y, z);
		}
		remap[i / 3] = idx;
	}
	const triOut: number[] = [];
	for (let i = 0; i < mesh.indices.length; i += 3) {
		const a = remap[mesh.indices[i]!]!;
		const b = remap[mesh.indices[i + 1]!]!;
		const c = remap[mesh.indices[i + 2]!]!;
		if (a === b || b === c || a === c) continue;
		triOut.push(a, b, c);
	}
	return {
		positions: new Float32Array(out),
		indices: new Uint32Array(triOut),
	};
}

/**
 * One pass of Loop subdivision. For every existing triangle we
 * emit four new ones by inserting a midpoint vertex on each edge:
 *
 *        a                    a
 *       / \                  /|\
 *      /   \      →         m─┼─n
 *     /     \              /\ | /\
 *    b───────c            b──p────c
 *
 * (m = midpoint of a–b, n = midpoint of a–c, p = midpoint of b–c.)
 * Both the new "odd" (edge-midpoint) vertices and the existing
 * "even" vertices are repositioned with smoothing weights so the
 * surface approaches a C² limit surface as passes accumulate.
 *
 * Smoothing rules (Loop, with Warren's β):
 *
 *   - Interior odd vertex (edge a–b shared by two tris with
 *     opposite vertices c, d): `3/8 (a+b) + 1/8 (c+d)`.
 *   - Boundary odd vertex (edge a–b shared by exactly one tri):
 *     `1/2 (a+b)`.
 *   - Interior even vertex of valence n: `(1 - n β) v + β Σ neighbours`,
 *     where β = `n == 3 ? 3/16 : 3/(8 n)`.
 *   - Boundary even vertex (lies on at least one boundary edge):
 *     `3/4 v + 1/8 (n1 + n2)` where n1, n2 are the two boundary
 *     neighbours.
 *
 * Boundary edges occur naturally on open surfaces (the underside
 * of a flat cape, the rim of a chalice, a hand's fingernail) —
 * they're real features of the source mesh, not authoring bugs.
 * Treating them with the boundary rules preserves crease lines
 * rather than smearing them inward.
 */
export function loopSubdivide(mesh: IndexedMesh): IndexedMesh {
	const oldVerts = mesh.positions.length / 3;
	const triCount = mesh.indices.length / 3;

	const edgeKey = (a: number, b: number) =>
		a < b ? a + '_' + b : b + '_' + a;
	interface EdgeInfo {
		count: number;
		opp1: number;
		opp2: number;
		a: number;
		b: number;
	}
	const edges = new Map<string, EdgeInfo>();
	const neighbours: Set<number>[] = new Array(oldVerts);
	for (let i = 0; i < oldVerts; i++) neighbours[i] = new Set();

	const recordEdge = (a: number, b: number, opp: number) => {
		const k = edgeKey(a, b);
		const e = edges.get(k);
		if (e) {
			e.count++;
			if (e.count === 2) e.opp2 = opp;
		} else {
			const lo = Math.min(a, b),
				hi = Math.max(a, b);
			edges.set(k, { count: 1, opp1: opp, opp2: -1, a: lo, b: hi });
		}
		neighbours[a]!.add(b);
		neighbours[b]!.add(a);
	};

	for (let t = 0; t < triCount; t++) {
		const a = mesh.indices[t * 3]!;
		const b = mesh.indices[t * 3 + 1]!;
		const c = mesh.indices[t * 3 + 2]!;
		recordEdge(a, b, c);
		recordEdge(b, c, a);
		recordEdge(c, a, b);
	}

	const isBoundaryVert = new Uint8Array(oldVerts);
	const boundaryNeighbours: [number, number][] = new Array(oldVerts);
	for (let i = 0; i < oldVerts; i++) boundaryNeighbours[i] = [-1, -1];
	for (const e of edges.values()) {
		if (e.count !== 1) continue;
		isBoundaryVert[e.a] = 1;
		isBoundaryVert[e.b] = 1;
		const ba = boundaryNeighbours[e.a]!;
		if (ba[0] === -1) ba[0] = e.b;
		else if (ba[1] === -1 && ba[0] !== e.b) ba[1] = e.b;
		const bb = boundaryNeighbours[e.b]!;
		if (bb[0] === -1) bb[0] = e.a;
		else if (bb[1] === -1 && bb[0] !== e.a) bb[1] = e.a;
	}

	const newVertCount = oldVerts + edges.size;
	const newPositions = new Float32Array(newVertCount * 3);
	const edgeMidIndex = new Map<string, number>();

	// 1. Reposition existing (even) vertices.
	for (let i = 0; i < oldVerts; i++) {
		const px = mesh.positions[i * 3]!;
		const py = mesh.positions[i * 3 + 1]!;
		const pz = mesh.positions[i * 3 + 2]!;
		if (isBoundaryVert[i]) {
			const [n1, n2] = boundaryNeighbours[i]!;
			if (n1 >= 0 && n2 >= 0) {
				const ax = mesh.positions[n1 * 3]!,
					ay = mesh.positions[n1 * 3 + 1]!,
					az = mesh.positions[n1 * 3 + 2]!;
				const bx = mesh.positions[n2 * 3]!,
					by = mesh.positions[n2 * 3 + 1]!,
					bz = mesh.positions[n2 * 3 + 2]!;
				newPositions[i * 3 + 0] = 0.75 * px + 0.125 * (ax + bx);
				newPositions[i * 3 + 1] = 0.75 * py + 0.125 * (ay + by);
				newPositions[i * 3 + 2] = 0.75 * pz + 0.125 * (az + bz);
			} else {
				newPositions[i * 3 + 0] = px;
				newPositions[i * 3 + 1] = py;
				newPositions[i * 3 + 2] = pz;
			}
		} else {
			const nbs = neighbours[i]!;
			const n = nbs.size;
			const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
			let sx = 0,
				sy = 0,
				sz = 0;
			for (const nb of nbs) {
				sx += mesh.positions[nb * 3]!;
				sy += mesh.positions[nb * 3 + 1]!;
				sz += mesh.positions[nb * 3 + 2]!;
			}
			newPositions[i * 3 + 0] = (1 - n * beta) * px + beta * sx;
			newPositions[i * 3 + 1] = (1 - n * beta) * py + beta * sy;
			newPositions[i * 3 + 2] = (1 - n * beta) * pz + beta * sz;
		}
	}

	// 2. Insert new (odd, edge-midpoint) vertices.
	let nextIdx = oldVerts;
	for (const [k, e] of edges) {
		const ax = mesh.positions[e.a * 3]!,
			ay = mesh.positions[e.a * 3 + 1]!,
			az = mesh.positions[e.a * 3 + 2]!;
		const bx = mesh.positions[e.b * 3]!,
			by = mesh.positions[e.b * 3 + 1]!,
			bz = mesh.positions[e.b * 3 + 2]!;
		let nx: number, ny: number, nz: number;
		if (e.count >= 2 && e.opp2 >= 0) {
			const cx = mesh.positions[e.opp1 * 3]!,
				cy = mesh.positions[e.opp1 * 3 + 1]!,
				cz = mesh.positions[e.opp1 * 3 + 2]!;
			const dx = mesh.positions[e.opp2 * 3]!,
				dy = mesh.positions[e.opp2 * 3 + 1]!,
				dz = mesh.positions[e.opp2 * 3 + 2]!;
			nx = 0.375 * (ax + bx) + 0.125 * (cx + dx);
			ny = 0.375 * (ay + by) + 0.125 * (cy + dy);
			nz = 0.375 * (az + bz) + 0.125 * (cz + dz);
		} else {
			nx = 0.5 * (ax + bx);
			ny = 0.5 * (ay + by);
			nz = 0.5 * (az + bz);
		}
		newPositions[nextIdx * 3 + 0] = nx;
		newPositions[nextIdx * 3 + 1] = ny;
		newPositions[nextIdx * 3 + 2] = nz;
		edgeMidIndex.set(k, nextIdx);
		nextIdx++;
	}

	// 3. Emit four sub-triangles per old triangle.
	const newIndices = new Uint32Array(triCount * 12);
	for (let t = 0; t < triCount; t++) {
		const a = mesh.indices[t * 3]!;
		const b = mesh.indices[t * 3 + 1]!;
		const c = mesh.indices[t * 3 + 2]!;
		const ab = edgeMidIndex.get(edgeKey(a, b))!;
		const bc = edgeMidIndex.get(edgeKey(b, c))!;
		const ca = edgeMidIndex.get(edgeKey(c, a))!;
		const o = t * 12;
		newIndices[o + 0] = a;
		newIndices[o + 1] = ab;
		newIndices[o + 2] = ca;
		newIndices[o + 3] = b;
		newIndices[o + 4] = bc;
		newIndices[o + 5] = ab;
		newIndices[o + 6] = c;
		newIndices[o + 7] = ca;
		newIndices[o + 8] = bc;
		newIndices[o + 9] = ab;
		newIndices[o + 10] = bc;
		newIndices[o + 11] = ca;
	}

	return { positions: newPositions, indices: newIndices };
}

/**
 * Emit a binary STL file from one or more indexed meshes.
 * Cross-format slicer-friendly export — the file is Z-up, has
 * flat per-triangle normals, and uses the standard STL binary
 * layout: 80-byte free-form header, uint32 triangle count, then
 * 50 bytes per triangle (3 floats normal + 3×3 floats positions
 * + 2 bytes attribute count = 0).
 *
 * Source axes can be `'y-up'` (rotated to Z-up via x ← x,
 * y ← -z, z ← y) or `'z-up'` (no rotation, already in slicer
 * convention).
 *
 * Triangles whose vertices contain non-finite components are
 * dropped rather than written with garbage values that might
 * crash the slicer. The header's triangle count is patched to
 * the actually-written total.
 *
 * Note: doesn't trigger a download itself — that's
 * {@link triggerDownload}'s job. Returning bytes lets callers
 * cache, hash, or transform the result further.
 */
export function emitBinarySTL(
	meshes: IndexedMesh[],
	options: {
		/** Free-form header text. Truncated to 79 chars. Must not start with "solid". */
		header: string;
		/** Source axis convention. Default `'y-up'`. */
		sourceAxis?: 'y-up' | 'z-up';
	},
): Uint8Array {
	const sourceAxis = options.sourceAxis ?? 'y-up';
	const flipToZUp = sourceAxis === 'y-up';

	let totalTris = 0;
	for (const m of meshes) totalTris += m.indices.length / 3;
	if (totalTris === 0) {
		// Return an empty-but-valid STL (header + count=0).
		const empty = new ArrayBuffer(84);
		const view = new DataView(empty);
		writeHeader(empty, options.header);
		view.setUint32(80, 0, true);
		return new Uint8Array(empty);
	}

	const bufSize = 84 + 50 * totalTris;
	const buf = new ArrayBuffer(bufSize);
	const view = new DataView(buf);
	writeHeader(buf, options.header);
	view.setUint32(80, totalTris, true);

	let off = 84;
	let written = 0;
	const ax = new Float32Array(3);
	const bx = new Float32Array(3);
	const cx = new Float32Array(3);
	for (const m of meshes) {
		const positions = m.positions;
		const indices = m.indices;
		for (let i = 0; i < indices.length; i += 3) {
			const ia = indices[i]! * 3;
			const ib = indices[i + 1]! * 3;
			const ic = indices[i + 2]! * 3;
			if (flipToZUp) {
				// (x, y, z) ← (x, −z, y)
				ax[0] = positions[ia]!;
				ax[1] = -positions[ia + 2]!;
				ax[2] = positions[ia + 1]!;
				bx[0] = positions[ib]!;
				bx[1] = -positions[ib + 2]!;
				bx[2] = positions[ib + 1]!;
				cx[0] = positions[ic]!;
				cx[1] = -positions[ic + 2]!;
				cx[2] = positions[ic + 1]!;
			} else {
				ax[0] = positions[ia]!;
				ax[1] = positions[ia + 1]!;
				ax[2] = positions[ia + 2]!;
				bx[0] = positions[ib]!;
				bx[1] = positions[ib + 1]!;
				bx[2] = positions[ib + 2]!;
				cx[0] = positions[ic]!;
				cx[1] = positions[ic + 1]!;
				cx[2] = positions[ic + 2]!;
			}
			if (
				!Number.isFinite(ax[0]! + ax[1]! + ax[2]!) ||
				!Number.isFinite(bx[0]! + bx[1]! + bx[2]!) ||
				!Number.isFinite(cx[0]! + cx[1]! + cx[2]!)
			) {
				continue;
			}
			// Flat per-triangle normal via cross product. Degenerate
			// triangles (zero-length cross) get a default (0, 0, 1).
			const e1x = bx[0]! - ax[0]!,
				e1y = bx[1]! - ax[1]!,
				e1z = bx[2]! - ax[2]!;
			const e2x = cx[0]! - ax[0]!,
				e2y = cx[1]! - ax[1]!,
				e2z = cx[2]! - ax[2]!;
			let nx = e1y * e2z - e1z * e2y;
			let ny = e1z * e2x - e1x * e2z;
			let nz = e1x * e2y - e1y * e2x;
			const len = Math.hypot(nx, ny, nz);
			if (len > 0) {
				nx /= len;
				ny /= len;
				nz /= len;
			} else {
				nx = 0;
				ny = 0;
				nz = 1;
			}
			view.setFloat32(off, nx, true);
			off += 4;
			view.setFloat32(off, ny, true);
			off += 4;
			view.setFloat32(off, nz, true);
			off += 4;
			view.setFloat32(off, ax[0]!, true);
			off += 4;
			view.setFloat32(off, ax[1]!, true);
			off += 4;
			view.setFloat32(off, ax[2]!, true);
			off += 4;
			view.setFloat32(off, bx[0]!, true);
			off += 4;
			view.setFloat32(off, bx[1]!, true);
			off += 4;
			view.setFloat32(off, bx[2]!, true);
			off += 4;
			view.setFloat32(off, cx[0]!, true);
			off += 4;
			view.setFloat32(off, cx[1]!, true);
			off += 4;
			view.setFloat32(off, cx[2]!, true);
			off += 4;
			view.setUint16(off, 0, true);
			off += 2; // attribute byte count
			written++;
		}
	}

	if (written !== totalTris) {
		view.setUint32(80, written, true);
		return new Uint8Array(buf, 0, 84 + 50 * written);
	}
	return new Uint8Array(buf);
}

function writeHeader(buf: ArrayBuffer, header: string): void {
	const headerBytes = new Uint8Array(buf, 0, 80);
	const trimmed = header.slice(0, 79);
	for (let i = 0; i < trimmed.length; i++) {
		headerBytes[i] = trimmed.charCodeAt(i);
	}
}

/**
 * Trigger a browser download for a binary blob. Used by the
 * mesh viewers to hand off STL exports without having to repeat
 * the anchor-click dance.
 */
export function triggerDownload(
	bytes: Uint8Array,
	fileName: string,
	mimeType: string,
): void {
	// Cast to ArrayBuffer-typed view for strict-DOM-lib compatibility.
	// `Uint8Array` is parameterised over `ArrayBufferLike` (which
	// includes `SharedArrayBuffer`) but `Blob` only accepts plain
	// `ArrayBuffer`-backed views — slice() materialises one.
	const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
		type: mimeType,
	});
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	// Release the object URL on the next tick so the browser has
	// time to start the download.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Sanitise a string into a filesystem-safe stem: strip the
 * extension and replace path-hostile characters.
 */
export function sanitizeStem(name: string): string {
	return name
		.replace(/\.[^./\\]+$/, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_');
}
