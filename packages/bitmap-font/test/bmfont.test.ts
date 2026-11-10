import { parseBmfont } from '@tootallnate/bmfont';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	bitmapFontToBmfont,
	bitmapFontToBmfontZip,
	decodePng,
	decodeTga,
	encodePng,
	readBmfontFiles,
	readBmfontZip,
	trimGlyph,
} from '../src/index.js';
import { syntheticFont } from './helpers.js';

describe('PNG', () => {
	it('round-trips RGBA pixels', () => {
		const data = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) & 0xff);
		const img = decodePng(encodePng({ width: 5, height: 3, data }));
		expect(img.width).toBe(5);
		expect(img.height).toBe(3);
		expect(img.data).toEqual(data);
	});
});

describe('TGA', () => {
	it('decodes bottom-up 32-bit BGRA', () => {
		const header = new Uint8Array(18);
		header[2] = 2;
		header[12] = 1;
		header[14] = 2;
		header[16] = 32;
		// Rows bottom-up: the first stored row is the bottom one.
		const pixels = new Uint8Array([3, 2, 1, 4, 30, 20, 10, 40]);
		const img = decodeTga(new Uint8Array([...header, ...pixels]));
		expect([...img.data]).toEqual([10, 20, 30, 40, 1, 2, 3, 4]);
	});
});

describe('BMFont export', () => {
	const font = syntheticFont();
	const { descriptor, files } = bitmapFontToBmfont(font, 'synthetic');

	it('writes a text descriptor and one page', () => {
		expect([...files.keys()]).toEqual(['synthetic.fnt', 'synthetic_0.png']);
		const text = new TextDecoder().decode(files.get('synthetic.fnt'));
		expect(text).toMatch(/^info face="Synthetic" size=40 /);
		expect(text).toContain('common lineHeight=40 base=32 ');
		expect(text).toContain('page id=0 file="synthetic_0.png"');
		expect(text).toContain('kerning first=79 second=73 amount=-3');
		const parsed = parseBmfont(files.get('synthetic.fnt')!);
		expect(parsed).toEqual(descriptor);
	});

	it('packs every glyph without overlap, alpha = coverage', () => {
		const page = decodePng(files.get('synthetic_0.png')!);
		const rects = descriptor.chars.filter((c) => c.width);
		for (const a of rects) {
			for (const b of rects) {
				if (a === b) continue;
				const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
				expect(apart).toBe(true);
			}
		}
		const o = descriptor.chars.find((c) => c.id === 0x6f)!;
		const g = trimGlyph(font.glyphs[0]!);
		expect(o.xoffset).toBe(g.x);
		expect(o.yoffset).toBe(g.y);
		for (let y = 0; y < g.height; y++) {
			for (let x = 0; x < g.width; x++) {
				expect(page.data[((o.y + y) * page.width + o.x + x) * 4 + 3]).toBe(g.coverage[y * g.width + x]);
			}
		}
	});

	it('reads back what it wrote, via files or a zip', () => {
		for (const back of [readBmfontFiles(files), readBmfontZip(bitmapFontToBmfontZip(font, 'synthetic'))]) {
			expect(back.family).toBe('Synthetic');
			expect(back.lineHeight).toBe(40);
			expect(back.base).toBe(32);
			expect(back.kerning).toEqual(font.kerning);
			for (const src of font.glyphs) {
				const a = trimGlyph(src);
				const b = back.glyphs.find((g) => g.codepoints[0] === src.codepoints[0])!;
				expect({ ...b, coverage: [...b.coverage] }).toEqual({ ...a, coverage: [...a.coverage] });
			}
		}
	});
});

describe('BMFont import', () => {
	const fnt = (extra = '') =>
		new TextEncoder().encode(
			[
				'info face="Opaque" size=8 bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1',
				'common lineHeight=10 base=8 scaleW=4 scaleH=4 pages=1 packed=0',
				'page id=0 file="sub/opaque_0.png"',
				'chars count=1',
				`char id=65 x=1 y=1 width=2 height=2 xoffset=0 yoffset=6 xadvance=3 page=0 chnl=15${extra}`,
			].join('\r\n'),
		);
	const page = (fg: number, bg: number) => {
		const data = new Uint8Array(4 * 4 * 4);
		for (let i = 0; i < 16; i++) {
			const inside = [5, 6, 9, 10].includes(i);
			data.set([inside ? fg : bg, inside ? fg : bg, inside ? fg : bg, 255], i * 4);
		}
		return encodePng({ width: 4, height: 4, data });
	};

	it('reads coverage from opaque light-on-dark and dark-on-light pages', () => {
		for (const [fg, bg] of [[255, 0], [0, 255]]) {
			const font = readBmfontFiles({ 'Font.FNT': fnt(), 'OPAQUE_0.png': page(fg!, bg!) });
			expect([...font.glyphs[0]!.coverage]).toEqual([255, 255, 255, 255]);
		}
	});

	it('finds the descriptor and pages inside folders in a zip', () => {
		const zip = zipSync({ 'MyFont/opaque.fnt': fnt(), 'MyFont/opaque_0.png': page(255, 0), '__MACOSX/MyFont/._opaque.fnt': new Uint8Array(4) });
		expect(Object.keys(unzipSync(zip))).toHaveLength(3);
		expect(readBmfontZip(zip).glyphs[0]!.advance).toBe(3);
	});

	it('reports missing pages', () => {
		expect(() => readBmfontFiles({ 'a.fnt': fnt() })).toThrow(/page not found: sub\/opaque_0.png/);
	});
});
