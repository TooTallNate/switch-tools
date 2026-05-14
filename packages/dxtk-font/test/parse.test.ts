import { describe, expect, it } from 'vitest';
import {
	DXGI_FORMAT_B4G4R4A4_UNORM,
	DXGI_FORMAT_R8G8B8A8_UNORM,
	isSpriteFontMagic,
	parseSpriteFont,
	SpriteFontParseError,
} from '../src/index.js';

/**
 * Build a synthetic DXTKfont byte buffer. Used to exercise the
 * parser's header / glyph-table / texture-format branches without
 * any real game data.
 *
 * Layout matches DirectXTK MakeSpriteFont/SpriteFontWriter.cs.
 */
interface GlyphSpec {
	character: number;
	left: number;
	top: number;
	right: number;
	bottom: number;
	xOffset: number;
	yOffset: number;
	xAdvance: number;
}

function buildSpriteFont(opts: {
	glyphs: GlyphSpec[];
	lineSpacing: number;
	defaultCharacter: number;
	textureWidth: number;
	textureHeight: number;
	textureFormat: number;
	textureStride: number;
	textureRows: number;
	pixels: Uint8Array;
}): Uint8Array {
	const headerSize = 8 + 4 + opts.glyphs.length * 32 + 28;
	const total = headerSize + opts.pixels.length;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	// Magic
	const magic = new TextEncoder().encode('DXTKfont');
	out.set(magic, 0);
	let p = 8;
	dv.setUint32(p, opts.glyphs.length, true);
	p += 4;
	for (const g of opts.glyphs) {
		dv.setUint32(p, g.character, true);
		dv.setInt32(p + 4, g.left, true);
		dv.setInt32(p + 8, g.top, true);
		dv.setInt32(p + 12, g.right, true);
		dv.setInt32(p + 16, g.bottom, true);
		dv.setFloat32(p + 20, g.xOffset, true);
		dv.setFloat32(p + 24, g.yOffset, true);
		dv.setFloat32(p + 28, g.xAdvance, true);
		p += 32;
	}
	dv.setFloat32(p, opts.lineSpacing, true);
	p += 4;
	dv.setUint32(p, opts.defaultCharacter, true);
	p += 4;
	dv.setUint32(p, opts.textureWidth, true);
	p += 4;
	dv.setUint32(p, opts.textureHeight, true);
	p += 4;
	dv.setUint32(p, opts.textureFormat, true);
	p += 4;
	dv.setUint32(p, opts.textureStride, true);
	p += 4;
	dv.setUint32(p, opts.textureRows, true);
	p += 4;
	out.set(opts.pixels, p);
	return out;
}

describe('isSpriteFontMagic', () => {
	it('recognises "DXTKfont"', () => {
		expect(
			isSpriteFontMagic(new TextEncoder().encode('DXTKfont')),
		).toBe(true);
	});
	it('rejects shorter inputs', () => {
		expect(isSpriteFontMagic(new TextEncoder().encode('DXTK'))).toBe(false);
		expect(isSpriteFontMagic(new Uint8Array(0))).toBe(false);
	});
	it('rejects different magics', () => {
		expect(isSpriteFontMagic(new TextEncoder().encode('AFS2....'))).toBe(false);
	});
});

