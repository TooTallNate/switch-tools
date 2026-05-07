/**
 * BFFNT (Cafe Font Format) container parser.
 *
 * BFFNT is Nintendo's bitmap-font format used by Wii U and Switch
 * games. The file is a chunked container holding:
 *
 *   FFNT — top-level header (magic + BOM + version + size + block count)
 *   FINF — font info: line height, baseline, per-default-glyph metrics,
 *          plus offsets to TGLP / CWDH / CMAP
 *   TGLP — texture glyph atlas: GPU-format texture(s) packed with all
 *          the glyphs in a sprite sheet, plus cell dimensions
 *   CWDH — character widths: per-glyph (left, glyph_width, char_width)
 *          metrics in glyph-index order. Linked list — each CWDH points
 *          to the next via `next_cwdh_offset`.
 *   CMAP — character map: Unicode codepoint → glyph index. Three
 *          mapping methods (direct, table, scan); each CMAP covers a
 *          range of codepoints and the file may contain many of them
 *          chained via `next_cmap_offset`.
 *   KRNG — kerning (optional, version-dependent; we don't use it)
 *
 * All multi-byte integers are little-endian on Switch (BOM = 0xFEFF
 * little-endian on disk = bytes `FF FE`). Wii U used big-endian — we
 * detect via the BOM and decode accordingly.
 *
 * Each section header is `<magic:4><size:4>` followed by section-
 * specific fields. Section sizes include the 8-byte header.
 *
 * Reference: https://www.3dbrew.org/wiki/BCFNT (BCFNT = same envelope,
 * older 3DS variant; BFFNT version 4 differs in field ordering and
 * texture format codes).
 */

export const FFNT_MAGIC = 'FFNT';

export type Endian = 'little' | 'big';

export interface BffntHeader {
	signature: 'FFNT';
	endian: Endian;
	headerSize: number;
	version: number;
	fileSize: number;
	blockCount: number;
}

/** FINF — Font Info section, v4 layout. */
export interface FontInfo {
	/** Font type: 1=glyph, 2=texture, 3=packed-texture. */
	fontType: number;
	height: number;
	width: number;
	ascent: number;
	lineFeed: number;
	/** Codepoint of the fallback glyph used for missing chars. */
	alterCharIndex: number;
	defaultLeft: number;
	defaultGlyphWidth: number;
	defaultCharWidth: number;
	/** 1=UTF-8, 2=UTF-16. */
	encoding: number;
	tglpOffset: number;
	cwdhOffset: number;
	cmapOffset: number;
}

/** TGLP — Texture Glyph atlas, v4 layout. */
export interface TextureGlyph {
	cellWidth: number;
	cellHeight: number;
	sheetCount: number;
	maxCharWidth: number;
	sheetSize: number;
	baselinePosition: number;
	/** Texture format code — see {@link decodeTextureFormat} mappings. */
	sheetImageFormat: number;
	sheetColumns: number;
	sheetRows: number;
	sheetWidth: number;
	sheetHeight: number;
	sheetDataOffset: number;
	/**
	 * The raw, still-swizzled texture bytes for every sheet,
	 * concatenated. Each sheet is `sheetSize` bytes.
	 */
	sheetData: Uint8Array;
}

/** CWDH — Character Widths block (one of potentially many). */
export interface CharWidthsBlock {
	startIndex: number;
	endIndex: number;
	/**
	 * 3-byte tuples of `(left, glyphWidth, charWidth)`, one per glyph
	 * index from `startIndex` to `endIndex` (inclusive). `left` is a
	 * signed-int8 horizontal-bearing offset; `glyphWidth` is the
	 * rendered glyph's width in pixels; `charWidth` is the advance
	 * width to use after this glyph.
	 */
	widths: Array<{ left: number; glyphWidth: number; charWidth: number }>;
}

