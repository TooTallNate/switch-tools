/**
 * Parser for FF7 PC field Section 9 (Background). This is the
 * meat of the field-scene format: it holds the per-palette
 * transparency-flag table, the four tile layers (TileMap), AND
 * the texture pages that the tiles sample from.
 *
 * Layout (after the section's 4-byte length prefix is stripped):
 *
 *   offset                size      field
 *      0                  u16       unknown1            (~0)
 *      2                  u16       depth               (1 / 2)
 *      4                  u8        unknown2 / enabled  (~1)
 *      5                  7 bytes   ASCII "PALETTE"
 *
 *      # Local 6-color palette (vestigial; we skip it)
 *     12                  u32       palSize             (= 12 + palW*2*palH)
 *     16                  u16       palX, palY          (PSX leftover)
 *     20                  u16       palWidth (always 6 on PC), palHeight (always 1)
 *     24                  u16[6]    6 RGB555 colors     (ignored)
 *
 *     36                  4 bytes   ASCII "BACK"
 *
 *     # Layer 0 (always present)
 *     40                  Layer0Block:
 *                           u16 width, height, numTiles, depth, blank
 *                           TilePC[numTiles]                 (52 bytes each)
 *                           u16 blank2
 *
 *     # Layer 1 (gated on a u8 flag)
 *      ?                  u8 enabled
 *                         if enabled:
 *                           u16 width, height, numTiles
 *                           u8[16] hint table (HeaderLayer2TilePC)
 *                           u16 blank
 *                           TilePC[numTiles]
 *                           u16 blank2
 *
 *     # Layer 2 (gated on a u8 flag, 32x32 tiles)
 *      ?                  u8 enabled
 *                         if enabled:
 *                           u16 width, height, numTiles
 *                           u8[10] reserved
 *                           u16 blank
 *                           TilePC[numTiles]
 *                           u16 blank2
 *
 *     # Layer 3 (gated on a u8 flag, 32x32 tiles)
 *      ?                  u8 enabled
 *                         if enabled:
 *                           u16 width, height, numTiles
 *                           u8[10] hint table (HeaderLayer4TilePC; only 8 used)
 *                           u16 blank
 *                           TilePC[numTiles]
 *                           u16 blank2
 *
 *      ?                  7 bytes   ASCII "TEXTURE"
 *                         TexturePage[42]                    (preceded by u16 exists)
 *                         3 bytes   ASCII "END"
 *                        14 bytes   ASCII "FINAL FANTASY7"
 *
 * The per-palette "ignoreFirstPixel" flags (20 bytes) overlap
 * with the local 6-color palette region (12 bytes), but the
 * runtime treats those 20 bytes as transparency flags. We expose
 * them as `ignoreFirstPixel` directly.
 *
 * TilePC (the on-disk record per tile, 52 bytes):
 *
 *   offset  size  field
 *     0     u16   blank   (= 0)
 *     2     i16   dstX
 *     4     i16   dstY
 *     6     u32   unused1
 *    10     u8    srcX     (texture page x; 0..255)
 *    11     u8    unused2
 *    12     u8    srcY
 *    13     u8    unused3
 *    14     u8    srcX2    (used when blending; layer > 0 only)
 *    15     u8    unused4
 *    16     u8    srcY2
 *    17     u8    unused5
 *    18     u16   width    (advisory; 16 or 32)
 *    20     u16   height
 *    22     u8    paletteID
 *    23     u8    unused6
 *    24     u16   ID       (Z layer marker; 4095=L0, ?=L1 Z, 4096=L2, 0=L3)
 *    26     u8    param    (script-driven visibility group)
 *    27     u8    state    (POWER-OF-TWO mask, not a bit index)
 *    28     u8    blending (0=no, 1=use typeTrans)
 *    29     u8    unknown7
 *    30     u8    typeTrans (0=50% avg, 1=add, 2=sub, 3=add 25%)
 *    31     u8    unused8
 *    32     u8    textureID
 *    33     u8    unused9
 *    34     u8    textureID2
 *    35     u8    unused10
 *    36     u8    depth     (1=paletted, 2=direct color, 0=4bpp [rare])
 *    37     u8    unused11
 *    38     u32   IDBig     (alt ID, unused)
 *    42     u32   srcXBig   (= round(srcX/256 * 1e7); leftover)
 *    46     u32   srcYBig
 *    50     u16   blank2    (= 0)
 *
 *
 * Texture page (after the "TEXTURE" magic):
 *
 *   for texID in 0..41:
 *     u16  exists
 *     if exists:
 *       u16  isBigTile  (advisory; 0 = 16x16 tile-mode, 1 = 32x32)
 *       u16  depth      (0 = 4bpp, 1 = 8-bit paletted, 2 = 16-bit direct)
 *       byte[ depth == 0 ? 32768 : 256*256*depth ]  pixel data
 */

export class BackgroundParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BackgroundParseError';
	}
}

