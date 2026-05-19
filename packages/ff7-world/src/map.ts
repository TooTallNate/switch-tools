/**
 * FF7 PC world-map (`wm0.map` / `wm2.map` / `wm3.map`) parser.
 *
 * Outer layout:
 *   - File = N × 0xB800-byte sections (no header).
 *   - Each section = 16 × u32 pointers (relative to section start),
 *     then up to 16 LZSS-compressed mesh blobs preceded by a u32
 *     "compressed size" length prefix.
 *   - Each section represents a 4×4 grid of 8192×8192-unit "sectors";
 *     sector index `s` is at `(x=s%4, z=s/4)` within the section.
 *
 * World grid:
 *   - WM0: 9 columns × 7 rows = 63 live sections + 5 story-replacement
 *     sections (indices 63..67) that swap into slots {50,41,42,60,47,48}
 *     based on game progress.
 *   - WM2: 3 × 4 = 12 sections (underwater + Junon harbor).
 *   - WM3: 2 × 2 = 4 sections (Great Glacier).
 *
 * Per-mesh layout (after LZSS decompression):
 *
 *   offset  size                 field
 *     0     u16                  numTriangles
 *     2     u16                  numVertices
 *     4     12 × numTriangles    Triangle[]
 *     ...   8 × numVertices      Vertex[]    (int16 x, y, z, w)
 *     ...   8 × numVertices      Normal[]    (int16 x, y, z, w)
 *
 * Triangle record (12 bytes):
 *   0..2   u8[3]   vertex indices (into Vertex[] for THIS sector)
 *   3      u8      bits 0..4 = walkmap type, bits 5..7 = script id
 *   4..9   u8[6]   UV coords: (u0,v0,u1,v1,u2,v2)
 *   10..11 u16     bits 0..8 = texture ID, 9..14 = region ID, 15 = chocobo flag
 *
 * Vertex / Normal records are 4 × int16 each. The 4th component is
 * unused on PC (always 0); ignore it. Normals are not unit-length —
 * normalize at render time.
 *
 * Triangle winding: most reimplementations flip CW→CCW for OpenGL-
 * style rendering. Track this empirically.
 *
 * UVs are RAW PSX VRAM coordinates (0..255). Convert via the
 * per-texture offset/size table in `texture-table.ts`:
 *   `u = (rawU - tex.uOffset) / tex.width`
 *   (result may be negative — sample with WRAP / REPEAT)
 */

import { decompressLzss } from '@tootallnate/ff7-flevel';

export const SECTION_SIZE = 0xb800 as const;
export const SECTORS_PER_SECTION = 16 as const;
export const SECTOR_WORLD_SIZE = 8192 as const;

export class WorldMapParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorldMapParseError';
	}
}

export interface WorldMapTriangle {
	/** Vertex indices into the SECTOR's local vertex array (0..255). */
	v0: number;
	v1: number;
	v2: number;
	/** Walkmap type code (0..31). See `WALKMAP_NAMES` for human strings. */
	walkmap: number;
	/**
	 * Script function ID. The raw upper 3 bits store `(funcId + 3)`
	 * for values ≥ 3; we expose the resolved 0-or-positive function
	 * ID here (0 = no script). See the wiki for the function table.
	 */
	functionId: number;
	/** Triangle UVs, raw 0..255 PSX VRAM coords. */
	u0: number;
	v0uv: number;
	u1: number;
	v1uv: number;
	u2: number;
	v2uv: number;
	/** Texture page (0..511; only 0..281 used in WM0). */
	textureId: number;
	/** Region ID (0..63). */
	regionId: number;
	/** True if chocobo encounters can occur on this triangle. */
	hasChocoboTracks: boolean;
}

export interface WorldMapVertex {
	x: number;
	y: number;
	z: number;
}

