/**
 * The format-neutral bitmap font model every converter here works on.
 * It follows BMFont's conventions, which most bitmap fonts can be
 * expressed in: each glyph is a coverage bitmap placed relative to the
 * pen at the *top of the line*, and the baseline sits `base` px below
 * that line top.
 */

export interface BitmapGlyph {
	/** The Unicode code points that map to this glyph. */
	codepoints: number[];
	/** Pen advance after the glyph, in px. */
	advance: number;
	/** Bitmap's left edge relative to the pen, in px. */
	x: number;
	/** Bitmap's top edge relative to the line top, in px. */
	y: number;
	width: number;
	height: number;
	/** `width × height` coverage values, 0 (empty) to 255 (solid), rows top-down. */
	coverage: Uint8Array;
}

export interface BitmapKerning {
	/** Code point of the left character. */
	first: number;
	/** Code point of the right character. */
	second: number;
	/** Advance adjustment between them, in px. */
	amount: number;
}

export interface BitmapFont {
	/** Family name, e.g. "Special_00". */
	family: string;
	/** Style name. Default "Regular". */
	style?: string;
	/** The em size the glyphs were rendered at, in px. */
	emSize: number;
	/** Distance between baselines, in px. */
	lineHeight: number;
	/** Baseline position below the line top, in px. */
	base: number;
	glyphs: BitmapGlyph[];
	kerning?: BitmapKerning[];
	bold?: boolean;
	italic?: boolean;
}

/**
 * Crop a glyph's bitmap to its non-empty pixels, adjusting its offset
 * so it still lands in the same place. Empty glyphs become 0 × 0 at
 * (0, 0).
 */
export function trimGlyph(glyph: BitmapGlyph): BitmapGlyph {
	const { width: w, height: h, coverage } = glyph;
	let x0 = w;
	let y0 = h;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!coverage[y * w + x]) continue;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
		}
	}
	if (x1 < 0) return { ...glyph, x: 0, y: 0, width: 0, height: 0, coverage: new Uint8Array(0) };
	if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return glyph;
	const tw = x1 - x0 + 1;
	const th = y1 - y0 + 1;
	const out = new Uint8Array(tw * th);
	for (let y = 0; y < th; y++) out.set(coverage.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + tw), y * tw);
	return { ...glyph, x: glyph.x + x0, y: glyph.y + y0, width: tw, height: th, coverage: out };
}

/**
 * Pick a trace mode for a font: pixel-exact for small fonts and fonts
 * with (almost) no anti-aliasing, where the square pixels are the
 * design; smooth outlines otherwise.
 */
export function chooseTraceMode(font: BitmapFont): 'smooth' | 'pixel' {
	if (font.emSize < 20) return 'pixel';
	let inked = 0;
	let partial = 0;
	for (const g of font.glyphs) {
		for (const v of g.coverage) {
			if (!v) continue;
			inked++;
			if (v > 16 && v < 240) partial++;
		}
	}
	return inked && partial / inked < 0.03 ? 'pixel' : 'smooth';
}
