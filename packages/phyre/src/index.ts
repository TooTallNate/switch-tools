/**
 * Sony PhyreEngine container format (`.phyre`).
 *
 * PhyreEngine is the middleware engine Sony shipped for first-
 * party (and some third-party) titles on PS3/PS4/Vita/Switch.
 * `.phyre` files are its **self-describing binary container**:
 * a small header, an embedded *namespace* describing the class
 * hierarchy and per-class member offsets, one or more class
 * *instances* in a packed binary form, and a tail of fixup
 * tables + raw asset payloads (texture pixels, vertex/index
 * buffers, etc.).
 *
 * The self-describing namespace is what makes this practical to
 * parse without bundling PhyreEngine itself — instead of hard-
 * coding struct layouts (which change per game, per platform,
 * sometimes per *patch*), we walk the in-file class descriptors
 * and look up member offsets by name (`m_width`, `m_height`,
 * `m_format`, …) from the embedded string table.
 *
 * # Top-level layout
 *
 *   0x00  magic                 'RYHP' (LE u32 = 0x50485952)
 *   0x04  size                  size of THIS top-level header
 *                                  DX11/DX12: 80 (0x50)
 *                                  NVN (Switch): 88 (0x58)
 *   0x08  namespaceSize         size of the embedded namespace
 *   0x0C  platformId            4 ASCII bytes (NUL-padded), e.g.
 *                                  "DX11", "DX12", "GCM ", "GXM ",
 *                                  "GNM ", or "\0NVN" for Switch
 *   0x10  instanceListCount     count of instance descriptors
 *   ...   16 more u32 fields (fixup sizes/counts, buffer sizes,
 *         physics engine id, etc.)
 *   0x50-0x57 (NVN only)         maxTextureBufferSize +
 *                                texture-block alignment u32
 *
 * The two-u32 NVN extension is what bumps the header from 80 to
 * 88 bytes; the layout is otherwise identical between platforms.
 *
 * # Section order after the header
 *
 *   namespace                    `namespaceSize` bytes
 *   instance descriptors         `instanceListCount` × 36 bytes
 *   instance data                `totalDataSize` bytes (packed
 *                                  binary class instances)
 *   user-fixup data              `userFixupDataSize` bytes of
 *                                  raw strings (format names,
 *                                  class names, asset refs)
 *   user-fixup table             `userFixupCount` × 12 bytes
 *                                  (typeId, size, offset into
 *                                  user-fixup data)
 *   array fixup table            `arrayFixupSize` bytes
 *   pointer fixup table          `pointerFixupSize` bytes
 *   pointer-array fixup table    `pointerArrayFixupSize` bytes
 *   payload                      everything else: pixel data,
 *                                  vertex buffers, etc.
 *
 * # Texture path
 *
 * For `*.dds.phyre` files (the texture flavour we care about),
 * the namespace will contain at minimum these classes:
 *
 *   PTexture2D / PTexture2DNVN   the concrete texture instance
 *   PTexture2DBase               m_width, m_height (u32 each)
 *   PTextureCommonBase           m_format, m_mipmapCount,
 *                                m_maxMipLevel, m_textureFlags
 *
 * The `m_format` member is a pointer fixup into the user-fixup
 * data (a NUL-terminated string like "DXT1" / "DXT5" / "BC7" /
 * "RGBA8" / "ARGB8" / "L8" / "A8"). The raw pixel data lives in
 * the payload section at the very end of the file, with mipmaps
 * concatenated in level order (smallest mip first on Switch's
 * NVN tiling, but verify per-platform).
 *
 * # References
 *   - https://github.com/595554963github/dds-phyre-tool (DX11 reference)
 *   - https://github.com/youssef02/Phyreenginevs8 (leaked SDK headers)
 */

import { deswizzle as bntxDeswizzle } from '@tootallnate/bntx';

/** First 4 bytes of every phyre file: ASCII `RYHP`. */
export const PHYRE_MAGIC = 0x50485952;

/** Big-endian magic — pre-PS3 PhyreEngine assets, theoretical. */
export const PHYRE_MAGIC_BE = 0x52594850;

/**
 * Top-level header, common across all platforms. NVN (Switch)
 * adds two trailing u32s beyond this, but the fields we care
 * about are all here.
 */
export interface PhyreHeader {
	/** Raw magic, useful for round-tripping. Always {@link PHYRE_MAGIC}. */
	magic: number;
	/**
	 * Size of this header in bytes. Determines where the
	 * namespace starts. 80 (`0x50`) for DX/GCM/GXM/GNM platforms,
	 * 88 (`0x58`) for NVN (Switch).
	 */
	size: number;
	/** Size of the embedded namespace in bytes. */
	namespaceSize: number;
	/**
	 * Platform identifier: 4 ASCII bytes, NUL-padded for shorter
	 * tags. Real-world values observed:
	 *
	 *   "DX11"  PS4 (older Phyre toolchain)
	 *   "DX12"  PS4 (newer)
	 *   "GCM "  PS3
	 *   "GXM "  Vita
	 *   "GNM "  PS4 (native)
	 *   "\0NVN" Switch
	 */
	platformId: string;
	instanceListCount: number;
	arrayFixupSize: number;
	arrayFixupCount: number;
	pointerFixupSize: number;
	pointerFixupCount: number;
	pointerArrayFixupSize: number;
	pointerArrayFixupCount: number;
	pointersInArraysCount: number;
	userFixupCount: number;
	userFixupDataSize: number;
	totalDataSize: number;
}

/**
 * Embedded class-namespace metadata. The phyre format is
 * self-describing precisely because every file carries one of
 * these.
 */
export interface PhyreNamespace {
	typeCount: number;
	classCount: number;
	dataMemberCount: number;
	stringTableSize: number;
	defaultBufferCount: number;
	defaultBufferSize: number;
	/** All class descriptors, in declaration order. */
	classes: PhyreClass[];
	/**
	 * String table — a single NUL-delimited blob. Members /
	 * classes / types reference into here by byte offset.
	 */
	stringTable: Uint8Array;
}

export interface PhyreClass {
	/** Class name (resolved from the string table). */
	name: string;
	/** Index of the base class in {@link PhyreNamespace.classes}, or 0 for root. */
	baseClassId: number;
	/**
	 * Combined size-and-alignment as stored in the file. The
	 * lower bits hold the size; the upper bits hold the alignment
	 * exponent. Most callers want individual `members[i].size`
	 * instead.
	 */
	sizeAndAlign: number;
	/** Member descriptors in declaration order. */
	members: PhyreMember[];
}

export interface PhyreMember {
	/** Member name (e.g. "m_width", "m_format"). */
	name: string;
	/**
	 * Byte offset of this member within an instance of the
	 * declaring class. Add this to the instance's base offset
	 * to read the member's value.
	 */
	valueOffset: number;
	/** Size of this member in bytes (4 for u32, 8 for pointer, …). */
	size: number;
	/** Type identifier — index into the type table. Rarely needed by callers. */
	typeId: number;
	/** Phyre member flags (see PhyreEngine SDK docs). */
	flags: number;
}

/**
 * One instance descriptor — points at a packed class instance
 * inside the data section.
 */
export interface PhyreInstance {
	/** 1-based index into {@link PhyreNamespace.classes}. 0 is invalid. */
	classId: number;
	count: number;
	size: number;
	objectSize: number;
	arraysSize: number;
	pointersInArraysCount: number;
	arrayFixupCount: number;
	pointerFixupCount: number;
	pointerArrayFixupCount: number;
	/**
	 * Absolute byte offset within the file at which this
	 * instance's packed data begins.
	 */
	dataOffset: number;
}

