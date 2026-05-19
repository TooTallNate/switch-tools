/**
 * FFVIII battle DAT — Section 2: Geometry.
 *
 * Layout (section-relative):
 *
 *   offset  type      field
 *     0x00  u32       cObjects
 *     0x04  u32[cObjects]   pObjects (section-relative offsets to each object)
 *     ...   Object[cObjects]
 *     END   u32       cTotalVertices (sum of all object vertex counts)
 *
 * Each Object:
 *   - u16 cVertexBlocks            (number of VertexData groups, NOT total vertices)
 *   - VertexData[cVertexBlocks] {
 *         u16 boneId
 *         u16 cVerticesInBlock
 *         Vertex[cVerticesInBlock]   (6 bytes: 3 × i16, no W)
 *     }
 *   - **Alignment**: after the vertex run, advance to the next 4-byte boundary.
 *     OpenVIII's exact rule: if `(pos - sectionOffset) % 4 == 0`, SKIP 4 BYTES;
 *     otherwise advance to the next multiple of 4. (Yes — the "already aligned"
 *     case advances a full 4 bytes, not zero.)
 *   - u16 cTriangles
 *   - u16 cQuads
 *   - 8 bytes unknown / padding (u64, asserted zero by OpenVIII)
 *   - Triangle[cTriangles]  (16 bytes each)
 *   - Quad[cQuads]          (20 bytes each)
 *
 * Triangle (16 bytes):
 *   offset  type    field
 *     0x00  u16     a            (low 12 bits = vertex index; mask 0x0FFF)
 *     0x02  u16     b
 *     0x04  u16     c
 *     0x06  u8 u8   uvA          (texU, texV — pairs with vertex A)
 *     0x08  u8 u8   uvB          (pairs with vertex B)
 *     0x0A  u16     texUnk       (texture index = (texUnk >> 6) & 0b111)
 *     0x0C  u8 u8   uvC          (pairs with vertex C)
 *     0x0E  u16     u            (textureID_related2; unused)
 *
 *   Winding order: the geometry consumer must draw vertices in (C, A, B) order
 *   (NOT (A, B, C) — verified by OpenVIII's `Triangle.cs:GetIndex`).
 *   UVs are kept in the natural (Vta, Vtb, Vtc) order, paired with the
 *   reordered vertex indexes so `uvs[i]` correctly matches `vertexIndexes[i]`.
 *
 * Quad (20 bytes):
 *   offset  type    field
 *     0x00  u16     a            (low 12 bits = vertex index)
 *     0x02  u16     b
 *     0x04  u16     c
 *     0x06  u16     d
 *     0x08  u8 u8   uvA          (pairs with vertex A)
 *     0x0A  u16     texUnk       (texture index = (texUnk >> 6) & 0b111)
 *     0x0C  u8 u8   uvB
 *     0x0E  u16     u            (textureID_related2; unused)
 *     0x10  u8 u8   uvC
 *     0x12  u8 u8   uvD
 *
 *   Triangulation (per OpenVIII's `Quad.cs:GenerateVPT`):
 *     Triangle 1: (A, B, D)
 *     Triangle 2: (A, C, D)
 *   Each vertex pairs with its natural UV (A↔Vta, B↔Vtb, C↔Vtc, D↔Vtd).
 */

import { DatParseError } from './header.js';

export interface DatVertex {
	x: number;
	y: number;
	z: number;
	/** Bone this vertex is attached to (skinning). */
	boneId: number;
}

export interface DatTriangle {
	/** Vertex indexes in DRAW order: (C, A, B). Already masked to 12 bits. */
	vertexIndexes: [number, number, number];
	/**
	 * UVs in natural (Vta, Vtb, Vtc) order. The "pairing" with vertex indexes
	 * is shifted: `uvs[0]` pairs with `vertexIndexes[0]` (= C), `uvs[1]` with A,
	 * `uvs[2]` with B. This matches OpenVIII's renderer behaviour exactly.
	 */
	uvs: [[number, number], [number, number], [number, number]];
	/** Texture index — typically 0..7. */
	textureIndex: number;
}

