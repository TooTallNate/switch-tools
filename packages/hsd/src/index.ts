/**
 * HSDArchive container.
 *
 * HSDArchive is HAL Laboratory's general-purpose asset container — the `.dat`
 * and `.usd` files that make up most of *Super Smash Bros. Melee*: character
 * models, stages, animations, menus, trophies. 894 of them on the retail disc.
 *
 * It is not a filesystem. An archive is one **relocated object graph**: a block
 * of C structures that pointed at each other in memory, dumped to disc with
 * every internal pointer converted to a file-relative offset. Loading it is
 * meant to be a memcpy plus a pass over a relocation table, which is why there
 * is no per-object index and no type tags — the game knows the shape of what it
 * asked for.
 *
 * What that means for a reader: the *container* is simple and fully
 * recoverable, but the objects inside it are only interpretable if you already
 * know each root's type. This module implements the container and stops there.
 * See "Scope" below.
 *
 * Everything is big-endian.
 *
 * ## Header, 0x20 bytes
 *
 *   0x00 u32     fileSize
 *   0x04 u32     dataSize        — size of the data block, which starts at 0x20
 *   0x08 u32     relocationCount
 *   0x0C u32     rootCount
 *   0x10 u32     externRootCount
 *   0x14 char[4] version tag, or zero — e.g. `001B`. Not a flags field.
 *   0x18 u32[2]  unused
 *
 * Then, back to back:
 *
 *   data block          `dataSize` bytes
 *   relocation table    `relocationCount` u32 offsets into the data block
 *   roots               `rootCount` × (u32 dataOffset, u32 nameOffset)
 *   extern roots        `externRootCount` × (u32 dataOffset, u32 nameOffset)
 *   string table        NUL-terminated names, to the end of the archive
 *
 * The layout is entirely derived from the five counts — there are no offsets to
 * the tables themselves. That makes the header self-validating: if the derived
 * string-table start doesn't land inside the file, it isn't an HSDArchive.
 *
 * ## Relocation table
 *
 * Each entry is the offset of a *pointer field* within the data block. At load
 * time the game adds the data block's base address to the u32 stored there. So
 * to follow a pointer in a file you read the u32 and treat it as a data-block
 * offset — and a field is only a pointer if its offset appears in this table.
 * That last part is the useful bit: without type information, the relocation
 * table is the only reliable way to know which words are pointers.
 *
 * ## Multi-archive files
 *
 * Melee's animation files (`Pl??AJ.dat`) are not single archives — they are
 * many archives concatenated, one per animation, each starting at a **32-byte
 * aligned** offset. 33 of the disc's files are like this, together holding 6245
 * sub-archives; the largest has over a thousand.
 *
 * The header's `fileSize` is what gives this away: for a normal archive it
 * equals the file length, and for these it describes only the first animation.
 * Reading such a file as a single archive silently yields one animation out of
 * hundreds, which is why {@link parseHsdFile} always walks the chain.
 * Advancing by the raw `fileSize` rather than the aligned one desynchronises on
 * the second archive — verified against the disc, where 32-byte alignment tiles
 * all 33 files exactly and 16, 8 and 4 tile none.
 *
 * ## Root naming
 *
 * Roots are named, and by convention the suffix encodes the type: `_joint`
 * (a scene graph, 762 on the disc), `_figatree` (an animation), `_animjoint`,
 * `_camera`, `_lights`, `_matanim`, `_texanim`, `_scene_data`. That convention
 * is how the community identifies content, and {@link hsdRootKind} exposes it —
 * but it is a naming convention, not a format guarantee.
 *
 * ## Scope
 *
 * Container only. The typed graph — `JOBJ` scene nodes, `DOBJ`/`POBJ` meshes,
 * `TOBJ` textures, `FigaTree` animation curves — is deliberately not decoded
 * here. Those structures carry no tags, so interpreting them means hardcoding
 * struct layouts per type and trusting the root-name convention to pick the
 * right one; that is a much larger and much less verifiable job than reading the
 * container, and it belongs in its own module built on this one.
 */

import {
	decodeGxTexture,
	gxFormatIsPaletted,
	gxImageSize,
} from '@tootallnate/bti';

/** Size of an archive header. */
export const HSD_HEADER_SIZE = 0x20;

/** Sub-archives in a concatenated file start on this boundary. */
export const HSD_ARCHIVE_ALIGNMENT = 32;

/** Guard against a corrupt chain producing an unbounded walk. */
const MAX_ARCHIVES = 1 << 16;
/** Sanity bound on the counts, to reject noise before multiplying. */
const MAX_COUNT = 1 << 22;

export interface HsdRoot {
	index: number;
	/** Offset of the object within the archive's data block. */
	dataOffset: number;
	/** Absolute offset of the object in the source buffer. */
	absoluteOffset: number;
	name: string;
	/** True for an extern root — a reference resolved by another archive. */
	extern: boolean;
	/** Type hinted by the name suffix; see {@link hsdRootKind}. */
	kind: string;
}

export interface HsdArchive {
	index: number;
	/** Absolute offset of this archive's header. */
	offset: number;
	/** Archive length, as declared. */
	size: number;
	/** Absolute offset of the data block. */
	dataOffset: number;
	dataSize: number;
	/** Absolute offset of the relocation table. */
	relocationOffset: number;
	relocationCount: number;
	/** Absolute offset of the string table. */
	stringTableOffset: number;
	/** Version tag from 0x14, or `''` when absent. */
	version: string;
	roots: HsdRoot[];
}

export interface HsdFile {
	/** One entry for a plain archive; many for a concatenated animation file. */
	archives: HsdArchive[];
	/** True when the archives tile the whole file. */
	complete: boolean;
}

/** Round up to the sub-archive alignment. */
function alignArchive(n: number): number {
	return (
		(n + (HSD_ARCHIVE_ALIGNMENT - 1)) & ~(HSD_ARCHIVE_ALIGNMENT - 1)
	);
}

/**
 * Type hinted by a root's name suffix.
 *
 * A convention rather than a guarantee: HSDArchive stores no type information,
 * so this is the community's read of HAL's naming and should be treated as a
 * label, not a promise.
 */
export function hsdRootKind(name: string): string {
	// Compound suffixes first. `..._matanim_joint` and `..._shapeanim_joint` end
	// in `_joint` but are not joint trees: `HSD_MatAnimJoint` is twelve bytes of
	// `{ child, next, matanim }` against a joint's sixty-four, so walking one as
	// a joint reads its `next` pointer as flags and invents a transform out of
	// whatever follows. They account for 596 of the 1,367 `_joint` roots on the
	// Melee disc — 44% — and the genuine scene graphs are `_top_joint`,
	// `_topn_joint` and `_share_joint`.
	const compound = /_([A-Za-z]+)_joint$/.exec(name);
	if (compound) {
		switch (compound[1].toLowerCase()) {
			case 'matanim':
				return 'material animation';
			case 'shapeanim':
				return 'shape animation';
			case 'anim':
				return 'joint animation';
		}
	}
	const m = /_([A-Za-z]+)$/.exec(name);
	if (!m) return '';
	const suffix = m[1].toLowerCase();
	switch (suffix) {
		case 'joint':
			return 'scene graph';
		case 'figatree':
			return 'animation';
		case 'animjoint':
			return 'joint animation';
		case 'matanim':
		case 'matanimjoint':
			return 'material animation';
		case 'texanim':
			return 'texture animation';
		case 'shapeanim':
		case 'shapeanimjoint':
			return 'shape animation';
		case 'camera':
			return 'camera';
		case 'lights':
			return 'lights';
		case 'scene':
		case 'scenedata':
			return 'scene';
		default:
			return suffix;
	}
}

