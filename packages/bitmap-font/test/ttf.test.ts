import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';
import { bitmapFontToTtf, chooseTraceMode, type BitmapFont } from '../src/index.js';
import { syntheticFont } from './helpers.js';

function open(bytes: Uint8Array) {
	return fontkit.create(Buffer.from(bytes)) as fontkit.Font;
}

/** The exact bounds of a glyph's path, by sampling its curves. */
function bounds(glyph: fontkit.Glyph) {
	const xs: number[] = [];
	const ys: number[] = [];
	let cx = 0;
	let cy = 0;
	for (const { command, args } of glyph.path.commands) {
		if (command === 'quadraticCurveTo') {
			const [qx, qy, ex, ey] = args as [number, number, number, number];
			for (let t = 0; t <= 1; t += 1 / 32) {
				xs.push((1 - t) ** 2 * cx + 2 * t * (1 - t) * qx + t * t * ex);
				ys.push((1 - t) ** 2 * cy + 2 * t * (1 - t) * qy + t * t * ey);
			}
		}
		if (args.length) {
			cx = args[args.length - 2]!;
			cy = args[args.length - 1]!;
			xs.push(cx);
			ys.push(cy);
		}
	}
	return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('bitmapFontToTtf', () => {
	const font = syntheticFont();
	const bytes = bitmapFontToTtf(font, { date: new Date(0) });
	const ttf = open(bytes);

	it('writes a font fontkit can read, with names and metrics', () => {
		expect(ttf.familyName).toBe('Synthetic');
		expect(ttf.subfamilyName).toBe('Regular');
		expect(ttf.postscriptName).toBe('Synthetic-Regular');
		// 40 px em at 25 units per px.
		expect(ttf.unitsPerEm).toBe(1000);
		expect(ttf.ascent).toBe(800);
		expect(ttf.descent).toBe(-200);
		expect(ttf.numGlyphs).toBe(6);
	});

	it('maps BMP and astral code points', () => {
		for (const cp of [0x6f, 0x4f, 0x49, 0x20, 0x1f600]) expect(ttf.hasGlyphForCodePoint(cp)).toBe(true);
		expect(ttf.hasGlyphForCodePoint(0x41)).toBe(false);
	});

	it('places outlines and advances in font units', () => {
		const o = ttf.glyphForCodePoint(0x6f);
		// Disc of radius 11 at (12, 12) in a bitmap placed at (1, 8);
		// baseline 32 px below the line top.
		expect(o.advanceWidth).toBe(26 * 25);
		const box = bounds(o);
		expect(Math.abs(box.minX / 25 - 2)).toBeLessThan(0.25);
		expect(Math.abs(box.maxX / 25 - 24)).toBeLessThan(0.25);
		expect(Math.abs(box.maxY / 25 - (32 - 9))).toBeLessThan(0.25);
		expect(Math.abs(box.minY / 25 - (32 - 31))).toBeLessThan(0.25);
		expect(ttf.glyphForCodePoint(0x20).advanceWidth).toBe(250);
		expect(ttf.glyphForCodePoint(0x20).path.commands).toHaveLength(0);
	});

	it('writes outer contours clockwise and holes counter-clockwise', () => {
		// fontkit keeps TrueType contour order; check the ring's two
		// contours have opposite winding in font units (y up).
		const ring = ttf.glyphForCodePoint(0x4f);
		const contours: [number, number][][] = [];
		for (const c of ring.path.commands) {
			if (c.command === 'moveTo') contours.push([]);
			if (c.args.length) contours[contours.length - 1]!.push([c.args[c.args.length - 2]!, c.args[c.args.length - 1]!]);
		}
		expect(contours).toHaveLength(2);
		const signed = contours.map((pts) => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1], 0) / 2);
		signed.sort((a, b) => Math.abs(b) - Math.abs(a));
		expect(signed[0]).toBeLessThan(0);
		expect(signed[1]).toBeGreaterThan(0);
	});

	it('applies kerning', () => {
		const run = ttf.layout('OI');
		expect(run.positions[0]!.xAdvance).toBe(32 * 25 - 3 * 25);
	});

	it('has valid table checksums', () => {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const n = view.getUint16(4);
		let total = 0;
		for (let i = 0; i < bytes.length; i += 4) total = (total + view.getUint32(i)) >>> 0;
		expect(total).toBe(0xb1b0afba);
		for (let t = 0; t < n; t++) {
			const rec = 12 + t * 16;
			const tag = String.fromCharCode(...bytes.subarray(rec, rec + 4));
			const offset = view.getUint32(rec + 8);
			const length = view.getUint32(rec + 12);
			let sum = 0;
			for (let i = 0; i < Math.ceil(length / 4) * 4; i += 4) sum = (sum + view.getUint32(offset + i)) >>> 0;
			if (tag === 'head') sum = (sum - view.getUint32(offset + 8)) >>> 0;
			expect(sum, tag).toBe(view.getUint32(rec + 4));
		}
	});

	it('is deterministic for a fixed date', () => {
		expect(bitmapFontToTtf(font, { date: new Date(0) })).toEqual(bytes);
	});
});

describe('pixel fonts', () => {
	const pixelFont: BitmapFont = {
		family: 'Tiny',
		emSize: 8,
		lineHeight: 8,
		base: 7,
		glyphs: [
			{
				codepoints: [0x41],
				advance: 4,
				x: 0,
				y: 2,
				width: 3,
				height: 5,
				// A 3×5 "A".
				coverage: new Uint8Array([0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1].map((v) => v * 255)),
			},
		],
	};

	it('picks pixel tracing for small or 1-bit fonts', () => {
		expect(chooseTraceMode(pixelFont)).toBe('pixel');
		expect(chooseTraceMode(syntheticFont())).toBe('smooth');
	});

	it('keeps every point on the pixel grid', () => {
		const ttf = open(bitmapFontToTtf(pixelFont, { date: new Date(0) }));
		expect(ttf.unitsPerEm).toBe(1000);
		const a = ttf.glyphForCodePoint(0x41);
		for (const c of a.path.commands) {
			for (const v of c.args) expect(v % 125).toBe(0);
		}
		expect(a.path.commands.every((c) => c.command !== 'quadraticCurveTo')).toBe(true);
	});
});
