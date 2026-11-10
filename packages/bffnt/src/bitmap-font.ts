/**
 * Convert a decoded BFFNT into the format-neutral bitmap font shape
 * used by `@tootallnate/bitmap-font` (TrueType / BMFont export). The
 * shape is declared here structurally, so this package doesn't depend
 * on that one.
 *
 * BFFNT places each glyph cell's top edge at the line top and its left
 * edge `left` px after the pen (see `renderText`), with the baseline
 * `baselinePosition` px below the cell top. A glyph's ink is the first
 * `glyphWidth` columns of its cell.
 */

import type { CharMapBlock, ParsedBffnt } from './parser.js';
import { glyphRect, widthsFor, type RenderableBffnt } from './render.js';

export interface BffntBitmapGlyph {
	codepoints: number[];
	advance: number;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Coverage (the atlas alpha), rows top-down. */
	coverage: Uint8Array;
}

export interface BffntBitmapFont {
	family: string;
	emSize: number;
	lineHeight: number;
	base: number;
	glyphs: BffntBitmapGlyph[];
}

/** Every code point → glyph index the CMAP blocks define (first block wins). */
export function codepointMap(parsed: ParsedBffnt): Map<number, number> {
	const map = new Map<number, number>();
	const set = (cp: number, idx: number) => {
		if (idx !== 0xffff && !map.has(cp)) map.set(cp, idx);
	};
	for (const block of parsed.cmapBlocks as CharMapBlock[]) {
		switch (block.type) {
			case 'direct':
				for (let cp = block.codeBegin; cp <= block.codeEnd; cp++) set(cp, block.indexOffset + (cp - block.codeBegin));
				break;
			case 'table':
				for (let cp = block.codeBegin; cp <= block.codeEnd; cp++) set(cp, block.indexTable[cp - block.codeBegin]!);
				break;
			case 'scan':
				for (const e of block.entries) set(e.codepoint, e.glyphIndex);
				break;
		}
	}
	return map;
}

/**
 * Build the bitmap font: one glyph per glyph index that a code point
 * maps to, with coverage taken from the decoded atlas's alpha channel
 * (decode single-channel sheets with `singleChannelTo: 'alpha'`, the
 * default).
 */
export function toBitmapFont(font: RenderableBffnt, family: string): BffntBitmapFont {
	const { parsed, sheets } = font;
	const { finf, tglp } = parsed;
	const byGlyph = new Map<number, number[]>();
	for (const [cp, idx] of codepointMap(parsed)) {
		let list = byGlyph.get(idx);
		if (!list) byGlyph.set(idx, (list = []));
		list.push(cp);
	}
	const glyphs: BffntBitmapGlyph[] = [];
	for (const [idx, codepoints] of byGlyph) {
		const w = widthsFor(parsed, idx);
		const rect = glyphRect(tglp, idx);
		const sheet = rect ? sheets[rect.sheet] : undefined;
		const width = rect && sheet ? Math.min(rect.width, Math.max(0, w.glyphWidth)) : 0;
		const height = rect && sheet ? rect.height : 0;
		const coverage = new Uint8Array(width * height);
		if (rect && sheet) {
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					coverage[y * width + x] = sheet.pixels[((rect.y + y) * sheet.width + rect.x + x) * 4 + 3]!;
				}
			}
		}
		glyphs.push({ codepoints, advance: w.charWidth, x: w.left, y: 0, width, height, coverage });
	}
	return {
		family,
		emSize: finf.height || finf.lineFeed,
		lineHeight: finf.lineFeed,
		base: tglp.baselinePosition,
		glyphs,
	};
}