export const TILE_PC_RECORD_SIZE = 52 as const;
export const MAX_TEXTURE_PAGES = 42 as const;
export const IGNORE_FIRST_PIXEL_TABLE_SIZE = 20 as const;

export interface BackgroundTile {
	/** 0..3, derived from `ID` field (see below). */
	layerID: 0 | 1 | 2 | 3;
	/** Destination position in image space ((0,0) is image center). */
	dstX: number;
	dstY: number;
	/**
	 * Resolved source coords + texture ID. For `layerID > 0 &&
	 * blending`, these come from the `*2` fields in the on-disk
	 * record. Otherwise they come from the primary `srcX/srcY/textureID`
	 * fields.
	 */
	srcX: number;
	srcY: number;
	textureID: number;
	/** Palette page index into `ParsedPalette.pages`. */
	paletteID: number;
	/** Z-marker as stored on disk (we keep both this and `layerID`). */
	ID: number;
	/** Script-driven visibility group key. */
	param: number;
	/** Power-of-two visibility mask byte (NOT a bit index). */
	state: number;
	/** Same as `state` but expressed as a bit index (or 0 if `state == 0`). */
	stateBit: number;
	/** 0 = no blending, 1 = apply `typeTrans`. Only on layers 1..3. */
	blending: 0 | 1;
	/** 0 = 50% avg, 1 = add, 2 = sub, 3 = add 25%. Honored if blending==1. */
	typeTrans: 0 | 1 | 2 | 3;
	/** 1 = paletted, 2 = direct-color, 0 = 4bpp (rare). Same as `textures[textureID].depth`. */
	depth: number;
	/** Source record index within its layer (debug). */
	recordIndex: number;
}

export interface BackgroundTexturePage {
	textureID: number;
	/** 16 (default) or 32. Advisory. */
	isBigTile: 0 | 1;
	/** 1 = paletted (256×256 bytes), 2 = direct-color (256×256 u16), 0 = 4bpp. */
	depth: 0 | 1 | 2;
	/** Raw pixel bytes. Length depends on depth (65536 / 131072 / 32768). */
	data: Uint8Array;
}

export interface ParsedBackground {
	/**
	 * Per-palette "render index 0 as transparent" boolean flags.
	 * Indexed by paletteID; missing entries default to `false`.
	 * Maximum length is 20.
	 */
	ignoreFirstPixel: boolean[];
	/** All tiles from all 4 layers, in author order. */
	tiles: BackgroundTile[];
	/** Texture pages by ID. Sparse (only populated IDs present). */
	textures: Map<number, BackgroundTexturePage>;
	/**
	 * Bounding box of all tile destinations, accounting for tile
	 * size per layer. Useful for sizing the composite canvas.
	 */
	bounds: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
	};
}

interface Cursor {
	view: DataView;
	bytes: Uint8Array;
	pos: number;
}

function readU8(c: Cursor): number {
	return c.view.getUint8(c.pos++);
}
function readU16(c: Cursor): number {
	const v = c.view.getUint16(c.pos, true);
	c.pos += 2;
	return v;
}
function readMagic(c: Cursor, expected: string): void {
	const got = String.fromCharCode(
		...c.bytes.subarray(c.pos, c.pos + expected.length),
	);
	if (got !== expected) {
		throw new BackgroundParseError(
			`Expected magic "${expected}" at offset 0x${c.pos.toString(16)}, got "${got}"`,
		);
	}
	c.pos += expected.length;
}

function readLayer(
	c: Cursor,
	layerID: 0 | 1 | 2 | 3,
	headerExtraSize: number,
	out: BackgroundTile[],
): void {
	// Layers 1..3 are gated on a presence byte.
	if (layerID !== 0) {
		const enabled = readU8(c);
		if (enabled === 0) return;
	}
	// Each layer has width/height/numTiles then a layer-specific
	// extra header block (16 bytes for L1, 10 bytes for L2/L3,
	// none for L0 which uses depth+blank instead).
	const _width = readU16(c);
	const _height = readU16(c);
	const numTiles = readU16(c);
	if (layerID === 0) {
		// L0's "extra" is u16 depth + u16 blank (= 4 bytes).
		c.pos += 4;
	} else {
		c.pos += headerExtraSize;
		// u16 blank
		c.pos += 2;
	}

	for (let i = 0; i < numTiles; i++) {
		if (c.pos + TILE_PC_RECORD_SIZE > c.bytes.length) {
			throw new BackgroundParseError(
				`Layer ${layerID} tile ${i}/${numTiles}: only ${
					c.bytes.length - c.pos
				} bytes remaining at offset 0x${c.pos.toString(16)}`,
			);
		}
		const base = c.pos;
		// blank
		const dstX = c.view.getInt16(base + 2, true);
		const dstY = c.view.getInt16(base + 4, true);
		const srcX = c.view.getUint8(base + 10);
		const srcY = c.view.getUint8(base + 12);
		const srcX2 = c.view.getUint8(base + 14);
		const srcY2 = c.view.getUint8(base + 16);
		// width/height advisory
		const paletteID = c.view.getUint8(base + 22);
		const ID = c.view.getUint16(base + 24, true);
		const param = c.view.getUint8(base + 26);
		const state = c.view.getUint8(base + 27);
		const blending = (c.view.getUint8(base + 28) & 1) as 0 | 1;
		const typeTrans = (c.view.getUint8(base + 30) & 3) as 0 | 1 | 2 | 3;
		const textureID = c.view.getUint8(base + 32);
		const textureID2 = c.view.getUint8(base + 34);
		const depth = c.view.getUint8(base + 36);

		c.pos += TILE_PC_RECORD_SIZE;

		// Resolve src + textureID based on layer + blending.
		const useAlt = layerID > 0 && blending === 1;
		const stateBit = state === 0 ? 0 : Math.log2(state) | 0;

		out.push({
			layerID,
			dstX,
			dstY,
			srcX: useAlt ? srcX2 : srcX,
			srcY: useAlt ? srcY2 : srcY,
			textureID: useAlt ? textureID2 : textureID,
			paletteID,
			ID,
			param,
			state,
			stateBit,
			blending,
			typeTrans,
			depth,
			recordIndex: i,
		});
	}
	// trailing u16 blank2
	c.pos += 2;
}

