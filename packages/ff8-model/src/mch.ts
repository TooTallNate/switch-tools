/**
 * FFVIII MCH model-body parser.
 *
 * An MCH body holds a PSX-style skinned mesh + a list of frame-
 * compressed animations. The body has a 64-byte `ModelHeader`
 * whose offsets are all RELATIVE to the start of the body. When
 * an MCH ships embedded in `chara.one`, the body is somewhere
 * inside an entry payload (offset reported by `parseCharaOne`).
 * When an MCH ships standalone as a `d###.mch` file, the file
 * starts with a TIM table-of-contents at offsets `[0, 0x100)`
 * terminated by `0xFFFFFFFF`, followed by a `modelOffset` u32,
 * followed by the body.
 *
 * The 64-byte ModelHeader (all values u32 little-endian unless
 * noted):
 *
 *     0x00  u32  boneCount
 *     0x04  u32  vertexCount
 *     0x08  u32  textureAnimationCount
 *     0x0C  u32  faceCount
 *     0x10  u32  unknown1Count
 *     0x14  u32  skinObjectCount
 *     0x18  u32  padding              (must be 0; sanity check)
 *     0x1C  u16  triangleCount
 *     0x1E  u16  quadCount
 *     0x20  u32  bonesOffset
 *     0x24  u32  verticesOffset
 *     0x28  u32  textureAnimationOffset
 *     0x2C  u32  facesOffset
 *     0x30  u32  unknown1Offset
 *     0x34  u32  skinObjectsOffset
 *     0x38  u32  animationsOffset
 *     0x3C  u16  unknown3a
 *     0x3E  u16  unknown3b
 *
 * Bone (64 bytes):
 *     0x00  u16  parentId           (1-based; 0 = no parent / root)
 *     0x02  u16  unknown1
 *     0x04  u32  unknown2
 *     0x08  i16  size               (signed bone length)
 *     0x0A  ... 54 bytes of opaque per-bone parameters
 *
 *  Note: deling treats `parentId == 0` as "root, no parent" and
 *  OpenVIII agrees; we expose `parentId` as the *raw* on-disk
 *  value (0 = root) AND a separate `logicalParent` field
 *  (`parentId - 1`, or `-1` for root) for direct array indexing.
 *
 * Vertex (8 bytes): 4 × i16 — (x, y, z, padding). PSX vertices
 * are usually 6 bytes; FF8 pads to 8 for alignment.
 *
 * Face (64 bytes): we expose the geometry-relevant subset.
 *     0x00  u32  polyType   (0x07060125 = TRI, 0x09070D01 = QUAD —
 *                            stored as 4 LE bytes; both byte
 *                            orderings appear in different sources.
 *                            We accept either form, plus
 *                            0x25010607 / 0x2D010709.)
 *     0x04  u16  cba        (CLUT id; palette index in TIM)
 *     0x06  u16  tsb        (texture state — `tsb & 0xF` = TIM index)
 *     0x08  u16  vertexIndex[4]
 *     0x10  u16  normalIndex[4]    (often dummy)
 *     0x18  i8x2 uv[4]              (texture coords, 0..255)
 *     0x20  rgba colors[4]          (per-vertex BGRA on PSX)
 *     0x30  ... 16 bytes of mode / opacity / flags
 *
 * SkinObject (8 bytes):
 *     0x00  u16  vertexIndex        (first vertex this group covers)
 *     0x02  u16  vertexCount        (how many vertices in the group)
 *     0x04  u16  boneId             (1-based, like bone parents)
 *     0x06  u16  unknown
 *
 * ModelUnknown1 (32 bytes): opaque; preserved as raw bytes.
 *
 * Animation block at `animationsOffset`:
 *     u16  animCount
 *     then `animCount` animations, each:
 *         u16 framesCount
 *         u16 bonesCount
 *         per frame:
 *             vec3 i16  rootTranslation
 *             per bone: 4-byte packed rotation (decoded via
 *             {@link unpackRotationDegrees})
 *
 * Triangle vertex order: OpenVIII emits the indices as
 * `(C, A, B)` rather than `(A, B, C)` to match PSX winding.
 * Quad triangulation follows the PSX "Z" pattern:
 *   triangle 1 = (0, 1, 3)
 *   triangle 2 = (0, 2, 3)   ← NOT (0,2,3)→(0,1,3) for some other formats
 *
 * References: deling (`Source/files/MchFile.cpp`), OpenVIII-
 * monogame (`Field/MCH/*`), kujata's FF7 field-model code (the
 * formats are closely related).
 */

