/**
 * `SHP1` — the shapes, and with them the actual geometry.
 *
 * A "shape" is one batch of triangles that shares a single vertex format and a
 * single material. Inside a shape the geometry is stored not as a triangle list
 * but as **GX display lists**: literal byte streams of graphics-processor
 * commands, ready to be DMA-ed at the command processor with no CPU work at
 * all. That is the whole point of the format — the game's draw call for a shape
 * is essentially "set up the array bases, then `GXCallDisplayList(ptr, size)`".
 *
 * Payload layout:
 *
 *   0x00 u16 shapeCount
 *   0x02 u16 padding
 *   0x04 u32 shapeOffset
 *   0x08 u32 remapTableOffset
 *   0x0C u32 nameTableOffset       — usually 0 (shapes are rarely named)
 *   0x10 u32 attributeOffset
 *   0x14 u32 matrixTableOffset
 *   0x18 u32 primitiveDataOffset
 *   0x1C u32 matrixDataOffset
 *   0x20 u32 packetLocationOffset
 *
 * Shape entry, 0x28 bytes:
 *
 *   0x00 u8      matrixType          — 0 normal, 1 billboard, 2 y-billboard,
 *                                      3 multi-matrix (skinned)
 *   0x01 u8      padding
 *   0x02 u16     packetCount
 *   0x04 u16     attributeOffset     — a *byte* offset into the attribute table,
 *                                      not an index, because entries are shared
 *                                      between shapes with identical formats
 *   0x06 u16     firstMatrixData
 *   0x08 u16     firstPacketLocation
 *   0x0A u16     padding
 *   0x0C f32     boundingSphereRadius
 *   0x10 f32[3]  bboxMin
 *   0x1C f32[3]  bboxMax
 *
 * Attribute table entries, 8 bytes, terminated by attribute 0xFF:
 *
 *   0x00 u32 attribute   — GX_VA_*
 *   0x04 u32 attrType    — GX_NONE / GX_DIRECT / GX_INDEX8 / GX_INDEX16
 *
 * This table is the shape's *vertex descriptor* — the exact thing the game
 * feeds to `GXSetVtxDesc`. It defines, in order, which attributes each vertex
 * in the display list supplies and how wide each one is, and therefore the
 * stride of a vertex in the stream:
 *
 *   stride = Σ sizeof(attrType)   where DIRECT = INDEX8 = 1 byte, INDEX16 = 2
 *
 * Get that sum wrong by a single byte and every vertex after the first is
 * garbage, so it's computed once per shape and reused.
 *
 * Packet location, 8 bytes: `u32 size, u32 offset`, the offset being relative to
 * `primitiveDataOffset`. A "packet" is one display list; a shape has several
 * because a skinned shape can only have 10 matrices loaded at a time, so the
 * exporter splits geometry into packets small enough that each one's bone set
 * fits in the transform unit's matrix memory. The bone set is described by the
 * matrix-data entry (`u16 unknown, u16 count, u32 firstIndex`) which slices the
 * shared matrix table (`u16` per entry: an index into `DRW1`).
 *
 * ## Display lists
 *
 * A GX primitive command is one opcode byte, then `u16 vertexCount`, then
 * `vertexCount` vertices of `stride` bytes each. The opcode is
 * `0x80 | (type << 3) | vat`; we mask off the VAT bits because J3D always uses
 * VAT 0 and the choice is irrelevant to us (the format lives in `VTX1`).
 *
 * Display lists must be a multiple of 32 bytes — the CP's FIFO reads in 32-byte
 * chunks — so packets are padded with 0x00 bytes, which decode as `GX_NOP`.
 * Hence the "skip zero bytes" branch in the loop below: it is not error
 * recovery, it is the padding the hardware requires.
 */

import { chunkOffset, validateChunk, type J3dChunk } from './container.js';
import {
	GxAttr,
	GxPrimitive,
	gxAttrTypeSize,
	gxPrimitiveIsKnown,
} from './gx.js';
import { CHUNK_HEADER_SIZE, readJ3dStringTable } from './util.js';

export const SHP1_SHAPE_SIZE = 0x28;
export const SHP1_ATTRIB_ENTRY_SIZE = 0x08;
export const SHP1_PACKET_LOCATION_SIZE = 0x08;
export const SHP1_MATRIX_DATA_SIZE = 0x08;

/** Runaway guards. A real vertex descriptor has at most 26 attributes. */
const MAX_ATTRIB_ENTRIES = 32;