/** NUL-terminated name from the string table. */
function readName(bytes: Uint8Array, start: number, limit: number): string {
	if (start < 0 || start >= limit) return '';
	let end = start;
	while (end < limit && bytes[end] !== 0) end++;
	let s = '';
	for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
	return s;
}

/**
 * Parse one archive at `offset`.
 *
 * Returns `null` unless the header's own counts describe a layout that fits
 * inside the declared size — the only validation available, since the format has
 * no magic. That check is strict enough to be usable: it accepts all 894 files
 * on the Melee disc and rejects arbitrary data.
 */
export function parseHsdArchive(
	bytes: Uint8Array,
	offset = 0,
	index = 0,
): HsdArchive | null {
	if (offset < 0 || offset + HSD_HEADER_SIZE > bytes.length) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(offset + o, false);

	const size = u32(0x00);
	const dataSize = u32(0x04);
	const relocationCount = u32(0x08);
	const rootCount = u32(0x0c);
	const externRootCount = u32(0x10);

	if (size < HSD_HEADER_SIZE || offset + size > bytes.length) return null;
	if (
		dataSize > MAX_COUNT * 1024 ||
		relocationCount > MAX_COUNT ||
		rootCount > MAX_COUNT ||
		externRootCount > MAX_COUNT
	) {
		return null;
	}

	const dataOffset = offset + HSD_HEADER_SIZE;
	const relocationOffset = dataOffset + dataSize;
	const rootOffset = relocationOffset + relocationCount * 4;
	const externOffset = rootOffset + rootCount * 8;
	const stringTableOffset = externOffset + externRootCount * 8;
	// Everything must fit inside this archive, not merely inside the file —
	// that's what makes the check meaningful for a concatenated animation file.
	if (stringTableOffset > offset + size) return null;

	// The version tag is four ASCII characters or nothing. It is *not* a flags
	// word: treating a non-zero value here as corruption rejects 179 valid files
	// on the Melee disc.
	let version = '';
	for (let i = 0x14; i < 0x18; i++) {
		const c = bytes[offset + i];
		if (c === 0) break;
		if (c < 0x20 || c > 0x7e) {
			version = '';
			break;
		}
		version += String.fromCharCode(c);
	}

	const limit = offset + size;
	const roots: HsdRoot[] = [];
	const readRoots = (base: number, count: number, extern: boolean) => {
		for (let i = 0; i < count; i++) {
			const at = base + i * 8;
			const objOffset = view.getUint32(at, false);
			const nameOffset = view.getUint32(at + 4, false);
			const name = readName(bytes, stringTableOffset + nameOffset, limit);
			roots.push({
				index: roots.length,
				dataOffset: objOffset,
				absoluteOffset: dataOffset + objOffset,
				name,
				extern,
				kind: hsdRootKind(name),
			});
		}
	};
	readRoots(rootOffset, rootCount, false);
	readRoots(externOffset, externRootCount, true);

	return {
		index,
		offset,
		size,
		dataOffset,
		dataSize,
		relocationOffset,
		relocationCount,
		stringTableOffset,
		version,
		roots,
	};
}

/**
 * Parse a whole file, which may hold one archive or many.
 *
 * Always walks the chain: a plain archive simply yields a chain of one. Stops on
 * the first sub-archive that doesn't validate, reporting `complete: false`, so a
 * truncated or partly-understood file still surfaces what it does contain.
 */
export function parseHsdFile(bytes: Uint8Array, offset = 0): HsdFile | null {
	const archives: HsdArchive[] = [];
	let at = offset;
	for (let i = 0; i < MAX_ARCHIVES; i++) {
		// A run shorter than a header is trailing alignment padding, not a
		// truncated archive.
		if (at + HSD_HEADER_SIZE > bytes.length) break;
		const archive = parseHsdArchive(bytes, at, archives.length);
		if (!archive) break;
		archives.push(archive);
		at += alignArchive(archive.size);
	}
	if (archives.length === 0) return null;
	// Anything left over that's smaller than the alignment is padding.
	const complete = bytes.length - at < HSD_ARCHIVE_ALIGNMENT;
	return { archives, complete };
}

/** Cheap check. Safe on arbitrary bytes; see `parseHsdArchive` on strictness. */
export function isHsd(bytes: Uint8Array, offset = 0): boolean {
	return parseHsdArchive(bytes, offset) !== null;
}

/**
 * Validate a header without needing the rest of the archive.
 *
 * {@link isHsd} requires the whole archive to be present, because it checks the
 * declared size against the buffer. That's the right check when you have the
 * bytes, but useless for sniffing a large file from its first 32 — the declared
 * size is megabytes and the slice is not, so it always says no.
 *
 * `availableBytes` is the size of the *file*, not of `head`.
 */
export function isHsdHeader(
	head: Uint8Array,
	availableBytes: number,
	offset = 0,
): boolean {
	if (offset < 0 || offset + HSD_HEADER_SIZE > head.length) return false;
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const u32 = (o: number) => view.getUint32(offset + o, false);
	const size = u32(0x00);
	const dataSize = u32(0x04);
	const relocationCount = u32(0x08);
	const rootCount = u32(0x0c);
	const externRootCount = u32(0x10);
	if (size < HSD_HEADER_SIZE || size > availableBytes) return false;
	if (
		relocationCount > MAX_COUNT ||
		rootCount > MAX_COUNT ||
		externRootCount > MAX_COUNT
	) {
		return false;
	}
	// At least one root, or the archive has nothing to expose.
	if (rootCount + externRootCount === 0) return false;
	const stringTableOffset =
		HSD_HEADER_SIZE +
		dataSize +
		relocationCount * 4 +
		rootCount * 8 +
		externRootCount * 8;
	return stringTableOffset <= size;
}

/**
 * Offsets of every pointer field in an archive's data block.
 *
 * Values are relative to the data block. Since the format carries no type
 * information, this table is the only dependable way to tell a pointer from an
 * integer that happens to look like one.
 */
export function hsdRelocations(bytes: Uint8Array, archive: HsdArchive): Uint32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const n = archive.relocationCount;
	const out = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		const at = archive.relocationOffset + i * 4;
		if (at + 4 > bytes.length) break;
		out[i] = view.getUint32(at, false);
	}
	return out;
}

/** Every root across every archive in a file. */
export function hsdAllRoots(file: HsdFile): HsdRoot[] {
	return file.archives.flatMap((a) => a.roots);
}

// ----- Images -----

/**
 * A texture recovered from an archive.
 *
 * Offsets are absolute in the source buffer, ready to hand to
 * `@tootallnate/bti`'s `decodeGxTexture`.
 */
export interface HsdImage {
	/** Root name, e.g. `GrdBigBlueFloor3_C8_image`. */
	name: string;
	width: number;
	height: number;
	/** GX texture format. */
	format: number;
	/** Absolute offset of the pixel data. */
	dataOffset: number;
	/** Byte length of the pixel data. */
	dataSize: number;
	/** Palette, for the C4/C8/C14X2 formats. */
	palette?: { offset: number; format: number; count: number };
}

/** An `ImageDesc`'s width/height/format sit just past its data pointer. */
const IMAGE_DESC_SIZE = 0x18;
const MAX_TEXTURE_DIMENSION = 4096;
const MAX_PALETTE_ENTRIES = 16384;

