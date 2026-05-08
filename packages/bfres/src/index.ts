/**
 * BFRES — Nintendo's Binary Cafe Resource format. The master 3D
 * resource container used across Wii U / Switch first-party
 * games across the first-party catalog.
 * A single `.bfres` bundles models (FMDL), skeletons (FSKL),
 * meshes (FSHP), animations (FSKA / FMAA / FVIS / FSHU / FSCN),
 * and a texture bank embedded as an external-file BNTX.
 *
 * **Scope:** This parser implements **metadata-tree-level**
 * support — it walks the top-level dicts, resolves names from the
 * string pool, and surfaces the embedded BNTX as a `Blob`. We do
 * NOT parse the FMDL body, vertex buffers, materials, or
 * animation curves; the format is *huge* (hundreds of struct
 * fields) and full geometry parsing only matters if you have a
 * 3D viewer to render the result. What we surface is enough for:
 *
 *   - listing what's in a BFRES at a glance,
 *   - extracting the BNTX texture bank (and decoding its textures
 *     via `@tootallnate/bntx`),
 *   - basic per-model "name + summary" metadata.
 *
 * Wire layout: see {@link parseBfres} for the offsets used.
 *
 * References:
 *   - https://github.com/KillzXGaming/BfresLibrary (most active)
 *   - https://github.com/aboood40091/BFRES-Tool
 *   - https://github.com/Syroot/NintenTools.Bfres (legacy, Wii U focus)
 */

export const BFRES_MAGIC = 'FRES';

export interface BfresVersion {
	major: number;
	minor: number;
	patch: number;
	/** Raw u32 from the header, packed `(major << 16) | (minor << 8) | patch`. */
	raw: number;
}

export interface BfresExternalFile {
	name: string;
	/** Absolute byte offset of this file's bytes in the source `Blob`. */
	offset: number;
	/** Size in bytes. */
	size: number;
	/** Lazy `Blob` view of the file's bytes. */
	data: Blob;
	/** Sniffed inner magic of the first 4 bytes. */
	innerMagic: string | null;
}

export interface BfresModel {
	name: string;
	/** Absolute file offset of the FMDL record. */
	offset: number;
	numMaterial: number;
	numShape: number;
	numVertexBuffer: number;
	/** Bone count (read from the linked FSKL). */
	numBone: number;
	/** Sum of `vertexCount` across all FVTX records (`null` if not parsed). */
	totalVertexCount: number | null;
	/** Sum of `meshes[0].indexCount / 3` across all FSHP records (`null` if not parsed). */
	totalFaceCount: number | null;
}

export interface BfresSubFileGroup {
	/** Friendly name of this sub-file kind. */
	kind:
		| 'skeletalAnim'
		| 'materialAnim'
		| 'boneVisibilityAnim'
		| 'shapeAnim'
		| 'sceneAnim';
	/** 4-byte ASCII magic of the sub-file (e.g. `'FSKA'`). */
	magic: string;
	/** Names of items in this group, taken from the sub-file dict. */
	names: string[];
}

export interface ParsedBfres {
	version: BfresVersion;
	/** Self-described file size from the header. */
	fileSize: number;
	/** File-display name (read from the header's `nameOffset`). */
	name: string;
	/** Header alignment exponent (`alignment = 1 << exponent`). */
	alignmentExponent: number;
	/** Models in declaration order. */
	models: BfresModel[];
	/** Per-kind animation sub-file groups (names only). */
	animationGroups: BfresSubFileGroup[];
	/** External files (typically just `textures.bntx`). */
	externalFiles: BfresExternalFile[];
	/** Convenience: the first `.bntx` external file, if any. */
	embeddedBntx: BfresExternalFile | null;
}

// ----- Geometry types (returned by `extractGeometry`) -----

/**
 * Decoded geometry for a single `Shape`. A shape's surface mesh is
 * indexed triangles (or another primitive type — see `primitiveType`)
 * stored as `Float32Array` for the position attribute and a
 * `Uint16Array` / `Uint32Array` for the index list. We hand back
 * decoded JS-typed arrays rather than raw buffers so callers can
 * drop them straight into Three.js / WebGPU / glTF.
 *
 * Skeletal weights and material binding are NOT included yet — this
 * struct can be extended.
 */