/** CMAP — Character Map block (one of potentially many, chained). */
export type CharMapBlock =
	| {
			type: 'direct';
			codeBegin: number;
			codeEnd: number;
			indexOffset: number;
	  }
	| {
			type: 'table';
			codeBegin: number;
			codeEnd: number;
			/** `indexTable[i]` is the glyph index for codepoint `codeBegin + i`. */
			indexTable: Uint16Array;
	  }
	| {
			type: 'scan';
			codeBegin: number;
			codeEnd: number;
			/** Sparse codepoint→glyph-index pairs. */
			entries: Array<{ codepoint: number; glyphIndex: number }>;
	  };

export interface ParsedBffnt {
	header: BffntHeader;
	finf: FontInfo;
	tglp: TextureGlyph;
	/** All CWDH blocks, in linked-list order. */
	cwdhBlocks: CharWidthsBlock[];
	/** All CMAP blocks, in linked-list order. */
	cmapBlocks: CharMapBlock[];
}

const SENTINEL_OFFSET = 0xffffffff;

/** Cheap (4-byte) check for the FFNT magic. */
export async function isBffnt(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x46 /* F */ &&
		head[1] === 0x46 /* F */ &&
		head[2] === 0x4e /* N */ &&
		head[3] === 0x54 /* T */
	);
}

/**
 * Parse a BFFNT blob's header and all its sections. The `tglp.sheetData`
 * is the raw, *still-swizzled* texture bytes — call `deswizzle` from
 * the swizzle module to get linear pixel data.
 */
export async function parseBffnt(blob: Blob): Promise<ParsedBffnt> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const reader = new StructReader(bytes);
	if (bytes.length < 0x14) {
		throw new Error(
			`Blob too small to be a BFFNT (${bytes.length} bytes)`,
		);
	}

	// --- FFNT header ---
	const sig = reader.readMagic(4);
	if (sig !== FFNT_MAGIC) {
		throw new Error(`Bad BFFNT magic "${sig}" (expected "FFNT")`);
	}
	const bom = reader.peekU16BE(reader.pos);
	let endian: Endian;
	if (bom === 0xfeff) endian = 'big';
	else if (bom === 0xfffe) endian = 'little';
	else throw new Error(`Bad BOM 0x${bom.toString(16)} in BFFNT header`);
	reader.endian = endian;
	reader.skip(2); // BOM
	const headerSize = reader.readU16();
	const version = reader.readU32();
	const fileSize = reader.readU32();
	const blockCount = reader.readU32();

	const header: BffntHeader = {
		signature: 'FFNT',
		endian,
		headerSize,
		version,
		fileSize,
		blockCount,
	};

	// FINF immediately follows the FFNT header.
	const finfStart = headerSize;
	const finf = parseFinf(bytes, finfStart, endian);

	// `tglpOffset`, `cwdhOffset`, `cmapOffset` from FINF point at the
	// start of each section's *data* (i.e. just past the 8-byte
	// magic+size header). Walk back 8 bytes to read the magic+size.
	const tglp = parseTglp(bytes, finf.tglpOffset, endian);

	const cwdhBlocks: CharWidthsBlock[] = [];
	const cmapBlocks: CharMapBlock[] = [];

	let cwdhOffset: number = finf.cwdhOffset;
	while (cwdhOffset && cwdhOffset !== SENTINEL_OFFSET) {
		const { block, nextOffset } = parseCwdh(bytes, cwdhOffset, endian);
		cwdhBlocks.push(block);
		cwdhOffset = nextOffset;
	}

	let cmapOffset: number = finf.cmapOffset;
	while (cmapOffset && cmapOffset !== SENTINEL_OFFSET) {
		const { block, nextOffset } = parseCmap(bytes, cmapOffset, endian);
		cmapBlocks.push(block);
		cmapOffset = nextOffset;
	}

	return { header, finf, tglp, cwdhBlocks, cmapBlocks };
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