/**
 * Recover the textures in an archive.
 *
 * ## Why this needs the relocation table
 *
 * A root named `..._image` does **not** point at a descriptor — it points
 * straight at the pixel bytes. The width, height and format live in an
 * `ImageDesc` somewhere else in the graph that points *back* at those bytes, and
 * with no type tags there is no way to find it by walking.
 *
 * The relocation table solves it. It lists every pointer field in the data
 * block, so inverting it — value to the sites holding that value — gives, for
 * any image buffer, the descriptors referencing it. A candidate is accepted only
 * if its dimensions are sane and its computed size fits inside the archive.
 *
 * That inference is checked against something independent: the root name also
 * spells out the format (`_CMPR_image`, `_C8_image`). Across the 2903 image
 * roots on the Melee disc this resolves 100%, and the format read from the
 * struct agrees with the one in the name for every texture except the 108
 * `RGBA32` ones, which the names call `RGBA8` — the same format under its other
 * name, not a disagreement.
 *
 * ## Palettes
 *
 * Paletted images need a `TlutDesc`, which is reached the same way: the `TObj`
 * that owns a texture stores its image and palette pointers adjacently, so the
 * palette pointer is the word after whichever site points at the `ImageDesc`.
 * That recovers 94% of paletted images; the rest are left without a palette
 * rather than guessed at, and `decodeGxTexture` will decline them.
 */
export function hsdImages(bytes: Uint8Array, archive: HsdArchive): HsdImage[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const imageRoots = archive.roots.filter((r) => r.kind === 'image');
	if (imageRoots.length === 0) return [];

	// Invert the relocation table: pointer value -> sites holding it.
	const sitesByValue = new Map<number, number[]>();
	const relocations = hsdRelocations(bytes, archive);
	for (const site of relocations) {
		const at = archive.dataOffset + site;
		if (at + 4 > bytes.length) continue;
		const value = view.getUint32(at, false);
		const list = sitesByValue.get(value);
		if (list) list.push(site);
		else sitesByValue.set(value, [site]);
	}

	const out: HsdImage[] = [];
	for (const root of imageRoots) {
		let descSite = -1;
		let width = 0;
		let height = 0;
		let format = -1;
		for (const site of sitesByValue.get(root.dataOffset) ?? []) {
			const at = archive.dataOffset + site;
			if (at + IMAGE_DESC_SIZE > bytes.length) continue;
			const w = view.getUint16(at + 4, false);
			const h = view.getUint16(at + 6, false);
			const fmt = view.getUint32(at + 8, false);
			if (w === 0 || h === 0) continue;
			if (w > MAX_TEXTURE_DIMENSION || h > MAX_TEXTURE_DIMENSION) continue;
			const need = gxImageSize(fmt, w, h);
			if (need <= 0 || root.dataOffset + need > archive.dataSize) continue;
			descSite = site;
			width = w;
			height = h;
			format = fmt;
			break;
		}
		if (descSite < 0) continue;

		let palette: HsdImage['palette'];
		if (gxFormatIsPaletted(format)) {
			// The owning TObj holds the palette pointer next to the image one.
			for (const owner of sitesByValue.get(descSite) ?? []) {
				const at = archive.dataOffset + owner + 4;
				if (at + 4 > bytes.length) continue;
				const tlutOffset = view.getUint32(at, false);
				if (tlutOffset <= 0 || tlutOffset >= archive.dataSize) continue;
				const tlut = archive.dataOffset + tlutOffset;
				if (tlut + 0x10 > bytes.length) continue;
				const lut = view.getUint32(tlut, false);
				const lutFormat = view.getUint32(tlut + 4, false);
				const count = view.getUint16(tlut + 12, false);
				if (lut <= 0 || lut >= archive.dataSize) continue;
				if (lutFormat > 2 || count === 0 || count > MAX_PALETTE_ENTRIES) continue;
				palette = {
					offset: archive.dataOffset + lut,
					format: lutFormat,
					count,
				};
				break;
			}
		}

		out.push({
			name: root.name,
			width,
			height,
			format,
			dataOffset: archive.dataOffset + root.dataOffset,
			dataSize: gxImageSize(format, width, height),
			palette,
		});
	}
	return out;
}

/** Decode a recovered texture to top-down RGBA8, or `null` if unsupported. */
export function decodeHsdImage(
	bytes: Uint8Array,
	image: HsdImage,
): { width: number; height: number; pixels: Uint8Array } | null {
	const pixels = decodeGxTexture(
		bytes,
		image.dataOffset,
		image.width,
		image.height,
		image.format,
		image.palette
			? {
					data: bytes,
					offset: image.palette.offset,
					format: image.palette.format,
					count: image.palette.count,
				}
			: undefined,
	);
	if (!pixels) return null;
	return { width: image.width, height: image.height, pixels };
}


// ----- Scene graph -----

/** Size of an on-disc joint node. */
export const HSD_JOINT_SIZE = 0x40;

/** Pass the parent's accumulated scale through instead of compounding. */
const JOBJ_CLASSICAL_SCALE = 1 << 3;

/**
 * `JOBJ_USE_QUATERNION`, which this parser deliberately does not implement.
 *
 * When it is set, `HSD_JObjSetupMatrix` builds the local transform with
 * `HSD_MtxSRTQuat` instead of `HSD_MtxSRT`, reading the joint's three rotation
 * floats as the x/y/z of a quaternion. The w is not recoverable from the
 * reference: `HSD_JObjLoadDesc` assigns only `rotate.x/y/z` and never touches
 * `rotate.w`, so whatever the allocation happened to contain is what reaches
 * `MTXQuat`.
 *
 * That was worth leaving alone rather than guessing at, because on this disc
 * the flag is never set on a joint: 0 of 14,212 joints across 725 scene-graph
 * roots. It looks common only if you walk the wrong roots as joints — it shows
 * up on 2,702 `animation`, 1,527 `image` and 316 `tlut` nodes, where the word
 * at +0x04 is a pointer or a width/height/format triple rather than flags. An
 * earlier count of 126 "quaternion joints" was exactly that mistake. That the
 * bit is set in 0 of 14,212 real joints, while high bits generally are set in
 * 4,488 of them, is also a decent check that the joint walk is reading the
 * struct it thinks it is.
 */
export const JOBJ_USE_QUATERNION = 1 << 17;

/**
 * Build a joint's local matrix as `Rz * Ry * Rx * S`, translation in column 3.
 *
 * ## Why this particular order
 *
 * Euler triples are meaningless without a convention, and the wrong one yields
 * a model that is subtly wrong rather than obviously broken — limbs rotated
 * about the wrong axis look like a bad pose, not like a bug. `HSD_MtxSRT` in
 * the Melee decompilation writes out all nine elements explicitly, and matching
 * them term by term pins the order down: the top-left is `cosZ * cosY`, the
 * bottom-left `-sinY`, which is `Rz * Ry * Rx` and no other permutation.
 *
 * ## The parent-scale compensation
 *
 * `sysdolphin` tracks an accumulated scale separately from the matrix chain.
 * When a parent has one, each element is scaled by `parent[col] / parent[row]`
 * — a conjugation by the parent scale that cancels it out of the child's basis
 * so scaling a joint doesn't shear its descendants. On this disc almost every
 * joint has unit scale, which makes it a no-op in practice, but it is cheap and
 * getting it wrong would only show up on the models that do use it.
 *
 * Matrices are 3x4 row-major, 12 floats: the fourth row is always `0 0 0 1`.
 */