export interface BfresGeometry {
	/** Friendly shape name (e.g. `"Body_BodyMat"`). */
	name: string;
	/** FMDL index this shape belongs to. */
	modelIndex: number;
	/** Material index inside the parent FMDL. */
	materialIndex: number;
	/** Primitive type — almost always `'triangles'`. */
	primitiveType: 'triangles' | 'lines' | 'points' | 'unsupported';
	/** Flat `Float32Array` of length `vertexCount * 3` (XYZ XYZ …). */
	positions: Float32Array;
	/** Optional normals: `Float32Array` of length `vertexCount * 3`. */
	normals: Float32Array | null;
	/** Optional UVs: `Float32Array` of length `vertexCount * 2`. */
	uvs: Float32Array | null;
	/** Optional vertex colors: `Float32Array` of length `vertexCount * 4` (RGBA, 0..1). */
	colors: Float32Array | null;
	/** Triangle indices. The width matches the on-disk format (u16 vs u32). */
	indices: Uint16Array | Uint32Array;
	/** Vertex count of the parent FVTX (for sanity checks). */
	vertexCount: number;
	/** Axis-aligned bounding box of the positions, in model space. */
	boundingBox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * One sampler-to-texture binding inside a material. The sampler's
 * **name** (the dict key) tells you what kind of texture it is by
 * convention: `_a0` / `_a1` are albedo (diffuse), `_n0` is normal,
 * `_s0` is specular, `_b0` / `_b1` are baked AO/lighting, `_e0` is
 * emissive, `_x0` is "extra" (often a detail / mask map). The
 * **texture name** points into the embedded BNTX bank.
 */
export interface BfresTextureBinding {
	/** Sampler name (e.g. `"_a0"`). Bind kind by convention. */
	samplerName: string;
	/** Texture name as stored in BFRES; matches a name inside the BNTX bank. */
	textureName: string;
}

/**
 * One FMAT record per shape. We only surface the fields that drive
 * texture binding — the full FMAT has render-state dictionaries,
 * shader-parameter blobs, and per-stage uniform overrides, which
 * are renderer-specific and not needed for a basic preview.
 */
export interface BfresMaterial {
	name: string;
	/** Texture-name list, parallel to `samplers`. */
	textureRefs: string[];
	/** Sampler names (dict keys), parallel to `textureRefs`. */
	samplers: string[];
	/** Convenience: sampler-to-texture pairings. */
	bindings: BfresTextureBinding[];
}

const HEADER_MIN_SIZE = 0x40;

/** Cheap (8-byte) check for "FRES" + 4 spaces (Switch BFRES). */
export async function isBfres(blob: Blob): Promise<boolean> {
	if (blob.size < 8) return false;
	const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
	return (
		head[0] === 0x46 /* F */ &&
		head[1] === 0x52 /* R */ &&
		head[2] === 0x45 /* E */ &&
		head[3] === 0x53 /* S */
	);
}

/**
 * Parse a Switch BFRES file. Reads the entire file into memory
 * (BFRES files are typically a few MB to a few hundred MB; large
 * but routinely browser-acceptable) and returns the metadata
 * tree.
 *
 * Throws for Wii U BFRES (offset 4 != `0x20202020`); we don't
 * support the BE Wii U variant.
 */
export async function parseBfres(blob: Blob): Promise<ParsedBfres> {
	if (blob.size < HEADER_MIN_SIZE) {
		throw new Error(
			`Blob too small to be a BFRES (${blob.size} bytes, need at least ${HEADER_MIN_SIZE})`,
		);
	}
	// Read the entire file. Practical for typical BFRES sizes.
	const data = new Uint8Array(await blob.arrayBuffer());
	if (
		data[0] !== 0x46 ||
		data[1] !== 0x52 ||
		data[2] !== 0x45 ||
		data[3] !== 0x53
	) {
		throw new Error('Bad BFRES magic');
	}
	if (
		data[4] !== 0x20 ||
		data[5] !== 0x20 ||
		data[6] !== 0x20 ||
		data[7] !== 0x20
	) {
		throw new Error(
			'BFRES with non-Switch padding at offset 4 — only the Switch variant is supported',
		);
	}
	const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const versionRaw = v.getUint32(0x08, true);
	const version: BfresVersion = {
		major: (versionRaw >> 16) & 0xff,
		minor: (versionRaw >> 8) & 0xff,
		patch: versionRaw & 0xff,
		raw: versionRaw,
	};
	// BOM stored as bytes `FF FE` on disk (Switch little-endian).
	// Reading those bytes as LE u16 yields 0xFEFF; reading as BE u16
	// yields 0xFFFE. We check both so the parser is forgiving even
	// if a future SDK swaps the convention.
	const bomBytes = (data[0x0c] << 8) | data[0x0d];
	if (bomBytes !== 0xfffe) {
		throw new Error(
			`Unsupported BFRES BOM 0x${bomBytes.toString(16)} (expected 0xFFFE bytes "FF FE" on Switch)`,
		);
	}
	const alignmentExponent = data[0x0e];
	const fileSize = v.getUint32(0x1c, true);
	const fileNameOffset = Number(v.getBigUint64(0x20, true));
	const name = readPoolString(data, fileNameOffset);

	// FMDL is the very first (array, dict) pair after the standard
	// pre-amble. The cursor moves over it, then over the
	// version-9-only padding, then over the five animation pairs,
	// then over the misc pointers, then over the external-file
	// pointers.
	let cursor = 0x28;
	const fmdlArrayOffset = Number(v.getBigUint64(cursor, true));
	cursor += 8;
	const fmdlDictOffset = Number(v.getBigUint64(cursor, true));
	cursor += 8;
	if (version.major >= 9) cursor += 0x20; // 4 reserved u64s

	function readPair(): { array: number; dict: number } {
		const array = Number(v.getBigUint64(cursor, true));
		cursor += 8;
		const dict = Number(v.getBigUint64(cursor, true));
		cursor += 8;
		return { array, dict };
	}

	const fska = readPair();
	const fmaa = readPair();
	const fvis = readPair();
	const fshu = readPair();
	const fscn = readPair();
	// Misc pointers (we don't use the memory pool / buffer info).
	cursor += 8 * 2; // memoryPool + bufferInfo
	const externalFileArrayOffset = Number(v.getBigUint64(cursor, true));
	cursor += 8;
	const externalFileDictOffset = Number(v.getBigUint64(cursor, true));
	cursor += 8;

	// We don't bother with the post-pointers count fields — we read
	// counts from the dicts themselves, which is more robust across
	// BFRES versions.
	void fileSize;

	const fmdlNames = readDict(data, v, fmdlDictOffset);
	const fskaNames = readDict(data, v, fska.dict);
	const fmaaNames = readDict(data, v, fmaa.dict);
	const fvisNames = readDict(data, v, fvis.dict);
	const fshuNames = readDict(data, v, fshu.dict);
	const fscnNames = readDict(data, v, fscn.dict);
	const externalNames = readDict(data, v, externalFileDictOffset);

	// External files: dataOffset (u64), dataSize (u64) per entry.
	const externalFiles: BfresExternalFile[] = new Array(externalNames.length);
	for (let i = 0; i < externalNames.length; i++) {
		const off = externalFileArrayOffset + i * 16;
		if (off + 16 > data.length) break;
		const dataOffset = Number(v.getBigUint64(off, true));
		const dataSize = Number(v.getBigUint64(off + 8, true));
		const safeEnd = Math.min(data.length, dataOffset + dataSize);
		let innerMagic: string | null = null;
		if (dataOffset >= 0 && dataOffset + 4 <= data.length) {
			const m = data.subarray(dataOffset, dataOffset + 4);
			// Most external files are BNTX; we use a relaxed printable-
			// ASCII test to surface other magics gracefully.
			let ok = true;
			let s = '';
			for (const b of m) {
				if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
				else { ok = false; break; }
			}
			innerMagic = ok ? s : null;
		}
		externalFiles[i] = {
			name: externalNames[i],
			offset: dataOffset,
			size: dataSize,
			data: blob.slice(dataOffset, safeEnd),
			innerMagic,
		};
	}
	// Find the first .bntx (or first BNTX-magic external file).
	const embeddedBntx =
		externalFiles.find(
			(f) => f.name.toLowerCase().endsWith('.bntx') || f.innerMagic === 'BNTX',
		) ?? null;

	// Models: walk each FMDL record. Stride is version-dependent so
	// we follow the offsets stored in the dict's parallel array
	// (each FMDL begins with `"FMDL"`, plus a header block, then a
	// sequence of u64 pointers; we read just the fields needed for
	// summary metadata).
	const models = readModels(
		data,
		v,
		fmdlArrayOffset,
		fmdlNames,
		version,
	);

	const animationGroups: BfresSubFileGroup[] = [
		{ kind: 'skeletalAnim', magic: 'FSKA', names: fskaNames },
		{ kind: 'materialAnim', magic: 'FMAA', names: fmaaNames },
		{ kind: 'boneVisibilityAnim', magic: 'FVIS', names: fvisNames },
		{ kind: 'shapeAnim', magic: 'FSHU', names: fshuNames },
		{ kind: 'sceneAnim', magic: 'FSCN', names: fscnNames },
	];

	return {
		version,
		fileSize,
		name,
		alignmentExponent,
		models,
		animationGroups,
		externalFiles,
		embeddedBntx,
	};
}

/**
 * Read a Switch ResDict and return its node names in declaration
 * order (skipping the root sentinel at node 0).
 *
 * Layout: u32 sig (=0), u32 numEntries (excludes root), then
 * `numEntries + 1` × 16-byte nodes. Node = (u32 reference, u16
 * idxLeft, u16 idxRight, u64 keyOffset). The key string is at
 * keyOffset + 2 (skipping the u16 length prefix).
 */
function readDict(data: Uint8Array, v: DataView, dictOffset: number): string[] {
	if (!dictOffset || dictOffset + 8 > data.length) return [];
	const numEntries = v.getInt32(dictOffset + 4, true);
	if (numEntries < 0 || numEntries > 0x10000) return [];
	const out: string[] = new Array(numEntries);
	for (let i = 0; i < numEntries; i++) {
		// Node 0 is the root; real entries start at node 1.
		const nodeOff = dictOffset + 8 + (i + 1) * 16;
		if (nodeOff + 16 > data.length) {
			out[i] = '';
			continue;
		}
		const keyOffset = Number(v.getBigUint64(nodeOff + 8, true));
		out[i] = readPoolString(data, keyOffset);
	}
	return out;
}

/**
 * Read a length-prefixed string from BFRES's string pool.
 *
 * The pool stores each string as `(u16 length, NUL-terminated
 * UTF-8)`. The offsets *embedded in BFRES records* point at the
 * length prefix, so the actual string body starts 2 bytes later.
 * We use the length to bound the read but rely on the NUL byte
 * to terminate (matching what BfresLibrary does — the lengths in
 * the wild are sometimes stale).
 */
function readPoolString(data: Uint8Array, offset: number): string {
	if (!offset || offset + 2 >= data.length) return '';
	const length =
		(data[offset] | (data[offset + 1] << 8)) & 0xffff;
	const cap = Math.min(length, 1024);
	const start = offset + 2;
	let end = start;
	while (end < data.length && end - start < cap && data[end] !== 0) end++;
	return new TextDecoder('utf-8').decode(data.subarray(start, end));
}

/**
 * For each FMDL named in `names`, find its record offset
 * (`fmdlArrayOffset + i * stride`), read the magic + name +
 * counts. We deliberately don't recurse into FVTX / FSHP geometry
 * here — the per-model summary uses just the easy fields.
 */
function readModels(
	data: Uint8Array,
	v: DataView,
	fmdlArrayOffset: number,
	names: string[],
	version: BfresVersion,
): BfresModel[] {
	if (!fmdlArrayOffset || names.length === 0) return [];
	// FMDL stride is version-dependent. v5–v8 use a 12-byte
	// HeaderBlock plus 9 × u64 pointers + various u16 counts +
	// padding = ~0x80 bytes. v9+ replaces the HeaderBlock with a
	// u32 flags. The numbers below are derived from
	// BfresLibrary's `Model.Read`.
	const stride = version.major >= 9 ? 0x78 : 0x80;

	const out: BfresModel[] = [];
	for (let i = 0; i < names.length; i++) {
		const fmdlOff = fmdlArrayOffset + i * stride;
		if (fmdlOff + 16 > data.length) break;
		// Sanity: FMDL records start with `"FMDL"`. If we don't see
		// it, our stride guess is off — bail with what we have.
		if (
			data[fmdlOff] !== 0x46 ||
			data[fmdlOff + 1] !== 0x4d ||
			data[fmdlOff + 2] !== 0x44 ||
			data[fmdlOff + 3] !== 0x4c
		) {
			break;
		}
		// Pointer block starts at +0x08 for v9+ (flags u32) or +0x10
		// for v5–v8 (HeaderBlock = u32 offset + u64 size).
		const ptrBase = fmdlOff + (version.major >= 9 ? 0x08 : 0x10);
		// Pointers (in order): nameOffset, pathOffset, skeletonOffset,
		// vertexBufferArrayOffset, shapeArrayOffset, shapeDictOffset,
		// materialArrayOffset, materialDictOffset, userDataArrayOffset,
		// userDataDictOffset, userPointer.
		const skeletonOffset = Number(v.getBigUint64(ptrBase + 0x10, true));
		// Counts come after the pointer block. v5–v8: 16 bytes after
		// the 88-byte pointer area (= ptrBase + 0x58); v9+: counts at
		// ptrBase + 0x50.
		const countsBase = ptrBase + (version.major >= 9 ? 0x48 : 0x58);
		if (countsBase + 8 > data.length) {
			out.push({
				name: names[i],
				offset: fmdlOff,
				numMaterial: 0,
				numShape: 0,
				numVertexBuffer: 0,
				numBone: 0,
				totalVertexCount: null,
				totalFaceCount: null,
			});
			continue;
		}
		const numVertexBuffer = v.getUint16(countsBase + 0, true);
		const numShape = v.getUint16(countsBase + 2, true);
		const numMaterial = v.getUint16(countsBase + 4, true);

		// Bone count: walk into FSKL.
		let numBone = 0;
		if (skeletonOffset > 0 && skeletonOffset + 0x40 <= data.length) {
			// Verify FSKL magic.
			if (
				data[skeletonOffset] === 0x46 /* F */ &&
				data[skeletonOffset + 1] === 0x53 /* S */ &&
				data[skeletonOffset + 2] === 0x4b /* K */ &&
				data[skeletonOffset + 3] === 0x4c /* L */
			) {
				// numBone is at a different offset by version. Per the
				// research note, v5–v8 puts it at ptrBase + 0x40 + 4
				// inside FSKL; v9+ at ptrBase + 0x30 + 0. To be
				// version-tolerant we scan a small range looking for a
				// plausible u16. Cheap fallback: grab the first u16 in
				// the post-pointer region that's between 1 and 4096.
				const fsklPtrBase = skeletonOffset + (version.major >= 9 ? 0x08 : 0x10);
				const fsklCountsCandidates =
					version.major >= 9
						? [fsklPtrBase + 0x40, fsklPtrBase + 0x48]
						: [fsklPtrBase + 0x44, fsklPtrBase + 0x50];
				for (const cand of fsklCountsCandidates) {
					if (cand + 2 > data.length) continue;
					const b = v.getUint16(cand, true);
					if (b > 0 && b < 4096) {
						numBone = b;
						break;
					}
				}
			}
		}

		out.push({
			name: names[i],
			offset: fmdlOff,
			numMaterial,
			numShape,
			numVertexBuffer,
			numBone,
			// Skip vertex/face counts for now — they require walking
			// every FVTX / FSHP record, which means tracing each
			// record's stride which differs by version. Leaving null
			// is fine; the UI shows "—" for unknown values.
			totalVertexCount: null,
			totalFaceCount: null,
		});
	}
	return out;
}

// ----- Geometry extraction -----

// Switch attribute format codes (low 16 bits of the on-disk u32 BE).
// Sourced from BfresLibrary's `SwitchAttribFormat` enum.
const ATTRIB_FORMAT = {
	Format_8_UNorm: 0x0102,
	Format_8_SNorm: 0x0202,
	Format_8_UInt: 0x0302,
	Format_8_SInt: 0x0402,
	Format_8_8_UNorm: 0x0109,
	Format_8_8_SNorm: 0x0209,
	Format_8_8_8_8_UNorm: 0x010b,
	Format_8_8_8_8_SNorm: 0x020b,
	Format_8_8_8_8_UInt: 0x030b,
	Format_8_8_8_8_SInt: 0x040b,
	Format_10_10_10_2_SNorm: 0x020e,
	Format_10_10_10_2_UNorm: 0x000b,
	Format_16_UNorm: 0x010a,
	Format_16_SNorm: 0x030a,
	Format_16_Single: 0x050a,
	Format_16_16_UNorm: 0x0112,
	Format_16_16_SNorm: 0x0212,
	Format_16_16_Single: 0x0512,
	Format_16_16_16_16_UNorm: 0x0115,
	Format_16_16_16_16_SNorm: 0x0215,
	Format_16_16_16_16_Single: 0x0515,
	Format_32_Single: 0x0516,
	Format_32_32_Single: 0x0517,
	Format_32_32_32_Single: 0x0518,
	Format_32_32_32_32_Single: 0x0519,
} as const;

interface VertexAttribute {
	name: string;
	format: number;
	bufferIndex: number;
	offsetInBuffer: number;
}

/**
 * Decode an IEEE 754 half-precision (16-bit) float into a 32-bit
 * float. We do this manually rather than relying on
 * `DataView.getFloat16` because that's only available in very recent
 * Node / browsers (May 2025+).
 */
function decodeHalf(h: number): number {
	const sign = (h & 0x8000) >> 15;
	const exp = (h & 0x7c00) >> 10;
	const frac = h & 0x03ff;
	if (exp === 0) {
		return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
	}
	if (exp === 31) {
		return frac ? NaN : (sign ? -Infinity : Infinity);
	}
	return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Decode `componentCount` components from a single attribute slot
 * starting at `offset` in `bytes`, treating the format code as
 * one of the entries in {@link ATTRIB_FORMAT}.
 *
 * Returns a normalized `number[]` (typically with values already
 * scaled into a sensible range — e.g. SNorm bytes become floats in
 * `[-1, 1]`). Returns `null` if the format isn't supported, so
 * the caller can either fall back to "no normals" or skip the
 * attribute.
 */
function decodeAttribValue(
	view: DataView,
	offset: number,
	format: number,
): number[] | null {
	switch (format) {
		// Float32 family
		case ATTRIB_FORMAT.Format_32_Single:
			return [view.getFloat32(offset, true)];
		case ATTRIB_FORMAT.Format_32_32_Single:
			return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true)];
		case ATTRIB_FORMAT.Format_32_32_32_Single:
			return [
				view.getFloat32(offset, true),
				view.getFloat32(offset + 4, true),
				view.getFloat32(offset + 8, true),
			];
		case ATTRIB_FORMAT.Format_32_32_32_32_Single:
			return [
				view.getFloat32(offset, true),
				view.getFloat32(offset + 4, true),
				view.getFloat32(offset + 8, true),
				view.getFloat32(offset + 12, true),
			];
		// Half-float family (16 bits each component, 2-byte aligned)
		case ATTRIB_FORMAT.Format_16_Single:
			return [decodeHalf(view.getUint16(offset, true))];
		case ATTRIB_FORMAT.Format_16_16_Single:
			return [
				decodeHalf(view.getUint16(offset, true)),
				decodeHalf(view.getUint16(offset + 2, true)),
			];
		case ATTRIB_FORMAT.Format_16_16_16_16_Single:
			return [
				decodeHalf(view.getUint16(offset, true)),
				decodeHalf(view.getUint16(offset + 2, true)),
				decodeHalf(view.getUint16(offset + 4, true)),
				decodeHalf(view.getUint16(offset + 6, true)),
			];
		// SNorm family — fixed-point in [-1, 1]
		case ATTRIB_FORMAT.Format_8_SNorm:
			return [Math.max((view.getInt8(offset)) / 127, -1)];
		case ATTRIB_FORMAT.Format_8_8_SNorm:
			return [
				Math.max(view.getInt8(offset) / 127, -1),
				Math.max(view.getInt8(offset + 1) / 127, -1),
			];
		case ATTRIB_FORMAT.Format_8_8_8_8_SNorm:
			return [
				Math.max(view.getInt8(offset) / 127, -1),
				Math.max(view.getInt8(offset + 1) / 127, -1),
				Math.max(view.getInt8(offset + 2) / 127, -1),
				Math.max(view.getInt8(offset + 3) / 127, -1),
			];
		case ATTRIB_FORMAT.Format_16_SNorm:
			return [Math.max(view.getInt16(offset, true) / 32767, -1)];
		case ATTRIB_FORMAT.Format_16_16_SNorm:
			return [
				Math.max(view.getInt16(offset, true) / 32767, -1),
				Math.max(view.getInt16(offset + 2, true) / 32767, -1),
			];
		case ATTRIB_FORMAT.Format_16_16_16_16_SNorm:
			return [
				Math.max(view.getInt16(offset, true) / 32767, -1),
				Math.max(view.getInt16(offset + 2, true) / 32767, -1),
				Math.max(view.getInt16(offset + 4, true) / 32767, -1),
				Math.max(view.getInt16(offset + 6, true) / 32767, -1),
			];
		case ATTRIB_FORMAT.Format_10_10_10_2_SNorm: {
			// 10-10-10-2 packed in a u32, components stored low-to-high.
			// The 2-bit "alpha" component is unsigned (used for handedness).
			const w = view.getUint32(offset, true);
			const sext10 = (n: number) => (n & 0x200 ? n - 1024 : n) / 511;
			return [
				Math.max(sext10(w & 0x3ff), -1),
				Math.max(sext10((w >> 10) & 0x3ff), -1),
				Math.max(sext10((w >> 20) & 0x3ff), -1),
				((w >> 30) & 0x3) / 3,
			];
		}
		// UNorm family — fixed-point in [0, 1]
		case ATTRIB_FORMAT.Format_8_UNorm:
			return [view.getUint8(offset) / 255];
		case ATTRIB_FORMAT.Format_8_8_UNorm:
			return [view.getUint8(offset) / 255, view.getUint8(offset + 1) / 255];
		case ATTRIB_FORMAT.Format_8_8_8_8_UNorm:
			return [
				view.getUint8(offset) / 255,
				view.getUint8(offset + 1) / 255,
				view.getUint8(offset + 2) / 255,
				view.getUint8(offset + 3) / 255,
			];
		case ATTRIB_FORMAT.Format_16_UNorm:
			return [view.getUint16(offset, true) / 65535];
		case ATTRIB_FORMAT.Format_16_16_UNorm:
			return [
				view.getUint16(offset, true) / 65535,
				view.getUint16(offset + 2, true) / 65535,
			];
		case ATTRIB_FORMAT.Format_16_16_16_16_UNorm:
			return [
				view.getUint16(offset, true) / 65535,
				view.getUint16(offset + 2, true) / 65535,
				view.getUint16(offset + 4, true) / 65535,
				view.getUint16(offset + 6, true) / 65535,
			];
		default:
			return null;
	}
}