import { unpackRotationDegrees } from './animation-decode.js';

export class MchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MchParseError';
	}
}

export const MCH_HEADER_SIZE = 64 as const;
export const MCH_BONE_SIZE = 64 as const;
export const MCH_VERTEX_SIZE = 8 as const;
export const MCH_FACE_SIZE = 64 as const;
export const MCH_SKIN_SIZE = 8 as const;
export const MCH_UNKNOWN1_SIZE = 32 as const;

export interface McbBone {
	/**
	 * Raw on-disk parent ID (1-based: 0 = no parent / root,
	 * 1 = first bone, 2 = second bone, etc).
	 */
	parentId: number;
	/**
	 * Zero-based parent index for direct array lookup
	 * (= `parentId - 1`, or `-1` for the root).
	 */
	logicalParent: number;
	/** Signed bone length / "size". */
	size: number;
	/** Same as `size` but exposed for clarity. */
	rawSize: number;
}

export interface McbFace {
	isQuad: boolean;
	/** Vertex indices, length is 4 for quads, 3 for triangles. */
	vertexIndexes: [number, number, number, number];
	/** Normal indices (parallel to `vertexIndexes`). */
	normalIndexes: [number, number, number, number];
	/** Per-vertex packed RGBA (callers split as needed). */
	colors: [number, number, number, number];
	/** Per-vertex UV in 0..255. */
	texCoords: [[number, number], [number, number], [number, number], [number, number]];
	/** Index of the TIM in the chara.one TIM list (or sibling MCH). */
	textureIndex: number;
}

export interface McbSkin {
	vertexIndex: number;
	vertexCount: number;
	/** 1-based bone ID; 0 means "no bone" / root attachment. */
	boneId: number;
	/** Zero-based for array lookup (-1 for "none"). */
	logicalBone: number;
}

export interface McbAnimationFrame {
	rootTranslation: [number, number, number];
	/** Per-bone (rotX, rotY, rotZ) in DEGREES. */
	boneRotations: [number, number, number][];
}

export interface McbAnimation {
	framesCount: number;
	bonesCount: number;
	frames: McbAnimationFrame[];
}

export interface ParsedMch {
	bones: McbBone[];
	/** Raw i16 vertex coords (caller scales as needed). */
	vertices: [number, number, number][];
	faces: McbFace[];
	skinObjects: McbSkin[];
	animations: McbAnimation[];
	/**
	 * Standalone MCH only: absolute offsets within the input
	 * buffer of the TIM entries listed in the TOC.
	 */
	embeddedTimOffsets?: number[];
	/**
	 * Standalone MCH only: byte offset where the model body
	 * starts (== the value of the TOC's terminating `modelOffset`
	 * field).
	 */
	bodyOffset?: number;
}

export interface ParseMchOptions {
	/**
	 * Byte offset (within `bytes`) where the MCH `ModelHeader`
	 * begins. For chara.one-embedded models the caller supplies
	 * this directly (it's `entry.modelOffset - entry.dataOffset`).
	 * For standalone `d###.mch` files leave undefined and we'll
	 * read the TIM TOC at `[0, 0x100)` to discover it.
	 */
	bodyOffset?: number;
}