export interface DatQuad {
	/**
	 * Raw quad order (a, b, c, d), each masked to 12 bits. To draw the quad,
	 * triangulate as: (A, B, D) + (A, C, D). Each vertex pairs with its
	 * natural UV at the same index (uvs[0]↔A, uvs[1]↔B, uvs[2]↔C, uvs[3]↔D).
	 */
	vertexIndexes: [number, number, number, number];
	uvs: [[number, number], [number, number], [number, number], [number, number]];
	textureIndex: number;
}

export interface DatObject {
	vertices: DatVertex[];
	triangles: DatTriangle[];
	quads: DatQuad[];
}

export interface DatGeometry {
	objects: DatObject[];
	/** From the u32 trailer after all objects. */
	totalVertexCount: number;
}

export function parseGeometry(
	bytes: Uint8Array,
	sectionOffset: number,
): DatGeometry {
	if (sectionOffset + 4 > bytes.length) {
		throw new DatParseError(
			`Geometry section truncated at offset ${sectionOffset}`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const cObjects = view.getUint32(sectionOffset + 0x00, true);
	if (cObjects > 4096) {
		throw new DatParseError(
			`Geometry cObjects=${cObjects} implausibly large`,
		);
	}
	const ptrTableEnd = sectionOffset + 4 + cObjects * 4;
	if (ptrTableEnd > bytes.length) {
		throw new DatParseError(
			`Geometry object pointer table truncated (needs ${cObjects * 4} bytes after header)`,
		);
	}
	const objectOffsets: number[] = [];
	for (let i = 0; i < cObjects; i++) {
		objectOffsets.push(view.getUint32(sectionOffset + 4 + i * 4, true));
	}

	const objects: DatObject[] = [];
	let afterLastObject = ptrTableEnd;
	for (let i = 0; i < cObjects; i++) {
		const objStart = sectionOffset + objectOffsets[i]!;
		const obj = parseObject(bytes, view, objStart, sectionOffset);
		objects.push(obj.object);
		afterLastObject = obj.endPos;
	}

	// Trailing u32 cTotalVertices.
	let totalVertexCount = 0;
	if (afterLastObject + 4 <= bytes.length) {
		totalVertexCount = view.getUint32(afterLastObject, true);
	}
	return { objects, totalVertexCount };
}

function parseObject(
	bytes: Uint8Array,
	view: DataView,
	objStart: number,
	sectionOffset: number,
): { object: DatObject; endPos: number } {
	if (objStart + 2 > bytes.length) {
		throw new DatParseError(`Geometry object header out of bounds at ${objStart}`);
	}
	const cVertexBlocks = view.getUint16(objStart, true);
	let pos = objStart + 2;

	const vertices: DatVertex[] = [];
	for (let block = 0; block < cVertexBlocks; block++) {
		if (pos + 4 > bytes.length) {
			throw new DatParseError(
				`Vertex-data block header out of bounds at ${pos}`,
			);
		}
		const boneId = view.getUint16(pos + 0, true);
		const cBlockVerts = view.getUint16(pos + 2, true);
		pos += 4;
		if (pos + cBlockVerts * 6 > bytes.length) {
			throw new DatParseError(
				`Vertex-data block of ${cBlockVerts} vertices out of bounds at ${pos}`,
			);
		}
		for (let v = 0; v < cBlockVerts; v++) {
			const x = view.getInt16(pos + 0, true);
			const y = view.getInt16(pos + 2, true);
			const z = view.getInt16(pos + 4, true);
			pos += 6;
			vertices.push({ x, y, z, boneId });
		}
	}

	// Alignment to 4 bytes (section-relative). OpenVIII's exact ternary:
	//   if already aligned, advance a FULL 4 bytes; otherwise advance to next multiple of 4.
	const rel = pos - sectionOffset;
	const mod = rel % 4;
	if (mod === 0) {
		pos += 4;
	} else {
		pos += 4 - mod;
	}

	if (pos + 12 > bytes.length) {
		throw new DatParseError(
			`Triangle/quad counts out of bounds at ${pos}`,
		);
	}
	const cTriangles = view.getUint16(pos + 0, true);
	const cQuads = view.getUint16(pos + 2, true);
	// 8 bytes unknown / padding (u64, asserted zero by OpenVIII).
	pos += 4 + 8;

	const triEnd = pos + cTriangles * 16;
	if (triEnd > bytes.length) {
		throw new DatParseError(
			`Triangles out of bounds: need ${cTriangles * 16} bytes at ${pos}`,
		);
	}
	const triangles: DatTriangle[] = [];
	for (let t = 0; t < cTriangles; t++) {
		const off = pos + t * 16;
		const a = view.getUint16(off + 0x00, true) & 0x0fff;
		const b = view.getUint16(off + 0x02, true) & 0x0fff;
		const c = view.getUint16(off + 0x04, true) & 0x0fff;
		const uA: [number, number] = [
			view.getUint8(off + 0x06),
			view.getUint8(off + 0x07),
		];
		const uB: [number, number] = [
			view.getUint8(off + 0x08),
			view.getUint8(off + 0x09),
		];
		const texUnk = view.getUint16(off + 0x0a, true);
		const textureIndex = (texUnk >> 6) & 0b111;
		const uC: [number, number] = [
			view.getUint8(off + 0x0c),
			view.getUint8(off + 0x0d),
		];
		// OpenVIII's `Triangle.cs:GetIndex` reorders vertex indexes to (C, A, B)
		// for drawing, but `GetUV` keeps UVs in their natural (Vta, Vtb, Vtc)
		// order. The renderer pairs them by the same `i`, so the pairing is
		// shifted: C↔Vta, A↔Vtb, B↔Vtc. This decoder exposes that same shifted
		// pairing so consumers can iterate `(vertexIndexes[i], uvs[i])` and
		// match OpenVIII's renderer exactly.
		triangles.push({
			vertexIndexes: [c, a, b],
			uvs: [uA, uB, uC],
			textureIndex,
		});
	}
	pos = triEnd;

	const quadEnd = pos + cQuads * 20;
	if (quadEnd > bytes.length) {
		throw new DatParseError(
			`Quads out of bounds: need ${cQuads * 20} bytes at ${pos}`,
		);
	}
	const quads: DatQuad[] = [];
	for (let q = 0; q < cQuads; q++) {
		const off = pos + q * 20;
		const a = view.getUint16(off + 0x00, true) & 0x0fff;
		const b = view.getUint16(off + 0x02, true) & 0x0fff;
		const c = view.getUint16(off + 0x04, true) & 0x0fff;
		const d = view.getUint16(off + 0x06, true) & 0x0fff;
		const uA: [number, number] = [
			view.getUint8(off + 0x08),
			view.getUint8(off + 0x09),
		];
		const texUnk = view.getUint16(off + 0x0a, true);
		const textureIndex = (texUnk >> 6) & 0b111;
		const uB: [number, number] = [
			view.getUint8(off + 0x0c),
			view.getUint8(off + 0x0d),
		];
		// 0x0E..0x0F = u (textureID_related2; unused).
		const uC: [number, number] = [
			view.getUint8(off + 0x10),
			view.getUint8(off + 0x11),
		];
		const uD: [number, number] = [
			view.getUint8(off + 0x12),
			view.getUint8(off + 0x13),
		];
		quads.push({
			vertexIndexes: [a, b, c, d],
			uvs: [uA, uB, uC, uD],
			textureIndex,
		});
	}
	pos = quadEnd;

	return { object: { vertices, triangles, quads }, endPos: pos };
}