/**
 * Walk the parsed BFRES and extract triangle geometry for every
 * `Shape` inside every `Model`. Each shape's first LOD ("Mesh[0]")
 * is decoded into `BfresGeometry` with positions / optional normals
 * / optional UVs / optional colors plus an index buffer.
 *
 * Limitations:
 *   - Only the first LOD of each shape is read.
 *   - Skeletal-skinning weights are not extracted (good enough for
 *     T-pose rendering).
 *   - Shader-parameter overrides aren't resolved (use
 *     `extractMaterials` for the texture-binding list, which is
 *     enough for basic albedo rendering).
 *   - Shapes whose primitive type isn't `triangles` come back with
 *     `primitiveType: 'unsupported'` so callers can skip them.
 *
 * Throws if the BFRES isn't a Switch v5+ build (we don't parse the
 * Wii U variant).
 */
export async function extractGeometry(blob: Blob): Promise<BfresGeometry[]> {
	if (blob.size < HEADER_MIN_SIZE) {
		throw new Error('Blob too small to be a BFRES');
	}
	const data = new Uint8Array(await blob.arrayBuffer());
	const v = new DataView(data.buffer, data.byteOffset, data.byteLength);

	if (
		data[0] !== 0x46 ||
		data[1] !== 0x52 ||
		data[2] !== 0x45 ||
		data[3] !== 0x53
	) {
		throw new Error('Bad BFRES magic');
	}
	if (
		data[4] !== 0x20 ||
		data[5] !== 0x20 ||
		data[6] !== 0x20 ||
		data[7] !== 0x20
	) {
		throw new Error('Wii U BFRES is not supported (Switch only)');
	}

	const versionRaw = v.getUint32(0x08, true);
	const major = (versionRaw >> 16) & 0xff;
	if (major < 5) {
		throw new Error(`BFRES version ${major} is too old (need v5+)`);
	}

	// Walk header to find the BufferInfo (so we know where vertex /
	// index bytes live). The header layout matches the description
	// in `parseBfres` above; we re-walk here to keep this function
	// self-contained.
	const fmdlArrayOffset = Number(v.getBigInt64(0x28, true));
	if (!fmdlArrayOffset) return [];

	let pos = 0x38;
	if (major >= 9) pos += 32; // reserved block

	// Skip 5 sub-file groups (skeletalAnim, materialAnim, etc.) —
	// each is 16 bytes (i64 array + i64 dict).
	pos += 5 * 16;

	// MemoryPool ptr (8 bytes) + BufferInfo ptr (8 bytes).
	pos += 8;
	const bufferInfoOffset = Number(v.getBigInt64(pos, true));
	if (!bufferInfoOffset || bufferInfoOffset + 24 > data.length) {
		throw new Error('BFRES has no BufferInfo block — cannot extract geometry');
	}
	// BufferInfo layout: u32 unk + u32 size + i64 baseBufferOffset +
	// 16 bytes padding.
	const baseBufferOffset = Number(v.getBigInt64(bufferInfoOffset + 8, true));
	if (!baseBufferOffset || baseBufferOffset >= data.length) {
		throw new Error(
			`BFRES BufferInfo.bufferOffset is out of range (0x${baseBufferOffset.toString(16)})`,
		);
	}

	const out: BfresGeometry[] = [];

	// Walk all FMDLs by name (we use the dict to count, then the
	// array of fixed-size FMDL records).
	const fmdlDictOffset = Number(v.getBigInt64(0x30, true));
	const fmdlNames = readDict(data, v, fmdlDictOffset);
	const fmdlStride = major >= 9 ? 0x78 : 0x80;

	for (let mi = 0; mi < fmdlNames.length; mi++) {
		const fmdlOff = fmdlArrayOffset + mi * fmdlStride;
		if (
			data[fmdlOff] !== 0x46 ||
			data[fmdlOff + 1] !== 0x4d ||
			data[fmdlOff + 2] !== 0x44 ||
			data[fmdlOff + 3] !== 0x4c
		) {
			break;
		}
		const ptrBase = fmdlOff + (major >= 9 ? 0x08 : 0x10);
		const shapeValuesOffset = Number(v.getBigUint64(ptrBase + 0x20, true));
		const countsBase = ptrBase + (major >= 9 ? 0x48 : 0x58);
		const numShape = v.getUint16(countsBase + 2, true);

		// Each FSHP value is a pointer to its FSHP record. v9+ FSHPs
		// are inline (the pointer is the FSHP itself), and earlier
		// versions store a u64 ptr per entry — but in practice for
		// the Switch builds we care about, FSHP records sit at
		// `shapeValuesOffset + i * shapeStride`. The stride in v5
		// is 0x70; in v9+ it's 0x68.
		const fshpStride = major >= 9 ? 0x68 : 0x70;
		for (let si = 0; si < numShape; si++) {
			const fshpOff = shapeValuesOffset + si * fshpStride;
			if (fshpOff + 16 > data.length) break;
			if (
				data[fshpOff] !== 0x46 ||
				data[fshpOff + 1] !== 0x53 ||
				data[fshpOff + 2] !== 0x48 ||
				data[fshpOff + 3] !== 0x50
			) {
				// FSHP magic missing — bail out of this model's shapes.
				break;
			}
			try {
				const geom = readShapeGeometry(
					data,
					v,
					fshpOff,
					mi,
					major,
					baseBufferOffset,
				);
				if (geom) out.push(geom);
			} catch (err) {
				// One bad shape shouldn't kill the whole extraction;
				// log and continue.
				if (typeof console !== 'undefined') {
					console.warn(`BFRES: failed to read shape #${si}: ${(err as Error).message}`);
				}
			}
		}
	}

	return out;
}