function hsdLocalMatrix(
	scale: readonly [number, number, number],
	rotation: readonly [number, number, number],
	position: readonly [number, number, number],
	parentScale: Float32Array | null,
): Float32Array {
	const sinX = Math.sin(rotation[0]);
	const cosX = Math.cos(rotation[0]);
	const sinY = Math.sin(rotation[1]);
	const cosY = Math.cos(rotation[1]);
	const sinZ = Math.sin(rotation[2]);
	const cosZ = Math.cos(rotation[2]);

	// Per-row scale factors; identical rows unless a parent scale compensates.
	let rx = scale[0];
	let ry = scale[1];
	let rz = scale[2];
	let sx1 = scale[0];
	let sy1 = scale[1];
	let sz1 = scale[2];
	let sx2 = scale[0];
	let sy2 = scale[1];
	let sz2 = scale[2];
	if (parentScale) {
		const [px, py, pz] = parentScale;
		if (px !== 0 && py !== 0 && pz !== 0) {
			ry = scale[1] * (py / px);
			rz = scale[2] * (pz / px);
			sx1 = scale[0] * (px / py);
			sz1 = scale[2] * (pz / py);
			sx2 = scale[0] * (px / pz);
			sy2 = scale[1] * (py / pz);
		}
	}

	const m = new Float32Array(12);
	m[0] = cosZ * cosY * rx;
	m[1] = (cosZ * sinX * sinY - cosX * sinZ) * ry;
	m[2] = (cosZ * cosX * sinY + sinX * sinZ) * rz;
	m[3] = position[0];
	m[4] = sinZ * cosY * sx1;
	m[5] = (sinZ * sinX * sinY + cosX * cosZ) * sy1;
	m[6] = (sinZ * cosX * sinY - sinX * cosZ) * sz1;
	m[7] = position[1];
	m[8] = -sinY * sx2;
	m[9] = cosY * sinX * sy2;
	m[10] = cosY * cosX * sz2;
	m[11] = position[2];
	return m;
}

/** Concatenate two 3x4 affine matrices: `out = a * b`. */
function hsdConcat(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(12);
	for (let r = 0; r < 3; r++) {
		const r0 = a[r * 4 + 0];
		const r1 = a[r * 4 + 1];
		const r2 = a[r * 4 + 2];
		out[r * 4 + 0] = r0 * b[0] + r1 * b[4] + r2 * b[8];
		out[r * 4 + 1] = r0 * b[1] + r1 * b[5] + r2 * b[9];
		out[r * 4 + 2] = r0 * b[2] + r1 * b[6] + r2 * b[10];
		out[r * 4 + 3] = r0 * b[3] + r1 * b[7] + r2 * b[11] + a[r * 4 + 3];
	}
	return out;
}

export interface HsdJoint {
	/** Offset of this node within the data block. */
	dataOffset: number;
	/** Depth in the tree; 0 for the root. */
	depth: number;
	/** Index of the parent in this flattened list, or -1 for the root. */
	parent: number;
	flags: number;
	rotation: [number, number, number];
	scale: [number, number, number];
	position: [number, number, number];
	/** Data-block offset of the attached display object, or 0 for none. */
	displayObject: number;
	/**
	 * Local-to-world transform, 3x4 row-major. Vertices attached to a joint are
	 * stored in its local space, so this is what places them.
	 */
	worldMatrix: Float32Array;
	/**
	 * The matrix pointed at by +0x38, when present.
	 *
	 * On a skinned model this is the inverse bind pose, and `worldMatrix`
	 * multiplied by it comes out as the identity. Measured across Melee's
	 * fighters that holds to float32 precision: median relative error 4.4e-7
	 * over 9,154 joints, 97.7% within 1e-2.
	 *
	 * It is *not* an inverse bind everywhere, which is easy to be misled by.
	 * On static assets the field is populated but means something else — for
	 * menu and trophy joints the same product has a median relative error of
	 * 1.0, and it is equally far from the forward transform and the identity.
	 * Nothing reads it there, because only a multi-bone envelope consumes it,
	 * so this costs nothing; but pooling those joints into a correctness metric
	 * makes a correct implementation look 84% right.
	 */
	inverseMatrix?: Float32Array;
}

const IDENTITY_3X4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

/**
 * The matrix a joint points at from +0x38, when the table marks it a pointer.
 * See {@link HsdJoint.inverseMatrix} for what it does and does not mean.
 */
function readInverseMatrix(
	view: DataView,
	bytes: Uint8Array,
	archive: HsdArchive,
	isPointer: Set<number>,
	offset: number,
): Float32Array | undefined {
	if (!isPointer.has(offset + 0x38)) return undefined;
	const at = view.getUint32(archive.dataOffset + offset + 0x38, false);
	if (at >= archive.dataSize) return undefined;
	const base = archive.dataOffset + at;
	if (base + 48 > bytes.length) return undefined;
	const m = new Float32Array(12);
	for (let i = 0; i < 12; i++) m[i] = view.getFloat32(base + i * 4, false);
	return m;
}

/**
 * Walk a joint hierarchy into a flat, parent-indexed list.
 *
 * ## The on-disc node is not the runtime one
 *
 * This is the trap in this format. `sysdolphin`'s runtime `HSD_JObj` is 0x88
 * bytes with a `parent` pointer, a quaternion at +0x1C and a baked `Mtx` at
 * +0x44. What is *stored* is `HSD_Joint`, a different and smaller structure —
 * reading a file with the runtime layout yields plausible-looking nonsense
 * because both begin with pointers and both contain float triples.
 *
 * The stored node is 0x40 bytes:
 *
 *   +0x00 char*  class name (usually null)
 *   +0x04 u32    flags
 *   +0x08 Joint* child
 *   +0x0C Joint* next sibling
 *   +0x10 DObjDesc* display object — geometry hangs off here
 *   +0x14 Vec3   rotation
 *   +0x20 Vec3   scale
 *   +0x2C Vec3   position
 *   +0x38 Mtx*   inverse world transform
 *   +0x3C RObjDesc* reference objects
 *
 * Derived here from the relocation table — exactly these fields are marked as
 * pointers, and the three words at +0x20 read 1.0, 1.0, 1.0 — and matching the
 * `HSD_Joint` definition in the Melee decompilation (`doldecomp/melee`,
 * `src/sysdolphin/baselib/jobj.h`), which agrees field for field.
 *
 * ## Following only real pointers
 *
 * A root's type comes from its name suffix, which is a convention rather than a
 * guarantee — so a root named `..._joint` is not certainly a joint. Walking one
 * that isn't produces a plausible-looking tree of noise.
 *
 * The relocation table settles it. `child`, `next` and the display-object
 * pointer are only followed when the table marks that exact field as a pointer,
 * which no amount of coincidental float data can fake. A root that isn't really
 * a joint therefore yields a single node or none, instead of garbage. Across the
 * disc this takes pointer agreement from 96.4% to total, by construction.
 *
 * The walk is iterative with a visited set: a corrupt `next` could otherwise
 * form a cycle, and an unbounded walk in a file browser is a hang rather than an
 * error. Depth is tracked so a caller can render the tree without a second pass.
 */