/** One entry of a shape's vertex descriptor. */
export interface Shp1AttribEntry {
	/** `GxAttr` value. */
	attribute: number;
	/** `GxAttrType` value. */
	attrType: number;
	/** Bytes this attribute occupies per vertex in the display list. */
	size: number;
}

/** One primitive command from a display list. */
export interface Shp1Primitive {
	/** Opcode with the VAT bits masked off; compare against `GxPrimitive`. */
	type: number;
	/** The VAT index the opcode selected (always 0 in practice). */
	vat: number;
	vertexCount: number;
	/** Number of attributes each vertex supplies — the row width of `indices`. */
	numAttributes: number;
	/**
	 * Flat `vertexCount * numAttributes` index array, row-major by vertex, in
	 * the same order as the shape's attribute table. Use
	 * {@link primitiveIndex} rather than doing the multiply yourself.
	 */
	indices: Uint16Array;
}

/** One display list, plus the bone set it is allowed to reference. */
export interface Shp1Packet {
	/** Byte size of the display list. */
	size: number;
	/** Absolute offset of the display list in the source buffer. */
	offset: number;
	primitives: Shp1Primitive[];
	/**
	 * `DRW1` indices this packet's `PNMTXIDX` values select from, in slot order:
	 * a `PNMTXIDX` of `n` in the vertex stream means `matrixTable[n / 3]`.
	 * (The division by three is GX's: matrix memory is addressed in rows of a
	 * 3x4 matrix.) Empty when the shape isn't skinned.
	 */
	matrixTable: number[];
}

export interface Shp1Shape {
	index: number;
	/** 0 normal, 1 billboard, 2 y-billboard, 3 multi-matrix. */
	matrixType: number;
	packetCount: number;
	/** Byte offset of this shape's descriptor within the attribute table. */
	attributeOffset: number;
	firstMatrixData: number;
	firstPacketLocation: number;
	boundingSphereRadius: number;
	bboxMin: [number, number, number];
	bboxMax: [number, number, number];
	/** The shape's vertex descriptor, in stream order. */
	attributes: Shp1AttribEntry[];
	/** Sum of the attribute widths: bytes per vertex in the display list. */
	vertexStride: number;
	packets: Shp1Packet[];
}

export interface Shp1 {
	shapes: Shp1Shape[];
	/** `u16` per shape; maps a "shape id" to a shape entry index. */
	remapTable: number[];
	/** Shape names, when the (usually absent) name table is present. */
	names: string[] | null;
}

/** One index out of a primitive's vertex data. */
export function primitiveIndex(
	prim: Shp1Primitive,
	vertex: number,
	attributeSlot: number,
): number {
	return prim.indices[vertex * prim.numAttributes + attributeSlot];
}

/** All of a vertex's indices, in attribute-table order. */
export function primitiveVertexIndices(
	prim: Shp1Primitive,
	vertex: number,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < prim.numAttributes; i++) {
		out.push(prim.indices[vertex * prim.numAttributes + i]);
	}
	return out;
}

/** Position of `attribute` in a shape's vertex descriptor, or -1. */
export function shapeAttributeSlot(shape: Shp1Shape, attribute: number): number {
	for (let i = 0; i < shape.attributes.length; i++) {
		if (shape.attributes[i].attribute === attribute) return i;
	}
	return -1;
}

/**
 * Convert a primitive into triangles, as flat triples of *local* vertex
 * numbers (0..vertexCount-1).
 *
 * Returns an empty array for the line and point primitives — they're valid, we
 * just have no triangles to give — and `null` for an opcode we don't know.
 *
 * The strip case is the one that bites: GX (like OpenGL) flips the winding of
 * every other triangle so that a strip keeps a consistent facing. Emitting
 * `(i-2, i-1, i)` for every `i` leaves half the faces back-to-front, which
 * looks fine with backface culling off and completely wrong with it on.
 */
export function triangulate(
	primitiveType: number,
	vertexCount: number,
): number[] | null {
	const out: number[] = [];
	switch (primitiveType) {
		case GxPrimitive.TRIANGLES:
			for (let i = 0; i + 2 < vertexCount; i += 3) {
				out.push(i, i + 1, i + 2);
			}
			return out;
		case GxPrimitive.TRIANGLESTRIP:
			for (let i = 2; i < vertexCount; i++) {
				if (i % 2 === 0) out.push(i - 2, i - 1, i);
				else out.push(i - 1, i - 2, i);
			}
			return out;
		case GxPrimitive.TRIANGLEFAN:
			for (let i = 2; i < vertexCount; i++) {
				out.push(0, i - 1, i);
			}
			return out;
		case GxPrimitive.QUADS:
		case GxPrimitive.QUADS2:
			for (let i = 0; i + 3 < vertexCount; i += 4) {
				out.push(i + 0, i + 1, i + 2);
				out.push(i + 0, i + 2, i + 3);
			}
			return out;
		case GxPrimitive.LINES:
		case GxPrimitive.LINESTRIP:
		case GxPrimitive.POINTS:
			return out;
		default:
			return null;
	}
}

