/**
 * BFFNT glyph composition.
 *
 * Given a {@link ParsedBffnt} (with its TGLP atlas already deswizzled
 * into RGBA8 sheets), look up each character of an input string in
 * the font's CMAP / CWDH tables and blit the corresponding glyph
 * cell from the atlas onto a destination buffer. The result is a
 * "rendered text" RGBA8 image you can draw into a `<canvas>` via
 * `ImageData` or upload as a `WebGLTexture`.
 *
 * No subpixel rendering, hinting, or kerning. The font's bitmap
 * glyphs are the source of truth — we just position them per the
 * CWDH metrics.
 */

import type {
	CharMapBlock,
	CharWidthsBlock,
	ParsedBffnt,
	TextureGlyph,
} from './parser.js';
import type { DecodedTexture, SingleChannelMode } from './texture.js';
import { decodeTexture, textureFormatInfo } from './texture.js';
import { deswizzle } from './swizzle.js';
import { bntxFormatToBffntFormat, isBntx, parseBntx } from './bntx.js';

/** A fully decoded BFFNT, ready for rendering. */
export interface RenderableBffnt {
	parsed: ParsedBffnt;
	/** Decoded RGBA8 atlas, one entry per sheet. */
	sheets: DecodedTexture[];
}

/**
 * Decode every TGLP sheet in a parsed BFFNT into RGBA8 pixels. The
 * single-channel formats (A8, BC4) default to alpha-mode so the
 * pixels can be drawn over a background colour via a normal blit
 * without manual recolouring.
 */
export function decodeBffnt(
	parsed: ParsedBffnt,
	options: { singleChannelTo?: SingleChannelMode } = {},
): RenderableBffnt {
	const { tglp } = parsed;
	const sheets: DecodedTexture[] = [];

	// Switch BFFNTs embed a full BNTX texture container inside the
	// TGLP `sheetData` rather than storing raw swizzled bytes
	// directly. Detect the magic and unwrap it.
	if (isBntx(tglp.sheetData)) {
		const tex = parseBntx(tglp.sheetData);
		const formatCode = bntxFormatToBffntFormat(tex.format);
		const fmt = textureFormatInfo(formatCode);
		const layerCount = Math.max(tex.arrayLength, tglp.sheetCount);
		for (let s = 0; s < layerCount; s++) {
			const layerStart = tex.mipOffset + s * tex.layerSize;
			const swizzled = tglp.sheetData.subarray(
				layerStart,
				layerStart + tex.layerSize,
			);
			const linear = deswizzle({
				width: tex.width,
				height: tex.height,
				blkWidth: fmt.blkWidth,
				blkHeight: fmt.blkHeight,
				bytesPerBlock: fmt.bytesPerBlock,
				data: swizzled,
				blockHeight: 1 << tex.blockHeightLog2,
			});
			const decoded = decodeTexture({
				linearBytes: linear,
				width: tex.width,
				height: tex.height,
				formatCode,
				singleChannelTo: options.singleChannelTo,
			});
			// Switch textures are stored upside-down (OpenGL/NVN
			// bottom-left origin convention). Flip so callers can
			// address pixels in normal top-left-origin image coords.
			flipVertically(decoded);
			sheets.push(decoded);
		}
		return { parsed, sheets };
	}

	// Legacy path: raw swizzled atlas (Wii U / 3DS / older Switch
	// firmwares). Treat each TGLP sheet as a standalone Tegra
	// block-linear surface.
	const fmt = textureFormatInfo(tglp.sheetImageFormat);
	for (let s = 0; s < tglp.sheetCount; s++) {
		const swizzled = tglp.sheetData.subarray(
			s * tglp.sheetSize,
			(s + 1) * tglp.sheetSize,
		);
		const linear = deswizzle({
			width: tglp.sheetWidth,
			height: tglp.sheetHeight,
			blkWidth: fmt.blkWidth,
			blkHeight: fmt.blkHeight,
			bytesPerBlock: fmt.bytesPerBlock,
			data: swizzled,
		});
		const decoded = decodeTexture({
			linearBytes: linear,
			width: tglp.sheetWidth,
			height: tglp.sheetHeight,
			formatCode: tglp.sheetImageFormat,
			singleChannelTo: options.singleChannelTo,
		});
		flipVertically(decoded);
		sheets.push(decoded);
	}
	return { parsed, sheets };
}

/**
 * Look up the glyph index for a Unicode codepoint by walking every
 * CMAP block. Returns the font's `alterCharIndex` fallback for chars
 * not in any block; that fallback is itself a glyph index, NOT a
 * codepoint.
 */
