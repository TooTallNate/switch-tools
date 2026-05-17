/**
 * Parser for idTech BFG `.bimage` files.
 *
 * `.bimage` is the preprocessed binary texture format introduced
 * with DOOM 3 BFG Edition (id Software, 2012). All BFG-era idTech
 * textures (Switch port of DOOM 3 BFG, RAGE, Wolfenstein TNO) end
 * up in this container, regardless of source asset type. The
 * container is dumb: a small header that describes the texture
 * dimensions + a tagged pixel format, followed by a list of mip
 * levels each carrying their pre-encoded pixel bytes.
 *
 * Wire layout (all multi-byte fields big-endian on disk; integer
 * fields use `idFile::WriteBig`, structs are `#pragma pack(1)`):
 *
 *   ┌─────────────────────────┐
 *   │ Header (36 bytes)       │   #pragma pack(1)
 *   │   uint64 sourceFileTime │
 *   │   uint32 magic          │   = 0x0A4D4942 ('BIM' + version 10)
 *   │   int32  textureType    │   1=2D, 2=Cubic
 *   │   int32  format         │   textureFormat_t enum
 *   │   int32  colorFormat    │   textureColor_t enum
 *   │   int32  width          │
 *   │   int32  height         │
 *   │   int32  numLevels      │
 *   ├─────────────────────────┤
 *   │ For each mip:           │   (×numLevels, ×6 if cube)
 *   │   int32 level           │   natural alignment, no packing
 *   │   int32 destZ           │
 *   │   int32 width           │
 *   │   int32 height          │
 *   │   int32 dataSize        │
 *   │   byte[dataSize] pixels │   format-specific encoded bytes
 *   └─────────────────────────┘
 *
 * Reference: `neo/renderer/BinaryImage.cpp` +
 * `neo/renderer/BinaryImageData.h` in `id-Software/DOOM-3-BFG`
 * (GPL-3, source for spec; this file is a clean-room rewrite).
 */

const HEADER_SIZE = 36;
const MIP_HEADER_SIZE = 20;

/** `'B' | 'I'<<8 | 'M'<<16 | (BIMAGE_VERSION=10)<<24` = 0x0A4D4942. */
export const BIMAGE_MAGIC = 0x0a4d4942;

/** idTech BFG `textureType_t`. */
export enum BimageTextureType {
	Disabled = 0,
	Texture2D = 1,
	Cubic = 2,
}

/**
 * idTech BFG `textureFormat_t`. Numeric values match the C++ enum
 * positions exactly so callers can do switch dispatch directly.
 */
export enum BimageFormat {
	None = 0,
	RGBA8 = 1, // 32 bpp
	XRGB8 = 2, // 32 bpp
	Alpha = 3, // 8 bpp alpha-only
	L8A8 = 4, // 16 bpp luminance + alpha
	LUM8 = 5, // 8 bpp luminance
	INT8 = 6, // 8 bpp intensity
	DXT1 = 7, // 4 bpp BC1
	DXT5 = 8, // 8 bpp BC3
	Depth = 9, // 24 bpp depth buffer
	X16 = 10, // 16 bpp
	Y16_X16 = 11, // 32 bpp
	RGB565 = 12, // 16 bpp
}

/** idTech BFG `textureColor_t`. */
export enum BimageColorFormat {
	Default = 0, // straight RGBA
	NormalDXT5 = 1, // swizzled normal map (XY in alpha+green)
	YCoCgDXT5 = 2, // chroma-subsampled colour
	GreenAlpha = 3, // alpha copied to green channel (signed-distance fonts)
}

export interface BimageMipLevel {
	/** Mip level index (0 = base). */
	level: number;
	/** Slice index for cube maps (0–5). Always 0 for 2D. */
	destZ: number;
	/** Width of this mip in pixels. */
	width: number;
	/** Height of this mip in pixels. */
	height: number;
	/** Encoded pixel byte count (matches the on-disk dataSize field). */
	dataSize: number;
	/** Lazy view of this mip's encoded pixel data. */
	data: Blob;
}

