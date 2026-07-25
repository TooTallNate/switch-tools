/**
 * Flattening J3D geometry into something a modern GPU can draw.
 *
 * The gap between J3D and WebGL/Three.js is not the file format — it's a
 * hardware difference. GX fetches **each vertex attribute through its own
 * index**: a display-list vertex is a tuple like `(pos 12, nrm 40, uv 7)`, and
 * the three numbers are unrelated. That's a genuinely better memory layout for
 * a console with 24 KB of texture cache and 1T-SRAM main memory, because a cube
 * needs 8 positions and 6 normals rather than 24 of each.
 *
 * Every GPU since has used a single index for all attributes, so converting
 * means de-duplicating: build the set of distinct index *tuples* actually
 * referenced, emit one output vertex per distinct tuple, and rewrite the
 * triangles to point at those. The cube becomes 24 vertices, which is
 * unavoidable — it's the price of the unified index.
 *
 * We key on the resolved `(position, normal, uv0, color0)` index quad rather
 * than on the raw display-list tuple. Those four numbers completely determine
 * an output vertex, so this is the maximal correct de-duplication: keying on the
 * raw tuple would additionally split on attributes we don't emit (matrix
 * indices, TEX1..TEX7) and produce duplicate vertices for no reason. An
 * attribute a shape doesn't have contributes -1, so vertices from a shape
 * without normals never merge with vertices from one that has them.
 *
 * Output sections follow `INF1`'s draw order, one per (shape, material) pair,
 * because that order is not arbitrary: J3D relies on it for translucency, and
 * a viewer that draws shapes in `SHP1` order will get the water and the glass
 * wrong. When there's no `INF1` we fall back to `SHP1` order with no material.
 *
 * A note on `PNMTXIDX`: we ignore it, which means the mesh is in its *bind
 * pose*. Applying skinning would require walking `DRW1`/`EVP1` and blending
 * matrices per vertex, which is a renderer's job — and for the overwhelming
 * majority of J3D models (props, terrain, buildings) the bind pose is the only
 * pose there is.
 */

import { GxAttr, GxAttrType } from './gx.js';
import type { J3dModel } from './model.js';
import {
	shapeAttributeSlot,
	triangulate,
	type Shp1Shape,
} from './shp1.js';
import { vtx1Array, type Vtx1Array } from './vtx1.js';

/** One draw range: a run of triangles sharing a material. */
export interface J3dMeshSection {
	/** Index into the model's material list, or -1 if unknown. */
	materialIndex: number;
	/** Offset in indices into the index buffer. */
	firstIndex: number;
	numTriangles: number;
	/** Which SHP1 shape produced this section. */
	shapeIndex: number;
}

/** A flattened, GPU-ready mesh. Mirrors what a Three.js `BufferGeometry` wants. */
export interface J3dMesh {
	numVertices: number;
	/** XYZ interleaved. */
	positions: Float32Array;
	/** XYZ interleaved, unit. Absent when no shape supplied normals. */
	normals?: Float32Array;
	/** UV interleaved (TEX0). Absent when no shape supplied texture coordinates. */
	uv?: Float32Array;
	/** RGB interleaved, 0..1 (CLR0). Absent when no shape supplied colours. */
	colors?: Float32Array;
	indices: Uint16Array | Uint32Array;
	sections: J3dMeshSection[];
}

/** Above this many vertices a `Uint16Array` index buffer can't address them all. */
const UINT16_INDEX_LIMIT = 65535;

/**
 * Which slot of a shape's vertex descriptor supplies `attribute`, but only when
 * we can actually resolve it into a `VTX1` array.
 *
 * A `DIRECT` attribute carries its value inline in the display list rather than
 * an index, so there is nothing to look up; J3D only ever does that for the
 * matrix indices, and treating it as "absent" here is both correct and safe.
 */
function resolvableSlot(shape: Shp1Shape, attribute: number): number {
	const slot = shapeAttributeSlot(shape, attribute);
	if (slot < 0) return -1;
	const type = shape.attributes[slot].attrType;
	if (type !== GxAttrType.INDEX8 && type !== GxAttrType.INDEX16) return -1;
	return slot;
}