export function glyphIndexFor(parsed: ParsedBffnt, codepoint: number): number {
	for (const block of parsed.cmapBlocks) {
		if (codepoint < block.codeBegin || codepoint > block.codeEnd) continue;
		switch (block.type) {
			case 'direct': {
				const idx = block.indexOffset + (codepoint - block.codeBegin);
				if (idx === 0xffff) continue;
				return idx;
			}
			case 'table': {
				const idx = block.indexTable[codepoint - block.codeBegin];
				if (idx === 0xffff) continue;
				return idx;
			}
			case 'scan': {
				for (const e of block.entries) {
					if (e.codepoint === codepoint) return e.glyphIndex;
				}
				continue;
			}
		}
	}
	return parsed.finf.alterCharIndex;
}

/**
 * Look up the per-glyph metrics for a glyph index, walking every
 * CWDH block. Falls back to the font's `defaultLeft` / `defaultGlyphWidth`
 * / `defaultCharWidth` if the glyph index is out of range — that
 * matches the runtime behaviour of Switch's font library.
 */
export function widthsFor(
	parsed: ParsedBffnt,
	glyphIndex: number,
): { left: number; glyphWidth: number; charWidth: number } {
	for (const block of parsed.cwdhBlocks) {
		if (glyphIndex < block.startIndex || glyphIndex > block.endIndex) {
			continue;
		}
		return block.widths[glyphIndex - block.startIndex];
	}
	return {
		left: parsed.finf.defaultLeft,
		glyphWidth: parsed.finf.defaultGlyphWidth,
		charWidth: parsed.finf.defaultCharWidth,
	};
}

/**
 * Calculate which (sheet, column, row) a glyph index lives at within
 * the atlas. Glyphs are laid out in row-major order, packing
 * `cols × rows` per sheet before spilling to the next.
 */
export function glyphCellLocation(
	tglp: TextureGlyph,
	glyphIndex: number,
): { sheet: number; col: number; row: number } | null {
	const cellsPerSheet = tglp.sheetColumns * tglp.sheetRows;
	if (cellsPerSheet === 0) return null;
	const sheet = Math.floor(glyphIndex / cellsPerSheet);
	if (sheet >= tglp.sheetCount) return null;
	const within = glyphIndex - sheet * cellsPerSheet;
	const row = Math.floor(within / tglp.sheetColumns);
	const col = within % tglp.sheetColumns;
	return { sheet, col, row };
}

/** Pixel rectangle for a glyph cell in its sheet. */
export interface GlyphRect {
	sheet: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Locate the glyph's pixel rectangle in the (already-Y-flipped)
 * decoded sheet. Switch BFFNT cells have a 1-pixel inter-cell gap
 * — the `cellWidth`/`cellHeight` from TGLP are the *content*
 * dimensions and cells are laid out on a `(cellWidth+1) ×
 * (cellHeight+1)` pixel pitch with the gap between cells.
 *
 * Glyph cells are arranged in row-major order with row 0 at the
 * top of the (Y-flipped) atlas — empirically verified against
 * a typical Latin-script BFFNT atlas where row 0 contains glyphs
 * 0-31 (`' '..'?'`) and row 1 contains glyphs 32-63 (`'@'..'_'`).
 */
export function glyphRect(
	tglp: TextureGlyph,
	glyphIndex: number,
): GlyphRect | null {
	const loc = glyphCellLocation(tglp, glyphIndex);
	if (!loc) return null;
	const gap = 1;
	const cellPitchX = tglp.cellWidth + gap;
	const cellPitchY = tglp.cellHeight + gap;
	const x = loc.col * cellPitchX;
	const y = loc.row * cellPitchY;
	if (x + tglp.cellWidth > tglp.sheetWidth) return null;
	if (y + tglp.cellHeight > tglp.sheetHeight) return null;
	return {
		sheet: loc.sheet,
		x,
		y,
		width: tglp.cellWidth,
		height: tglp.cellHeight,
	};
}

/**
 * Render a string of text using the font's bitmap glyphs into a
 * freshly-allocated RGBA8 buffer. The buffer is sized just large
 * enough to hold the rendered text (no auto-wrapping; line breaks
 * in the input string force a hard break to the next line).
 *
 * Pen position semantics:
 *   - x advances by `charWidth` after each glyph
 *   - y advances by `lineFeed` after each '\n'
 *   - each glyph's blit position = `(penX + left, penY + (ascent - glyph.height))`
 *     — but in practice Switch BFFNTs encode glyphs at full cell
 *     height with the baseline at `baselinePosition` rows from the
 *     top. We position glyphs so their top edge sits at
 *     `penY + (ascent - baselinePosition)` to align the baseline.
 */
export function renderText(
	font: RenderableBffnt,
	text: string,
): { width: number; height: number; pixels: Uint8Array } {
	const { parsed, sheets } = font;
	const { finf, tglp } = parsed;

	// First pass: lay out positions to discover the bounding box.
	const lines: { glyphs: Array<{ rect: GlyphRect; penX: number }>; advance: number }[] = [];
	let curLine: typeof lines[number] = { glyphs: [], advance: 0 };
	let widestLine = 0;
	const codepoints = [...text]; // handles surrogate pairs

	for (const ch of codepoints) {
		if (ch === '\n') {
			widestLine = Math.max(widestLine, curLine.advance);
			lines.push(curLine);
			curLine = { glyphs: [], advance: 0 };
			continue;
		}
		const cp = ch.codePointAt(0)!;
		const idx = glyphIndexFor(parsed, cp);
		const w = widthsFor(parsed, idx);
		const rect = glyphRect(tglp, idx);
		if (rect) {
			curLine.glyphs.push({ rect, penX: curLine.advance + w.left });
		}
		curLine.advance += w.charWidth;
	}
	widestLine = Math.max(widestLine, curLine.advance);
	lines.push(curLine);

	const lineHeight = finf.lineFeed;
	const totalHeight = Math.max(lineHeight, lines.length * lineHeight);
	const totalWidth = Math.max(1, widestLine);

	const out = new Uint8Array(totalWidth * totalHeight * 4);

	// Second pass: blit. Each line's glyphs are positioned with their
	// top edge at `lineY` (= line index × lineFeed), letting the
	// font's own metrics handle vertical alignment within a line.
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];
		const lineY = li * lineHeight;
		for (const g of line.glyphs) {
			const sheet = sheets[g.rect.sheet];
			if (!sheet) continue;
			blitGlyph(sheet, g.rect, out, totalWidth, totalHeight, g.penX, lineY);
		}
	}

	return { width: totalWidth, height: totalHeight, pixels: out };
}