function readTextures(c: Cursor): Map<number, BackgroundTexturePage> {
	readMagic(c, 'TEXTURE');
	const textures = new Map<number, BackgroundTexturePage>();
	for (let t = 0; t < MAX_TEXTURE_PAGES; t++) {
		const exists = readU16(c);
		if (!exists) continue;
		const isBigTile = readU16(c) === 1 ? 1 : 0;
		const depth = readU16(c);
		if (depth !== 0 && depth !== 1 && depth !== 2) {
			throw new BackgroundParseError(
				`Texture page ${t}: invalid depth ${depth} (expected 0, 1, or 2)`,
			);
		}
		const byteSize = depth === 0 ? 32768 : 256 * 256 * depth;
		if (c.pos + byteSize > c.bytes.length) {
			throw new BackgroundParseError(
				`Texture page ${t}: needs ${byteSize} bytes but only ${
					c.bytes.length - c.pos
				} remain`,
			);
		}
		textures.set(t, {
			textureID: t,
			isBigTile,
			depth: depth as 0 | 1 | 2,
			data: c.bytes.subarray(c.pos, c.pos + byteSize),
		});
		c.pos += byteSize;
	}
	return textures;
}

function computeBounds(tiles: BackgroundTile[]): ParsedBackground['bounds'] {
	if (tiles.length === 0) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const t of tiles) {
		const size = t.layerID >= 2 ? 32 : 16;
		if (t.dstX < minX) minX = t.dstX;
		if (t.dstY < minY) minY = t.dstY;
		if (t.dstX + size > maxX) maxX = t.dstX + size;
		if (t.dstY + size > maxY) maxY = t.dstY + size;
	}
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

export function parseBackground(bytes: Uint8Array): ParsedBackground {
	if (bytes.length < 64) {
		throw new BackgroundParseError(
			`Background section too short (${bytes.length} bytes)`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const c: Cursor = { view, bytes, pos: 0 };

	// Skip 2 + 2 + 1 header bytes (unknown1 / depth / unknown2).
	c.pos += 5;
	readMagic(c, 'PALETTE');

	// The next 20 bytes are the per-palette "ignoreFirstPixel"
	// transparency flags. (They textually overlap with a 12-byte
	// "local 6-color palette" header but the PC runtime treats
	// them as flags — see makoureactor's PaletteIOPC.)
	const ignoreFirstPixel: boolean[] = new Array(
		IGNORE_FIRST_PIXEL_TABLE_SIZE,
	);
	for (let i = 0; i < IGNORE_FIRST_PIXEL_TABLE_SIZE; i++) {
		ignoreFirstPixel[i] = bytes[c.pos + i]! !== 0;
	}
	c.pos += IGNORE_FIRST_PIXEL_TABLE_SIZE;
	// Skip the u32 "blank" after the flag table.
	c.pos += 4;

	readMagic(c, 'BACK');

	const tiles: BackgroundTile[] = [];
	// Layer 0 (always present; no enable byte).
	readLayer(c, 0, 0, tiles);
	// Layer 1 (16 bytes of HeaderLayer2TilePC hints).
	readLayer(c, 1, 16, tiles);
	// Layer 2 (10 bytes of reserved zeros).
	readLayer(c, 2, 10, tiles);
	// Layer 3 (10 bytes of HeaderLayer4TilePC hints; only 8 used).
	readLayer(c, 3, 10, tiles);

	const textures = readTextures(c);

	// Optional sanity check: "END" + "FINAL FANTASY7" should
	// follow. Don't fail hard — some modded fields trim them.
	try {
		readMagic(c, 'END');
		readMagic(c, 'FINAL FANTASY7');
	} catch {
		/* tolerate */
	}

	const bounds = computeBounds(tiles);
	return { ignoreFirstPixel, tiles, textures, bounds };
}
