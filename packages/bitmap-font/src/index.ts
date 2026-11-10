/**
 * Bitmap fonts, converted to formats everything else reads.
 *
 * There's no universal bitmap font format: every engine has its own
 * atlas-plus-metrics layout (Nintendo BFFNT, DirectXTK SpriteFont,
 * idTech `.dat`, …). This package works on one format-neutral model
 * ({@link BitmapFont}) and converts it to:
 *
 *  - **TrueType** ({@link bitmapFontToTtf}): the glyph bitmaps are
 *    traced into real outlines (./trace.ts), so the result works in
 *    CSS, canvas, design tools and outline-based tools.
 *  - **AngelCode BMFont** ({@link bitmapFontToBmfont}): the de-facto
 *    common bitmap font format, a `.fnt` descriptor plus PNG pages.
 *
 * and reads BMFont back ({@link readBmfontFiles}, {@link readBmfontZip}),
 * so a BMFont from any tool can become a TrueType font too.
 */

export { chooseTraceMode, trimGlyph, type BitmapFont, type BitmapGlyph, type BitmapKerning } from './font.js';
export { area, traceCoverage, type TraceContour, type TraceMode, type TraceOptions, type TracePoint } from './trace.js';
export { bitmapFontToTtf, type TtfOptions } from './ttf.js';
export {
	bitmapFontToBmfont,
	bitmapFontToBmfontZip,
	bmfontToBitmapFont,
	isZip,
	readBmfontFiles,
	readBmfontZip,
	type BmfontFiles,
	type FileSet,
} from './bmfont.js';
export { decodeImage, decodePng, decodeTga, encodePng, isPng, type RgbaImage } from './image.js';
export { isBmfont, parseBmfont, type ParsedBmFont } from '@tootallnate/bmfont';
