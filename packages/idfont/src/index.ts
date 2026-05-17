/**
 * Parser for idTech BFG `.dat` bitmap-font metrics files.
 *
 * The format ships exclusively as `newfonts/<FontName>/48.dat`
 * inside the BFG-era idTech games (DOOM 3 BFG Edition, RAGE,
 * Wolfenstein: The New Order, and their Switch / PS4 / Xbox One
 * ports). Each file holds the per-glyph layout metrics + a
 * sparse codepoint → glyph-index map. The actual pixel data
 * lives in a sibling `.bimage` at
 * `generated/images/newfonts/<FontName>/48#__0400.bimage`
 * and is referenced indirectly via the per-glyph `s` / `t`
 * pixel offsets.
 *
 * Wire layout (header big-endian via `idFile::ReadBig`;
 * everything after the header is **native-endian on disk** so
 * for a Switch / PC build the bytes are little-endian, which is
 * how this parser reads them):
 *
 *   ┌─────────────────────────┐
 *   │ Header (12 bytes, BE)   │
 *   │   uint32 magic          │   = 0x6964662A ('idf*')
 *   │   int16  pointSize      │   typically 48
 *   │   int16  ascender       │   pixels above baseline
 *   │   int16  descender      │   pixels below (signed, negative)
 *   │   int16  numGlyphs      │
 *   ├─────────────────────────┤
 *   │ Glyph table (LE)        │   10 bytes per glyph, ×numGlyphs
 *   │   uint8 width           │
 *   │   uint8 height          │
 *   │   int8  top             │
 *   │   int8  left            │
 *   │   uint8 xSkip           │
 *   │   byte  _pad            │   1 byte alignment pad for uint16 s/t
 *   │   uint16 s              │   x offset in atlas (pixels)
 *   │   uint16 t              │   y offset in atlas (pixels)
 *   ├─────────────────────────┤
 *   │ charIndex (LE)          │   4 bytes per glyph, ×numGlyphs
 *   │   uint32 codepoint      │   sorted ascending
 *   └─────────────────────────┘
 *
 * Reference: `neo/renderer/Font.cpp` + `Font.h` in the
 * `id-Software/DOOM-3-BFG` GPL-3 release. The on-disk layout
 * documented here matches what the Switch port writes; the original
 * BFG release on big-endian consoles (PS3/Xbox 360) writes the same
 * bytes byte-swapped for the post-header fields, but the Switch
 * port is little-endian-native and `idSwap::Little` is a no-op
 * there. This parser assumes the Switch (LE-native) layout.
 */

const HEADER_SIZE = 12;
const GLYPH_SIZE = 10;
const CHARINDEX_ENTRY_SIZE = 4;

/** `'i' << 24 | 'd' << 16 | 'f' << 8 | 42` ⇒ `0x6964662A`. */
export const IDFONT_MAGIC = 0x6964662a;

/** Per-glyph metrics. */
export interface IdFontGlyph {
	/** Glyph width in pixels. */
	width: number;
	/** Glyph height in pixels. */
	height: number;
	/** Distance from baseline to the top of the glyph (signed). */
	top: number;
	/** Horizontal offset from the pen to the left edge of the glyph (signed). */
	left: number;
	/** Horizontal advance applied after rendering this glyph. */
	xSkip: number;
	/** X pixel offset of this glyph inside the atlas. */
	s: number;
	/** Y pixel offset of this glyph inside the atlas. */
	t: number;
}

