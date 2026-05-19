/**
 * Parser for FF7 PC field Section 4 (Palette). This section
 * holds the 256-color palette PAGES that the tiles in Section
 * 9 reference by palette ID.
 *
 * Layout (after the section's 4-byte length prefix, which the
 * `FieldModule` parser already strips):
 *
 *   offset  size   field
 *     0     u32    length (repeat of the outer length — unused)
 *     4     u16    palX            (0; PSX leftover)
 *     6     u16    palY            (480; PSX vRAM y-coord)
 *     8     u16    colorsPerPage   (always 256)
 *    10     u16    pageCount       (varies by field)
 *    12     u16[pageCount * colorsPerPage]  color data
 *
 * Color encoding: 15-bit MBGR (`MBBBBBGGGGGRRRRR`, R = LSB):
 *
 *   bit 15: M (mask/alpha-select; PSX semantic. On PC,
 *             treat as ignorable but expose for completeness.)
 *   bits 10–14: B (5-bit blue)
 *   bits  5–9:  G (5-bit green)
 *   bits  0–4:  R (5-bit red)
 *
 * Each 5-bit channel scales to 8 bits via `(c << 3) | (c >> 2)`
 * — equivalent to `round(c * 255/31)` to within ±1.
 *
 * ⚠️ The "direct color" texture pages in Section 9 use a
 * DIFFERENT bit layout (RRRRRGGGGGABBBBB, R = MSB). Don't
 * reuse this decoder for them — see `texture.ts`.
 */

export class PaletteParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PaletteParseError';
	}
}

export interface ParsedPalette {
	colorsPerPage: number;
	pageCount: number;
	/**
	 * Decoded RGBA8 pages, one per palette index. Shape:
	 * `pages[pageId][colorIdx*4 + {0..3}]` = R/G/B/A.
	 *
	 * The A byte is set from the M (mask) bit: M=0 → 255,
	 * M=1 → 0. Tile-level transparency rules (the per-palette
	 * "ignoreFirstPixel" flags) live in
	 * `ParsedBackground.ignoreFirstPixel`, not here.
	 */
	pages: Uint8Array[];
	/** Raw u16 colors per page (for callers that want the M bit). */
	pagesRaw: Uint16Array[];
}

export function parsePalette(bytes: Uint8Array): ParsedPalette {
	if (bytes.length < 12) {
		throw new PaletteParseError(
			`Palette section too short (${bytes.length} bytes); need at least 12`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	// Skip the duplicated length at offset 0.
	const colorsPerPage = view.getUint16(8, true);
	const pageCount = view.getUint16(10, true);
	const expectedColors = colorsPerPage * pageCount;
	const expectedBytes = 12 + expectedColors * 2;
	if (bytes.length < expectedBytes) {
		throw new PaletteParseError(
			`Palette declares ${pageCount} pages × ${colorsPerPage} colors = ${expectedColors} entries, but section is only ${
				bytes.length - 12
			} bytes of color data (need ${expectedColors * 2})`,
		);
	}

	const pages: Uint8Array[] = new Array(pageCount);
	const pagesRaw: Uint16Array[] = new Array(pageCount);
	for (let p = 0; p < pageCount; p++) {
		const raw = new Uint16Array(colorsPerPage);
		const rgba = new Uint8Array(colorsPerPage * 4);
		for (let c = 0; c < colorsPerPage; c++) {
			const color = view.getUint16(12 + (p * colorsPerPage + c) * 2, true);
			raw[c] = color;
			const r5 = color & 0x1f;
			const g5 = (color >> 5) & 0x1f;
			const b5 = (color >> 10) & 0x1f;
			const m = (color >> 15) & 1;
			rgba[c * 4 + 0] = (r5 << 3) | (r5 >> 2);
			rgba[c * 4 + 1] = (g5 << 3) | (g5 >> 2);
			rgba[c * 4 + 2] = (b5 << 3) | (b5 >> 2);
			rgba[c * 4 + 3] = m ? 0 : 255;
		}
		pages[p] = rgba;
		pagesRaw[p] = raw;
	}
	return { colorsPerPage, pageCount, pages, pagesRaw };
}