function readModelHeader(view: DataView, base: number) {
	return {
		boneCount: view.getUint32(base + 0x00, true),
		vertexCount: view.getUint32(base + 0x04, true),
		textureAnimationCount: view.getUint32(base + 0x08, true),
		faceCount: view.getUint32(base + 0x0c, true),
		unknown1Count: view.getUint32(base + 0x10, true),
		skinObjectCount: view.getUint32(base + 0x14, true),
		padding: view.getUint32(base + 0x18, true),
		triangleCount: view.getUint16(base + 0x1c, true),
		quadCount: view.getUint16(base + 0x1e, true),
		bonesOffset: view.getUint32(base + 0x20, true),
		verticesOffset: view.getUint32(base + 0x24, true),
		textureAnimationOffset: view.getUint32(base + 0x28, true),
		facesOffset: view.getUint32(base + 0x2c, true),
		unknown1Offset: view.getUint32(base + 0x30, true),
		skinObjectsOffset: view.getUint32(base + 0x34, true),
		animationsOffset: view.getUint32(base + 0x38, true),
		unknown3a: view.getUint16(base + 0x3c, true),
		unknown3b: view.getUint16(base + 0x3e, true),
	};
}

/**
 * Parse a TIM table-of-contents from `[0, 0x100)` of a
 * standalone MCH file: u32 offsets terminated by 0xFFFFFFFF,
 * then a u32 modelOffset.
 */
function readStandaloneToc(
	bytes: Uint8Array,
	view: DataView,
): { timOffsets: number[]; bodyOffset: number } {
	const tocLimit = Math.min(0x100, bytes.length);
	const timOffsets: number[] = [];
	let p = 0;
	while (p + 4 <= tocLimit) {
		const v = view.getUint32(p, true);
		p += 4;
		if (v === 0xffffffff) {
			if (p + 4 > bytes.length) {
				throw new MchParseError(
					'Standalone MCH truncated before modelOffset',
				);
			}
			const bodyOffset = view.getUint32(p, true);
			return { timOffsets, bodyOffset };
		}
		timOffsets.push(v);
	}
	throw new MchParseError(
		'Standalone MCH has no 0xFFFFFFFF TOC terminator within first 0x100 bytes',
	);
}