/**
 * One user-fixup entry — typically a string the engine needed to
 * pin somewhere stable so multiple instances can share it.
 */
export interface PhyreUserFixup {
	/** Type identifier (PhyreEngine class id of the referent). */
	typeId: number;
	/** Length in bytes of the referent data, including any NUL terminator. */
	size: number;
	/** Byte offset into the user-fixup data section. */
	offset: number;
	/** Resolved string content if the bytes happen to be NUL-terminated text. */
	stringValue: string;
}

/**
 * The fully-parsed phyre container.
 */
export interface ParsedPhyre {
	header: PhyreHeader;
	namespace: PhyreNamespace;
	instances: PhyreInstance[];
	userFixups: PhyreUserFixup[];
	/**
	 * Absolute byte offset within the file where the payload
	 * section begins — for texture phyres this is the start of
	 * the pixel data; for mesh phyres it's the vertex/index
	 * buffer. Computed as `header.size + namespaceSize +
	 * instanceListCount * 36 + totalDataSize + userFixupDataSize
	 * + userFixupCount * 12 + arrayFixupSize + pointerFixupSize +
	 * pointerArrayFixupSize`.
	 */
	payloadOffset: number;
	/** Total payload size in bytes. */
	payloadSize: number;
	/**
	 * Pointer to the original bytes so caller helpers
	 * ({@link findTexture}, {@link extractTexturePixels}) don't
	 * have to be threaded through.
	 */
	readonly bytes: Uint8Array;
}

export class PhyreParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PhyreParseError';
	}
}

/**
 * Parse a phyre file's metadata. Does NOT touch the payload
 * bytes (texture pixels / vertex buffers) — those are sliced
 * lazily via {@link extractTexturePixels} or by reading
 * `bytes.subarray(payloadOffset, payloadOffset + payloadSize)`.
 *
 * The parse is cheap (a few KB of header + namespace + fixup
 * tables) and synchronous; safe to call on a fully-resident
 * `Uint8Array` view.
 */
