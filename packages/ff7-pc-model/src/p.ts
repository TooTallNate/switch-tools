/**
 * FF7 "P file" (`.p`) binary mesh parser.
 *
 * Despite the `.p` extension and the `.PLY` references inside
 * the sibling RSD, this is NOT Stanford PLY. It's Square's
 * bespoke 90s polygon format used by PC FF7 for character /
 * battle / location meshes.
 *
 * # File layout
 *
 *     header                 128 bytes (64 of metadata + 64 runtime)
 *     vertices[]             12 B × NumVertices (vec3 float32 LE)
 *     normals[]              12 B × NumNormals
 *     unknown1[]             12 B × NumUnknown1
 *     texCoords[]            8  B × NumTexCoords (vec2 float32)
 *     vertexColors[]         4  B × NumVertexColors (BGRA8)
 *     polygonColors[]        4  B × NumPolygons (BGRA8)
 *     edges[]                4  B × NumEdges (u16 + u16)
 *     polygons[]             24 B × NumPolygons (PpolygonStruct)
 *     unknown2[]             24 B × NumUnknown2
 *     unknown3[]             3  B × NumUnknown3
 *     hundreds[]             ?  × NumHundreds (render state — opaque)
 *     groups[]               56 B × NumGroups
 *     boundingBoxes[]        24 B × NumBoundingBoxes
 *     normalIndexTable[]     4  B × NumVertices (if NormIndexTableFlag set)
 *
 * The mesh is rendered group-by-group: each group records
 * (PrimitiveType, PolygonStart, PolygonCount, VertexStart,
 * VertexCount, TexCoordStart, AreTexturesUsed, TextureNumber).
 * Polygon vertex / texcoord indices are GROUP-RELATIVE — you
 * add the group's start offsets to get the actual array index.
 *
 * Each polygon is a triangle (3 vertex indices + 3 normal
 * indices + 3 edge indices + a 4 byte preamble + 4 trailer
 * bytes). Triangle winding matches typical D3D / OpenGL (CCW
 * outward).
 */

const HEADER_TOTAL_SIZE = 0x80; // 64 metadata + 64 runtime
const HEADER_META_SIZE = 0x40;

/** One render group inside a P file. */
export interface PGroup {
	primitiveType: number;
	polygonStartIndex: number;
	numPolygons: number;
	verticesStartIndex: number;
	numVertices: number;
	edgeStartIndex: number;
	numEdges: number;
	texCoordStartIndex: number;
	areTexturesUsed: boolean;
	/** Slot index into the RSD's `textures[]` array. */
	textureNumber: number;
}

/** One polygon (always a triangle in retail FF7 P files). */
export interface PPolygon {
	/** GROUP-RELATIVE vertex indices (add group.verticesStartIndex). */
	vertexIndex: [number, number, number];
	/** GROUP-RELATIVE normal indices. */
	normalIndex: [number, number, number];
}

export interface ParsedP {
	version: number;
	vertexType: number;
	/** Flat vec3 array — `positions[i*3 + 0..2]` is vertex `i`. */
	positions: Float32Array;
	/** Flat vec3 array — same indexing as `positions`. */
	normals: Float32Array;
	/** Flat vec2 array — `texCoords[i*2 + 0..1]` is texcoord `i`. */
	texCoords: Float32Array;
	/** Per-vertex BGRA8 colors (flat — 4 bytes per vertex). */
	vertexColors: Uint8Array;
	/** Per-polygon BGRA8 colors (4 bytes per polygon). */
	polygonColors: Uint8Array;
	polygons: PPolygon[];
	groups: PGroup[];
	/** Min/max corners for each bounding box (6 floats each). */
	boundingBoxes: Float32Array;
}

export class PParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PParseError';
	}
}

/**
 * Sniff whether bytes look like an FF7 P file. The format has
 * no proper magic — `version` is always 1 and there's a 1 at
 * offset 4 — so we check the smaller integer footprint of the
 * fixed header bytes.
 */
export function isPMesh(bytes: Uint8Array): boolean {
	if (bytes.byteLength < HEADER_TOTAL_SIZE) return false;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = v.getUint32(0, true);
	const constOne = v.getUint32(4, true);
	const vertexType = v.getUint32(8, true);
	// Version is always 1; word at +4 is always 1; vertexType is
	// 0..2 in retail data. Plus the polygon count + group count
	// should be > 0 and sensible.
	if (version !== 1) return false;
	if (constOne !== 1) return false;
	if (vertexType > 2) return false;
	const numPolys = v.getUint32(0x24, true);
	const numGroups = v.getUint32(0x34, true);
	if (numPolys === 0 || numPolys > 200_000) return false;
	if (numGroups === 0 || numGroups > 1024) return false;
	return true;
}