describe('parseSpriteFont — R8G8B8A8 atlas', () => {
	it('decodes a single-glyph 2x2 RGBA atlas', () => {
		const pixels = new Uint8Array([
			// (0,0) red, (1,0) green, (0,1) blue, (1,1) white
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
		]);
		const bytes = buildSpriteFont({
			glyphs: [
				{
					character: 65, // 'A'
					left: 0,
					top: 0,
					right: 2,
					bottom: 2,
					xOffset: 0,
					yOffset: 0,
					xAdvance: 12,
				},
			],
			lineSpacing: 14,
			defaultCharacter: 32,
			textureWidth: 2,
			textureHeight: 2,
			textureFormat: DXGI_FORMAT_R8G8B8A8_UNORM,
			textureStride: 8,
			textureRows: 2,
			pixels,
		});
		const font = parseSpriteFont(bytes);
		expect(font.glyphs).toHaveLength(1);
		expect(font.glyphs[0]).toEqual({
			character: 65,
			subrect: { left: 0, top: 0, right: 2, bottom: 2 },
			xOffset: 0,
			yOffset: 0,
			xAdvance: 12,
		});
		expect(font.lineSpacing).toBe(14);
		expect(font.defaultCharacter).toBe(32);
		expect(font.textureWidth).toBe(2);
		expect(font.textureHeight).toBe(2);
		expect(font.textureFormatName).toBe('r8g8b8a8');
		expect(Array.from(font.atlasRgba)).toEqual(Array.from(pixels));
	});

	it('strips row padding when textureStride > width*4', () => {
		// 2x1 image but stride 16 bytes (8 bytes of padding per row).
		// We supply 2 rows but textureRows=1 so the slice excludes the pad.
		const pixels = new Uint8Array([
			// Row 0: 2 pixels of data + 8 bytes pad
			10, 20, 30, 40, 50, 60, 70, 80,
			0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		]);
		const bytes = buildSpriteFont({
			glyphs: [],
			lineSpacing: 10,
			defaultCharacter: 32,
			textureWidth: 2,
			textureHeight: 1,
			textureFormat: DXGI_FORMAT_R8G8B8A8_UNORM,
			textureStride: 16,
			textureRows: 1,
			pixels,
		});
		const font = parseSpriteFont(bytes);
		expect(font.atlasRgba.length).toBe(2 * 1 * 4);
		expect(Array.from(font.atlasRgba)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
	});
});

describe('parseSpriteFont — B4G4R4A4 atlas', () => {
	it('expands 16-bit packed pixels to RGBA8', () => {
		// One pixel: B=0xF, G=0xF, R=0xF, A=0xF → packed = 0xFFFF → expand to all 255.
		const pixels = new Uint8Array([0xff, 0xff]);
		const bytes = buildSpriteFont({
			glyphs: [],
			lineSpacing: 10,
			defaultCharacter: 32,
			textureWidth: 1,
			textureHeight: 1,
			textureFormat: DXGI_FORMAT_B4G4R4A4_UNORM,
			textureStride: 2,
			textureRows: 1,
			pixels,
		});
		const font = parseSpriteFont(bytes);
		expect(Array.from(font.atlasRgba)).toEqual([255, 255, 255, 255]);
	});

	it('unpacks channels in the correct order', () => {
		// Pack a known value: B=0x1, G=0x2, R=0x3, A=0x4 → packed = 0x4321.
		// Bytes LE = [0x21, 0x43]. Expected expanded RGBA:
		//   R: (3<<4)|3 = 0x33
		//   G: (2<<4)|2 = 0x22
		//   B: (1<<4)|1 = 0x11
		//   A: (4<<4)|4 = 0x44
		const pixels = new Uint8Array([0x21, 0x43]);
		const bytes = buildSpriteFont({
			glyphs: [],
			lineSpacing: 10,
			defaultCharacter: 32,
			textureWidth: 1,
			textureHeight: 1,
			textureFormat: DXGI_FORMAT_B4G4R4A4_UNORM,
			textureStride: 2,
			textureRows: 1,
			pixels,
		});
		const font = parseSpriteFont(bytes);
		expect(Array.from(font.atlasRgba)).toEqual([0x33, 0x22, 0x11, 0x44]);
	});
});

describe('parseSpriteFont — errors', () => {
	it('throws on bad magic', () => {
		const bytes = new Uint8Array(64);
		bytes.set(new TextEncoder().encode('NotAFont'));
		expect(() => parseSpriteFont(bytes)).toThrow(SpriteFontParseError);
	});

	it('throws on truncated input', () => {
		expect(() => parseSpriteFont(new TextEncoder().encode('DXTKfont'))).toThrow(
			/truncated|too short/i,
		);
	});

	it('throws on implausible glyph count', () => {
		const bytes = new Uint8Array(64);
		bytes.set(new TextEncoder().encode('DXTKfont'));
		new DataView(bytes.buffer).setUint32(8, 99_999_999, true);
		expect(() => parseSpriteFont(bytes)).toThrow(/implausible/i);
	});

	it('marks unknown texture formats as "unknown" without throwing', () => {
		const bytes = buildSpriteFont({
			glyphs: [],
			lineSpacing: 10,
			defaultCharacter: 32,
			textureWidth: 1,
			textureHeight: 1,
			textureFormat: 99_999, // not a known DXGI format
			textureStride: 4,
			textureRows: 1,
			pixels: new Uint8Array([1, 2, 3, 4]),
		});
		const font = parseSpriteFont(bytes);
		expect(font.textureFormatName).toBe('unknown');
		// Atlas is zeroed (since we don't know how to decode).
		expect(font.atlasRgba.every((b) => b === 0)).toBe(true);
	});
});