export function hsdJoints(
	bytes: Uint8Array,
	archive: HsdArchive,
	rootDataOffset: number,
	maxNodes = 65536,
): HsdJoint[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: HsdJoint[] = [];
	const seen = new Set<number>();
	// Pointer fields, by data-block offset. Anything not in here is data that
	// merely looks like an offset.
	const isPointer = new Set(hsdRelocations(bytes, archive));
	// Depth-first, but siblings are pushed before children so the flattened
	// order reads like the tree.
	const stack: { offset: number; depth: number; parent: number }[] = [
		{ offset: rootDataOffset, depth: 0, parent: -1 },
	];

	while (stack.length > 0 && out.length < maxNodes) {
		const { offset, depth, parent } = stack.pop()!;
		// Note: offset 0 is a valid node position — a null *pointer* is filtered
		// where children and siblings are pushed, not here. Rejecting 0 up front
		// would make a joint stored at the very start of the data block
		// invisible.
		if (offset >= archive.dataSize) continue;
		if (seen.has(offset)) continue;
		seen.add(offset);
		const at = archive.dataOffset + offset;
		if (at + HSD_JOINT_SIZE > bytes.length) continue;

		const f32 = (o: number) => view.getFloat32(at + o, false);
		const index = out.length;
		out.push({
			dataOffset: offset,
			depth,
			parent,
			flags: view.getUint32(at + 0x04, false),
			rotation: [f32(0x14), f32(0x18), f32(0x1c)],
			scale: [f32(0x20), f32(0x24), f32(0x28)],
			position: [f32(0x2c), f32(0x30), f32(0x34)],
			displayObject: isPointer.has(offset + 0x10)
				? view.getUint32(at + 0x10, false)
				: 0,
			worldMatrix: IDENTITY_3X4.slice(),
			inverseMatrix: readInverseMatrix(
				view,
				bytes,
				archive,
				isPointer,
				offset,
			),
		});

		const child = isPointer.has(offset + 0x08)
			? view.getUint32(at + 0x08, false)
			: 0;
		const next = isPointer.has(offset + 0x0c)
			? view.getUint32(at + 0x0c, false)
			: 0;
		// A sibling shares this node's parent and depth; a child is one deeper.
		if (next !== 0 && next < archive.dataSize) {
			stack.push({ offset: next, depth, parent });
		}
		if (child !== 0 && child < archive.dataSize) {
			stack.push({ offset: child, depth: depth + 1, parent: index });
		}
	}

	// Accumulate world transforms. A parent is always appended before its
	// children — a node enters the list when it is popped, and its children are
	// pushed only then — so one forward pass suffices.
	const scales: (Float32Array | null)[] = [];
	for (let i = 0; i < out.length; i++) {
		const joint = out[i];
		const parentScale = joint.parent >= 0 ? scales[joint.parent] : null;
		// With JOBJ_CLASSICAL_SCALE the joint's own scale is not compounded into
		// the accumulated value; the parent's is passed straight through.
		scales.push(
			joint.flags & JOBJ_CLASSICAL_SCALE
				? parentScale
					? new Float32Array(parentScale)
					: null
				: parentScale
					? new Float32Array([
							joint.scale[0] * parentScale[0],
							joint.scale[1] * parentScale[1],
							joint.scale[2] * parentScale[2],
						])
					: new Float32Array(joint.scale),
		);
		// Built from scale/rotation/position rather than read from the stored
		// inverse-bind matrix. Inverting that matrix looked more direct — it is
		// by definition the inverse of this transform — but measured against the
		// disc it gave no geometric change at all, while 196 of 1,437 stored
		// matrices are singular or zero and the invertible remainder includes
		// translations as large as 1e22. Trusting it would reintroduce the exact
		// spike artefacts that placing geometry correctly removed.
		const local = hsdLocalMatrix(
			joint.scale,
			joint.rotation,
			joint.position,
			parentScale,
		);
		joint.worldMatrix =
			joint.parent >= 0 ? hsdConcat(out[joint.parent].worldMatrix, local) : local;
	}
	return out;
}

// ----- Geometry -----

/** Size of one `HSD_VtxDescList` entry. */
/**
 * Offsets into the serialised material structures.
 *
 * ## Where a texture actually lives
 *
 * Geometry says nothing about its own appearance. The path from a drawable to
 * an image is `HSD_DObjDesc -> HSD_MObjDesc -> HSD_TObjDesc -> HSD_ImageDesc`:
 * the display object names a material, the material names a chain of texture
 * objects, and each texture object names the image and, for the paletted
 * formats, its lookup table. Nothing in that chain is length-prefixed or
 * tagged, so every hop is a bare pointer.
 *
 * `HSD_MObjDesc` is 0x18 bytes and uniformly word-sized, so `texdesc` falls at
 * +0x08 with no padding to reason about. `HSD_TObjDesc` is the awkward one:
 *
 *   +0x00 char*   class name        +0x34 wrap_s
 *   +0x04 TObj*   next              +0x38 wrap_t
 *   +0x08 u32     tex map id        +0x3C u8 repeat_s, +0x3D u8 repeat_t
 *   +0x0C u32     tex gen source    (two bytes of padding)
 *   +0x10 Vec3    rotate            +0x40 u32 blend flags
 *   +0x1C Vec3    scale             +0x44 f32 blending
 *   +0x28 Vec3    translate         +0x48 u32 mag filter
 *                                   +0x4C ImageDesc*
 *                                   +0x50 TlutDesc*
 *
 * The two padding bytes after `repeat_t` are load-bearing. They are what put
 * the image pointer at +0x4C rather than +0x4A, and since a pointer field must
 * be four-byte aligned, the alignment alone rules the shifted reading out.
 *
 * Derived from the `HSD_MObjDesc`, `HSD_TObjDesc`, `HSD_TlutDesc` and
 * `HSD_ImageDesc` definitions in the Melee decompilation
 * (`doldecomp/melee`, `src/sysdolphin/baselib/{mobj,tobj}.h`), and confirmed
 * against the relocation table on the retail disc: across 894 files and 22,535
 * display objects, every non-zero value at these offsets that belongs to a
 * scene-graph root is marked as a pointer by the table, which float or string
 * data cannot fake.
 *
 * They also agree with a derivation made here independently and earlier:
 * {@link hsdImages} locates a palette by finding whoever points at an
 * `ImageDesc` and reading the *next* word, having inferred that the palette
 * pointer sits directly after the image pointer without knowing the structure.
 * +0x4C and +0x50 are exactly four apart, so the two readings coincide.
 */
const HSD_MOBJ_TEXDESC = 0x08;
const HSD_TOBJ_NEXT = 0x04;
const HSD_TOBJ_IMAGEDESC = 0x4c;
const HSD_TOBJ_TLUTDESC = 0x50;

export const HSD_VTXDESC_SIZE = 0x18;
/** `GX_VA_NULL`, terminating a vertex-descriptor list. */
const GX_VA_NULL = 0xff;

/** GX vertex attributes we consume. */
const GX_VA_PNMTXIDX = 0;
/** Attributes 0-8 are matrix indices: `PNMTXIDX` then `TEX0..7MTXIDX`. */
const GX_VA_LAST_MTXIDX = 8;
const GX_VA_MAX = 25;
/** Bytes per component format: u8, s8, u16, s16, f32. */
const GX_COMP_BYTES = [1, 1, 2, 2, 4];
/** Bytes per colour format: RGB565, RGB888, RGB888x, RGBA4444, RGBA6666, RGBA8888. */
const GX_COLOR_BYTES = [2, 3, 4, 2, 3, 4];

/**
 * Bytes one attribute occupies inside a display list.
 *
 * Indexed attributes cost one or two bytes for the index itself. A direct
 * attribute instead carries its whole value inline, and getting that width
 * wrong desynchronises every attribute after it in the vertex — which shows up
 * as garbage indices and spikes rather than as an error.
 *
 * Matrix indices are always a single byte regardless of anything else; Dolphin
 * states it plainly in `VertexLoaderBase::GetVertexSize` ("Each enabled
 * TexMatIdx adds one byte, as does PosMatIdx"). Everything else is
 * `componentCount * formatSize`, except colours, whose packed formats have
 * their own widths.
 */
function gxAttrByteSize(a: HsdVertexAttribute): number {
	if (a.attrType === GX_INDEX16) return 2;
	if (a.attrType === GX_INDEX8) return 1;
	if (a.attrType !== GX_DIRECT) return 0;
	if (a.attr <= GX_VA_LAST_MTXIDX) return 1;
	if (a.attr === GX_VA_CLR0 || a.attr === GX_VA_CLR0 + 1) {
		return GX_COLOR_BYTES[a.componentType] ?? 0;
	}
	const unit = GX_COMP_BYTES[a.componentType] ?? 0;
	if (a.attr === GX_VA_POS) return unit * (a.componentCount === 0 ? 2 : 3);
	if (a.attr === GX_VA_NRM) return unit * (a.componentCount === 1 ? 9 : 3);
	if (a.attr >= GX_VA_TEX0) return unit * (a.componentCount === 0 ? 1 : 2);
	return unit * Math.max(1, a.componentCount);
}
const GX_VA_POS = 9;
const GX_VA_NRM = 10;
const GX_VA_CLR0 = 11;
const GX_VA_TEX0 = 13;