/**
 * Clamp an index into an array's range.
 *
 * Out-of-range indices do turn up: a few retail models index one past the end
 * of a texture-coordinate array, apparently harmlessly, because the GP read
 * whatever followed in memory. Clamping keeps the mesh intact where refusing to
 * build it would lose a whole model over one stray vertex.
 */
function clampIndex(index: number, array: Vtx1Array): number {
	if (index < 0) return 0;
	if (index >= array.count) return array.count > 0 ? array.count - 1 : 0;
	return index;
}

/**
 * Flatten a parsed model into a single interleaved-attribute mesh.
 *
 * Returns `null` when there is nothing to draw: no `VTX1`, no `SHP1`, no
 * position array, or no triangles at all.
 */
export function buildJ3dMesh(model: J3dModel): J3dMesh | null {
	const { vtx1, shp1 } = model;
	if (!vtx1 || !shp1) return null;

	const posArray = vtx1Array(vtx1, GxAttr.POS);
	if (!posArray || posArray.count === 0) return null;
	const nrmArray = vtx1Array(vtx1, GxAttr.NRM);
	const uvArray = vtx1Array(vtx1, GxAttr.TEX0);
	const clrArray = vtx1Array(vtx1, GxAttr.CLR0);

	// Draw order comes from INF1 when we have it; see the module comment.
	//
	// INF1's material references are not guaranteed to be in range: a handful of
	// retail models name a material index past the end of MAT3 (unused draw
	// branches left in by the exporter). Normalise those to -1 rather than
	// letting them reach the caller, which would otherwise index off the end of
	// its own material/texture arrays.
	//
	// We only do this when there *is* a MAT3 to validate against. With no
	// material table there's nothing to overrun and nothing to check, so INF1's
	// reference is passed through as-is rather than destroyed.
	const materialCount = model.mat3 ? model.mat3.materials.length : -1;
	const drawCalls: { shapeIndex: number; materialIndex: number }[] = [];
	if (model.inf1 && model.inf1.drawCalls.length > 0) {
		for (const dc of model.inf1.drawCalls) {
			if (dc.shapeIndex < 0 || dc.shapeIndex >= shp1.shapes.length) continue;
			drawCalls.push({
				shapeIndex: dc.shapeIndex,
				materialIndex:
					materialCount < 0 || dc.materialIndex < materialCount
						? dc.materialIndex
						: -1,
			});
		}
	} else {
		for (let i = 0; i < shp1.shapes.length; i++) {
			drawCalls.push({ shapeIndex: i, materialIndex: -1 });
		}
	}
	if (drawCalls.length === 0) return null;

	// Which channels any shape actually supplies. We only allocate the ones that
	// get used, so a terrain model with no vertex colours doesn't pay for them.
	let anyNormal = false;
	let anyUv = false;
	let anyColor = false;
	for (const dc of drawCalls) {
		const shape = shp1.shapes[dc.shapeIndex];
		if (nrmArray && resolvableSlot(shape, GxAttr.NRM) >= 0) anyNormal = true;
		if (uvArray && resolvableSlot(shape, GxAttr.TEX0) >= 0) anyUv = true;
		if (clrArray && resolvableSlot(shape, GxAttr.CLR0) >= 0) anyColor = true;
	}

	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	const sections: J3dMeshSection[] = [];
	const seen = new Map<string, number>();

	/** Emit (or reuse) the vertex for one resolved index quad. */
	const vertexFor = (
		posIdx: number,
		nrmIdx: number,
		uvIdx: number,
		clrIdx: number,
	): number => {
		const key = `${posIdx},${nrmIdx},${uvIdx},${clrIdx}`;
		const existing = seen.get(key);
		if (existing !== undefined) return existing;
		const out = positions.length / 3;

		const pi = clampIndex(posIdx, posArray) * posArray.numComponents;
		positions.push(
			posArray.values[pi] ?? 0,
			posArray.values[pi + 1] ?? 0,
			// A 2-component (XY) position array leaves Z at zero.
			posArray.numComponents >= 3 ? (posArray.values[pi + 2] ?? 0) : 0,
		);

		if (anyNormal) {
			if (nrmIdx >= 0 && nrmArray) {
				// NBT arrays hold normal, binormal and tangent; the normal is first.
				const ni = clampIndex(nrmIdx, nrmArray) * nrmArray.numComponents;
				let x = nrmArray.values[ni] ?? 0;
				let y = nrmArray.values[ni + 1] ?? 0;
				let z = nrmArray.values[ni + 2] ?? 0;
				const len = Math.sqrt(x * x + y * y + z * z);
				if (len > 0) {
					x /= len;
					y /= len;
					z /= len;
				}
				normals.push(x, y, z);
			} else {
				// This shape has no normals. Zero is the honest answer; callers that
				// need something can recompute them from the triangles.
				normals.push(0, 0, 0);
			}
		}

		if (anyUv) {
			if (uvIdx >= 0 && uvArray) {
				const ti = clampIndex(uvIdx, uvArray) * uvArray.numComponents;
				uvs.push(
					uvArray.values[ti] ?? 0,
					// An S-only array (componentCount 0) has no V.
					uvArray.numComponents >= 2 ? (uvArray.values[ti + 1] ?? 0) : 0,
				);
			} else {
				uvs.push(0, 0);
			}
		}

		if (anyColor) {
			if (clrIdx >= 0 && clrArray) {
				const ci = clampIndex(clrIdx, clrArray) * clrArray.numComponents;
				colors.push(
					clrArray.values[ci] ?? 1,
					clrArray.values[ci + 1] ?? 1,
					clrArray.values[ci + 2] ?? 1,
				);
			} else {
				// White multiplies out to "no tint" in every sane material setup.
				colors.push(1, 1, 1);
			}
		}

		seen.set(key, out);
		return out;
	};

	for (const dc of drawCalls) {
		const shape = shp1.shapes[dc.shapeIndex];
		const posSlot = resolvableSlot(shape, GxAttr.POS);
		// Without a position index there is no geometry to recover from this shape.
		if (posSlot < 0) continue;
		const nrmSlot = nrmArray ? resolvableSlot(shape, GxAttr.NRM) : -1;
		const uvSlot = uvArray ? resolvableSlot(shape, GxAttr.TEX0) : -1;
		const clrSlot = clrArray ? resolvableSlot(shape, GxAttr.CLR0) : -1;
		const width = shape.attributes.length;

		const firstIndex = indices.length;
		for (const packet of shape.packets) {
			for (const prim of packet.primitives) {
				const tris = triangulate(prim.type, prim.vertexCount);
				// Lines and points give an empty list; an unknown opcode can't get
				// this far (parseShp1 would have failed), but be explicit anyway.
				if (!tris || tris.length === 0) continue;
				for (const local of tris) {
					const row = local * width;
					indices.push(
						vertexFor(
							prim.indices[row + posSlot],
							nrmSlot >= 0 ? prim.indices[row + nrmSlot] : -1,
							uvSlot >= 0 ? prim.indices[row + uvSlot] : -1,
							clrSlot >= 0 ? prim.indices[row + clrSlot] : -1,
						),
					);
				}
			}
		}

		const numTriangles = (indices.length - firstIndex) / 3;
		if (numTriangles > 0) {
			sections.push({
				materialIndex: dc.materialIndex,
				firstIndex,
				numTriangles,
				shapeIndex: dc.shapeIndex,
			});
		}
	}

	const numVertices = positions.length / 3;
	if (numVertices === 0 || indices.length === 0) return null;

	const mesh: J3dMesh = {
		numVertices,
		positions: new Float32Array(positions),
		indices:
			numVertices > UINT16_INDEX_LIMIT
				? new Uint32Array(indices)
				: new Uint16Array(indices),
		sections,
	};
	if (anyNormal) mesh.normals = new Float32Array(normals);
	if (anyUv) mesh.uv = new Float32Array(uvs);
	if (anyColor) mesh.colors = new Float32Array(colors);
	return mesh;
}