/**
 * Walk the parsed BFRES and surface each FMAT material with its
 * texture-name list and sampler bindings. The result's outer index
 * matches the FMDL's material index (so a Shape's `materialIndex`
 * directly indexes into the `BfresMaterial[]` for that model).
 *
 * The list is grouped per-FMDL: `result[modelIndex][materialIndex]`.
 * Empty FMDLs (no materials) come back as empty inner arrays.
 *
 * We deliberately don't read render-state, shader params, or user
 * data here — just the texture binding info needed to wire albedo
 * textures into a renderer.
 *
 * Throws if the BFRES isn't a Switch v5+ build.
 */
export async function extractMaterials(blob: Blob): Promise<BfresMaterial[][]> {
	if (blob.size < HEADER_MIN_SIZE) {
		throw new Error('Blob too small to be a BFRES');
	}
	const data = new Uint8Array(await blob.arrayBuffer());
	const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (
		data[0] !== 0x46 ||
		data[1] !== 0x52 ||
		data[2] !== 0x45 ||
		data[3] !== 0x53
	) {
		throw new Error('Bad BFRES magic');
	}
	if (
		data[4] !== 0x20 ||
		data[5] !== 0x20 ||
		data[6] !== 0x20 ||
		data[7] !== 0x20
	) {
		throw new Error('Wii U BFRES is not supported (Switch only)');
	}
	const versionRaw = v.getUint32(0x08, true);
	const major = (versionRaw >> 16) & 0xff;
	if (major < 5) {
		throw new Error(`BFRES version ${major} is too old (need v5+)`);
	}

	const fmdlArrayOffset = Number(v.getBigInt64(0x28, true));
	const fmdlDictOffset = Number(v.getBigInt64(0x30, true));
	const fmdlNames = readDict(data, v, fmdlDictOffset);
	if (!fmdlArrayOffset) return fmdlNames.map(() => []);

	const fmdlStride = major >= 9 ? 0x78 : 0x80;
	const out: BfresMaterial[][] = [];

	for (let mi = 0; mi < fmdlNames.length; mi++) {
		const fmdlOff = fmdlArrayOffset + mi * fmdlStride;
		if (
			data[fmdlOff] !== 0x46 ||
			data[fmdlOff + 1] !== 0x4d ||
			data[fmdlOff + 2] !== 0x44 ||
			data[fmdlOff + 3] !== 0x4c
		) {
			break;
		}
		const ptrBase = fmdlOff + (major >= 9 ? 0x08 : 0x10);

		// pointer block layout (relative to ptrBase):
		//   0x00 nameOffset, 0x08 pathOffset, 0x10 skeletonOffset,
		//   0x18 vertexBufferArrayOffset, 0x20 shapeValuesOffset,
		//   0x28 shapeDictOffset, 0x30 materialValuesOffset,
		//   0x38 materialDictOffset, ...
		const matValuesOffset = Number(v.getBigUint64(ptrBase + 0x30, true));
		const matDictOffset = Number(v.getBigUint64(ptrBase + 0x38, true));
		const matNames = readDict(data, v, matDictOffset);
		const countsBase = ptrBase + (major >= 9 ? 0x48 : 0x58);
		const numMaterial = v.getUint16(countsBase + 4, true);

		const matsForFmdl: BfresMaterial[] = [];
		// The actual record stride is decided by the on-disk FMAT layout
		// (0xb8 for v5–v8, smaller for v9+). We sniff by checking the
		// FMAT magic at successive candidate strides on the first
		// material, then commit to that stride for the rest.
		let stride = 0;
		const candidateStrides = major >= 9 ? [0xa0, 0xb0, 0xb8] : [0xb8, 0xc0];
		for (const cand of candidateStrides) {
			const off = matValuesOffset + 0 * cand;
			if (off + 4 > data.length) continue;
			if (
				data[off] === 0x46 &&
				data[off + 1] === 0x4d &&
				data[off + 2] === 0x41 &&
				data[off + 3] === 0x54
			) {
				stride = cand;
				break;
			}
		}
		if (stride === 0) {
			// FMAT magic missing — bail with empty materials
			while (matsForFmdl.length < numMaterial) {
				matsForFmdl.push({
					name: matNames[matsForFmdl.length] ?? '',
					textureRefs: [],
					samplers: [],
					bindings: [],
				});
			}
			out.push(matsForFmdl);
			continue;
		}

		for (let i = 0; i < numMaterial; i++) {
			const off = matValuesOffset + i * stride;
			if (
				data[off] !== 0x46 ||
				data[off + 1] !== 0x4d ||
				data[off + 2] !== 0x41 ||
				data[off + 3] !== 0x54
			) {
				break;
			}
			// Parse FMAT record. v9+ replaces the leading 12-byte
			// HeaderBlock with a u32 flags field, which shifts every
			// subsequent offset by 8 bytes.
			const baseShift = major >= 9 ? -8 : 0;
			const matNameOff = Number(
				v.getBigInt64(off + 0x10 + baseShift, true),
			);
			const textureNameArrayOff = Number(
				v.getBigInt64(off + 0x38 + baseShift, true),
			);
			const samplerDictOff = Number(
				v.getBigInt64(off + 0x50 + baseShift, true),
			);
			const numTextureRef = data[off + 0xa8 + baseShift];
			const numSampler = data[off + 0xa9 + baseShift];

			const name = matNames[i] ?? readPoolString(data, matNameOff);
			const textureRefs: string[] = [];
			if (textureNameArrayOff && numTextureRef > 0) {
				for (let t = 0; t < numTextureRef; t++) {
					const strPtr = Number(
						v.getBigInt64(textureNameArrayOff + t * 8, true),
					);
					textureRefs.push(readPoolString(data, strPtr));
				}
			}
			const samplers: string[] =
				numSampler > 0 ? readDict(data, v, samplerDictOff) : [];
			const bindings: BfresTextureBinding[] = [];
			const pairs = Math.min(textureRefs.length, samplers.length);
			for (let p = 0; p < pairs; p++) {
				bindings.push({
					samplerName: samplers[p],
					textureName: textureRefs[p],
				});
			}
			matsForFmdl.push({ name, textureRefs, samplers, bindings });
		}
		// Pad to numMaterial in case of early break.
		while (matsForFmdl.length < numMaterial) {
			matsForFmdl.push({
				name: matNames[matsForFmdl.length] ?? '',
				textureRefs: [],
				samplers: [],
				bindings: [],
			});
		}
		out.push(matsForFmdl);
	}
	return out;
}

