/**
 * Convert between {@link BitmapFont} and AngelCode BMFont: a `.fnt`
 * descriptor plus PNG (or TGA) atlas pages. BMFont is the closest
 * thing bitmap fonts have to a common format: Phaser, PixiJS,
 * three-bmfont-text, libGDX, Godot, Cocos2d, MonoGame and Unity all
 * read it. We write the text descriptor (the most widely read of the
 * three encodings) with white glyphs whose alpha is the coverage,
 * which is the AngelCode tool's "white text with alpha" preset.
 *
 * Reading accepts any encoding and works out where the coverage is:
 * one channel for packed fonts, else the alpha channel when the page
 * has transparency, else the brightness (inverted for dark-on-light
 * pages).
 */

import { parseBmfont, writeBmfontText, type BmfChar, type ParsedBmFont } from '@tootallnate/bmfont';
import { unzipSync, zipSync } from 'fflate';
import { trimGlyph, type BitmapFont, type BitmapGlyph } from './font.js';
import { decodeImage, encodePng, type RgbaImage } from './image.js';

// ----- reading -----

/**
 * Build a {@link BitmapFont} from a parsed descriptor and its decoded
 * pages (indexed like `parsed.pages`; a missing page leaves its
 * glyphs empty).
 */
export function bmfontToBitmapFont(parsed: ParsedBmFont, pages: (RgbaImage | null)[], family?: string): BitmapFont {
	const readers = pages.map((p) => (p ? coverageReader(p, parsed) : null));
	const glyphs: BitmapGlyph[] = parsed.chars
		.filter((c) => c.id >= 0)
		.map((c) => {
			const read = readers[c.page];
			const w = read ? c.width : 0;
			const h = read ? c.height : 0;
			const coverage = new Uint8Array(w * h);
			if (read) {
				for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) coverage[y * w + x] = read(c.x + x, c.y + y, c.chnl);
			}
			return { codepoints: [c.id], advance: c.xadvance, x: c.xoffset, y: c.yoffset, width: w, height: h, coverage };
		});
	const { info, common } = parsed;
	return {
		family: family ?? (info.face || 'Bitmap Font'),
		emSize: Math.abs(info.fontSize) || common.lineHeight,
		lineHeight: common.lineHeight,
		base: common.base,
		glyphs,
		kerning: parsed.kernings.map((k) => ({ ...k })),
		bold: info.flags.bold,
		italic: info.flags.italic,
	};
}

function coverageReader(page: RgbaImage, parsed: ParsedBmFont): (x: number, y: number, chnl: number) => number {
	const { width, height, data } = page;
	let translucent = false;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i]! < 255) {
			translucent = true;
			break;
		}
	}
	// Opaque pages draw the glyphs in colour on a solid background;
	// sample the corners to tell light-on-dark from dark-on-light.
	let invert = false;
	if (!translucent) {
		const lum = (x: number, y: number) => {
			const i = (y * width + x) * 4;
			return (data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000;
		};
		const corners = [lum(0, 0), lum(width - 1, 0), lum(0, height - 1), lum(width - 1, height - 1)];
		invert = corners.reduce((a, b) => a + b, 0) / 4 > 127;
	}
	const packed = parsed.common.flags.packed;
	return (x, y, chnl) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return 0;
		const i = (y * width + x) * 4;
		if (packed) {
			// chnl: 1 = blue, 2 = green, 4 = red, 8 = alpha.
			if (chnl === 1) return data[i + 2]!;
			if (chnl === 2) return data[i + 1]!;
			if (chnl === 4) return data[i]!;
			if (chnl === 8) return data[i + 3]!;
		}
		if (translucent) return data[i + 3]!;
		const l = Math.round((data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000);
		return invert ? 255 - l : l;
	};
}

/** Files of a BMFont: the descriptor and its pages, by file name. */
export type FileSet = Map<string, Uint8Array> | Record<string, Uint8Array>;

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

/**
 * Read a BMFont from a set of files: the descriptor (the first `.fnt`,
 * or `descriptor` if given) and its pages, matched by file name
 * regardless of folder or case.
 */
export function readBmfontFiles(files: FileSet, descriptor?: string): BitmapFont {
	const entries = files instanceof Map ? [...files] : Object.entries(files);
	const fnt = descriptor
		? entries.find(([name]) => name === descriptor || baseName(name) === baseName(descriptor))
		: (entries.find(([name]) => /\.fnt$/i.test(name)) ??
			entries.find(([name, bytes]) => !/\.(png|tga|dds)$/i.test(name) && looksLikeDescriptor(bytes)));
	if (!fnt) throw new Error('No BMFont descriptor (.fnt) found');
	const parsed = parseBmfont(fnt[1]);
	const byName = new Map(entries.map(([name, bytes]) => [baseName(name), bytes]));
	const missing: string[] = [];
	const pages = parsed.pages.map((file) => {
		const bytes = byName.get(baseName(file));
		if (!bytes) {
			missing.push(file);
			return null;
		}
		return decodeImage(bytes);
	});
	if (missing.length) throw new Error(`BMFont page${missing.length > 1 ? 's' : ''} not found: ${missing.join(', ')}`);
	const stem = baseName(fnt[0]).replace(/\.[^.]+$/, '');
	return bmfontToBitmapFont(parsed, pages, parsed.info.face || stem);
}

function looksLikeDescriptor(bytes: Uint8Array): boolean {
	try {
		parseBmfont(bytes);
		return true;
	} catch {
		return false;
	}
}