export interface ParsedBimage {
	/** Build-time timestamp of the source asset (epoch seconds). */
	sourceFileTime: bigint;
	/** Texture topology. */
	textureType: BimageTextureType;
	/** Pixel encoding format. */
	format: BimageFormat;
	/** Channel-layout hint that modifies decode (see {@link BimageColorFormat}). */
	colorFormat: BimageColorFormat;
	/** Width of the base mip in pixels. */
	width: number;
	/** Height of the base mip in pixels. */
	height: number;
	/** Number of mip levels (1 = no mips). */
	numLevels: number;
	/**
	 * Parsed mip levels in declaration order. For cube maps each
	 * mip is repeated 6 times (one entry per face) — total length
	 * is `numLevels * 6` in that case; for 2D textures it equals
	 * `numLevels`.
	 */
	mips: BimageMipLevel[];
}

/** Cheap magic check: BIMAGE_MAGIC at offset 8 (skip the 8-byte timestamp). */
export async function isBimage(blob: Blob): Promise<boolean> {
	if (blob.size < 12) return false;
	const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
	return v.getUint32(8, /*littleEndian*/ false) === BIMAGE_MAGIC;
}

/**
 * Parse a `.bimage` file. Reads the header + per-mip headers up
 * front; each mip's pixel data is exposed as a lazy `Blob.slice()`
 * so callers can defer decode to whatever BCn / RGBA reader they
 * prefer.
 */
export async function parseBimage(blob: Blob): Promise<ParsedBimage> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a .bimage (${blob.size} bytes, need at least ${HEADER_SIZE})`,
		);
	}

	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

	const sourceFileTime = view.getBigUint64(0, false);
	const magic = view.getUint32(8, false);
	if (magic !== BIMAGE_MAGIC) {
		throw new Error(
			`Bad .bimage magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x0a4d4942)`,
		);
	}
	const textureType = view.getInt32(12, false) as BimageTextureType;
	const format = view.getInt32(16, false) as BimageFormat;
	const colorFormat = view.getInt32(20, false) as BimageColorFormat;
	const width = view.getInt32(24, false);
	const height = view.getInt32(28, false);
	const numLevels = view.getInt32(32, false);

	if (numLevels <= 0 || numLevels > 32) {
		throw new Error(`Implausible numLevels ${numLevels}`);
	}
	if (width <= 0 || height <= 0 || width > 32768 || height > 32768) {
		throw new Error(`Implausible dimensions ${width}×${height}`);
	}
	if (textureType !== BimageTextureType.Texture2D && textureType !== BimageTextureType.Cubic) {
		throw new Error(`Unsupported textureType ${textureType}`);
	}

	const totalMips = textureType === BimageTextureType.Cubic ? numLevels * 6 : numLevels;

	// Walk the mip headers. The pixel data is sandwiched between
	// each header — we read each header, note where the data lives,
	// then skip past it to the next header.
	const mips: BimageMipLevel[] = new Array(totalMips);
	let cursor = HEADER_SIZE;
	for (let i = 0; i < totalMips; i++) {
		if (cursor + MIP_HEADER_SIZE > blob.size) {
			throw new Error(
				`Mip ${i}: header runs past end of file (cursor=${cursor}, blob=${blob.size})`,
			);
		}
		const mipHeadBuf = new Uint8Array(
			await blob.slice(cursor, cursor + MIP_HEADER_SIZE).arrayBuffer(),
		);
		const mv = new DataView(mipHeadBuf.buffer, mipHeadBuf.byteOffset, mipHeadBuf.byteLength);
		const level = mv.getInt32(0, false);
		const destZ = mv.getInt32(4, false);
		const mipWidth = mv.getInt32(8, false);
		const mipHeight = mv.getInt32(12, false);
		const dataSize = mv.getInt32(16, false);
		cursor += MIP_HEADER_SIZE;

		if (dataSize < 0 || cursor + dataSize > blob.size) {
			throw new Error(
				`Mip ${i}: bad dataSize ${dataSize} at offset ${cursor}`,
			);
		}
		mips[i] = {
			level,
			destZ,
			width: mipWidth,
			height: mipHeight,
			dataSize,
			data: blob.slice(cursor, cursor + dataSize),
		};
		cursor += dataSize;
	}

	return {
		sourceFileTime,
		textureType,
		format,
		colorFormat,
		width,
		height,
		numLevels,
		mips,
	};
}