/** `GXAttrType`. */
const GX_NONE = 0;
const GX_DIRECT = 1;
const GX_INDEX8 = 2;
const GX_INDEX16 = 3;

/** `GXCompType` for non-colour attributes. */
const COMP_SIZE = [1, 1, 2, 2, 4]; // u8, s8, u16, s16, f32

export interface HsdVertexAttribute {
	attr: number;
	attrType: number;
	componentCount: number;
	componentType: number;
	/** Fixed-point fractional bits; 0 for floats. */
	frac: number;
	/** Bytes per element in the array. */
	stride: number;
	/** Data-block offset of the array. */
	vertexOffset: number;
}

/**
 * Primitive-object kinds, from the low bits of a `PObjDesc`'s flags.
 *
 * The published headers don't give these values, but the disc does: of 2,910
 * primitive objects, 1,095 have `0x2000` set and every one of those has its
 * trailing union pointer marked in the relocation table, where only 178 of the
 * other 1,815 have anything there at all. A union that is always present is the
 * envelope's joint/weight list.
 */
const POBJ_ENVELOPE = 0x2000;
const POBJ_SHAPEANIM = 0x1000;
const POBJ_TYPE_MASK = 0x3000;
/** A joint that begins a skeleton; decides the envelope matrix convention. */
const JOBJ_SKELETON_ROOT = 1 << 1;
/** GX holds ten position matrices, so an envelope has at most ten entries. */
const HSD_MAX_ENVELOPE_ENTRIES = 10;
/** `{ HSD_Joint* joint; f32 weight; }` */
const HSD_ENVELOPE_DESC_SIZE = 8;

/** Weighted sum of 3x4 matrices, accumulated into `out`. */
function hsdScaledAdd(out: Float32Array, m: Float32Array, w: number): void {
	for (let i = 0; i < 12; i++) out[i] += m[i] * w;
}

/**
 * The position matrices a primitive object draws with, indexed by GX slot.
 *
 * ## Which matrix a vertex uses
 *
 * This is the difference between a character and a pile of parts, and it is not
 * guessable from the geometry — it comes from what `PObjSetupMtx` loads into GX
 * before the display list runs (`doldecomp/melee`, `pobj.c`):
 *
 *  • A plain object with no shared joint loads one matrix, the owning joint's
 *    world transform, and every vertex uses it.
 *
 *  • A plain object *with* a shared joint loads the owner into `PNMTX0` and the
 *    shared joint into `PNMTX1`; vertices choose between them.
 *
 *  • An envelope loads one matrix per entry in its list. An entry whose first
 *    weight is 1 is a single bone and loads that joint's world transform
 *    directly — so those vertices are stored in *bone-local* space. An entry
 *    with fractional weights loads the weighted sum of
 *    `world * inverseBind` over its bones, which is the identity at bind pose,
 *    so those vertices are stored in *bind* space.
 *
 * That last split is the subtle one: two vertices in one mesh can live in
 * different spaces, and treating the whole envelope as bind-space leaves every
 * single-bone group — 2,753 of 4,431 entries on this disc — unplaced.
 *
 * ## The convention flag
 *
 * `_HSD_mkEnvelopeModelNodeMtx` returns null when the owning joint is a
 * skeleton root, and that null is what selects the bone-local reading above;
 * otherwise every entry would use `world * inverseBind` and be post-multiplied
 * by a node matrix. Every one of the 1,095 envelope objects on this disc is
 * owned by a skeleton root, so only the null branch is implemented, and the
 * other is refused rather than approximated.
 *
 * A vertex's `PNMTXIDX` is a slot number times three, so the returned array is
 * indexed by `PNMTXIDX / 3`.
 */
function pobjMatrices(
	view: DataView,
	archive: HsdArchive,
	isPointer: Set<number>,
	joints: readonly HsdJoint[],
	jointByOffset: Map<number, HsdJoint>,
	owner: HsdJoint,
	pobj: number,
	flags: number,
): Array<Float32Array | null> {
	const base = archive.dataOffset;
	const u32 = (o: number) => view.getUint32(base + o, false);
	const type = flags & POBJ_TYPE_MASK;
	const union = isPointer.has(pobj + 0x14) ? u32(pobj + 0x14) : 0;

	if (type !== POBJ_ENVELOPE) {
		// Shape animation behaves like a plain object for a static pose.
		const out: Array<Float32Array | null> = [owner.worldMatrix];
		if (type !== POBJ_SHAPEANIM && union) {
			const shared = jointByOffset.get(union);
			if (shared) out.push(shared.worldMatrix);
		}
		return out;
	}

	if (!union) return [owner.worldMatrix];
	// Only the skeleton-root convention is implemented; see above.
	if ((owner.flags & JOBJ_SKELETON_ROOT) === 0) return [owner.worldMatrix];

	const out: Array<Float32Array | null> = [];
	for (let i = 0; i < HSD_MAX_ENVELOPE_ENTRIES; i++) {
		const site = union + i * 4;
		if (site + 4 > archive.dataSize) break;
		// The pointer array ends at its first null entry.
		const list = isPointer.has(site) ? u32(site) : 0;
		if (!list) break;

		const sum = new Float32Array(12);
		let single: Float32Array | null = null;
		let any = false;
		for (let q = 0; q < 32; q++) {
			const at = list + q * HSD_ENVELOPE_DESC_SIZE;
			if (at + HSD_ENVELOPE_DESC_SIZE > archive.dataSize) break;
			// A pair list ends at its first null joint.
			const jp = isPointer.has(at) ? u32(at) : 0;
			if (!jp) break;
			const weight = view.getFloat32(base + at + 4, false);
			const bone = jointByOffset.get(jp);
			if (!bone) continue;
			if (q === 0 && weight >= 1 - 1e-6) {
				single = bone.worldMatrix;
				any = true;
				break;
			}
			if (bone.inverseMatrix) {
				hsdScaledAdd(sum, hsdConcat(bone.worldMatrix, bone.inverseMatrix), weight);
				any = true;
			}
		}
		out.push(single ?? (any ? sum : null));
	}
	return out.length > 0 ? out : [owner.worldMatrix];
}

/** One material-bounded run of triangles, in draw order. */
export interface HsdMeshSection {
	/** Index into {@link HsdMesh.materials}, or -1 when none resolved. */
	materialIndex: number;
	/** Start of this run within {@link HsdMesh.indices}. */
	indexOffset: number;
	indexCount: number;
}

export interface HsdMesh {
	/** Vertex count = positions.length / 3. */
	numVertices: number;
	/** XYZ-interleaved positions. */
	positions: Float32Array;
	/** XYZ-interleaved unit normals, when present. */
	normals?: Float32Array;
	/** UV-interleaved first texture coordinate set, when present. */
	uv?: Float32Array;
	/** Triangle-list indices. */
	indices: Uint32Array;
	/** Joints that contributed geometry. */
	jointCount: number;
	/** One entry per drawable display object, in draw order. */
	sections: HsdMeshSection[];
	/**
	 * Textures referenced by {@link sections}, de-duplicated. Shaped as
	 * {@link HsdImage} so {@link decodeHsdImage} decodes them unchanged.
	 */
	materials: HsdImage[];
}