/**
 * `finfStart` is the absolute byte offset of the FINF section's *magic*
 * (i.e. the start of its 8-byte header). Returns parsed fields with
 * absolute byte offsets for downstream sections.
 */
function parseFinf(
	bytes: Uint8Array,
	finfStart: number,
	endian: Endian,
): FontInfo {
	const reader = new StructReader(bytes, endian, finfStart);
	const magic = reader.readMagic(4);
	if (magic !== 'FINF') {
		throw new Error(`Expected FINF at offset ${finfStart}, got "${magic}"`);
	}
	reader.skip(4); // section size
	const fontType = reader.readU8();
	const height = reader.readU8();
	const width = reader.readU8();
	const ascent = reader.readU8();
	const lineFeed = reader.readU16();
	const alterCharIndex = reader.readU16();
	// Default width: 3 bytes (left, glyphWidth, charWidth) — `left`
	// is signed.
	const defaultLeft = reader.readI8();
	const defaultGlyphWidth = reader.readU8();
	const defaultCharWidth = reader.readU8();
	const encoding = reader.readU8();
	// The TGLP / CWDH / CMAP offsets stored here point at section
	// *data* (i.e. 8 bytes past the section's magic). To make
	// downstream parsing clearer we subtract 8 to get the magic
	// offset.
	const tglpDataOffset = reader.readU32();
	const cwdhDataOffset = reader.readU32();
	const cmapDataOffset = reader.readU32();

	return {
		fontType,
		height,
		width,
		ascent,
		lineFeed,
		alterCharIndex,
		defaultLeft,
		defaultGlyphWidth,
		defaultCharWidth,
		encoding,
		tglpOffset: tglpDataOffset - 8,
		cwdhOffset: cwdhDataOffset - 8,
		cmapOffset: cmapDataOffset - 8,
	};
}

function parseTglp(
	bytes: Uint8Array,
	tglpStart: number,
	endian: Endian,
): TextureGlyph {
	const reader = new StructReader(bytes, endian, tglpStart);
	const magic = reader.readMagic(4);
	if (magic !== 'TGLP') {
		throw new Error(`Expected TGLP at offset ${tglpStart}, got "${magic}"`);
	}
	reader.skip(4); // section size
	const cellWidth = reader.readU8();
	const cellHeight = reader.readU8();
	const sheetCount = reader.readU8();
	const maxCharWidth = reader.readU8();
	const sheetSize = reader.readU32();
	const baselinePosition = reader.readU16();
	const sheetImageFormat = reader.readU16();
	const sheetColumns = reader.readU16();
	const sheetRows = reader.readU16();
	const sheetWidth = reader.readU16();
	const sheetHeight = reader.readU16();
	const sheetDataOffset = reader.readU32();

	const totalSize = sheetCount * sheetSize;
	if (sheetDataOffset + totalSize > bytes.length) {
		throw new Error(
			`TGLP sheet data (${totalSize} bytes at offset ${sheetDataOffset}) exceeds blob size (${bytes.length})`,
		);
	}
	const sheetData = bytes.slice(
		sheetDataOffset,
		sheetDataOffset + totalSize,
	);

	return {
		cellWidth,
		cellHeight,
		sheetCount,
		maxCharWidth,
		sheetSize,
		baselinePosition,
		sheetImageFormat,
		sheetColumns,
		sheetRows,
		sheetWidth,
		sheetHeight,
		sheetDataOffset,
		sheetData,
	};
}

function parseCwdh(
	bytes: Uint8Array,
	cwdhStart: number,
	endian: Endian,
): { block: CharWidthsBlock; nextOffset: number } {
	const reader = new StructReader(bytes, endian, cwdhStart);
	const magic = reader.readMagic(4);
	if (magic !== 'CWDH') {
		throw new Error(`Expected CWDH at offset ${cwdhStart}, got "${magic}"`);
	}
	reader.skip(4); // section size
	const startIndex = reader.readU16();
	const endIndex = reader.readU16();
	const nextDataOffset = reader.readU32();
	const count = endIndex - startIndex + 1;
	const widths: CharWidthsBlock['widths'] = [];
	for (let i = 0; i < count; i++) {
		widths.push({
			left: reader.readI8(),
			glyphWidth: reader.readU8(),
			charWidth: reader.readU8(),
		});
	}
	return {
		block: { startIndex, endIndex, widths },
		nextOffset: nextDataOffset === 0 ? 0 : nextDataOffset - 8,
	};
}