/**
 * Flip an RGBA8 image vertically in-place. Used to undo the
 * upside-down storage convention of Switch BFFNT atlases.
 */
function flipVertically(image: DecodedTexture): void {
	const { width, height, pixels } = image;
	const stride = width * 4;
	const tmp = new Uint8Array(stride);
	for (let y = 0; y < Math.floor(height / 2); y++) {
		const top = y * stride;
		const bot = (height - 1 - y) * stride;
		tmp.set(pixels.subarray(top, top + stride));
		pixels.copyWithin(top, bot, bot + stride);
		pixels.set(tmp, bot);
	}
}

/**
 * Composite a glyph cell from `sheet` onto `dst` at `(dstX, dstY)`.
 * Uses straight alpha-over compositing — assumes both source and
 * destination are non-premultiplied RGBA8.
 *
 * Out-of-range pixels are silently clipped.
 */
function blitGlyph(
	sheet: DecodedTexture,
	rect: GlyphRect,
	dst: Uint8Array,
	dstWidth: number,
	dstHeight: number,
	dstX: number,
	dstY: number,
): void {
	for (let py = 0; py < rect.height; py++) {
		const sy = rect.y + py;
		const dy = dstY + py;
		if (dy < 0 || dy >= dstHeight) continue;
		for (let px = 0; px < rect.width; px++) {
			const sx = rect.x + px;
			const dx = dstX + px;
			if (dx < 0 || dx >= dstWidth) continue;
			const sIdx = (sy * sheet.width + sx) * 4;
			const dIdx = (dy * dstWidth + dx) * 4;
			const srcA = sheet.pixels[sIdx + 3];
			if (srcA === 0) continue;
			if (srcA === 255) {
				dst[dIdx + 0] = sheet.pixels[sIdx + 0];
				dst[dIdx + 1] = sheet.pixels[sIdx + 1];
				dst[dIdx + 2] = sheet.pixels[sIdx + 2];
				dst[dIdx + 3] = 255;
				continue;
			}
			// Source-over compositing.
			const sA = srcA / 255;
			const dA = dst[dIdx + 3] / 255;
			const outA = sA + dA * (1 - sA);
			if (outA === 0) continue;
			for (let c = 0; c < 3; c++) {
				dst[dIdx + c] = Math.round(
					(sheet.pixels[sIdx + c] * sA +
						dst[dIdx + c] * dA * (1 - sA)) /
						outA,
				);
			}
			dst[dIdx + 3] = Math.round(outA * 255);
		}
	}
}