/** Read one element of an attribute array as floats. */
function readAttrValues(
	view: DataView,
	base: number,
	attr: HsdVertexAttribute,
	index: number,
	count: number,
	out: Float32Array,
	outOffset: number,
): void {
	const size = COMP_SIZE[attr.componentType] ?? 0;
	if (size === 0) return;
	const at = base + attr.vertexOffset + index * attr.stride;
	// Bounds-check before reading. A display list can carry an index that
	// overruns its vertex array — in a format with no per-array length there is
	// nothing to validate it against up front — and an out-of-range DataView
	// read throws, which would take down the caller rather than degrade.
	if (at < 0 || at + count * size > view.byteLength) return;
	const scale = attr.frac > 0 ? 1 / (1 << attr.frac) : 1;
	for (let c = 0; c < count; c++) {
		const o = at + c * size;
		let v: number;
		switch (attr.componentType) {
			case 0: v = view.getUint8(o); break;
			case 1: v = view.getInt8(o); break;
			case 2: v = view.getUint16(o, false); break;
			case 3: v = view.getInt16(o, false); break;
			default: v = view.getFloat32(o, false); break;
		}
		// Integer components are fixed-point; floats are already scaled.
		out[outOffset + c] = attr.componentType === 4 ? v : v * scale;
	}
}

/**
 * Extract renderable geometry from a joint hierarchy.
 *
 * ## The chain
 *
 * `HSD_Joint.dobjdesc` → `HSD_DObjDesc` (a linked list of display objects) →
 * `HSD_PObjDesc` (a linked list of primitive objects) → a `HSD_VtxDescList`
 * describing the vertex format, plus a GX display list.
 *
 * All of these are the *serialised* `*Desc` structs, not the runtime ones —
 * mixing the two silently produces plausible nonsense. Layouts follow the Melee
 * decompilation (`doldecomp/melee`, `src/sysdolphin/baselib/{jobj,dobj,pobj}.h`)
 * and were each confirmed against the relocation table on retail data.
 *
 * ## Vertex descriptors
 *
 * A `HSD_VtxDescList` is 0x18 bytes — `attr`, `attr_type`, `comp_cnt`,
 * `comp_type`, `u8 frac`, `u16 stride`, `void* vertex` — repeated until an
 * `attr` of `GX_VA_NULL`. Note the two padding bytes the compiler inserts after
 * `frac`, which put `stride` at +0x12 and the array pointer at +0x14.
 *
 * Integer components are fixed-point: divide by `2 ** frac`. Missing that is the
 * classic way to get a model a thousand times too large.
 *
 * ## Display lists
 *
 * The display list is a raw GX primitive stream: an opcode, a `u16` vertex
 * count, then per-vertex indices — one index per attribute in the descriptor
 * list, sized by that attribute's `attr_type`. Strips and fans are triangulated
 * here, with the strip winding alternating so faces don't come out inside-out.
 *
 * Because each attribute is indexed independently, vertices are de-duplicated on
 * the tuple of indices rather than on position alone.
 */