export interface ParsedIdFont {
	/** Point size baked into the file (the canonical BFG value is 48). */
	pointSize: number;
	/** Ascender in pixels (above the baseline). */
	ascender: number;
	/** Descender in pixels (negative; below the baseline). */
	descender: number;
	/**
	 * Per-glyph metrics, indexed parallel to {@link codepoints}: i.e.
	 * `glyphs[i]` describes the glyph for `codepoints[i]`.
	 */
	glyphs: IdFontGlyph[];
	/**
	 * Codepoints (Unicode scalar values) that this font defines,
	 * sorted in ascending order. The decoder uses this for binary
	 * search; consumers wanting a direct char→glyph map should
	 * build their own with `new Map(codepoints.map((c, i) => [c, glyphs[i]]))`.
	 */
	codepoints: number[];
	/**
	 * Convenience: a `Map` from codepoint to glyph metrics for
	 * direct lookup. Built eagerly because the typical font is
	 * a few hundred glyphs and consumers almost always want this.
	 */
	byCodepoint: Map<number, IdFontGlyph>;
}

/** Cheap 4-byte magic check. */
export async function isIdFont(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x69 /* i */ &&
		head[1] === 0x64 /* d */ &&
		head[2] === 0x66 /* f */ &&
		head[3] === 0x2a /* *  ⇒ version 42 */
	);
}

/**
 * Parse a `48.dat` idTech BFG bitmap-font metrics file.
 *
 * Returns the header + glyph table + codepoint mapping. The
 * pixel data lives in a sibling `.bimage`; locating it is the
 * caller's responsibility (the BFG convention is
 * `generated/images/newfonts/<name>/48#__0400.bimage`,
 * relative to the same parent archive).
 */
export async function parseIdFont(blob: Blob): Promise<ParsedIdFont> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be an idFont (${blob.size} bytes, need at least ${HEADER_SIZE})`,
		);
	}

	const bytes = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Header: BE multi-byte fields written via idFile::ReadBig.
	const magic = view.getUint32(0, /*littleEndian*/ false);
	if (magic !== IDFONT_MAGIC) {
		throw new Error(
			`Bad idFont magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x6964662a 'idf*')`,
		);
	}
	const pointSize = view.getInt16(4, false);
	const ascender = view.getInt16(6, false);
	const descender = view.getInt16(8, false);
	const numGlyphs = view.getInt16(10, false);

	if (numGlyphs < 0 || numGlyphs > 100000) {
		throw new Error(`Implausible numGlyphs ${numGlyphs}`);
	}

	const glyphTableEnd = HEADER_SIZE + numGlyphs * GLYPH_SIZE;
	const charIndexEnd = glyphTableEnd + numGlyphs * CHARINDEX_ENTRY_SIZE;
	if (charIndexEnd > bytes.length) {
		throw new Error(
			`idFont runs past end of file (declared ${charIndexEnd} bytes for ${numGlyphs} glyphs, have ${bytes.length})`,
		);
	}

	// Glyph table: native-endian on disk. For Switch / PC builds
	// that's LE; reading LE on either platform gives the intended
	// values.
	const glyphs: IdFontGlyph[] = new Array(numGlyphs);
	for (let i = 0; i < numGlyphs; i++) {
		const off = HEADER_SIZE + i * GLYPH_SIZE;
		glyphs[i] = {
			width: bytes[off],
			height: bytes[off + 1],
			top: view.getInt8(off + 2),
			left: view.getInt8(off + 3),
			xSkip: bytes[off + 4],
			// off + 5 is alignment padding before the uint16 s/t pair.
			s: view.getUint16(off + 6, /*littleEndian*/ true),
			t: view.getUint16(off + 8, /*littleEndian*/ true),
		};
	}

	// charIndex: parallel uint32 codepoints (LE on disk for Switch /
	// PC builds; idSwap::LittleArray is a no-op there).
	const codepoints: number[] = new Array(numGlyphs);
	for (let i = 0; i < numGlyphs; i++) {
		codepoints[i] = view.getUint32(
			glyphTableEnd + i * CHARINDEX_ENTRY_SIZE,
			/*littleEndian*/ true,
		);
	}

	const byCodepoint = new Map<number, IdFontGlyph>();
	for (let i = 0; i < numGlyphs; i++) {
		byCodepoint.set(codepoints[i], glyphs[i]);
	}

	return {
		pointSize,
		ascender,
		descender,
		glyphs,
		codepoints,
		byCodepoint,
	};
}