export function isZip(bytes: Uint8Array): boolean {
	return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Read a BMFont from a `.zip` holding the descriptor and its pages. */
export function readBmfontZip(bytes: Uint8Array): BitmapFont {
	const files = unzipSync(bytes, { filter: (f) => !f.name.endsWith('/') && !/(^|\/)__MACOSX\//.test(f.name) });
	return readBmfontFiles(files);
}

// ----- writing -----

export interface BmfontFiles {
	/** The parsed descriptor (as written). */
	descriptor: ParsedBmFont;
	/** File name → contents: `<name>.fnt` plus `<name>_<n>.png` pages. */
	files: Map<string, Uint8Array>;
}

/** Largest atlas page edge we produce. */
const MAX_PAGE = 4096;
/** Empty pixels between glyphs, so filtering doesn't bleed. */
const GAP = 1;

/**
 * Pack a bitmap font's glyphs into atlas pages and write a text
 * BMFont: `<name>.fnt` and `<name>_0.png`, `<name>_1.png`, ….
 */
export function bitmapFontToBmfont(font: BitmapFont, name: string = font.family): BmfontFiles {
	const stem = name.replace(/[\\/:*?"<>|]/g, '_') || 'font';
	const glyphs = font.glyphs.map(trimGlyph);
	const order = glyphs
		.map((g, i) => i)
		.filter((i) => glyphs[i]!.width && glyphs[i]!.height)
		.sort((a, b) => glyphs[b]!.height - glyphs[a]!.height || glyphs[b]!.width - glyphs[a]!.width);

	// Square power-of-two page big enough for everything (with some
	// slack for shelf waste), capped at MAX_PAGE.
	const area = order.reduce((n, i) => n + (glyphs[i]!.width + GAP) * (glyphs[i]!.height + GAP), 0);
	const widest = order.reduce((n, i) => Math.max(n, glyphs[i]!.width + GAP), 0);
	let size = 64;
	while (size < MAX_PAGE && (size * size < area * 1.2 || size < widest)) size *= 2;
	const width = Math.max(size, Math.min(widest, 65535));

	const place = new Map<number, { page: number; x: number; y: number }>();
	const used: number[] = [0];
	let page = 0;
	let x = GAP;
	let y = GAP;
	let shelf = 0;
	for (const i of order) {
		const g = glyphs[i]!;
		if (x + g.width + GAP > width) {
			x = GAP;
			y += shelf + GAP;
			shelf = 0;
		}
		if (y + g.height + GAP > MAX_PAGE && y > GAP) {
			page++;
			used.push(0);
			x = GAP;
			y = GAP;
			shelf = 0;
		}
		place.set(i, { page, x, y });
		x += g.width + GAP;
		shelf = Math.max(shelf, g.height);
		used[page] = Math.max(used[page]!, y + g.height + GAP);
	}
	// All pages share one size in BMFont; trim the height to what's used.
	let height = Math.max(...used, 1);
	height = Math.ceil(height / 4) * 4;

	const images: RgbaImage[] = used.map(() => {
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 255;
		return { width, height, data };
	});
	for (const [i, at] of place) {
		const g = glyphs[i]!;
		const img = images[at.page]!;
		for (let gy = 0; gy < g.height; gy++) {
			for (let gx = 0; gx < g.width; gx++) {
				img.data[((at.y + gy) * width + at.x + gx) * 4 + 3] = g.coverage[gy * g.width + gx]!;
			}
		}
	}

	const chars: BmfChar[] = [];
	const seen = new Set<number>();
	glyphs.forEach((g, i) => {
		const at = place.get(i);
		for (const id of g.codepoints) {
			if (seen.has(id)) continue;
			seen.add(id);
			chars.push({
				id,
				x: at?.x ?? 0,
				y: at?.y ?? 0,
				width: at ? g.width : 0,
				height: at ? g.height : 0,
				xoffset: at ? g.x : 0,
				yoffset: at ? g.y : 0,
				xadvance: g.advance,
				page: at?.page ?? 0,
				chnl: 15,
			});
		}
	});
	chars.sort((a, b) => a.id - b.id);

	const pageNames = images.map((_, i) => `${stem}_${i}.png`);
	const descriptor: ParsedBmFont = {
		version: 3,
		info: {
			fontSize: Math.round(font.emSize),
			flags: { smooth: true, unicode: true, italic: !!font.italic, bold: !!font.bold, fixedHeight: false },
			charSet: 0,
			stretchH: 100,
			aa: 1,
			padding: { up: 0, right: 0, down: 0, left: 0 },
			spacing: { horizontal: GAP, vertical: GAP },
			outline: 0,
			face: font.family,
		},
		common: {
			lineHeight: font.lineHeight,
			base: font.base,
			scaleW: width,
			scaleH: height,
			pages: images.length,
			flags: { packed: false },
			alphaChnl: 0,
			redChnl: 4,
			greenChnl: 4,
			blueChnl: 4,
		},
		pages: pageNames,
		chars,
		kernings: (font.kerning ?? []).map((k) => ({ ...k })),
	};
	const files = new Map<string, Uint8Array>();
	files.set(`${stem}.fnt`, new TextEncoder().encode(writeBmfontText(descriptor)));
	images.forEach((img, i) => files.set(pageNames[i]!, encodePng(img)));
	return { descriptor, files };
}

/** {@link bitmapFontToBmfont}, zipped. */
export function bitmapFontToBmfontZip(font: BitmapFont, name?: string): Uint8Array {
	const { files } = bitmapFontToBmfont(font, name);
	// PNGs are already deflated; store them.
	const entries: Record<string, [Uint8Array, { level: 0 | 9 }]> = {};
	for (const [file, bytes] of files) entries[file] = [bytes, { level: /\.png$/i.test(file) ? 0 : 9 }];
	return zipSync(entries);
}
