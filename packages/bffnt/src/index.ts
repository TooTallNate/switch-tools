/**
 * BFFNT (Cafe Font Format) — Nintendo's bitmap-font format used by
 * Wii U / Switch first-party games.
 *
 * Unlike `@tootallnate/bfttf` (which deobfuscates a TrueType outline
 * font), BFFNT is a sprite-sheet of pre-rendered glyphs along with
 * per-glyph metrics and a Unicode → glyph-index map. This package
 * provides:
 *
 *  - {@link parseBffnt}: container parser (FFNT header, FINF, TGLP,
 *    chained CWDH/CMAP blocks)
 *  - {@link decodeBffnt}: deswizzle + decode the TGLP atlas into
 *    RGBA8 pixels (handles BC4, A8, LA8, RGBA8)
 *  - {@link renderText}: rasterise arbitrary text into a freshly-
 *    allocated RGBA8 buffer using the font's own glyphs
 *  - Lower-level helpers ({@link glyphIndexFor}, {@link widthsFor},
 *    {@link glyphRect}, {@link textureFormatName}, …) for callers
 *    who want to compose glyph layout themselves.
 */

export {
	FFNT_MAGIC,
	isBffnt,
	parseBffnt,
	type BffntHeader,
	type CharMapBlock,
	type CharWidthsBlock,
	type Endian,
	type FontInfo,
	type ParsedBffnt,
	type TextureGlyph,
} from './parser.js';

export {
	textureFormatInfo,
	textureFormatName,
	decodeTexture,
	type DecodedTexture,
	type SingleChannelMode,
} from './texture.js';

export { deswizzle, getBlockHeight } from './swizzle.js';

export {
	BNTX_MAGIC,
	bntxFormatToBffntFormat,
	isBntx,
	parseBntx,
	type BntxTextureLayer,
} from './bntx.js';

export {
	decodeBffnt,
	glyphCellLocation,
	glyphIndexFor,
	glyphRect,
	renderText,
	widthsFor,
	type GlyphRect,
	type RenderableBffnt,
} from './render.js';