export function parseMch(
	bytes: Uint8Array,
	opts: ParseMchOptions = {},
): ParsedMch {
	if (bytes.length < MCH_HEADER_SIZE) {
		throw new MchParseError(
			`MCH too short (${bytes.length} bytes); need at least ${MCH_HEADER_SIZE}`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);

	let bodyOffset: number;
	let embeddedTimOffsets: number[] | undefined;
	if (opts.bodyOffset !== undefined) {
		bodyOffset = opts.bodyOffset;
	} else {
		const toc = readStandaloneToc(bytes, view);
		bodyOffset = toc.bodyOffset;
		embeddedTimOffsets = toc.timOffsets;
	}

	if (bodyOffset + MCH_HEADER_SIZE > bytes.length) {
		throw new MchParseError(
			`MCH bodyOffset 0x${bodyOffset.toString(16)} overruns buffer (length ${bytes.length})`,
		);
	}

	const h = readModelHeader(view, bodyOffset);
	if (h.padding !== 0) {
		throw new MchParseError(
			`MCH header padding non-zero (0x${h.padding.toString(16)}); likely wrong bodyOffset`,
		);
	}
	if (h.boneCount > 4096 || h.vertexCount > 65535 || h.faceCount > 65535) {
		throw new MchParseError(
			`MCH header counts implausible: bones=${h.boneCount} verts=${h.vertexCount} faces=${h.faceCount}`,
		);
	}

	// ---------------------------------------------------------
	// Bones
	// ---------------------------------------------------------
	const bones: McbBone[] = [];
	{
		const base = bodyOffset + h.bonesOffset;
		const need = base + h.boneCount * MCH_BONE_SIZE;
		if (need > bytes.length) {
			throw new MchParseError(
				`MCH bones overrun buffer (need ${need}, have ${bytes.length})`,
			);
		}
		for (let i = 0; i < h.boneCount; i++) {
			const off = base + i * MCH_BONE_SIZE;
			const parentId = view.getUint16(off + 0x00, true);
			// off + 0x02: u16 unknown1
			// off + 0x04: u32 unknown2
			const size = view.getInt16(off + 0x08, true);
			bones.push({
				parentId,
				logicalParent: parentId === 0 ? -1 : parentId - 1,
				size,
				rawSize: size,
			});
		}
	}

	// ---------------------------------------------------------
	// Vertices
	// ---------------------------------------------------------
	const vertices: [number, number, number][] = [];
	{
		const base = bodyOffset + h.verticesOffset;
		const need = base + h.vertexCount * MCH_VERTEX_SIZE;
		if (need > bytes.length) {
			throw new MchParseError(
				`MCH vertices overrun buffer (need ${need}, have ${bytes.length})`,
			);
		}
		for (let i = 0; i < h.vertexCount; i++) {
			const off = base + i * MCH_VERTEX_SIZE;
			const x = view.getInt16(off + 0, true);
			const y = view.getInt16(off + 2, true);
			const z = view.getInt16(off + 4, true);
			vertices.push([x, y, z]);
		}
	}

	// ---------------------------------------------------------
	// Faces (triangles first, then quads)
	// ---------------------------------------------------------
	const faces: McbFace[] = [];
	{
		const base = bodyOffset + h.facesOffset;
		const need = base + h.faceCount * MCH_FACE_SIZE;
		if (need > bytes.length) {
			throw new MchParseError(
				`MCH faces overrun buffer (need ${need}, have ${bytes.length})`,
			);
		}
		for (let i = 0; i < h.faceCount; i++) {
			const off = base + i * MCH_FACE_SIZE;
			const polyType = view.getUint32(off + 0x00, true);
			// Triangles: 0x07060125 (= 0x25 0x01 0x06 0x07 LE) or the
			// reverse 0x25010607. Quads: 0x09070D01 or 0x2D010709.
			// We accept either polarity.
			const isQuad =
				polyType === 0x09070d01 ||
				polyType === 0x2d010709 ||
				// Spec mentions some variants; fall back to using the
				// quadCount split rather than relying on polyType.
				i >= h.triangleCount;

			// CLUT / TSB
			void view.getUint16(off + 0x04, true);
			const tsb = view.getUint16(off + 0x06, true);
			const textureIndex = tsb & 0xf;

			const v0 = view.getUint16(off + 0x08, true);
			const v1 = view.getUint16(off + 0x0a, true);
			const v2 = view.getUint16(off + 0x0c, true);
			const v3 = view.getUint16(off + 0x0e, true);

			const n0 = view.getUint16(off + 0x10, true);
			const n1 = view.getUint16(off + 0x12, true);
			const n2 = view.getUint16(off + 0x14, true);
			const n3 = view.getUint16(off + 0x16, true);

			// UVs are 4 × (u8 u, u8 v).
			const u0 = bytes[off + 0x18] ?? 0;
			const tv0 = bytes[off + 0x19] ?? 0;
			const u1 = bytes[off + 0x1a] ?? 0;
			const tv1 = bytes[off + 0x1b] ?? 0;
			const u2 = bytes[off + 0x1c] ?? 0;
			const tv2 = bytes[off + 0x1d] ?? 0;
			const u3 = bytes[off + 0x1e] ?? 0;
			const tv3 = bytes[off + 0x1f] ?? 0;

			// Per-vertex colours: 4 × u32 (packed RGBA / BGRA).
			const c0 = view.getUint32(off + 0x20, true);
			const c1 = view.getUint32(off + 0x24, true);
			const c2 = view.getUint32(off + 0x28, true);
			const c3 = view.getUint32(off + 0x2c, true);

			faces.push({
				isQuad,
				vertexIndexes: [v0, v1, v2, v3],
				normalIndexes: [n0, n1, n2, n3],
				colors: [c0, c1, c2, c3],
				texCoords: [
					[u0, tv0],
					[u1, tv1],
					[u2, tv2],
					[u3, tv3],
				],
				textureIndex,
			});
		}
	}

	// ---------------------------------------------------------
	// Skin objects
	// ---------------------------------------------------------
	const skinObjects: McbSkin[] = [];
	{
		const base = bodyOffset + h.skinObjectsOffset;
		const need = base + h.skinObjectCount * MCH_SKIN_SIZE;
		if (need > bytes.length) {
			throw new MchParseError(
				`MCH skin objects overrun buffer (need ${need}, have ${bytes.length})`,
			);
		}
		for (let i = 0; i < h.skinObjectCount; i++) {
			const off = base + i * MCH_SKIN_SIZE;
			const vertexIndex = view.getUint16(off + 0x00, true);
			const vertexCount = view.getUint16(off + 0x02, true);
			const boneId = view.getUint16(off + 0x04, true);
			// off + 0x06: u16 unknown
			skinObjects.push({
				vertexIndex,
				vertexCount,
				boneId,
				logicalBone: boneId === 0 ? -1 : boneId - 1,
			});
		}
	}

	// ---------------------------------------------------------
	// Animations
	// ---------------------------------------------------------
	const animations: McbAnimation[] = [];
	if (h.animationsOffset !== 0 && h.animationsOffset !== 0xffffffff) {
		const base = bodyOffset + h.animationsOffset;
		if (base + 2 > bytes.length) {
			throw new MchParseError(
				`MCH animation block overruns buffer (offset 0x${base.toString(16)})`,
			);
		}
		const animCount = view.getUint16(base, true);
		// Sanity bound: PSX MCHs rarely have more than 256.
		if (animCount > 4096) {
			throw new MchParseError(
				`Implausible MCH animCount ${animCount}`,
			);
		}
		let cur = base + 2;
		for (let a = 0; a < animCount; a++) {
			if (cur + 4 > bytes.length) {
				throw new MchParseError(
					`MCH animation ${a} header overruns buffer`,
				);
			}
			const framesCount = view.getUint16(cur + 0, true);
			const bonesCount = view.getUint16(cur + 2, true);
			cur += 4;
			const perFrame = 6 + bonesCount * 4;
			const total = framesCount * perFrame;
			if (cur + total > bytes.length) {
				throw new MchParseError(
					`MCH animation ${a} body overruns buffer (need ${total} bytes from 0x${cur.toString(16)})`,
				);
			}
			const frames: McbAnimationFrame[] = [];
			for (let f = 0; f < framesCount; f++) {
				const tx = view.getInt16(cur + 0, true);
				const ty = view.getInt16(cur + 2, true);
				const tz = view.getInt16(cur + 4, true);
				cur += 6;
				const boneRotations: [number, number, number][] = [];
				for (let b = 0; b < bonesCount; b++) {
					const b0 = bytes[cur + 0] ?? 0;
					const b1 = bytes[cur + 1] ?? 0;
					const b2 = bytes[cur + 2] ?? 0;
					const b3 = bytes[cur + 3] ?? 0;
					cur += 4;
					boneRotations.push(unpackRotationDegrees(b0, b1, b2, b3));
				}
				frames.push({ rootTranslation: [tx, ty, tz], boneRotations });
			}
			animations.push({ framesCount, bonesCount, frames });
		}
	}

	const result: ParsedMch = {
		bones,
		vertices,
		faces,
		skinObjects,
		animations,
	};
	if (embeddedTimOffsets !== undefined) {
		result.embeddedTimOffsets = embeddedTimOffsets;
		result.bodyOffset = bodyOffset;
	}
	return result;
}

/**
 * Triangulate an MCH face into one or two triangles of vertex
 * indices, applying the PSX winding fixes:
 *
 *   - Triangle order is `(C, A, B)`, not `(A, B, C)`.
 *   - Quads are split with the PSX "Z" pattern: `(0,1,3)` and
 *     `(0,2,3)`, NOT `(0,1,2)` and `(0,2,3)`.
 *
 * Result is a flat array of triangle vertex indices (3 entries
 * per triangle).
 */
export function triangulateMchFace(face: McbFace): number[] {
	const v = face.vertexIndexes;
	if (face.isQuad) {
		// Tri 1: vertices 0,1,3 → reorder to (C,A,B) = (v3, v0, v1)
		// Tri 2: vertices 0,2,3 → reorder to (C,A,B) = (v3, v0, v2)
		return [v[3]!, v[0]!, v[1]!, v[3]!, v[0]!, v[2]!];
	}
	// Triangle: (A, B, C) on disk → emit (C, A, B).
	return [v[2]!, v[0]!, v[1]!];
}