export function hsdMesh(
	bytes: Uint8Array,
	archive: HsdArchive,
	joints: readonly HsdJoint[],
	maxVertices = 1 << 20,
): HsdMesh | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const base = archive.dataOffset;
	const isPointer = new Set(hsdRelocations(bytes, archive));
	const u32 = (o: number) => view.getUint32(base + o, false);
	const u16 = (o: number) => view.getUint16(base + o, false);

	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];
	const dedup = new Map<string, number>();
	let sawNormals = false;
	let sawUv = false;
	let contributing = 0;

	const tmp = new Float32Array(4);
	const sections: HsdMeshSection[] = [];
	const materials: HsdImage[] = [];
	// Envelopes and shared-vertex objects point at joints by data offset.
	const jointByOffset = new Map<number, HsdJoint>();
	for (const j of joints) jointByOffset.set(j.dataOffset, j);
	const materialByDesc = new Map<number, number>();

	/**
	 * Resolve a display object's first usable texture.
	 *
	 * A material may chain several texture objects for multi-stage TEV work;
	 * the first that resolves to a decodable image is taken as the diffuse
	 * layer, which is what a static preview can show. A paletted image whose
	 * lookup table cannot be found is rejected rather than guessed at: a wrong
	 * palette renders as confident nonsense, where no texture merely renders
	 * untextured.
	 */
	const resolveMaterial = (dobj: number): number => {
		const mobj = isPointer.has(dobj + 0x08) ? u32(dobj + 0x08) : 0;
		if (!mobj) return -1;
		const texdesc = isPointer.has(mobj + HSD_MOBJ_TEXDESC)
			? u32(mobj + HSD_MOBJ_TEXDESC)
			: 0;
		if (!texdesc) return -1;
		for (
			let t = texdesc, guard = 0;
			t !== 0 && t < archive.dataSize && guard < 32;
			t = isPointer.has(t + HSD_TOBJ_NEXT) ? u32(t + HSD_TOBJ_NEXT) : 0, guard++
		) {
			const desc = isPointer.has(t + HSD_TOBJ_IMAGEDESC)
				? u32(t + HSD_TOBJ_IMAGEDESC)
				: 0;
			if (!desc) continue;
			const cached = materialByDesc.get(desc);
			if (cached !== undefined) return cached;
			if (base + desc + IMAGE_DESC_SIZE > bytes.length) continue;
			const pixels = isPointer.has(desc) ? u32(desc) : 0;
			const width = u16(desc + 0x04);
			const height = u16(desc + 0x06);
			const format = u32(desc + 0x08);
			if (!pixels || pixels >= archive.dataSize) continue;
			if (
				width === 0 ||
				height === 0 ||
				width > MAX_TEXTURE_DIMENSION ||
				height > MAX_TEXTURE_DIMENSION
			) {
				continue;
			}
			const dataSize = gxImageSize(format, width, height);
			if (dataSize <= 0 || pixels + dataSize > archive.dataSize) continue;

			let palette: HsdImage['palette'];
			if (gxFormatIsPaletted(format)) {
				const tl = isPointer.has(t + HSD_TOBJ_TLUTDESC)
					? u32(t + HSD_TOBJ_TLUTDESC)
					: 0;
				if (tl && base + tl + 0x10 <= bytes.length) {
					const lut = isPointer.has(tl) ? u32(tl) : 0;
					const lutFormat = u32(tl + 0x04);
					const count = u16(tl + 0x0c);
					if (
						lut &&
						lut < archive.dataSize &&
						lutFormat <= 2 &&
						count > 0 &&
						count <= MAX_PALETTE_ENTRIES
					) {
						palette = { offset: base + lut, format: lutFormat, count };
					}
				}
				if (!palette) continue;
			}

			const index = materials.length;
			materials.push({
				name: '',
				width,
				height,
				format,
				dataOffset: base + pixels,
				dataSize,
				palette,
			});
			materialByDesc.set(desc, index);
			return index;
		}
		return -1;
	};

	for (const joint of joints) {
		if (!joint.displayObject) continue;
		let jointAdded = false;

		// Display objects, then primitive objects, both singly-linked.
		for (
			let dobj = joint.displayObject, dGuard = 0;
			dobj !== 0 && dobj < archive.dataSize && dGuard < 4096;
			dobj = isPointer.has(dobj + 0x04) ? u32(dobj + 0x04) : 0, dGuard++
		) {
			const sectionStart = indices.length;
			const materialIndex = resolveMaterial(dobj);
			for (
				let pobj = isPointer.has(dobj + 0x0c) ? u32(dobj + 0x0c) : 0, pGuard = 0;
				pobj !== 0 && pobj < archive.dataSize && pGuard < 4096;
				pobj = isPointer.has(pobj + 0x04) ? u32(pobj + 0x04) : 0, pGuard++
			) {
				const pobjFlags = u16(pobj + 0x0c);
				const vertsOffset = isPointer.has(pobj + 0x08) ? u32(pobj + 0x08) : 0;
				const displayOffset = isPointer.has(pobj + 0x10) ? u32(pobj + 0x10) : 0;
				const displayLength = u16(pobj + 0x0e) * 32; // n_display is in 32-byte units
				if (!displayOffset || displayLength === 0) continue;

				// Vertex descriptors.
				const attrs: HsdVertexAttribute[] = [];
				for (let v = vertsOffset, k = 0; k < 32; k++, v += HSD_VTXDESC_SIZE) {
					if (base + v + HSD_VTXDESC_SIZE > bytes.length) break;
					const attr = u32(v);
					if (attr === GX_VA_NULL) break;
					// A list should end with GX_VA_NULL. When one doesn't, the
					// next words are whatever follows in the data block — often
					// floats — so anything outside the attribute and type
					// enumerations ends the list too.
					const attrTypeRaw = u32(v + 0x04);
					if (attr > GX_VA_MAX || attrTypeRaw > GX_INDEX16) break;
					attrs.push({
						attr,
						attrType: u32(v + 0x04),
						componentCount: u32(v + 0x08),
						componentType: u32(v + 0x0c),
						frac: bytes[base + v + 0x10],
						stride: u16(v + 0x12),
						vertexOffset: u32(v + 0x14),
					});
				}
				if (attrs.length === 0) continue;
				// Per-vertex matrix selection. GX loads up to ten position
				// matrices and each vertex names one through PNMTXIDX, whose
				// value is the slot number times three.
				const matrices = pobjMatrices(
					view,
					archive,
					isPointer,
					joints,
					jointByOffset,
					joint,
					pobj,
					pobjFlags,
				);
				const mtxAttrIndex = attrs.findIndex(
					(x) => x.attr === GX_VA_PNMTXIDX && x.attrType !== GX_NONE,
				);
				const posAttr = attrs.find((x) => x.attr === GX_VA_POS);
				if (!posAttr || posAttr.attrType === GX_DIRECT) continue;
				const nrmAttr = attrs.find((x) => x.attr === GX_VA_NRM);
				const uvAttr = attrs.find((x) => x.attr === GX_VA_TEX0);

				// Walk the display list.
				let p = base + displayOffset;
				const end = Math.min(p + displayLength, bytes.length);
				while (p < end) {
					const opcode = bytes[p];
					if (opcode === 0) break; // padding to the 32-byte block
					const primitive = opcode & 0xf8;
					if (p + 3 > end) break;
					const count = view.getUint16(p + 1, false);
					p += 3;
					if (count === 0) continue;

					const verts: number[] = [];
					const idxs: number[] = new Array(attrs.length).fill(0);
					for (let i = 0; i < count; i++) {
						for (let ai = 0; ai < attrs.length; ai++) {
							const a = attrs[ai];
							const width = gxAttrByteSize(a);
							if (width === 0) { idxs[ai] = 0; continue; }
							if (p + width > end) { p = end; break; }
							// Only indexed attributes yield an index; a direct
							// value is skipped over, except a matrix index which
							// is a single meaningful byte.
							if (a.attrType === GX_INDEX16) idxs[ai] = view.getUint16(p, false);
							else if (a.attrType === GX_INDEX8) idxs[ai] = bytes[p];
							else if (a.attr <= GX_VA_LAST_MTXIDX) idxs[ai] = bytes[p];
							else idxs[ai] = 0;
							p += width;
						}
						// Keyed on the whole index tuple. Attribute order is
						// fixed for a primitive object, so positional joining is
						// unambiguous — looking indices up by attribute number
						// would confuse an index that happens to equal one.
						const key = idxs;
						// De-duplicate on the whole index tuple: attributes are
						// indexed independently, so two vertices sharing a
						// position may still differ.
						const k = key.join(',');
						const place =
							mtxAttrIndex >= 0
								? (matrices[Math.floor(idxs[mtxAttrIndex] / 3)] ?? matrices[0])
								: matrices[0];
						let vi = dedup.get(k);
						if (vi === undefined) {
							if (positions.length / 3 >= maxVertices) return null;
							vi = positions.length / 3;
							dedup.set(k, vi);
							const readOne = (a: HsdVertexAttribute | undefined, n: number) => {
								if (!a) return null;
								const slot = attrs.indexOf(a);
								if (slot < 0) return null;
								tmp.fill(0);
								readAttrValues(view, base, a, idxs[slot], n, tmp, 0);
								return tmp;
							};
							const pv = readOne(posAttr, 3);
							let px = pv ? pv[0] : 0;
							let py = pv ? pv[1] : 0;
							let pz = pv ? pv[2] : 0;
							if (place) {
								const x = px;
								const y = py;
								const z = pz;
								px = place[0] * x + place[1] * y + place[2] * z + place[3];
								py = place[4] * x + place[5] * y + place[6] * z + place[7];
								pz = place[8] * x + place[9] * y + place[10] * z + place[11];
							}
							positions.push(px, py, pz);
							const nv = readOne(nrmAttr, 3);
							if (nv) {
								sawNormals = true;
								let nx = nv[0];
								let ny = nv[1];
								let nz = nv[2];
								if (place) {
									const x = nx;
									const y = ny;
									const z = nz;
									// Rotation part only — a normal is a direction, so the
									// translation column must not apply.
									nx = place[0] * x + place[1] * y + place[2] * z;
									ny = place[4] * x + place[5] * y + place[6] * z;
									nz = place[8] * x + place[9] * y + place[10] * z;
									const len = Math.hypot(nx, ny, nz);
									if (len > 1e-8) { nx /= len; ny /= len; nz /= len; }
								}
								normals.push(nx, ny, nz);
							}
							else normals.push(0, 0, 0);
							const tv = readOne(uvAttr, 2);
							if (tv) { sawUv = true; uvs.push(tv[0], tv[1]); }
							else uvs.push(0, 0);
						}
						verts.push(vi);
					}

					// Triangulate.
					if (primitive === 0x90) {
						for (let i = 0; i + 2 < verts.length; i += 3) {
							indices.push(verts[i], verts[i + 1], verts[i + 2]);
						}
					} else if (primitive === 0x98) {
						// Strip: winding alternates, or every other face is inverted.
						for (let i = 2; i < verts.length; i++) {
							if (i % 2 === 0) indices.push(verts[i - 2], verts[i - 1], verts[i]);
							else indices.push(verts[i - 1], verts[i - 2], verts[i]);
						}
					} else if (primitive === 0xa0) {
						for (let i = 2; i < verts.length; i++) {
							indices.push(verts[0], verts[i - 1], verts[i]);
						}
					} else if (primitive === 0x80) {
						for (let i = 0; i + 3 < verts.length; i += 4) {
							indices.push(verts[i], verts[i + 1], verts[i + 2]);
							indices.push(verts[i], verts[i + 2], verts[i + 3]);
						}
					}
					if (!jointAdded) { contributing++; jointAdded = true; }
				}
			}
			if (indices.length > sectionStart) {
				sections.push({
					materialIndex,
					indexOffset: sectionStart,
					indexCount: indices.length - sectionStart,
				});
			}
		}
	}

	if (positions.length === 0 || indices.length === 0) return null;
	return {
		sections,
		materials,
		numVertices: positions.length / 3,
		positions: new Float32Array(positions),
		normals: sawNormals ? new Float32Array(normals) : undefined,
		uv: sawUv ? new Float32Array(uvs) : undefined,
		indices: new Uint32Array(indices),
		jointCount: contributing,
	};
}