/**
 * Parse an FF7 P-format mesh into typed arrays + group records.
 *
 * The returned arrays are the raw, group-relative source data.
 * Use {@link extractTrianglesForGroup} (below) to emit a flat
 * triangle-list suitable for a Three.js `BufferGeometry`.
 */
export function parsePMesh(bytes: Uint8Array): ParsedP {
	if (bytes.byteLength < HEADER_TOTAL_SIZE) {
		throw new PParseError(`P file too small (${bytes.byteLength} bytes)`);
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = v.getUint32(0, true);
	if (version !== 1) {
		throw new PParseError(`Unsupported P version ${version}`);
	}
	const vertexType = v.getUint32(8, true);
	const numVertices = v.getUint32(0x0c, true);
	const numNormals = v.getUint32(0x10, true);
	const numUnknown1 = v.getUint32(0x14, true);
	const numTexCoords = v.getUint32(0x18, true);
	const numVertexColors = v.getUint32(0x1c, true);
	const numEdges = v.getUint32(0x20, true);
	const numPolygons = v.getUint32(0x24, true);
	const numUnknown2 = v.getUint32(0x28, true);
	const numUnknown3 = v.getUint32(0x2c, true);
	const numHundreds = v.getUint32(0x30, true);
	const numGroups = v.getUint32(0x34, true);
	const numBoundingBoxes = v.getUint32(0x38, true);
	const normIndexTableFlag = v.getUint32(0x3c, true);

	let cursor = HEADER_TOTAL_SIZE;

	const positions = readVec3Array(v, cursor, numVertices);
	cursor += 12 * numVertices;

	const normals = readVec3Array(v, cursor, numNormals);
	cursor += 12 * numNormals;

	// Skip unknown1
	cursor += 12 * numUnknown1;

	const texCoords = readVec2Array(v, cursor, numTexCoords);
	cursor += 8 * numTexCoords;

	const vertexColors = bytes.subarray(cursor, cursor + 4 * numVertexColors);
	cursor += 4 * numVertexColors;

	const polygonColors = bytes.subarray(cursor, cursor + 4 * numPolygons);
	cursor += 4 * numPolygons;

	// Edges — skip
	cursor += 4 * numEdges;

	const polygons: PPolygon[] = [];
	for (let i = 0; i < numPolygons; i++) {
		const off = cursor + i * 24;
		// Bytes 0..1: zero / padding (per spec).
		const v0 = v.getUint16(off + 2, true);
		const v1 = v.getUint16(off + 4, true);
		const v2 = v.getUint16(off + 6, true);
		const n0 = v.getUint16(off + 8, true);
		const n1 = v.getUint16(off + 10, true);
		const n2 = v.getUint16(off + 12, true);
		polygons.push({
			vertexIndex: [v0, v1, v2],
			normalIndex: [n0, n1, n2],
		});
	}
	cursor += 24 * numPolygons;

	// Skip unknown2, unknown3, hundreds
	cursor += 24 * numUnknown2;
	cursor += 3 * numUnknown3;
	// Hundreds: each is a 100-byte render-state record. (Some
	// FF7 builds emit other sizes — most reverse-engineered code
	// treats it as opaque. The wiki spec doesn't define a size,
	// so we use the conventional 100 bytes here.)
	cursor += 100 * numHundreds;

	const groups: PGroup[] = [];
	for (let i = 0; i < numGroups; i++) {
		const off = cursor + i * 56;
		groups.push({
			primitiveType: v.getUint32(off + 0x00, true),
			polygonStartIndex: v.getUint32(off + 0x04, true),
			numPolygons: v.getUint32(off + 0x08, true),
			verticesStartIndex: v.getUint32(off + 0x0c, true),
			numVertices: v.getUint32(off + 0x10, true),
			edgeStartIndex: v.getUint32(off + 0x14, true),
			numEdges: v.getUint32(off + 0x18, true),
			// u1..u4 at 0x1c..0x2b: unknown
			texCoordStartIndex: v.getUint32(off + 0x2c, true),
			areTexturesUsed: v.getUint32(off + 0x30, true) !== 0,
			textureNumber: v.getUint32(off + 0x34, true),
		});
	}
	cursor += 56 * numGroups;

	const boundingBoxes = new Float32Array(6 * numBoundingBoxes);
	for (let i = 0; i < 6 * numBoundingBoxes; i++) {
		boundingBoxes[i] = v.getFloat32(cursor + i * 4, true);
	}
	cursor += 24 * numBoundingBoxes;

	void normIndexTableFlag;

	return {
		version,
		vertexType,
		positions,
		normals,
		texCoords,
		vertexColors,
		polygonColors,
		polygons,
		groups,
		boundingBoxes,
	};
}

function readVec3Array(v: DataView, offset: number, count: number): Float32Array {
	const out = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		out[i * 3 + 0] = v.getFloat32(offset + i * 12 + 0, true);
		out[i * 3 + 1] = v.getFloat32(offset + i * 12 + 4, true);
		out[i * 3 + 2] = v.getFloat32(offset + i * 12 + 8, true);
	}
	return out;
}