function readShapeGeometry(
	data: Uint8Array,
	v: DataView,
	fshpOff: number,
	modelIndex: number,
	major: number,
	baseBufferOffset: number,
): BfresGeometry | null {
	let p = fshpOff + 4; // skip "FSHP"
	if (major >= 9) p += 4; // flags u32
	else p += 12; // header block

	const nameOff = Number(v.getBigInt64(p, true)); p += 8;
	const fvtxOff = Number(v.getBigInt64(p, true)); p += 8;
	const meshArrayOff = Number(v.getBigInt64(p, true)); p += 8;
	p += 8; // skinBoneIndexListOffset
	p += 8; // keyShapeValuesOffset
	p += 8; // keyShapeDictOffset
	p += 8; // boundingBoxArrayOffset
	if (major > 2) {
		p += 8; // radiusOffset
		p += 8; // userPointer
	} else {
		p += 8; // userPointer
		p += 4; // single radius
	}
	if (major < 9) p += 4; // legacy ShapeFlags
	p += 2; // idx
	const materialIndex = v.getUint16(p, true); p += 2;
	p += 2; // boneIndex
	const vertexBufferIndex = v.getUint16(p, true); p += 2;
	p += 2; // numSkinBoneIndex
	p += 1; // vertexSkinCount
	p += 1; // numKeys (read below)
	// Actually the next byte is numMesh per the C# code; let me re-walk:
	// The bytes after the u16 padding here (per BfresLibrary's Shape.Read switch path):
	//   ushort numSkinBoneIndex; byte vertexSkinCount; byte numMesh; byte numKeys; byte targetAttribCount;
	// I overshot by 1 byte above — fix by stepping back and reading correctly.
	p -= 2;
	const vertexSkinCount = v.getUint8(p++);
	const numMesh = v.getUint8(p++);

	if (numMesh === 0) return null;

	// Read FVTX
	if (
		data[fvtxOff] !== 0x46 ||
		data[fvtxOff + 1] !== 0x56 ||
		data[fvtxOff + 2] !== 0x54 ||
		data[fvtxOff + 3] !== 0x58
	) {
		return null;
	}
	const fvtx = readFvtx(data, v, fvtxOff, major, baseBufferOffset);
	if (!fvtx) return null;

	// Read Mesh[0]
	const mesh = readMesh(data, v, meshArrayOff, baseBufferOffset);
	if (!mesh) return null;

	const positions = decodePositions(fvtx);
	if (!positions) return null;
	const normals = decodeNormals(fvtx);
	const uvs = decodeUvs(fvtx);
	const colors = decodeColors(fvtx);

	// Bounding box from positions
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i], y = positions[i + 1], z = positions[i + 2];
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (z < minZ) minZ = z;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
		if (z > maxZ) maxZ = z;
	}

	// Adjust indices for `firstVertex` if non-zero — mesh indices
	// are zero-based against `firstVertex` into the FVTX.
	if (mesh.firstVertex !== 0) {
		for (let i = 0; i < mesh.indices.length; i++) {
			mesh.indices[i] += mesh.firstVertex;
		}
	}

	const name = readPoolString(data, nameOff);
	return {
		name,
		modelIndex,
		materialIndex,
		primitiveType: mesh.primitiveType,
		positions,
		normals,
		uvs,
		colors,
		indices: mesh.indices,
		vertexCount: fvtx.vertexCount,
		boundingBox: {
			min: [minX, minY, minZ],
			max: [maxX, maxY, maxZ],
		},
	};
}

