import { describe, expect, it } from 'vitest';

import { IDFONT_MAGIC, isIdFont, parseIdFont } from '../src/index.js';

interface SyntheticGlyph {
	codepoint: number;
	width: number;
	height: number;
	top: number;
	left: number;
	xSkip: number;
	s: number;
	t: number;
}

function buildIdFont(opts: {
	pointSize: number;
	ascender: number;
	descender: number;
	glyphs: SyntheticGlyph[];
}): Blob {
	// Sort by codepoint (the parser assumes ascending order).
	const sorted = [...opts.glyphs].sort((a, b) => a.codepoint - b.codepoint);
	const numGlyphs = sorted.length;

	const HEADER = 12;
	const GLYPH = 10;
	const total = HEADER + numGlyphs * GLYPH + numGlyphs * 4;
	const buf = new Uint8Array(total);
	const view = new DataView(buf.buffer);

	// Header (BE).
	view.setUint32(0, IDFONT_MAGIC, false);
	view.setInt16(4, opts.pointSize, false);
	view.setInt16(6, opts.ascender, false);
	view.setInt16(8, opts.descender, false);
	view.setInt16(10, numGlyphs, false);

	// Glyph table (LE for s/t).
	for (let i = 0; i < numGlyphs; i++) {
		const g = sorted[i];
		const off = HEADER + i * GLYPH;
		buf[off] = g.width;
		buf[off + 1] = g.height;
		view.setInt8(off + 2, g.top);
		view.setInt8(off + 3, g.left);
		buf[off + 4] = g.xSkip;
		// off + 5 padding
		view.setUint16(off + 6, g.s, /*littleEndian*/ true);
		view.setUint16(off + 8, g.t, /*littleEndian*/ true);
	}

	// charIndex (LE).
	const cpOff = HEADER + numGlyphs * GLYPH;
	for (let i = 0; i < numGlyphs; i++) {
		view.setUint32(cpOff + i * 4, sorted[i].codepoint, /*littleEndian*/ true);
	}

	return new Blob([buf]);
}

describe('isIdFont', () => {
	it('returns true for the 4-byte idf* magic', async () => {
		const blob = new Blob([new Uint8Array([0x69, 0x64, 0x66, 0x2a, 0, 0, 0, 0])]);
		expect(await isIdFont(blob)).toBe(true);
	});
	it('returns false for non-matching bytes', async () => {
		const blob = new Blob([new Uint8Array([0x69, 0x64, 0x66, 0x2b])]);
		expect(await isIdFont(blob)).toBe(false);
	});
	it('returns false for short blobs', async () => {
		expect(await isIdFont(new Blob([new Uint8Array(2)]))).toBe(false);
	});
});

describe('parseIdFont', () => {
	it('round-trips a single-glyph font', async () => {
		const arc = buildIdFont({
			pointSize: 48,
			ascender: 48,
			descender: -11,
			glyphs: [
				{
					codepoint: 65 /* 'A' */,
					width: 30,
					height: 36,
					top: 36,
					left: 1,
					xSkip: 32,
					s: 0,
					t: 0,
				},
			],
		});
		const parsed = await parseIdFont(arc);
		expect(parsed.pointSize).toBe(48);
		expect(parsed.ascender).toBe(48);
		expect(parsed.descender).toBe(-11);
		expect(parsed.glyphs).toHaveLength(1);
		expect(parsed.codepoints).toEqual([65]);
		const a = parsed.byCodepoint.get(65);
		expect(a).toEqual({
			width: 30,
			height: 36,
			top: 36,
			left: 1,
			xSkip: 32,
			s: 0,
			t: 0,
		});
	});

	it('preserves ascending codepoint order and the parallel glyph mapping', async () => {
		const arc = buildIdFont({
			pointSize: 48,
			ascender: 48,
			descender: -11,
			glyphs: [
				{ codepoint: 65, width: 1, height: 1, top: 0, left: 0, xSkip: 1, s: 100, t: 200 },
				{ codepoint: 32, width: 0, height: 0, top: 0, left: 0, xSkip: 12, s: 0, t: 0 },
				{ codepoint: 200, width: 2, height: 2, top: 1, left: 0, xSkip: 2, s: 300, t: 400 },
				{ codepoint: 90, width: 5, height: 5, top: 5, left: 0, xSkip: 6, s: 500, t: 600 },
			],
		});
		const parsed = await parseIdFont(arc);
		expect(parsed.codepoints).toEqual([32, 65, 90, 200]);
		expect(parsed.byCodepoint.get(200)!.s).toBe(300);
		expect(parsed.byCodepoint.get(200)!.t).toBe(400);
		expect(parsed.byCodepoint.get(32)!.xSkip).toBe(12);
	});

	it('handles negative top / left (signed int8)', async () => {
		const arc = buildIdFont({
			pointSize: 48,
			ascender: 48,
			descender: -11,
			glyphs: [
				{ codepoint: 65, width: 8, height: 8, top: -5, left: -3, xSkip: 8, s: 0, t: 0 },
			],
		});
		const parsed = await parseIdFont(arc);
		const g = parsed.byCodepoint.get(65)!;
		expect(g.top).toBe(-5);
		expect(g.left).toBe(-3);
	});

	it('rejects a bad magic', async () => {
		const buf = new Uint8Array(16);
		await expect(parseIdFont(new Blob([buf]))).rejects.toThrow(/magic/i);
	});

	it('rejects truncated files', async () => {
		const buf = new Uint8Array(12);
		new DataView(buf.buffer).setUint32(0, IDFONT_MAGIC, false);
		new DataView(buf.buffer).setInt16(10, 50, false); // numGlyphs=50 but no data
		await expect(parseIdFont(new Blob([buf]))).rejects.toThrow(/past end/i);
	});
});