export function parsePhyre(bytes: Uint8Array): ParsedPhyre {
	if (bytes.byteLength < 16) {
		throw new PhyreParseError(
			`file too small to be phyre (${bytes.byteLength} bytes; need ≥ 16)`,
		);
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = v.getUint32(0x00, true);
	if (magic !== PHYRE_MAGIC) {
		if (magic === PHYRE_MAGIC_BE) {
			throw new PhyreParseError(
				'big-endian phyre files are not yet supported',
			);
		}
		throw new PhyreParseError(
			`bad magic at offset 0: expected 'RYHP' (0x${PHYRE_MAGIC.toString(16)}), got 0x${magic.toString(16)}`,
		);
	}

	const headerSize = v.getUint32(0x04, true);
	const namespaceSize = v.getUint32(0x08, true);
	// Platform id: 4 ASCII bytes at offset 0x0c. NUL-padded for
	// shorter tags like "NVN" (which stores as `\0NVN`).
	const platformId = new TextDecoder('ascii')
		.decode(bytes.subarray(0x0c, 0x10))
		.replace(/\0/g, '');

	if (headerSize < 0x40 || headerSize > 0x80) {
		throw new PhyreParseError(
			`implausible header size: ${headerSize} (expected 80 or 88)`,
		);
	}
	if (headerSize + namespaceSize > bytes.byteLength) {
		throw new PhyreParseError(
			`namespace extends past EOF (header=${headerSize} + namespace=${namespaceSize} > file=${bytes.byteLength})`,
		);
	}

	// Field offsets 0x10 .. 0x40 are stable across DX/NVN per
	// the SDK headers we have access to; the trailing two u32s
	// beyond 0x40 are NVN-only and largely uninteresting to us.
	const header: PhyreHeader = {
		magic,
		size: headerSize,
		namespaceSize,
		platformId,
		instanceListCount: v.getUint32(0x10, true),
		arrayFixupSize: v.getUint32(0x14, true),
		arrayFixupCount: v.getUint32(0x18, true),
		pointerFixupSize: v.getUint32(0x1c, true),
		pointerFixupCount: v.getUint32(0x20, true),
		pointerArrayFixupSize: v.getUint32(0x24, true),
		pointerArrayFixupCount: v.getUint32(0x28, true),
		pointersInArraysCount: v.getUint32(0x2c, true),
		userFixupCount: v.getUint32(0x30, true),
		userFixupDataSize: v.getUint32(0x34, true),
		totalDataSize: v.getUint32(0x38, true),
	};

	const namespace = parseNamespace(bytes, v, headerSize, namespaceSize);

	const instanceListStart = headerSize + namespaceSize;
	const instanceListBytes = header.instanceListCount * INSTANCE_DESC_SIZE;
	if (instanceListStart + instanceListBytes > bytes.byteLength) {
		throw new PhyreParseError(
			`instance descriptor list extends past EOF`,
		);
	}
	const dataStart = instanceListStart + instanceListBytes;
	const instances: PhyreInstance[] = [];
	let instanceDataCursor = 0;
	for (let i = 0; i < header.instanceListCount; i++) {
		const o = instanceListStart + i * INSTANCE_DESC_SIZE;
		const size = v.getUint32(o + 8, true);
		instances.push({
			classId: v.getUint32(o, true),
			count: v.getUint32(o + 4, true),
			size,
			objectSize: v.getUint32(o + 12, true),
			arraysSize: v.getUint32(o + 16, true),
			pointersInArraysCount: v.getUint32(o + 20, true),
			arrayFixupCount: v.getUint32(o + 24, true),
			pointerFixupCount: v.getUint32(o + 28, true),
			pointerArrayFixupCount: v.getUint32(o + 32, true),
			dataOffset: dataStart + instanceDataCursor,
		});
		instanceDataCursor += size;
	}

	const userFixupDataStart = dataStart + header.totalDataSize;
	const userFixupTableStart = userFixupDataStart + header.userFixupDataSize;
	const userFixups: PhyreUserFixup[] = [];
	for (let i = 0; i < header.userFixupCount; i++) {
		const o = userFixupTableStart + i * USER_FIXUP_SIZE;
		const typeId = v.getUint32(o, true);
		const size = v.getUint32(o + 4, true);
		const offset = v.getUint32(o + 8, true);
		const stringValue = readCString(
			bytes,
			userFixupDataStart + offset,
			size,
		);
		userFixups.push({ typeId, size, offset, stringValue });
	}

	const payloadOffset =
		userFixupTableStart +
		header.userFixupCount * USER_FIXUP_SIZE +
		header.arrayFixupSize +
		header.pointerFixupSize +
		header.pointerArrayFixupSize;
	const payloadSize = Math.max(0, bytes.byteLength - payloadOffset);

	return {
		header,
		namespace,
		instances,
		userFixups,
		payloadOffset,
		payloadSize,
		bytes,
	};
}

/** Bytes per instance descriptor (9 × u32). */
const INSTANCE_DESC_SIZE = 36;
/** Bytes per user-fixup table entry (3 × u32). */
const USER_FIXUP_SIZE = 12;
/** Bytes per class descriptor in the namespace (9 × u32). */
const CLASS_DESC_SIZE = 36;
/** Bytes per data member descriptor in the namespace (6 × u32). */
const DATA_MEMBER_SIZE = 24;

/**
 * Decode the embedded namespace. The string table sits at the
 * tail; class descriptors and member descriptors precede it in
 * fixed-size record arrays.
 */
function parseNamespace(
	bytes: Uint8Array,
	v: DataView,
	nsStart: number,
	nsSize: number,
): PhyreNamespace {
	// Namespace header: 8 × u32 = 32 bytes.
	//   magic (always 0x01020304), size, typeCount, classCount,
	//   dataMemberCount, stringTableSize, defaultBufferCount,
	//   defaultBufferSize
	const typeCount = v.getUint32(nsStart + 0x08, true);
	const classCount = v.getUint32(nsStart + 0x0c, true);
	const dataMemberCount = v.getUint32(nsStart + 0x10, true);
	const stringTableSize = v.getUint32(nsStart + 0x14, true);
	const defaultBufferCount = v.getUint32(nsStart + 0x18, true);
	const defaultBufferSize = v.getUint32(nsStart + 0x1c, true);

	const typeTableStart = nsStart + 0x20;
	const classTableStart = typeTableStart + typeCount * 4;
	const dataMemberTableStart = classTableStart + classCount * CLASS_DESC_SIZE;
	// String table sits at the very end of the namespace, just
	// before the (optional) default-buffer blob.
	const stringTableStart =
		nsStart +
		nsSize -
		stringTableSize -
		defaultBufferCount * defaultBufferSize;
	const stringTable = bytes.subarray(
		stringTableStart,
		stringTableStart + stringTableSize,
	);

	const readStr = (relOff: number): string => readCString(stringTable, relOff);

	const classes: PhyreClass[] = [];
	let memberCursor = 0;
	for (let i = 0; i < classCount; i++) {
		const o = classTableStart + i * CLASS_DESC_SIZE;
		const baseClassId = v.getUint32(o, true);
		const sizeAndAlign = v.getUint32(o + 4, true);
		const nameOffset = v.getUint32(o + 8, true);
		const dataMemberCountForClass = v.getUint32(o + 12, true);
		const members: PhyreMember[] = [];
		for (let m = 0; m < dataMemberCountForClass; m++) {
			const mo = dataMemberTableStart + (memberCursor + m) * DATA_MEMBER_SIZE;
			members.push({
				name: readStr(v.getUint32(mo, true)),
				typeId: v.getUint32(mo + 4, true),
				valueOffset: v.getUint32(mo + 8, true),
				size: v.getUint32(mo + 12, true),
				flags: v.getUint32(mo + 16, true),
			});
		}
		memberCursor += dataMemberCountForClass;
		classes.push({
			name: readStr(nameOffset),
			baseClassId,
			sizeAndAlign,
			members,
		});
	}

	return {
		typeCount,
		classCount,
		dataMemberCount,
		stringTableSize,
		defaultBufferCount,
		defaultBufferSize,
		classes,
		stringTable,
	};
}

/**
 * Look up a class by exact name. Returns `null` when not found.
 */
export function findClass(
	ns: PhyreNamespace,
	name: string,
): PhyreClass | null {
	for (const c of ns.classes) {
		if (c.name === name) return c;
	}
	return null;
}

/**
 * Look up a member by name within a class. Returns `null` when
 * not found (e.g. an older file that pre-dates the member's
 * introduction).
 */
export function findMember(
	cls: PhyreClass,
	name: string,
): PhyreMember | null {
	for (const m of cls.members) {
		if (m.name === name) return m;
	}
	return null;
}

// ----- Texture extraction -----

/**
 * Subset of standard DDS pixel formats we map onto when
 * exporting. Mirrors what dds-phyre-tool / PhyreEngine actually
 * produce; not exhaustive vs the full DDS spec.
 */
export type PhyreTextureFormat =
	| 'DXT1'
	| 'DXT3'
	| 'DXT5'
	| 'BC4'
	| 'BC5'
	| 'BC7'
	| 'RGBA8'
	| 'ARGB8'
	| 'L8'
	| 'A8';

const TEXTURE_FORMATS: ReadonlyArray<PhyreTextureFormat> = [
	'DXT1',
	'DXT3',
	'DXT5',
	'BC4',
	'BC5',
	'BC7',
	'RGBA8',
	'ARGB8',
	'L8',
	'A8',
];

export interface PhyreTexture {
	width: number;
	height: number;
	mipmapCount: number;
	maxMipLevel: number;
	textureFlags: number;
	format: PhyreTextureFormat;
	/** Raw format string as it appears in the user-fixup data ("DXT5", etc). */
	formatRaw: string;
	/**
	 * Absolute byte offset of the texture's pixel data within
	 * the parent file. Stable across re-reads of the same
	 * `parsed` object.
	 */
	pixelDataOffset: number;
	/** Size of the pixel data in bytes, including all mipmap levels. */
	pixelDataSize: number;
}

/**
 * Find the first texture instance in the parsed phyre and
 * extract its metadata. Returns `null` if the file contains no
 * textures (it's a mesh, shader, etc.).
 *
 * `parsed.bytes` must still be available — we read the texture
 * dimensions from the instance data section.
 */
export function findTexture(parsed: ParsedPhyre): PhyreTexture | null {
	const baseCls = findClass(parsed.namespace, 'PTexture2DBase');
	const commonCls = findClass(parsed.namespace, 'PTextureCommonBase');
	if (!baseCls || !commonCls) return null;
	const widthMember = findMember(baseCls, 'm_width');
	const heightMember = findMember(baseCls, 'm_height');
	const mipmapCountMember = findMember(commonCls, 'm_mipmapCount');
	const maxMipMember = findMember(commonCls, 'm_maxMipLevel');
	const textureFlagsMember = findMember(commonCls, 'm_textureFlags');
	if (
		!widthMember ||
		!heightMember ||
		!mipmapCountMember ||
		!maxMipMember ||
		!textureFlagsMember
	) {
		return null;
	}

	// Find the texture instance. The classId here is 1-based.
	// We accept any subclass of PTexture2DBase as a texture
	// (PTexture2D, PTexture2DNVN, PTexture2DDX11, …). The easy
	// heuristic: look for a class whose name starts with
	// `PTexture2D` and is in the instance list.
	let textureInstance: PhyreInstance | null = null;
	for (const inst of parsed.instances) {
		const cls = parsed.namespace.classes[inst.classId - 1];
		if (cls && /^PTexture2D/.test(cls.name)) {
			textureInstance = inst;
			break;
		}
	}
	if (!textureInstance) return null;

	const v = new DataView(
		parsed.bytes.buffer,
		parsed.bytes.byteOffset,
		parsed.bytes.byteLength,
	);
	const base = textureInstance.dataOffset;
	const width = v.getUint32(base + widthMember.valueOffset, true);
	const height = v.getUint32(base + heightMember.valueOffset, true);
	const mipmapCount = v.getUint32(base + mipmapCountMember.valueOffset, true);
	const maxMipLevel = v.getUint32(base + maxMipMember.valueOffset, true);
	const textureFlags = v.getUint32(
		base + textureFlagsMember.valueOffset,
		true,
	);

	// Format string lives in a user-fixup. The dds-phyre-tool's
	// convention is that the SECOND user-fixup is the format
	// string (the first being the class name "PTexture2D"). We
	// look at fixups in order, picking the first one whose string
	// is a known texture format token. This is more robust than
	// hard-coding an index.
	let formatRaw: string | null = null;
	for (const fx of parsed.userFixups) {
		const candidate = fx.stringValue;
		if (TEXTURE_FORMATS.includes(candidate as PhyreTextureFormat)) {
			formatRaw = candidate;
			break;
		}
	}
	if (!formatRaw) {
		// Fall back: try the second fixup verbatim (matches the
		// dds-phyre-tool heuristic). Surfaces a clear error if it's
		// not actually a format string.
		const fb = parsed.userFixups[1]?.stringValue ?? null;
		throw new PhyreParseError(
			`could not find texture format in user fixups (saw ${parsed.userFixups.length}; second = ${JSON.stringify(fb)})`,
		);
	}

	return {
		width,
		height,
		mipmapCount,
		maxMipLevel,
		textureFlags,
		format: formatRaw as PhyreTextureFormat,
		formatRaw,
		pixelDataOffset: parsed.payloadOffset,
		pixelDataSize: parsed.payloadSize,
	};
}

/**
 * Slice out the raw pixel bytes for a texture. For multi-mip
 * textures this returns ALL levels concatenated in the order
 * PhyreEngine stored them.
 */
export function extractTexturePixels(
	parsed: ParsedPhyre,
	texture: PhyreTexture,
): Uint8Array {
	return parsed.bytes.subarray(
		texture.pixelDataOffset,
		texture.pixelDataOffset + texture.pixelDataSize,
	);
}

// ----- Mesh extraction -----

/**
 * A single sub-mesh inside a PhyreEngine model (`.dae.phyre`).
 * Each segment renders with one material; a `PMesh` has 1..N
 * segments. Positions and indices reference geometry buffer bytes
 * stored at the end of the file (a layout convention specific to
 * the FFX HD Remaster builds we've inspected, but likely shared
 * across all NVN-platform PhyreEngine assets).
 */
/**
 * One named vertex attribute stream inside a {@link PhyreMeshSegment}.
 * Each stream is a flat array of one attribute (positions,
 * normals, UVs, …) packed `vertexCount × stride` bytes.
 *
 * Semantic name comes from the model's userFixup string table
 * (`SkinnableVertex`, `SkinnableNormal`, `ST`, `SkinnableTangent`,
 * `SkinnableBinormal`, `SkinWeights`, `SkinIndices` for the FFX
 * HD corpus); the engine identifies the attribute by name rather
 * than by index, so per-segment stream order can theoretically
 * vary even though FFX HD always follows the canonical order.
 */
export interface PhyreVertexStream {
	/**
	 * Attribute semantic. One of the strings the engine looks up
	 * (`SkinnableVertex`, `SkinnableNormal`, `ST`, `SkinnableTangent`,
	 * `SkinnableBinormal`, `SkinWeights`, `SkinIndices`, possibly
	 * others for non-skinned meshes). Empty when we couldn't
	 * resolve the name (file uses an unknown attribute order).
	 */
	name: string;
	/**
	 * PhyreEngine `m_type` byte. Encodes both component count and
	 * width:
	 *
	 *   1 = vec2 float32          (8 B/vert) — UVs
	 *   2 = vec3 float32          (12 B/vert) — positions/normals/tangents/binormals
	 *   3 = vec4 float32          (16 B/vert) — skin weights, possibly colors
	 *   19 = vec4 uint8 / packed  (4 B/vert) — skin indices
	 *
	 * Other values may appear for compressed attributes (half-
	 * float positions, snorm normals, etc.); we currently only
	 * decode the common-case types.
	 */
	type: number;
	/** Bytes per vertex in this stream. */
	stride: number;
	/** Number of vertices (== segment vertex count). */
	vertexCount: number;
	/** Absolute file offset to the start of this stream's data. */
	offset: number;
}

export interface PhyreMeshSegment {
	/** 0-based index among the segments inside a `PMesh`. */
	index: number;
	/** Index into the parent file's `PMaterialSet.m_materials`. */
	materialIndex: number;
	/** PhyreEngine primitive type. 2 = TRIANGLES (the common case for FFX HD). */
	primitiveType: number;
	/** Number of vertices in this segment. */
	vertexCount: number;
	/** Number of indices (3 × triangle count for `primitiveType === 2`). */
	indexCount: number;
	/** Size of each index in bytes (2 for u16, 4 for u32). */
	indexSize: number;
	/** Absolute file offset to the index buffer. */
	indicesOffset: number;
	/**
	 * Vertex attribute streams, in PVertexStream declaration
	 * order. The convenience accessors below ({@link
	 * findStream}) look streams up by name.
	 */
	streams: PhyreVertexStream[];
	/**
	 * Convenience: file offset to the *position* stream (the
	 * first stream named `SkinnableVertex`, or the first vec3
	 * stream if name resolution failed). Always `float32 × 3`.
	 */
	positionsOffset: number;
	/** Stride of the position stream (always 12 in known files). */
	positionsStride: number;
}

/**
 * Full mesh metadata for a `.dae.phyre` file: one segment list
 * + the absolute byte offsets of the geometry buffer pools.
 */
export interface PhyreMesh {
	segments: PhyreMeshSegment[];
	/** Absolute file offset where the vertex buffer pool begins. */
	vertexPoolOffset: number;
	/** Total vertex buffer pool size in bytes (all streams, all segments). */
	vertexPoolSize: number;
	/** Absolute file offset where the index buffer pool begins. */
	indexPoolOffset: number;
	/** Total index buffer pool size in bytes (all segments concatenated). */
	indexPoolSize: number;
}

/**
 * Find the mesh in a parsed phyre and extract the per-segment
 * geometry metadata. Returns `null` if the file isn't a mesh
 * (it's a texture, shader, animation, etc.).
 *
 * # Layout convention
 *
 * The mesh metadata (PMesh, PMeshSegment, PDataBlock) lives in
 * the instance-data section as usual; the actual vertex and
 * index bytes live at the **end of the file** in this layout:
 *
 *     [... payload (animations, fixups, etc) ...]
 *     [index data — all segments concatenated]
 *     [vertex data — all streams of all segments concatenated]
 *     [EOF]
 *
 * Within the vertex pool, the streams are laid out per-segment:
 *
 *     segment 0 stream 0 (e.g. positions, 12 B/vert × N0 verts)
 *     segment 0 stream 1 (e.g. normals,   12 B/vert × N0 verts)
 *     ...
 *     segment 0 stream K-1
 *     segment 1 stream 0
 *     ...
 *
 * Each `PVertexStream` instance has an `m_type` byte that
 * identifies the attribute kind (1 = u32 attribute like UVs,
 * 2 = vector-3 attribute like position / normal / tangent,
 * 3 = vector-4 attribute like bone weights). We don't currently
 * use `m_type` — by convention the first stream of each segment
 * is positions. For complex multi-UV meshes (some maps) this
 * heuristic may need refinement.
 *
 * # Indices
 *
 * Indices are u16 by default (`PIndexDataBlockNVN.m_type == 0xC`).
 * The `idxDataSize` and `m_offsetInMemoryBuffer` fields give a
 * per-segment slice into the file-end index pool.
 */
export function findMesh(parsed: ParsedPhyre): PhyreMesh | null {
	const meshInst = findFirstInstance(parsed, 'PMesh');
	const segInst = findFirstInstance(parsed, 'PMeshSegment');
	const blockInst = findFirstInstance(parsed, 'PDataBlock');
	const streamInst = findFirstInstance(parsed, 'PVertexStream');
	if (!meshInst || !segInst || !blockInst) return null;

	const segSize = segInst.objectSize / segInst.count;
	const blockSize = blockInst.objectSize / blockInst.count;
	const v = new DataView(
		parsed.bytes.buffer,
		parsed.bytes.byteOffset,
		parsed.bytes.byteLength,
	);

	// Parse all PDataBlock entries — these are the vertex buffers,
	// concatenated in file-end order. We accumulate sizes to find
	// the position-stream offset for each segment.
	const blocks: Array<{
		stride: number;
		elementCount: number;
		dataSize: number;
		offsetInMemoryBuffer: number;
	}> = [];
	let totalVertexBytes = 0;
	for (let i = 0; i < blockInst.count; i++) {
		const off = blockInst.dataOffset + i * blockSize;
		const stride = v.getUint32(off + 0x00, true);
		const elementCount = v.getUint32(off + 0x04, true);
		// PDataBlockNVN extends PDataBlockBase; offsetInMemoryBuffer is
		// at +0x60, dataSize at +0x68 (see PDataBlockNVN class layout).
		const offsetInMemoryBuffer = v.getUint32(off + 0x60, true);
		const dataSize = v.getUint32(off + 0x68, true);
		blocks.push({ stride, elementCount, dataSize, offsetInMemoryBuffer });
		totalVertexBytes += dataSize;
	}

	// Parse PVertexStream entries to get per-stream attribute
	// type (`m_type` byte). The semantic *name* of each stream
	// lives in the user-fixup table — entries with typeId=15
	// are the `m_renderDataType` strings consumed by the engine.
	// The fixup table only contains DEDUPLICATED names (one per
	// distinct attribute), and each segment reuses the same
	// canonical layout in the same order. So `streamTemplate`
	// is a tile we repeat across segments.
	const streamTypes: number[] = [];
	if (streamInst) {
		const streamSize = streamInst.objectSize / streamInst.count;
		for (let i = 0; i < streamInst.count; i++) {
			const off = streamInst.dataOffset + i * streamSize;
			// m_type byte at +0x10 (per `PVertexStream` class layout).
			streamTypes.push(parsed.bytes[off + 0x10] ?? 0);
		}
	}
	// Build a template of attribute names from the user-fixup
	// strings. The typeId for `PRenderDataType` varies between
	// phyre files (we've seen 13, 15) — the literal value
	// depends on namespace class-declaration order. We instead
	// recognise the canonical attribute names directly.
	//
	// PhyreEngine's FFX HD pipeline emits exactly this set per
	// segment, in declaration order:
	//   SkinnableVertex, SkinnableNormal, ST, SkinnableTangent,
	//   SkinnableBinormal, SkinWeights, SkinIndices
	// (`ST` is Maya's UV name; `SkinWeights` may be omitted in
	// unskinned static meshes.)
	const KNOWN_ATTRIBUTES = new Set([
		'SkinnableVertex',
		'SkinnableNormal',
		'ST',
		'SkinnableTangent',
		'SkinnableBinormal',
		'SkinWeights',
		'SkinIndices',
		// Plus a few common alternates we may eventually see
		// in non-skinned meshes:
		'Vertex',
		'Normal',
		'Tangent',
		'Binormal',
		'Color0',
		'Color1',
	]);
	const streamTemplate: string[] = [];
	for (const fx of parsed.userFixups) {
		const s = fx.stringValue;
		if (s && KNOWN_ATTRIBUTES.has(s)) streamTemplate.push(s);
	}

	// Parse all PMeshSegment entries.
	const segmentsTmp: Array<{
		materialIndex: number;
		primitiveType: number;
		streamCount: number;
		indexCount: number;
		indexSize: number;
		indexOffsetInMemoryBuffer: number;
		indexDataSize: number;
	}> = [];
	let totalIndexBytes = 0;
	for (let i = 0; i < segInst.count; i++) {
		const segOff = segInst.dataOffset + i * segSize;
		const materialIndex = v.getUint32(segOff + 0x00, true);
		const primitiveType = v.getUint32(segOff + 0x18, true);
		const streamCount = v.getUint32(segOff + 0x30, true);
		const idxOff = segOff + 0x40;
		const indexCount = v.getUint32(idxOff + 0x08, true);
		const idxType = parsed.bytes[idxOff + 0x0c];
		const indexOffsetInMemoryBuffer = v.getUint32(idxOff + 0x58, true);
		const indexDataSize = v.getUint32(idxOff + 0x60, true);
		let indexSize: number;
		if (idxType === 0x0c) indexSize = 2;
		else if (idxType === 0x0d) indexSize = 4;
		else indexSize = 2;
		segmentsTmp.push({
			materialIndex,
			primitiveType,
			streamCount,
			indexCount,
			indexSize,
			indexOffsetInMemoryBuffer,
			indexDataSize,
		});
		totalIndexBytes += indexDataSize;
	}

	const vertexPoolOffset = parsed.bytes.byteLength - totalVertexBytes;
	const indexPoolOffset = vertexPoolOffset - totalIndexBytes;

	// Walk segments and partition the PDataBlock list into per-
	// segment stream groups. Each segment consumes `streamCount`
	// consecutive PDataBlocks. The stream NAMES come from the
	// dedup'd `streamTemplate` re-applied per segment; the
	// engine assumes every segment follows the same attribute
	// layout (verified in the FFX HD corpus: all segments have
	// matching stride patterns 12/12/8/12/12/16/4).
	const segments: PhyreMeshSegment[] = [];
	let streamIdx = 0;
	for (let i = 0; i < segmentsTmp.length; i++) {
		const seg = segmentsTmp[i]!;
		const segBlocks = blocks.slice(streamIdx, streamIdx + seg.streamCount);
		if (segBlocks.length === 0) break;
		const segStreamTypes = streamTypes.slice(
			streamIdx,
			streamIdx + seg.streamCount,
		);
		const streams: PhyreVertexStream[] = segBlocks.map((b, k) => ({
			// Reuse the template entry by position; if a segment
			// has more streams than the template covers (unusual)
			// we fall through to an empty name.
			name: streamTemplate[k] ?? '',
			type: segStreamTypes[k] ?? 0,
			stride: b.stride,
			vertexCount: b.elementCount,
			offset: vertexPoolOffset + b.offsetInMemoryBuffer,
		}));
		// Pick the position stream: prefer the first one named
		// `SkinnableVertex`; fall back to the first vec3 stream
		// (stride 12) when names couldn't be resolved.
		let posIdx = streams.findIndex((s) => s.name === 'SkinnableVertex');
		if (posIdx < 0) posIdx = streams.findIndex((s) => s.stride === 12);
		if (posIdx < 0) posIdx = 0;
		const posStream = streams[posIdx]!;
		segments.push({
			index: i,
			materialIndex: seg.materialIndex,
			primitiveType: seg.primitiveType,
			vertexCount: posStream.vertexCount,
			indexCount: seg.indexCount,
			indexSize: seg.indexSize,
			indicesOffset: indexPoolOffset + seg.indexOffsetInMemoryBuffer,
			streams,
			positionsOffset: posStream.offset,
			positionsStride: posStream.stride,
		});
		streamIdx += seg.streamCount;
	}

	return {
		segments,
		vertexPoolOffset,
		vertexPoolSize: totalVertexBytes,
		indexPoolOffset,
		indexPoolSize: totalIndexBytes,
	};
}

/**
 * Find a vertex stream by semantic name within a segment.
 * Returns `null` if the segment has no stream with that name
 * (e.g. an unskinned mesh has no `SkinWeights`).
 */
export function findStream(
	segment: PhyreMeshSegment,
	name: string,
): PhyreVertexStream | null {
	for (const s of segment.streams) {
		if (s.name === name) return s;
	}
	return null;
}

/**
 * Extract position data for a single mesh segment as a flat
 * `Float32Array` of `[x0, y0, z0, x1, y1, z1, ...]`. Length is
 * `segment.vertexCount * 3`.
 */
export function extractPositions(
	parsed: ParsedPhyre,
	segment: PhyreMeshSegment,
): Float32Array {
	if (segment.positionsStride !== 12) {
		throw new Error(
			`Unsupported positions stride ${segment.positionsStride}. Only float32x3 (stride 12) is implemented.`,
		);
	}
	const out = new Float32Array(segment.vertexCount * 3);
	const v = new DataView(
		parsed.bytes.buffer,
		parsed.bytes.byteOffset,
		parsed.bytes.byteLength,
	);
	for (let i = 0; i < segment.vertexCount; i++) {
		const o = segment.positionsOffset + i * 12;
		out[i * 3 + 0] = v.getFloat32(o + 0, true);
		out[i * 3 + 1] = v.getFloat32(o + 4, true);
		out[i * 3 + 2] = v.getFloat32(o + 8, true);
	}
	return out;
}

/**
 * Extract UV (`ST`) coordinates for a single mesh segment as a
 * flat `Float32Array` of `[u0, v0, u1, v1, ...]`. Length is
 * `segment.vertexCount * 2`.
 *
 * Returns `null` if the segment doesn't have a UV stream (the
 * model is unmapped, e.g. some debug / collision meshes), or
 * if the stream uses an unsupported component layout.
 *
 * PhyreEngine UV streams are typically `m_type=1` (vec2 float32,
 * stride 8). Some FFX HD textures sample with `1 − v` instead of
 * `v` (Maya UV-origin convention); the caller is expected to
 * pair this with a texture whose `flipY` is set appropriately.
 */
export function extractUVs(
	parsed: ParsedPhyre,
	segment: PhyreMeshSegment,
): Float32Array | null {
	const stream = findStream(segment, 'ST');
	if (!stream) return null;
	// Only the common case for now: stride 8 = vec2 float32.
	if (stream.stride !== 8) return null;
	const out = new Float32Array(segment.vertexCount * 2);
	const v = new DataView(
		parsed.bytes.buffer,
		parsed.bytes.byteOffset,
		parsed.bytes.byteLength,
	);
	for (let i = 0; i < segment.vertexCount; i++) {
		const o = stream.offset + i * 8;
		out[i * 2 + 0] = v.getFloat32(o + 0, true);
		out[i * 2 + 1] = v.getFloat32(o + 4, true);
	}
	return out;
}

/**
 * Extract vertex normals for a single mesh segment.
 *
 * PhyreEngine NVN stores normals as `SkinnableNormal` (vec3
 * float32, stride 12). Returns `null` if the segment has no
 * normal stream — the caller should fall back to flat-shaded
 * face normals (Three.js does this via `computeVertexNormals`).
 */
export function extractNormals(
	parsed: ParsedPhyre,
	segment: PhyreMeshSegment,
): Float32Array | null {
	const stream = findStream(segment, 'SkinnableNormal');
	if (!stream) return null;
	if (stream.stride !== 12) return null;
	const out = new Float32Array(segment.vertexCount * 3);
	const v = new DataView(
		parsed.bytes.buffer,
		parsed.bytes.byteOffset,
		parsed.bytes.byteLength,
	);
	for (let i = 0; i < segment.vertexCount; i++) {
		const o = stream.offset + i * 12;
		out[i * 3 + 0] = v.getFloat32(o + 0, true);
		out[i * 3 + 1] = v.getFloat32(o + 4, true);
		out[i * 3 + 2] = v.getFloat32(o + 8, true);
	}
	return out;
}

/**
 * Extract index data for a single mesh segment as a typed array
 * (`Uint16Array` if `indexSize === 2`, `Uint32Array` if 4). Use
 * directly with `THREE.BufferGeometry.setIndex` or a raw WebGL
 * `ELEMENT_ARRAY_BUFFER`.
 */
export function extractIndices(
	parsed: ParsedPhyre,
	segment: PhyreMeshSegment,
): Uint16Array | Uint32Array {
	const v = new DataView(
		parsed.bytes.buffer,
		parsed.bytes.byteOffset,
		parsed.bytes.byteLength,
	);
	if (segment.indexSize === 2) {
		const out = new Uint16Array(segment.indexCount);
		for (let i = 0; i < segment.indexCount; i++) {
			out[i] = v.getUint16(segment.indicesOffset + i * 2, true);
		}
		return out;
	}
	if (segment.indexSize === 4) {
		const out = new Uint32Array(segment.indexCount);
		for (let i = 0; i < segment.indexCount; i++) {
			out[i] = v.getUint32(segment.indicesOffset + i * 4, true);
		}
		return out;
	}
	throw new Error(`Unsupported index size ${segment.indexSize}`);
}

/**
 * Find the first instance of a given class in the parsed phyre.
 * Returns `null` if the class isn't present.
 */
function findFirstInstance(
	parsed: ParsedPhyre,
	className: string,
): PhyreInstance | null {
	for (const inst of parsed.instances) {
		const cls = parsed.namespace.classes[inst.classId - 1];
		if (cls && cls.name === className) return inst;
	}
	return null;
}

/**
 * Collect every NUL-terminated ASCII string found in the array
 * tail of one or more class instance groups.
 *
 * PhyreEngine packs per-instance string content (asset IDs, bone
 * names, sampler names) into the `arraysSize` section that
 * follows each class group's object array. The actual byte
 * offsets of those strings are stored as pointers inside the
 * objects — pointers that are zeroed in the file image and only
 * become valid after the array-fixup table is applied at runtime.
 *
 * Rather than decode the (variable-length, big-endian, currently
 * undocumented) fixup tables, we scan the arrays section
 * directly. Every meaningful string is delimited by NUL bytes;
 * we yield each one in order. This is the same approach used by
 * `PhyreUnpacker` and `dds-phyre-tool` reference C++ codebases.
 */
function* scanArrayStrings(
	parsed: ParsedPhyre,
	className: string,
	minLength: number,
): Generator<string> {
	for (const inst of parsed.instances) {
		const cls = parsed.namespace.classes[inst.classId - 1];
		if (!cls || cls.name !== className) continue;
		const start = inst.dataOffset + inst.objectSize;
		const end = start + inst.arraysSize;
		let s = '';
		for (let i = start; i < end; i++) {
			const b = parsed.bytes[i]!;
			if (b >= 32 && b < 127) {
				s += String.fromCharCode(b);
			} else {
				if (s.length >= minLength) yield s;
				s = '';
			}
		}
		if (s.length >= minLength) yield s;
	}
}

/**
 * A texture / asset reference parsed out of a `.dae.phyre` file.
 * Asset paths look like `PS3Data/chr/npc/n142/tex/n142.dds`; we
 * strip the `PS3Data/` prefix and the original asset's `.dds`
 * suffix to make them easier to correlate with sibling files on
 * disk (which usually end in `.dds.phyre`).
 */
export interface PhyreAssetReference {
	/** Original reference string exactly as stored in the file. */
	raw: string;
	/**
	 * Logical path with `PS3Data/` prefix stripped. Useful for
	 * matching against archive paths like `ffx_data/gamedata/ps3data/...`.
	 */
	path: string;
	/**
	 * Just the file name component (e.g. `n142.dds` for the
	 * reference `PS3Data/chr/npc/n142/tex/n142.dds`). Easiest
	 * thing to match against a phyre archive that flattens
	 * paths to file names.
	 */
	name: string;
	/** True if the reference points to a texture (suffix `.dds`). */
	isTexture: boolean;
}

/**
 * Extract every asset reference embedded in a parsed `.dae.phyre`
 * (or any phyre with `PAssetReference` instances).
 *
 * Returns references in declaration order. Use
 * `.filter(r => r.isTexture)` to narrow to texture references.
 *
 * Path strings look like `PS3Data/chr/npc/n142/tex/n142.dds`;
 * the sibling phyre file on disk would be at
 * `…/n142/tex/nvn/n142.dds.phyre`.
 */
export function findAssetReferences(
	parsed: ParsedPhyre,
): PhyreAssetReference[] {
	const out: PhyreAssetReference[] = [];
	// References are stored across two related classes — strings
	// land in whichever instance owns the array tail, which
	// varies between platform builds.
	const visited = new Set<string>();
	const scanClasses = ['PAssetReference', 'PAssetReferenceImport'];
	const all: string[] = [];
	for (const className of scanClasses) {
		for (const raw of scanArrayStrings(parsed, className, 4)) {
			if (visited.has(raw)) continue;
			visited.add(raw);
			all.push(raw);
		}
	}
	for (const raw of all) {
		// Skip obvious non-asset-id strings (PS3Data/... prefix is
		// the standard marker; nothing else passes this filter).
		if (!raw.startsWith('PS3Data/')) continue;
		// Strip the prefix; trim a trailing `#fragment` (asset
		// fragment, e.g. `#MeshNode0`) and keep the file part.
		const noPrefix = raw.slice('PS3Data/'.length);
		const beforeFragment = noPrefix.split('#')[0]!;
		const lastSlash = beforeFragment.lastIndexOf('/');
		const name = lastSlash >= 0
			? beforeFragment.slice(lastSlash + 1)
			: beforeFragment;
		const isTexture = beforeFragment.toLowerCase().endsWith('.dds');
		out.push({ raw, path: beforeFragment, name, isTexture });
	}
	return out;
}

// ----- DDS export -----

/** DDS pixel-format flags. */
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_ALPHA = 0x2;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;

/** DDS header flags. */
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_LINEARSIZE = 0x80000;

/** DDS caps flags. */
const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_TEXTURE = 0x1000;
const DDSCAPS_MIPMAP = 0x400000;

/** DDS FourCC constants (ASCII LE). */
const FOURCC_DXT1 = 0x31545844;
const FOURCC_DXT3 = 0x33545844;
const FOURCC_DXT5 = 0x35545844;
const FOURCC_ATI2 = 0x32495441;
const FOURCC_BC7 = 0x20374342;
const FOURCC_DX10 = 0x30315844;

/** DX10 dxgiFormat constants for the BC7 extension path. */
const DXGI_FORMAT_BC7_UNORM = 98;

/**
 * Build a standard DDS file (header + optional DX10 extension +
 * pixel data) from a PhyreEngine texture. The result is byte-
 * for-byte compatible with Photoshop's DDS plugin, Noesis, and
 * the GPU-Z dump format.
 *
 * Mipmaps are passed through unchanged. The caller decides
 * whether to apply the upside-down -> right-side-up row flip
 * (NVN textures store rows reversed vs DDS convention); see
 * {@link flipDdsRowsInPlace} for that.
 */
export function encodeAsDds(
	texture: PhyreTexture,
	pixels: Uint8Array,
): Uint8Array {
	const useDx10 = texture.format === 'BC7';
	const headerSize = useDx10 ? 128 + 20 : 128;
	const out = new Uint8Array(headerSize + pixels.byteLength);
	const v = new DataView(out.buffer);
	const enc = new TextEncoder();

	// "DDS " magic + DDS_HEADER (124 bytes after the magic).
	out.set(enc.encode('DDS '), 0);
	v.setUint32(4, 124, true); // dwSize
	let flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
	let caps = DDSCAPS_TEXTURE;
	// Use the engine's reported mip count if present; fall back
	// to maxMipLevel (which some files use as the *count* when
	// mipmapCount is zero).
	const mips = texture.mipmapCount > 0
		? texture.mipmapCount
		: texture.maxMipLevel > 0
			? texture.maxMipLevel
			: 1;
	if (mips > 1) {
		flags |= DDSD_MIPMAPCOUNT;
		caps |= DDSCAPS_MIPMAP | DDSCAPS_COMPLEX;
	}
	const pitch = computePitchOrLinearSize(
		texture.format,
		texture.width,
		texture.height,
	);
	if (pitch.isLinear) flags |= DDSD_LINEARSIZE;
	else flags |= DDSD_PITCH;
	v.setUint32(8, flags, true);
	v.setUint32(12, texture.height, true);
	v.setUint32(16, texture.width, true);
	v.setUint32(20, pitch.value, true);
	v.setUint32(24, 1, true); // depth
	v.setUint32(28, mips, true);
	// reserved1[11] at offset 32–75
	writePixelFormat(v, 76, texture.format, useDx10);
	v.setUint32(108, caps, true);
	// caps2, caps3, caps4, reserved2: all zero
	if (useDx10) {
		// DX10 extension header
		v.setUint32(128, DXGI_FORMAT_BC7_UNORM, true);
		v.setUint32(132, 3, true); // resourceDimension = TEXTURE2D
		v.setUint32(136, 0, true); // miscFlag
		v.setUint32(140, 1, true); // arraySize
		v.setUint32(144, 0, true); // miscFlags2
	}
	out.set(pixels, headerSize);
	return out;
}

/**
 * Write the DDS_PIXELFORMAT struct (32 bytes at `offset`) for
 * the given Phyre texture format.
 */
function writePixelFormat(
	v: DataView,
	offset: number,
	format: PhyreTextureFormat,
	useDx10: boolean,
): void {
	v.setUint32(offset + 0, 32, true); // dwSize
	let pfFlags = 0;
	let fourCC = 0;
	let rgbBitCount = 0;
	let rMask = 0,
		gMask = 0,
		bMask = 0,
		aMask = 0;
	switch (format) {
		case 'DXT1':
			pfFlags = DDPF_FOURCC;
			fourCC = FOURCC_DXT1;
			break;
		case 'DXT3':
			pfFlags = DDPF_FOURCC;
			fourCC = FOURCC_DXT3;
			break;
		case 'DXT5':
			pfFlags = DDPF_FOURCC;
			fourCC = FOURCC_DXT5;
			break;
		case 'BC4':
			pfFlags = DDPF_FOURCC;
			fourCC = 0x31495441; // 'ATI1'
			break;
		case 'BC5':
			pfFlags = DDPF_FOURCC;
			fourCC = FOURCC_ATI2; // 'ATI2'
			break;
		case 'BC7':
			pfFlags = DDPF_FOURCC;
			fourCC = useDx10 ? FOURCC_DX10 : FOURCC_BC7;
			break;
		case 'RGBA8':
			pfFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
			rgbBitCount = 32;
			rMask = 0x000000ff;
			gMask = 0x0000ff00;
			bMask = 0x00ff0000;
			aMask = 0xff000000;
			break;
		case 'ARGB8':
			pfFlags = DDPF_RGB | DDPF_ALPHAPIXELS;
			rgbBitCount = 32;
			rMask = 0x00ff0000;
			gMask = 0x0000ff00;
			bMask = 0x000000ff;
			aMask = 0xff000000;
			break;
		case 'L8':
			pfFlags = DDPF_LUMINANCE;
			rgbBitCount = 8;
			rMask = 0xff;
			break;
		case 'A8':
			pfFlags = DDPF_ALPHA;
			rgbBitCount = 8;
			aMask = 0xff;
			break;
	}
	v.setUint32(offset + 4, pfFlags, true);
	v.setUint32(offset + 8, fourCC, true);
	v.setUint32(offset + 12, rgbBitCount, true);
	v.setUint32(offset + 16, rMask, true);
	v.setUint32(offset + 20, gMask, true);
	v.setUint32(offset + 24, bMask, true);
	v.setUint32(offset + 28, aMask, true);
}

/**
 * Compute the DDS `dwPitchOrLinearSize` field for the given
 * format / dimensions. For uncompressed formats this is the row
 * pitch in bytes; for compressed formats it's the total mip-0
 * size in bytes.
 */
function computePitchOrLinearSize(
	format: PhyreTextureFormat,
	width: number,
	height: number,
): { value: number; isLinear: boolean } {
	const blocksX = Math.max(1, (width + 3) >> 2);
	const blocksY = Math.max(1, (height + 3) >> 2);
	switch (format) {
		case 'DXT1':
		case 'BC4':
			return { value: blocksX * blocksY * 8, isLinear: true };
		case 'DXT3':
		case 'DXT5':
		case 'BC5':
		case 'BC7':
			return { value: blocksX * blocksY * 16, isLinear: true };
		case 'RGBA8':
		case 'ARGB8':
			return { value: width * 4, isLinear: false };
		case 'L8':
		case 'A8':
			return { value: width, isLinear: false };
	}
}

/**
 * Number of bytes a single mip level occupies for the given
 * format + dimensions. Useful for callers that want to iterate
 * just the first mip (and skip the smaller mip pyramids).
 */
export function bytesForMipLevel(
	format: PhyreTextureFormat,
	width: number,
	height: number,
): number {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const blocksX = Math.max(1, (w + 3) >> 2);
	const blocksY = Math.max(1, (h + 3) >> 2);
	switch (format) {
		case 'DXT1':
		case 'BC4':
			return blocksX * blocksY * 8;
		case 'DXT3':
		case 'DXT5':
		case 'BC5':
		case 'BC7':
			return blocksX * blocksY * 16;
		case 'RGBA8':
		case 'ARGB8':
			return w * h * 4;
		case 'L8':
		case 'A8':
			return w * h;
	}
}

// ----- NVN (Switch) deswizzle -----

/**
 * Pick the Tegra X1 block-height exponent PhyreEngine uses when
 * laying out NVN textures.
 *
 * Empirically (FFX HD Remaster, Switch), Phyre picks
 *
 *     blockHeight = clamp(prevPow2(floor(heightInBlocks / 8)), 1, 16)
 *
 * which differs from BNTX's "largest pow2 ≤ heightInBlocks"
 * heuristic. A GOB on Tegra is 8 rows of blocks tall, so
 * `heightInBlocks / 8` is the number of GOB rows; rounding down
 * to a power of two matches the driver's preferred block-height
 * for non-power-of-two surfaces.
 *
 * Verified samples (hib -> bh):
 *   8 -> 1, 16 -> 2, 40 -> 4, 64 -> 8, 256 -> 16
 */
export function phyreNvnBlockHeight(heightInBlocks: number): number {
	const gobRows = Math.floor(heightInBlocks / 8);
	if (gobRows < 1) return 1;
	// Largest power of 2 ≤ gobRows, capped at 16.
	let bh = 1;
	while (bh * 2 <= gobRows && bh < 16) bh *= 2;
	return bh;
}

/**
 * Deswizzle a single mip level of a PhyreEngine NVN (Switch)
 * texture. The input is the swizzled block-linear payload as
 * stored in the `.phyre` file; the output is the linear row-
 * major pixel bytes that DDS / decoders expect.
 *
 * `mipBytes` should be the slice of pixel data corresponding to
 * one mip level only — pass `bytesForMipLevel(format, w, h)`
 * worth of bytes for the chosen `width` and `height`. For
 * single-mip textures this is just {@link extractTexturePixels}.
 *
 * Returns a fresh buffer of size
 * `bytesForMipLevel(format, width, height)` (the LINEAR mip
 * size), regardless of how much padding/swizzling the source
 * contained.
 */
export function deswizzleNvnMip(opts: {
	format: PhyreTextureFormat;
	width: number;
	height: number;
	data: Uint8Array;
	/**
	 * Override the block-height exponent. Defaults to
	 * {@link phyreNvnBlockHeight} for the computed height-in-
	 * blocks.
	 */
	blockHeight?: number;
}): Uint8Array {
	const { blkW, blkH, bpb } = blockInfo(opts.format);
	const heightInBlocks = Math.max(1, Math.ceil(opts.height / blkH));
	const blockHeight = opts.blockHeight ?? phyreNvnBlockHeight(heightInBlocks);
	return bntxDeswizzle({
		width: opts.width,
		height: opts.height,
		blkWidth: blkW,
		blkHeight: blkH,
		bytesPerBlock: bpb,
		data: opts.data,
		blockHeight,
	});
}

function blockInfo(format: PhyreTextureFormat): {
	blkW: number;
	blkH: number;
	bpb: number;
} {
	switch (format) {
		case 'DXT1':
		case 'BC4':
			return { blkW: 4, blkH: 4, bpb: 8 };
		case 'DXT3':
		case 'DXT5':
		case 'BC5':
		case 'BC7':
			return { blkW: 4, blkH: 4, bpb: 16 };
		case 'RGBA8':
		case 'ARGB8':
			return { blkW: 1, blkH: 1, bpb: 4 };
		case 'L8':
		case 'A8':
			return { blkW: 1, blkH: 1, bpb: 1 };
	}
}

/**
 * Flip pixel rows in-place to convert from PhyreEngine's
 * upside-down convention to the standard DDS / Photoshop /
 * Noesis convention. Only flips mip 0; mip pyramids stay in
 * level order.
 *
 * Returns the input array for chaining convenience.
 */
export function flipDdsRowsInPlace(
	pixels: Uint8Array,
	format: PhyreTextureFormat,
	width: number,
	height: number,
): Uint8Array {
	const rowPitch = rowPitchBytes(format, width);
	const numRows = format === 'RGBA8' || format === 'ARGB8' || format === 'L8' || format === 'A8'
		? height
		: Math.max(1, (height + 3) >> 2); // block rows for compressed
	if (rowPitch === 0 || numRows < 2) return pixels;
	const tmp = new Uint8Array(rowPitch);
	for (let y = 0; y < numRows >> 1; y++) {
		const top = y * rowPitch;
		const bot = (numRows - 1 - y) * rowPitch;
		tmp.set(pixels.subarray(top, top + rowPitch));
		pixels.copyWithin(top, bot, bot + rowPitch);
		pixels.set(tmp, bot);
	}
	return pixels;
}

function rowPitchBytes(format: PhyreTextureFormat, width: number): number {
	const w = Math.max(1, width);
	const blocksX = Math.max(1, (w + 3) >> 2);
	switch (format) {
		case 'DXT1':
		case 'BC4':
			return blocksX * 8;
		case 'DXT3':
		case 'DXT5':
		case 'BC5':
		case 'BC7':
			return blocksX * 16;
		case 'RGBA8':
		case 'ARGB8':
			return w * 4;
		case 'L8':
		case 'A8':
			return w;
	}
}

// ----- Utility -----

/**
 * Read a NUL-terminated ASCII string starting at `offset`. If
 * `maxLength` is given, the read stops there even without a NUL.
 */
function readCString(
	bytes: Uint8Array,
	offset: number,
	maxLength?: number,
): string {
	const end =
		maxLength !== undefined
			? Math.min(bytes.byteLength, offset + maxLength)
			: bytes.byteLength;
	let i = offset;
	while (i < end && bytes[i] !== 0) i++;
	return new TextDecoder('ascii').decode(bytes.subarray(offset, i));
}