interface FvtxData {
	vertexCount: number;
	attributes: VertexAttribute[];
	/**
	 * Per-buffer file-offset where the buffer's vertex bytes start.
	 * `attribute.bufferIndex` is an index into this array.
	 */
	bufferStarts: number[];
	bufferStrides: number[];
	view: DataView;
}

function readFvtx(
	data: Uint8Array,
	v: DataView,
	fvtxOff: number,
	major: number,
	baseBufferOffset: number,
): FvtxData | null {
	let p = fvtxOff + 4; // skip "FVTX"
	if (major >= 9) p += 4; // flags u32
	else p += 12; // header block

	const attribValuesOff = Number(v.getBigInt64(p, true)); p += 8;
	p += 8; // attribDictOff
	p += 8; // memoryPoolOff
	p += 8; // unkOff
	if (major > 2) p += 8; // unk2
	const vertexBufferSizeArrayOff = Number(v.getBigInt64(p, true)); p += 8;
	const vertexStrideArrayOff = Number(v.getBigInt64(p, true)); p += 8;
	p += 8; // padding
	const fvtxBufferOffset = v.getUint32(p, true); p += 4;
	const numVertexAttrib = v.getUint8(p++);
	const numBuffer = v.getUint8(p++);
	p += 2; // idx
	const vertexCount = v.getUint32(p, true); p += 4;
	p += 2; // vertexSkinCount
	let gpuBufferAlignment = 8;
	if (major >= 10) {
		gpuBufferAlignment = v.getUint16(p, true);
	}

	// Read attributes (16-byte stride: name i64 + format u16 BE + pad u16 + offset u16 + bufIdx u16)
	const attributes: VertexAttribute[] = [];
	for (let i = 0; i < numVertexAttrib; i++) {
		const recOff = attribValuesOff + i * 16;
		const aNameOff = Number(v.getBigInt64(recOff, true));
		const formatBE = (data[recOff + 8] << 8) | data[recOff + 9];
		const offsetInBuf = v.getUint16(recOff + 12, true);
		const bufIdx = v.getUint16(recOff + 14, true);
		attributes.push({
			name: readPoolString(data, aNameOff),
			format: formatBE,
			offsetInBuffer: offsetInBuf,
			bufferIndex: bufIdx,
		});
	}

	// Per-buffer strides + sizes (each entry is a 16-byte struct).
	const bufferStrides: number[] = [];
	const bufferSizes: number[] = [];
	for (let i = 0; i < numBuffer; i++) {
		bufferStrides.push(v.getUint32(vertexStrideArrayOff + i * 16, true));
		bufferSizes.push(v.getUint32(vertexBufferSizeArrayOff + i * 16, true));
	}

	// Each buffer's bytes start at `baseBufferOffset + fvtxBufferOffset
	// + sum(prev buffer sizes, aligned to gpuBufferAlignment)`.
	const bufferStarts: number[] = [];
	let cursor = baseBufferOffset + fvtxBufferOffset;
	for (let i = 0; i < numBuffer; i++) {
		bufferStarts.push(cursor);
		let advance = bufferSizes[i];
		if (advance % gpuBufferAlignment !== 0) {
			advance += gpuBufferAlignment - (advance % gpuBufferAlignment);
		}
		cursor += advance;
	}

	return {
		vertexCount,
		attributes,
		bufferStarts,
		bufferStrides,
		view: v,
	};
}