function parseCmap(
	bytes: Uint8Array,
	cmapStart: number,
	endian: Endian,
): { block: CharMapBlock; nextOffset: number } {
	const reader = new StructReader(bytes, endian, cmapStart);
	const magic = reader.readMagic(4);
	if (magic !== 'CMAP') {
		throw new Error(`Expected CMAP at offset ${cmapStart}, got "${magic}"`);
	}
	reader.skip(4); // section size
	// Switch BFFNT v4 uses u32 codepoint ranges (vs. u16 in the
	// 3DS BCFNT) so it can handle the full Unicode range up through
	// supplementary planes. Wii U is also v4 + u32.
	const codeBegin = reader.readU32();
	const codeEnd = reader.readU32();
	const mappingMethod = reader.readU16();
	reader.skip(2); // reserved
	const nextDataOffset = reader.readU32();

	let block: CharMapBlock;
	if (mappingMethod === 0) {
		const indexOffset = reader.readU16();
		block = { type: 'direct', codeBegin, codeEnd, indexOffset };
	} else if (mappingMethod === 1) {
		const count = codeEnd - codeBegin + 1;
		const indexTable = new Uint16Array(count);
		for (let i = 0; i < count; i++) {
			indexTable[i] = reader.readU16();
		}
		block = { type: 'table', codeBegin, codeEnd, indexTable };
	} else if (mappingMethod === 2) {
		const numEntries = reader.readU16();
		const entries: Array<{ codepoint: number; glyphIndex: number }> = [];
		for (let i = 0; i < numEntries; i++) {
			const cp = reader.readU16();
			const gi = reader.readU16();
			entries.push({ codepoint: cp, glyphIndex: gi });
		}
		block = { type: 'scan', codeBegin, codeEnd, entries };
	} else {
		throw new Error(
			`Unknown CMAP mapping method ${mappingMethod} at offset ${cmapStart}`,
		);
	}

	return {
		block,
		nextOffset: nextDataOffset === 0 ? 0 : nextDataOffset - 8,
	};
}

// ---------------------------------------------------------------------------
// Endian-aware struct reader. `endian` is set on construction or via
// the public field — section parsers create a reader at a specific
// offset and walk it forward.
// ---------------------------------------------------------------------------

class StructReader {
	endian: Endian;
	pos: number;
	view: DataView;

	constructor(
		private bytes: Uint8Array,
		endian: Endian = 'little',
		startPos = 0,
	) {
		this.endian = endian;
		this.pos = startPos;
		this.view = new DataView(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength,
		);
	}

	skip(n: number): void {
		this.pos += n;
	}

	readU8(): number {
		const v = this.view.getUint8(this.pos);
		this.pos += 1;
		return v;
	}

	readI8(): number {
		const v = this.view.getInt8(this.pos);
		this.pos += 1;
		return v;
	}

	readU16(): number {
		const v = this.view.getUint16(this.pos, this.endian === 'little');
		this.pos += 2;
		return v;
	}

	readU32(): number {
		const v = this.view.getUint32(this.pos, this.endian === 'little');
		this.pos += 4;
		return v;
	}

	peekU16BE(at: number): number {
		return this.view.getUint16(at, false);
	}

	readMagic(n: number): string {
		const slice = this.bytes.subarray(this.pos, this.pos + n);
		this.pos += n;
		return new TextDecoder('ascii').decode(slice);
	}
}