/** How many triangles a shape's display lists add up to. */
export function shapeTriangleCount(shape: Shp1Shape): number {
	let n = 0;
	for (const packet of shape.packets) {
		for (const prim of packet.primitives) {
			const tris = triangulate(prim.type, prim.vertexCount);
			if (tris) n += tris.length / 3;
		}
	}
	return n;
}

/**
 * Read a shape's vertex descriptor.
 *
 * `NONE`-typed entries are kept in the list (so a slot index still lines up
 * with what a writer intended) but contribute 0 bytes to the stride.
 */
function parseAttributes(
	view: DataView,
	start: number,
	limit: number,
): { attributes: Shp1AttribEntry[]; stride: number } | null {
	const attributes: Shp1AttribEntry[] = [];
	let stride = 0;
	let p = start;
	for (let i = 0; i < MAX_ATTRIB_ENTRIES; i++) {
		if (p + SHP1_ATTRIB_ENTRY_SIZE > limit) return null;
		const attribute = view.getUint32(p + 0x00, false);
		if (attribute === GxAttr.NULL) return { attributes, stride };
		const attrType = view.getUint32(p + 0x04, false);
		const size = gxAttrTypeSize(attrType);
		if (size < 0) return null;
		attributes.push({ attribute, attrType, size });
		stride += size;
		p += SHP1_ATTRIB_ENTRY_SIZE;
	}
	return null;
}

/**
 * Parse a `SHP1` chunk.
 *
 * Returns `null` when the header, the shape table, any shape's descriptor, or
 * any display list is unreadable. Geometry is all-or-nothing on purpose: a
 * half-decoded shape is worse than no shape.
 */