export interface WorldMapSector {
	/** Sector index within its section (0..15). */
	sectorIndex: number;
	/** Sector grid position within its section: 0..3. */
	gridX: number;
	gridZ: number;
	/** World-space offset of this sector's local (0,0,0) origin. */
	offsetX: number;
	offsetZ: number;
	triangles: WorldMapTriangle[];
	vertices: WorldMapVertex[];
	normals: WorldMapVertex[];
}

export interface WorldMapSection {
	/** Section index (0..67 for WM0, 0..11 for WM2, 0..3 for WM3). */
	sectionIndex: number;
	sectors: WorldMapSector[];
}

export interface ParsedWorldMap {
	/** Section grid width (9 for WM0, 3 for WM2, 2 for WM3). */
	gridWidth: number;
	/** Section grid height (7 for WM0, 4 for WM2, 2 for WM3). */
	gridHeight: number;
	/**
	 * Number of sections that fill the visible grid (`gridWidth ×
	 * gridHeight`). Sections beyond this count are story-replacements
	 * (WM0 only) that swap into specific live slots based on game
	 * progress — non-game viewers should typically ignore them.
	 */
	liveSections: number;
	/** All sections in file order. */
	sections: WorldMapSection[];
}

/**
 * Auto-detect which world map this is from its file size.
 *
 * Section counts vary between releases:
 *   WM0: 68 (PC original) or 69 (Switch — one extra alternate)
 *   WM2: 12 (3 × 4 grid)
 *   WM3: 4 (2 × 2 grid)
 *
 * For unknown counts we default to "overworld" geometry (9 × 7)
 * since the alternative — a 1-wide strip — looks visibly wrong.
 */
function detectGrid(byteCount: number): {
	gridWidth: number;
	gridHeight: number;
	liveSections: number;
} {
	const sectionCount = Math.floor(byteCount / SECTION_SIZE);
	if (sectionCount >= 60) {
		// WM0 variants. Only the first 63 sections (9 × 7) form
		// the live grid; the rest are story-replacement blocks.
		return { gridWidth: 9, gridHeight: 7, liveSections: 63 };
	}
	if (sectionCount === 12) {
		return { gridWidth: 3, gridHeight: 4, liveSections: 12 };
	}
	if (sectionCount === 4) {
		return { gridWidth: 2, gridHeight: 2, liveSections: 4 };
	}
	return { gridWidth: 1, gridHeight: sectionCount, liveSections: sectionCount };
}

export function parseWorldMap(bytes: Uint8Array): ParsedWorldMap {
	if (bytes.length === 0 || bytes.length % SECTION_SIZE !== 0) {
		throw new WorldMapParseError(
			`World-map file size (${bytes.length}) is not a multiple of ${SECTION_SIZE}`,
		);
	}
	const { gridWidth, gridHeight, liveSections } = detectGrid(bytes.length);
	const sectionCount = bytes.length / SECTION_SIZE;
	const sections: WorldMapSection[] = [];
	for (let s = 0; s < sectionCount; s++) {
		sections.push(parseSection(bytes, s));
	}
	return { gridWidth, gridHeight, liveSections, sections };
}

function parseSection(bytes: Uint8Array, sectionIndex: number): WorldMapSection {
	const base = sectionIndex * SECTION_SIZE;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const sectors: WorldMapSector[] = [];
	for (let s = 0; s < SECTORS_PER_SECTION; s++) {
		const ptr = view.getUint32(base + s * 4, true);
		// Pointer is relative to the start of the section. Skip
		// sectors whose pointer is obviously bogus (out of section
		// bounds) — defensive.
		if (ptr >= SECTION_SIZE) continue;
		const meshAbsOff = base + ptr;
		if (meshAbsOff + 4 > bytes.length) continue;
		const compSize = view.getUint32(meshAbsOff, true);
		if (compSize === 0 || meshAbsOff + 4 + compSize > bytes.length) continue;
		// LZSS payload follows the size prefix.
		const lzssBlob = bytes.subarray(meshAbsOff, meshAbsOff + 4 + compSize);
		// `decompressLzss` reads `bytes[0..4]` as declared length;
		// FF7 world-map uses the same convention.
		let decompressed: Uint8Array;
		try {
			decompressed = decompressLzss(lzssBlob);
		} catch {
			continue;
		}
		const sector = parseMesh(decompressed, s);
		sectors.push(sector);
	}
	return { sectionIndex, sectors };
}

