import { describe, it, expect } from 'vitest';
import {
	decompressLzss,
	isLzss,
	parseFieldModule,
	getSection,
	parsePalette,
	parseBackground,
	composite,
	FieldSection,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// LZSS
// ---------------------------------------------------------------------------

describe('decompressLzss', () => {
	it('rejects inputs shorter than 4 bytes', () => {
		expect(() => decompressLzss(new Uint8Array([1, 2, 3]))).toThrow(
			RangeError,
		);
	});

	it('decompresses a stream of 8 literal bytes (one full control byte)', () => {
		// Header: declaredLen = 9 (1 control + 8 literals)
		// Control byte = 0xFF (all bits = literal)
		// Then 8 literal bytes
		const input = new Uint8Array([
			9, 0, 0, 0, // declaredLen = 9
			0xff, // control byte: 8 literals
			0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
		]);
		const out = decompressLzss(input);
		expect(Array.from(out)).toEqual([
			0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
		]);
	});

	it('decompresses a single back-reference (zero-window read)', () => {
		// rawOffset = 0; the formula `tail - ((tail - 18 - 0) mod 4096)`
		// produces a negative position → emits zero bytes from the
		// pre-zeroed window.
		const input = new Uint8Array([
			3, 0, 0, 0, // declaredLen = 3
			0x00, // control byte: all references
			0x00, 0x00, // raw_offset=0, raw_length=0 → length=3
		]);
		const out = decompressLzss(input);
		// First reference reads from before the buffer (all zeros).
		expect(Array.from(out)).toEqual([0, 0, 0]);
	});

	it('decompresses an RLE-style run-past-tail reference', () => {
		// Literal 'A' (0x41), then a back-reference for length 5
		// pointing at the literal. The "real offset" for raw=0 ends
		// up before the buffer (so the first byte is 0); to make the
		// test deterministic we use a larger raw offset that points
		// AT our literal.
		//
		// tail after first literal = 1. We want realOffset = 0 so:
		//   0 = 1 - ((1 - 18 - raw) mod 4096)
		//   1 = (1 - 18 - raw) mod 4096
		//   raw = (1 - 18 - 1) mod 4096 = -18 mod 4096 = 4078
		// Encode raw=4078 → byte1=0xEE, byte2 high nibble = 0xF
		// length 5 → raw_length = 2 → byte2 low nibble = 0x2
		// → byte2 = 0xF2
		const input = new Uint8Array([
			6, 0, 0, 0, // declaredLen = 6
			0x01, // control: bit 0 = literal, bits 1..7 = ref (only bit 1 used)
			0x41, // literal 'A'
			0xee, 0xf2, // ref: offset=4078 → real=0, length=5
		]);
		const out = decompressLzss(input);
		// First literal = 'A', then 5 bytes RLE-reading from offset 0
		// (which holds 'A') → "AAAAA".
		// Combined output = "AAAAAA" (6 bytes).
		expect(out.length).toBe(6);
		expect(String.fromCharCode(...out)).toBe('AAAAAA');
	});
});

describe('isLzss', () => {
	it('returns false for too-short inputs', () => {
		expect(isLzss(new Uint8Array(3))).toBe(false);
	});
	it('returns true when length matches header', () => {
		const buf = new Uint8Array(10);
		buf[0] = 6; // declaredLen = 6 → total 10
		expect(isLzss(buf)).toBe(true);
	});
	it('returns false on length mismatch', () => {
		const buf = new Uint8Array(10);
		buf[0] = 99;
		expect(isLzss(buf)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// FieldModule (synthetic)
// ---------------------------------------------------------------------------

function makeFieldModule(sectionPayloads: Uint8Array[]): Uint8Array {
	if (sectionPayloads.length !== 9) {
		throw new Error('FieldModule needs exactly 9 sections');
	}
	const headerSize = 2 + 4 + 9 * 4;
	let total = headerSize;
	for (const p of sectionPayloads) total += 4 + p.length;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(0, 0, true);
	view.setUint32(2, 9, true);
	let cursor = headerSize;
	for (let i = 0; i < 9; i++) {
		view.setUint32(6 + i * 4, cursor, true);
		view.setUint32(cursor, sectionPayloads[i]!.length, true);
		out.set(sectionPayloads[i]!, cursor + 4);
		cursor += 4 + sectionPayloads[i]!.length;
	}
	return out;
}

describe('parseFieldModule', () => {
	it('extracts 9 sections with correct payload boundaries', () => {
		const payloads = Array.from({ length: 9 }, (_, i) =>
			new Uint8Array([i + 1, i + 2, i + 3]),
		);
		const bytes = makeFieldModule(payloads);
		const mod = parseFieldModule(bytes);
		expect(mod.sections).toHaveLength(9);
		for (let i = 0; i < 9; i++) {
			expect(Array.from(mod.sections[i]!)).toEqual(Array.from(payloads[i]!));
		}
	});

	it('throws when the leading u16 is not zero', () => {
		const bytes = makeFieldModule(
			Array.from({ length: 9 }, () => new Uint8Array(0)),
		);
		bytes[0] = 1;
		expect(() => parseFieldModule(bytes)).toThrow(/expected leading u16/);
	});

	it('throws when numSections is not 9', () => {
		const bytes = makeFieldModule(
			Array.from({ length: 9 }, () => new Uint8Array(0)),
		);
		const view = new DataView(bytes.buffer);
		view.setUint32(2, 10, true);
		expect(() => parseFieldModule(bytes)).toThrow(/expected 9 sections/);
	});

	it('exposes named-section access', () => {
		const payloads = Array.from({ length: 9 }, (_, i) =>
			new Uint8Array([0xaa, i]),
		);
		const mod = parseFieldModule(makeFieldModule(payloads));
		expect(getSection(mod, 'Palette')).toEqual(payloads[FieldSection.Palette]);
		expect(getSection(mod, 'Background')).toEqual(
			payloads[FieldSection.Background],
		);
	});
});

// ---------------------------------------------------------------------------
// Palette (synthetic)
// ---------------------------------------------------------------------------

describe('parsePalette', () => {
	it('decodes a 2-page palette with 4 colors per page', () => {
		// Header: 12 bytes. Then 2 pages × 4 colors × 2 bytes = 16.
		const bytes = new Uint8Array(12 + 16);
		const view = new DataView(bytes.buffer);
		// palX, palY, colorsPerPage, pageCount
		view.setUint16(4, 0, true);
		view.setUint16(6, 480, true);
		view.setUint16(8, 4, true);
		view.setUint16(10, 2, true);
		// Page 0: red (0x001F), green (0x03E0), blue (0x7C00), M=1 (0x8000)
		view.setUint16(12, 0x001f, true);
		view.setUint16(14, 0x03e0, true);
		view.setUint16(16, 0x7c00, true);
		view.setUint16(18, 0x8000, true);
		// Page 1: white-ish (0x7FFF), black (0x0000), red dim (0x000F), grey (0x4210)
		view.setUint16(20, 0x7fff, true);
		view.setUint16(22, 0x0000, true);
		view.setUint16(24, 0x000f, true);
		view.setUint16(26, 0x4210, true);
		const p = parsePalette(bytes);
		expect(p.pageCount).toBe(2);
		expect(p.colorsPerPage).toBe(4);
		// Page 0 color 0 = pure red
		expect(Array.from(p.pages[0]!.subarray(0, 4))).toEqual([255, 0, 0, 255]);
		// Page 0 color 1 = pure green
		expect(Array.from(p.pages[0]!.subarray(4, 8))).toEqual([0, 255, 0, 255]);
		// Page 0 color 2 = pure blue
		expect(Array.from(p.pages[0]!.subarray(8, 12))).toEqual([0, 0, 255, 255]);
		// Page 0 color 3 = M-bit set → alpha 0
		expect(p.pages[0]![15]).toBe(0);
	});

	it('exposes raw u16 colors for callers that want the M bit', () => {
		const bytes = new Uint8Array(12 + 4);
		const view = new DataView(bytes.buffer);
		view.setUint16(8, 2, true);
		view.setUint16(10, 1, true);
		view.setUint16(12, 0xabcd, true);
		view.setUint16(14, 0x1234, true);
		const p = parsePalette(bytes);
		expect(p.pagesRaw[0]![0]).toBe(0xabcd);
		expect(p.pagesRaw[0]![1]).toBe(0x1234);
	});

	it('rejects truncated input', () => {
		const bytes = new Uint8Array(12 + 2); // Claims 4 colors × 1 page but has 2 bytes
		const view = new DataView(bytes.buffer);
		view.setUint16(8, 4, true);
		view.setUint16(10, 1, true);
		expect(() => parsePalette(bytes)).toThrow(/declares/);
	});
});

// ---------------------------------------------------------------------------
// Background — only tested end-to-end via the round-trip below.
// Synthetic Section 9 is too complex to author by hand for a unit test;
// the real-corpus integration testing happens in the nx-archive app.
// ---------------------------------------------------------------------------

describe('composite', () => {
	it('returns an empty result for empty tile list', () => {
		const result = composite(
			{
				tiles: [],
				textures: new Map(),
				ignoreFirstPixel: [],
				bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			},
			{ colorsPerPage: 256, pageCount: 0, pages: [], pagesRaw: [] },
		);
		expect(result.width).toBe(0);
		expect(result.height).toBe(0);
		expect(result.pixels).toHaveLength(0);
	});

	it('draws a single paletted tile at the canvas origin', () => {
		// One layer-0 tile, 16×16, all texels = palette index 5.
		const texData = new Uint8Array(256 * 256).fill(5);
		const palette0 = new Uint8Array(256 * 4);
		// Color 5 = orange (255, 128, 0, 255)
		palette0[5 * 4 + 0] = 255;
		palette0[5 * 4 + 1] = 128;
		palette0[5 * 4 + 2] = 0;
		palette0[5 * 4 + 3] = 255;

		const result = composite(
			{
				tiles: [
					{
						layerID: 0,
						dstX: 0,
						dstY: 0,
						srcX: 0,
						srcY: 0,
						textureID: 0,
						paletteID: 0,
						ID: 4095,
						param: 0,
						state: 0,
						stateBit: 0,
						blending: 0,
						typeTrans: 0,
						depth: 1,
						recordIndex: 0,
					},
				],
				textures: new Map([
					[
						0,
						{
							textureID: 0,
							isBigTile: 0,
							depth: 1,
							data: texData,
						},
					],
				]),
				ignoreFirstPixel: [],
				bounds: { minX: 0, minY: 0, maxX: 16, maxY: 16, width: 16, height: 16 },
			},
			{
				colorsPerPage: 256,
				pageCount: 1,
				pages: [palette0],
				pagesRaw: [new Uint16Array(256)],
			},
		);
		expect(result.width).toBe(16);
		expect(result.height).toBe(16);
		// Every pixel should be the orange palette color.
		for (let i = 0; i < 16 * 16; i++) {
			expect(result.pixels[i * 4 + 0]).toBe(255);
			expect(result.pixels[i * 4 + 1]).toBe(128);
			expect(result.pixels[i * 4 + 2]).toBe(0);
			expect(result.pixels[i * 4 + 3]).toBe(255);
		}
	});
});
