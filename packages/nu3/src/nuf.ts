/**
 * NUF bitmap fonts (`NUF\0`), Pokkén Tournament DX. A NUF holds the
 * glyph metrics; its atlas is a NUT (BC4) in the same DRP entry.
 *
 * Header, little-endian:
 *
 *     0x00  "NUF\0"        0x04  glyph height (px)
 *     0x08  glyph count    0x0C  u8 size, u8 line height
 *     0x10  font name (Shift-JIS, 0x20 bytes), 0x30 weight / style
 *
 * The glyph records are the last `count * 0x20` bytes of the file:
 *
 *     +0x00  s32 (-1 for blank glyphs)
 *     +0x04  u16 atlas x      +0x06  u16 atlas y
 *     +0x08  s16 bearing x    +0x0A  s16 bearing y (top, above the baseline)
 *     +0x0C  s16 advance      (all three in 1/64 px)
 *     +0x14  u8 width         +0x15  u8 height
 *     +0x16  u16 code (UTF-16, big-endian)
 *
 * Worked out from Pokkén DX's `font.drp` (full-width kana advance 24 px
 * in the 24 px font, `!` 6 px; codes run 0x0020 … 0xFFE5).
 */

export interface NufGlyph {
	code: number;
	x: number;
	y: number;
	width: number;
	height: number;
	bearingX: number;
	bearingY: number;
	advance: number;
}

export interface NufFont {
	/** Glyph height in pixels. */
	size: number;
	lineHeight: number;
	name: string;
	style: string;
	/** Baseline offset from the top of a line (the tallest bearing). */
	ascent: number;
	glyphs: Map<number, NufGlyph>;
}

export function isNuf(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 0x40 && bytes[0] === 0x4e && bytes[1] === 0x55 && bytes[2] === 0x46 && bytes[3] === 0;
}

function sjisString(b: Uint8Array): string {
	let end = 0;
	while (end < b.byteLength && b[end] !== 0) end++;
	try {
		return new TextDecoder('shift_jis').decode(b.subarray(0, end));
	} catch {
		return new TextDecoder('latin1').decode(b.subarray(0, end));
	}
}

export function parseNuf(bytes: Uint8Array): NufFont {
	if (!isNuf(bytes)) throw new Error('Not a NUF font');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = dv.getUint32(0x04, true);
	const count = dv.getUint32(0x08, true);
	const lineHeight = bytes[0x0d] || size;
	const base = bytes.byteLength - count * 0x20;
	if (count === 0 || base < 0x40) throw new Error('NUF: glyph table is out of bounds');
	const glyphs = new Map<number, NufGlyph>();
	let ascent = 0;
	for (let i = 0; i < count; i++) {
		const r = base + i * 0x20;
		const g: NufGlyph = {
			code: dv.getUint16(r + 0x16, false),
			x: dv.getUint16(r + 0x04, true),
			y: dv.getUint16(r + 0x06, true),
			bearingX: dv.getInt16(r + 0x08, true) / 64,
			bearingY: dv.getInt16(r + 0x0a, true) / 64,
			advance: dv.getInt16(r + 0x0c, true) / 64,
			width: bytes[r + 0x14]!,
			height: bytes[r + 0x15]!,
		};
		if (g.code >= 0x30 && g.code <= 0x5a) ascent = Math.max(ascent, g.bearingY);
		glyphs.set(g.code, g);
	}
	return {
		size,
		lineHeight,
		name: sjisString(bytes.subarray(0x10, 0x30)),
		style: sjisString(bytes.subarray(0x30, 0x40)),
		ascent: ascent || size * 0.8,
		glyphs,
	};
}

export interface GlyphAtlas {
	width: number;
	height: number;
	/** RGBA8; the red channel is the glyph coverage. */
	pixels: Uint8Array;
}

/**
 * Render lines of text with a NUF font onto a transparent RGBA canvas.
 * Missing characters are skipped (advancing half the font size).
 */
export function renderNufText(
	font: NufFont,
	atlas: GlyphAtlas,
	lines: string[],
	options: {
		padding?: number;
		maxWidth?: number;
		/**
		 * `coverage` (default): the atlas red channel is glyph coverage
		 * (BC4 text fonts), drawn white. `color`: copy the atlas RGBA (icon
		 * fonts such as Pokkén DX's button glyphs).
		 */
		mode?: 'coverage' | 'color';
	} = {},
): GlyphAtlas {
	const color = options.mode === 'color';
	const pad = options.padding ?? 8;
	const measure = (line: string) => {
		let w = 0;
		for (const ch of line) w += font.glyphs.get(ch.codePointAt(0)!)?.advance ?? font.size / 2;
		return w;
	};
	const width = Math.min(options.maxWidth ?? 4096, Math.ceil(Math.max(1, ...lines.map(measure)) + pad * 2));
	const lineHeight = Math.max(font.lineHeight, font.size);
	const height = Math.ceil(lines.length * lineHeight + pad * 2);
	const out = new Uint8Array(width * height * 4);
	lines.forEach((line, li) => {
		let pen = pad;
		const baseline = pad + li * lineHeight + font.ascent;
		for (const ch of line) {
			const g = font.glyphs.get(ch.codePointAt(0)!);
			if (!g) {
				pen += font.size / 2;
				continue;
			}
			const ox = Math.round(pen + g.bearingX);
			const oy = Math.round(baseline - g.bearingY);
			for (let y = 0; y < g.height; y++) {
				const ty = oy + y;
				const sy = g.y + y;
				if (ty < 0 || ty >= height || sy >= atlas.height) continue;
				for (let x = 0; x < g.width; x++) {
					const tx = ox + x;
					const sx = g.x + x;
					if (tx < 0 || tx >= width || sx >= atlas.width) continue;
					const si = (sy * atlas.width + sx) * 4;
					const o = (ty * width + tx) * 4;
					if (color) {
						if (atlas.pixels[si + 3]! > out[o + 3]!) out.set(atlas.pixels.subarray(si, si + 4), o);
					} else {
						const a = atlas.pixels[si]!;
						if (a > out[o + 3]!) out.set([255, 255, 255, a], o);
					}
				}
			}
			pen += g.advance;
		}
	});
	return { width, height, pixels: out };
}