function parseMesh(bytes: Uint8Array, sectorIndex: number): WorldMapSector {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 4) {
		throw new WorldMapParseError(
			`Mesh too short (${bytes.length} bytes); need at least 4 for header`,
		);
	}
	const numTriangles = view.getUint16(0, true);
	const numVertices = view.getUint16(2, true);
	const expectedSize = 4 + 12 * numTriangles + 8 * numVertices * 2;
	if (bytes.length < expectedSize) {
		throw new WorldMapParseError(
			`Mesh declares ${numTriangles} tris + ${numVertices} verts (expect ${expectedSize} bytes), got ${bytes.length}`,
		);
	}
	const triangles: WorldMapTriangle[] = new Array(numTriangles);
	for (let t = 0; t < numTriangles; t++) {
		const off = 4 + t * 12;
		const v0 = view.getUint8(off + 0);
		const v1 = view.getUint8(off + 1);
		const v2 = view.getUint8(off + 2);
		const walkPacked = view.getUint8(off + 3);
		const u0 = view.getUint8(off + 4);
		const v0uv = view.getUint8(off + 5);
		const u1 = view.getUint8(off + 6);
		const v1uv = view.getUint8(off + 7);
		const u2 = view.getUint8(off + 8);
		const v2uv = view.getUint8(off + 9);
		const texLoc = view.getUint16(off + 10, true);
		const funcRaw = walkPacked >> 5; // 0..7
		triangles[t] = {
			v0,
			v1,
			v2,
			walkmap: walkPacked & 0x1f,
			functionId: funcRaw >= 3 ? funcRaw - 3 : 0,
			u0,
			v0uv,
			u1,
			v1uv,
			u2,
			v2uv,
			textureId: texLoc & 0x1ff,
			regionId: (texLoc >> 9) & 0x3f,
			hasChocoboTracks: (texLoc & 0x8000) !== 0,
		};
	}
	const vertices: WorldMapVertex[] = new Array(numVertices);
	const vertsBase = 4 + 12 * numTriangles;
	for (let i = 0; i < numVertices; i++) {
		const off = vertsBase + i * 8;
		vertices[i] = {
			x: view.getInt16(off + 0, true),
			y: view.getInt16(off + 2, true),
			z: view.getInt16(off + 4, true),
		};
	}
	const normals: WorldMapVertex[] = new Array(numVertices);
	const normsBase = vertsBase + 8 * numVertices;
	for (let i = 0; i < numVertices; i++) {
		const off = normsBase + i * 8;
		normals[i] = {
			x: view.getInt16(off + 0, true),
			y: view.getInt16(off + 2, true),
			z: view.getInt16(off + 4, true),
		};
	}
	return {
		sectorIndex,
		gridX: sectorIndex % 4,
		gridZ: Math.floor(sectorIndex / 4),
		offsetX: SECTOR_WORLD_SIZE * (sectorIndex % 4),
		offsetZ: SECTOR_WORLD_SIZE * Math.floor(sectorIndex / 4),
		triangles,
		vertices,
		normals,
	};
}

/**
 * Compute the absolute world-space position of a vertex from its
 * sector-local coords + the parent section's grid position.
 */
export function sectorVertexWorld(
	vert: WorldMapVertex,
	sector: WorldMapSector,
	sectionGridX: number,
	sectionGridZ: number,
): WorldMapVertex {
	const sectionBlock = 4 * SECTOR_WORLD_SIZE;
	return {
		x: vert.x + sector.offsetX + sectionGridX * sectionBlock,
		y: vert.y,
		z: vert.z + sector.offsetZ + sectionGridZ * sectionBlock,
	};
}