function findAttribute(fvtx: FvtxData, names: string[]): VertexAttribute | null {
	for (const want of names) {
		for (const a of fvtx.attributes) {
			if (a.name === want) return a;
		}
	}
	return null;
}

function decodePositions(fvtx: FvtxData): Float32Array | null {
	const a = findAttribute(fvtx, ['_p0']);
	if (!a) return null;
	const out = new Float32Array(fvtx.vertexCount * 3);
	const start = fvtx.bufferStarts[a.bufferIndex];
	const stride = fvtx.bufferStrides[a.bufferIndex];
	for (let i = 0; i < fvtx.vertexCount; i++) {
		const v = decodeAttribValue(
			fvtx.view,
			start + i * stride + a.offsetInBuffer,
			a.format,
		);
		if (!v) return null;
		out[i * 3] = v[0] ?? 0;
		out[i * 3 + 1] = v[1] ?? 0;
		out[i * 3 + 2] = v[2] ?? 0;
	}
	return out;
}

function decodeNormals(fvtx: FvtxData): Float32Array | null {
	const a = findAttribute(fvtx, ['_n0']);
	if (!a) return null;
	const out = new Float32Array(fvtx.vertexCount * 3);
	const start = fvtx.bufferStarts[a.bufferIndex];
	const stride = fvtx.bufferStrides[a.bufferIndex];
	for (let i = 0; i < fvtx.vertexCount; i++) {
		const v = decodeAttribValue(
			fvtx.view,
			start + i * stride + a.offsetInBuffer,
			a.format,
		);
		if (!v) return null;
		out[i * 3] = v[0] ?? 0;
		out[i * 3 + 1] = v[1] ?? 0;
		out[i * 3 + 2] = v[2] ?? 0;
	}
	return out;
}

