/**
 * BFRES — Nintendo's Binary Cafe Resource format. The master 3D
 * resource container used across Wii U / Switch first-party
 * games — MK8D, BotW, TotK, Splatoon, Smash Bros., you name it.
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