function readVec2Array(v: DataView, offset: number, count: number): Float32Array {
	const out = new Float32Array(count * 2);
	for (let i = 0; i < count; i++) {
		out[i * 2 + 0] = v.getFloat32(offset + i * 8 + 0, true);
		out[i * 2 + 1] = v.getFloat32(offset + i * 8 + 4, true);
	}
	return out;
}

/**
 * Build a flat triangle list for one group as `{ positions,
 * normals, texCoords?, indices }`. Each triangle pulls 3
 * vertices from the file's vertex pool (rebased through
 * `group.verticesStartIndex`) and stores them as UNIQUE
 * vertices in the output — i.e. no vertex sharing across
 * triangles, because FF7's normals and UVs are per-polygon
 * not per-vertex, so deduplicating would lose information.
 *
 * Output is `Float32Array` (positions / normals / UVs) and
 * `Uint32Array` (indices). Suitable for direct hand-off to a
 * Three.js `BufferGeometry`.
 */
export function extractTrianglesForGroup(
	parsed: ParsedP,
	group: PGroup,
): {
	positions: Float32Array;
	normals: Float32Array;
	colors: Float32Array;
	texCoords: Float32Array | null;
	indices: Uint32Array;
} {
	const tris = parsed.polygons.slice(
		group.polygonStartIndex,
		group.polygonStartIndex + group.numPolygons,
	);
	const out = {
		positions: new Float32Array(tris.length * 9),
		normals: new Float32Array(tris.length * 9),
		// Per-vertex RGB linear floats (3 floats per vertex). FF7
		// stores BGRA8 — we drop alpha and convert to 0..1 floats.
		colors: new Float32Array(tris.length * 9),
		texCoords: group.areTexturesUsed
			? new Float32Array(tris.length * 6)
			: null,
		indices: new Uint32Array(tris.length * 3),
	};
	for (let t = 0; t < tris.length; t++) {
		const tri = tris[t]!;
		for (let k = 0; k < 3; k++) {
			const vIdx = tri.vertexIndex[k] + group.verticesStartIndex;
			const nIdx = tri.normalIndex[k] + group.verticesStartIndex;
			out.positions[t * 9 + k * 3 + 0] = parsed.positions[vIdx * 3 + 0]!;
			out.positions[t * 9 + k * 3 + 1] = parsed.positions[vIdx * 3 + 1]!;
			out.positions[t * 9 + k * 3 + 2] = parsed.positions[vIdx * 3 + 2]!;
			if (nIdx * 3 + 2 < parsed.normals.length) {
				out.normals[t * 9 + k * 3 + 0] = parsed.normals[nIdx * 3 + 0]!;
				out.normals[t * 9 + k * 3 + 1] = parsed.normals[nIdx * 3 + 1]!;
				out.normals[t * 9 + k * 3 + 2] = parsed.normals[nIdx * 3 + 2]!;
			}
			// BGRA8 → RGB float. Vertex colors are indexed by
			// the polygon's vertexIndex (rebased through the
			// group's verticesStartIndex), same as positions.
			const cIdx = vIdx * 4;
			if (cIdx + 2 < parsed.vertexColors.length) {
				out.colors[t * 9 + k * 3 + 0] = parsed.vertexColors[cIdx + 2]! / 255;
				out.colors[t * 9 + k * 3 + 1] = parsed.vertexColors[cIdx + 1]! / 255;
				out.colors[t * 9 + k * 3 + 2] = parsed.vertexColors[cIdx + 0]! / 255;
			} else {
				out.colors[t * 9 + k * 3 + 0] = 1;
				out.colors[t * 9 + k * 3 + 1] = 1;
				out.colors[t * 9 + k * 3 + 2] = 1;
			}
			if (out.texCoords) {
				const uvIdx = tri.vertexIndex[k] + group.texCoordStartIndex;
				if (uvIdx * 2 + 1 < parsed.texCoords.length) {
					out.texCoords[t * 6 + k * 2 + 0] = parsed.texCoords[uvIdx * 2 + 0]!;
					out.texCoords[t * 6 + k * 2 + 1] = parsed.texCoords[uvIdx * 2 + 1]!;
				}
			}
			out.indices[t * 3 + k] = t * 3 + k;
		}
	}
	return out;
}