export function parseShp1(bytes: Uint8Array, chunk: J3dChunk): Shp1 | null {
	if (!validateChunk(bytes, chunk)) return null;
	if (chunk.size < CHUNK_HEADER_SIZE + 0x24) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;
	const chunkEnd = chunk.offset + chunk.size;

	const shapeCount = view.getUint16(payload + 0x00, false);
	const shapeRel = view.getUint32(payload + 0x04, false);
	const remapRel = view.getUint32(payload + 0x08, false);
	const nameRel = view.getUint32(payload + 0x0c, false);
	const attributeRel = view.getUint32(payload + 0x10, false);
	const matrixTableRel = view.getUint32(payload + 0x14, false);
	const primitiveDataRel = view.getUint32(payload + 0x18, false);
	const matrixDataRel = view.getUint32(payload + 0x1c, false);
	const packetLocationRel = view.getUint32(payload + 0x20, false);

	const shapeOffset = chunkOffset(chunk, shapeRel, shapeCount * SHP1_SHAPE_SIZE);
	const attributeOffset = chunkOffset(chunk, attributeRel);
	const primitiveDataOffset = chunkOffset(chunk, primitiveDataRel);
	const packetLocationOffset = chunkOffset(chunk, packetLocationRel);
	if (shapeCount > 0) {
		if (shapeOffset < 0) return null;
		if (attributeOffset < 0) return null;
		if (primitiveDataOffset < 0) return null;
		if (packetLocationOffset < 0) return null;
	}

	const remapOffset = chunkOffset(chunk, remapRel, shapeCount * 2);
	const remapTable: number[] = [];
	if (remapOffset >= 0) {
		for (let i = 0; i < shapeCount; i++) {
			remapTable.push(view.getUint16(remapOffset + i * 2, false));
		}
	}

	let names: string[] | null = null;
	const nameOffset = chunkOffset(chunk, nameRel, 4);
	if (nameOffset >= 0) names = readJ3dStringTable(bytes, nameOffset, chunkEnd);

	const matrixTableOffset = chunkOffset(chunk, matrixTableRel);
	const matrixDataOffset = chunkOffset(chunk, matrixDataRel);

	const shapes: Shp1Shape[] = [];
	for (let i = 0; i < shapeCount; i++) {
		const p = shapeOffset + i * SHP1_SHAPE_SIZE;
		const matrixType = view.getUint8(p + 0x00);
		const packetCount = view.getUint16(p + 0x02, false);
		const attribRel = view.getUint16(p + 0x04, false);
		const firstMatrixData = view.getUint16(p + 0x06, false);
		const firstPacketLocation = view.getUint16(p + 0x08, false);
		const boundingSphereRadius = view.getFloat32(p + 0x0c, false);
		const bboxMin: [number, number, number] = [
			view.getFloat32(p + 0x10, false),
			view.getFloat32(p + 0x14, false),
			view.getFloat32(p + 0x18, false),
		];
		const bboxMax: [number, number, number] = [
			view.getFloat32(p + 0x1c, false),
			view.getFloat32(p + 0x20, false),
			view.getFloat32(p + 0x24, false),
		];

		const desc = parseAttributes(view, attributeOffset + attribRel, chunkEnd);
		if (!desc) return null;
		const { attributes, stride } = desc;
		if (stride <= 0) return null;

		const packets: Shp1Packet[] = [];
		for (let k = 0; k < packetCount; k++) {
			const locP =
				packetLocationOffset +
				(firstPacketLocation + k) * SHP1_PACKET_LOCATION_SIZE;
			if (locP + SHP1_PACKET_LOCATION_SIZE > chunkEnd) return null;
			const size = view.getUint32(locP + 0x00, false);
			const rel = view.getUint32(locP + 0x04, false);
			const start = primitiveDataOffset + rel;
			const end = start + size;
			if (start < chunk.offset || end > chunkEnd) return null;

			const primitives = decodePrimitives(view, start, end, attributes, stride);
			if (!primitives) return null;

			// Bone set for this packet. Absent (or unreadable) matrix data just
			// means no skinning info, which costs us nothing for rendering.
			const matrixTable: number[] = [];
			if (matrixDataOffset >= 0 && matrixTableOffset >= 0) {
				const mdP =
					matrixDataOffset + (firstMatrixData + k) * SHP1_MATRIX_DATA_SIZE;
				if (mdP + SHP1_MATRIX_DATA_SIZE <= chunkEnd) {
					const count = view.getUint16(mdP + 0x02, false);
					const first = view.getUint32(mdP + 0x04, false);
					const tableP = matrixTableOffset + first * 2;
					if (tableP + count * 2 <= chunkEnd) {
						for (let m = 0; m < count; m++) {
							matrixTable.push(view.getUint16(tableP + m * 2, false));
						}
					}
				}
			}

			packets.push({ size, offset: start, primitives, matrixTable });
		}

		shapes.push({
			index: i,
			matrixType,
			packetCount,
			attributeOffset: attribRel,
			firstMatrixData,
			firstPacketLocation,
			boundingSphereRadius,
			bboxMin,
			bboxMax,
			attributes,
			vertexStride: stride,
			packets,
		});
	}

	return { shapes, remapTable, names };
}

/**
 * Decode one display list, given the shape's descriptor.
 *
 * Kept separate from {@link parseShp1} so the per-attribute widths can be
 * hoisted out of the vertex loop — reading them out of the descriptor objects
 * for every attribute of every vertex is measurably slower on the ~100k-vertex
 * shapes in Wind Waker's bigger models.
 */
function decodePrimitives(
	view: DataView,
	start: number,
	end: number,
	attributes: readonly Shp1AttribEntry[],
	stride: number,
): Shp1Primitive[] | null {
	const numAttributes = attributes.length;
	const sizes = new Int32Array(numAttributes);
	for (let i = 0; i < numAttributes; i++) sizes[i] = attributes[i].size;

	const out: Shp1Primitive[] = [];
	let p = start;
	while (p < end) {
		const op = view.getUint8(p);
		// GX_NOP: the padding that keeps the list a multiple of 32 bytes.
		if (op === 0x00) {
			p++;
			continue;
		}
		const type = op & 0xf8;
		const vat = op & 0x07;
		if (!gxPrimitiveIsKnown(type)) return null;
		if (p + 3 > end) return null;
		const vertexCount = view.getUint16(p + 1, false);
		p += 3;
		if (p + vertexCount * stride > end) return null;

		const indices = new Uint16Array(vertexCount * numAttributes);
		let q = p;
		for (let v = 0; v < vertexCount; v++) {
			const row = v * numAttributes;
			for (let a = 0; a < numAttributes; a++) {
				const size = sizes[a];
				if (size === 1) indices[row + a] = view.getUint8(q);
				else if (size === 2) indices[row + a] = view.getUint16(q, false);
				q += size;
			}
		}
		p += vertexCount * stride;
		out.push({ type, vat, vertexCount, numAttributes, indices });
	}
	return out;
}