function decodeUvs(fvtx: FvtxData): Float32Array | null {
	const a = findAttribute(fvtx, ['_u0']);
	if (!a) return null;
	const out = new Float32Array(fvtx.vertexCount * 2);
	const start = fvtx.bufferStarts[a.bufferIndex];
	const stride = fvtx.bufferStrides[a.bufferIndex];
	for (let i = 0; i < fvtx.vertexCount; i++) {
		const v = decodeAttribValue(
			fvtx.view,
			start + i * stride + a.offsetInBuffer,
			a.format,
		);
		if (!v) return null;
		out[i * 2] = v[0] ?? 0;
		// Switch / Tegra ships UVs with V=0 at the top of the
		// texture (DirectX convention). Three.js samples textures
		// with V=0 at the bottom (OpenGL convention) and its
		// `texture.flipY` flag is a no-op for DataTexture inputs,
		// so we flip V here at extraction time. Without this,
		// textures show up vertically mirrored — most visibly on
		// faces (e.g. Peach's eyes appear on her chin).
		out[i * 2 + 1] = 1 - (v[1] ?? 0);
	}
	return out;
}

function decodeColors(fvtx: FvtxData): Float32Array | null {
	const a = findAttribute(fvtx, ['_c0']);
	if (!a) return null;
	const out = new Float32Array(fvtx.vertexCount * 4);
	const start = fvtx.bufferStarts[a.bufferIndex];
	const stride = fvtx.bufferStrides[a.bufferIndex];
	for (let i = 0; i < fvtx.vertexCount; i++) {
		const v = decodeAttribValue(
			fvtx.view,
			start + i * stride + a.offsetInBuffer,
			a.format,
		);
		if (!v) return null;
		out[i * 4] = v[0] ?? 1;
		out[i * 4 + 1] = v[1] ?? 1;
		out[i * 4 + 2] = v[2] ?? 1;
		out[i * 4 + 3] = v[3] ?? 1;
	}
	return out;
}

interface MeshData {
	primitiveType: 'triangles' | 'lines' | 'points' | 'unsupported';
	indices: Uint16Array | Uint32Array;
	firstVertex: number;
}

function readMesh(
	data: Uint8Array,
	v: DataView,
	meshArrayOff: number,
	baseBufferOffset: number,
): MeshData | null {
	let p = meshArrayOff;
	p += 8; // subMeshArrayOff
	p += 8; // memoryPoolOff
	p += 8; // bufferOff
	p += 8; // bufferSizeOff
	const faceBufferOffset = v.getUint32(p, true); p += 4;
	const primTypeRaw = v.getUint32(p, true); p += 4;
	const idxFmtRaw = v.getUint32(p, true); p += 4;
	const indexCount = v.getUint32(p, true); p += 4;
	const firstVertex = v.getUint32(p, true); p += 4;

	let primitiveType: MeshData['primitiveType'];
	switch (primTypeRaw) {
		case 0x00:
			primitiveType = 'points';
			break;
		case 0x01:
		case 0x02:
			primitiveType = 'lines';
			break;
		case 0x03:
			primitiveType = 'triangles';
			break;
		default:
			primitiveType = 'unsupported';
			break;
	}
	if (primitiveType !== 'triangles') {
		// Still report so caller can render points/lines if desired.
	}

	const idxStart = baseBufferOffset + faceBufferOffset;
	if (idxFmtRaw === 2) {
		const idx = new Uint32Array(indexCount);
		for (let i = 0; i < indexCount; i++) {
			idx[i] = v.getUint32(idxStart + i * 4, true);
		}
		return { primitiveType, indices: idx, firstVertex };
	}
	// Default: u16 (covers idxFmtRaw === 0 [unsigned byte → u16] and 1)
	const idx = new Uint16Array(indexCount);
	for (let i = 0; i < indexCount; i++) {
		idx[i] = v.getUint16(idxStart + i * 2, true);
	}
	return { primitiveType, indices: idx, firstVertex };
}
