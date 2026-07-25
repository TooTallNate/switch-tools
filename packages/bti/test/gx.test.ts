import { describe, expect, it } from 'vitest';
import {
	GxPaletteFormat,
	GxTextureFormat,
	decodeGxTexture,
	gxBlockHeight,
	gxBlockWidth,
	gxFormatIsKnown,
	gxFormatIsPaletted,
	gxFormatName,
	gxImageSize,
	gxPaletteFormatName,
} from '../src/index.js';
import {
	be16Repeat,
	concat,
	dxt1SubBlock,
	idxRow,
	px,
	rgb4443,
	rgb555Opaque,
	rgb565,
} from './fixtures.js';

const RED565 = rgb565(255, 0, 0); // 0xF800
const GREEN565 = rgb565(0, 255, 0); // 0x07E0
const BLUE565 = rgb565(0, 0, 255); // 0x001F
const WHITE565 = 0xffff;
const BLACK565 = 0x0000;

const OPAQUE_RED = [255, 0, 0, 255];
const OPAQUE_GREEN = [0, 255, 0, 255];
const OPAQUE_BLUE = [0, 0, 255, 255];
const OPAQUE_WHITE = [255, 255, 255, 255];
const OPAQUE_BLACK = [0, 0, 0, 255];
const TRANSPARENT = [0, 0, 0, 0];

describe('format metadata', () => {
	it('names every documented format', () => {
		expect(gxFormatName(GxTextureFormat.I4)).toBe('I4');
		expect(gxFormatName(GxTextureFormat.I8)).toBe('I8');
		expect(gxFormatName(GxTextureFormat.IA4)).toBe('IA4');
		expect(gxFormatName(GxTextureFormat.IA8)).toBe('IA8');
		expect(gxFormatName(GxTextureFormat.RGB565)).toBe('RGB565');
		expect(gxFormatName(GxTextureFormat.RGB5A3)).toBe('RGB5A3');
		expect(gxFormatName(GxTextureFormat.RGBA32)).toBe('RGBA32');
		expect(gxFormatName(GxTextureFormat.C4)).toBe('C4');
		expect(gxFormatName(GxTextureFormat.C8)).toBe('C8');
		expect(gxFormatName(GxTextureFormat.C14X2)).toBe('C14X2');
		expect(gxFormatName(GxTextureFormat.CMPR)).toBe('CMPR');
	});

	it('reports unknown formats without throwing', () => {
		// 0x07 and 0x0B..0x0D are holes in the GX format enumeration.
		expect(gxFormatName(0x07)).toBe('Unknown(0x07)');
		expect(gxFormatName(0x0b)).toBe('Unknown(0x0b)');
		expect(gxFormatIsKnown(0x07)).toBe(false);
		expect(gxFormatIsKnown(GxTextureFormat.CMPR)).toBe(true);
		expect(gxBlockWidth(0x07)).toBe(0);
		expect(gxBlockHeight(0x07)).toBe(0);
	});

	it('names palette formats', () => {
		expect(gxPaletteFormatName(GxPaletteFormat.IA8)).toBe('IA8');
		expect(gxPaletteFormatName(GxPaletteFormat.RGB565)).toBe('RGB565');
		expect(gxPaletteFormatName(GxPaletteFormat.RGB5A3)).toBe('RGB5A3');
		expect(gxPaletteFormatName(9)).toBe('Unknown(0x09)');
	});

	it('knows which formats are paletted', () => {
		expect(gxFormatIsPaletted(GxTextureFormat.C4)).toBe(true);
		expect(gxFormatIsPaletted(GxTextureFormat.C8)).toBe(true);
		expect(gxFormatIsPaletted(GxTextureFormat.C14X2)).toBe(true);
		expect(gxFormatIsPaletted(GxTextureFormat.I4)).toBe(false);
		expect(gxFormatIsPaletted(GxTextureFormat.CMPR)).toBe(false);
	});

	it('uses the cache-line block sizes', () => {
		// 4 bpp → 8x8, 8 bpp → 8x4, 16/32 bpp → 4x4.
		const expected: Array<[number, number, number]> = [
			[GxTextureFormat.I4, 8, 8],
			[GxTextureFormat.C4, 8, 8],
			[GxTextureFormat.CMPR, 8, 8],
			[GxTextureFormat.I8, 8, 4],
			[GxTextureFormat.IA4, 8, 4],
			[GxTextureFormat.C8, 8, 4],
			[GxTextureFormat.IA8, 4, 4],
			[GxTextureFormat.RGB565, 4, 4],
			[GxTextureFormat.RGB5A3, 4, 4],
			[GxTextureFormat.C14X2, 4, 4],
			[GxTextureFormat.RGBA32, 4, 4],
		];
		for (const [format, bw, bh] of expected) {
			expect([gxBlockWidth(format), gxBlockHeight(format)]).toEqual([
				bw,
				bh,
			]);
		}
	});

	it('makes every block exactly one 32-byte cache line (except RGBA32)', () => {
		for (const format of Object.values(GxTextureFormat)) {
			const bytes = gxImageSize(
				format,
				gxBlockWidth(format),
				gxBlockHeight(format),
			);
			expect(bytes).toBe(format === GxTextureFormat.RGBA32 ? 64 : 32);
		}
	});
});

describe('gxImageSize', () => {
	it('rounds up to whole blocks', () => {
		// A 5x5 CMPR image still occupies one complete 8x8 block.
		expect(gxImageSize(GxTextureFormat.CMPR, 5, 5)).toBe(32);
		expect(gxImageSize(GxTextureFormat.CMPR, 8, 8)).toBe(32);
		// 9x9 spills into a 2x2 grid of blocks.
		expect(gxImageSize(GxTextureFormat.CMPR, 9, 9)).toBe(128);
		expect(gxImageSize(GxTextureFormat.CMPR, 16, 8)).toBe(64);

		// 4 bpp, 8x8 blocks.
		expect(gxImageSize(GxTextureFormat.I4, 1, 1)).toBe(32);
		expect(gxImageSize(GxTextureFormat.I4, 8, 8)).toBe(32);
		expect(gxImageSize(GxTextureFormat.I4, 16, 8)).toBe(64);
		expect(gxImageSize(GxTextureFormat.C4, 9, 9)).toBe(128);

		// 8 bpp, 8x4 blocks.
		expect(gxImageSize(GxTextureFormat.I8, 8, 4)).toBe(32);
		expect(gxImageSize(GxTextureFormat.I8, 5, 5)).toBe(64);
		expect(gxImageSize(GxTextureFormat.IA4, 16, 8)).toBe(128);
		expect(gxImageSize(GxTextureFormat.C8, 8, 8)).toBe(64);

		// 16 bpp, 4x4 blocks.
		expect(gxImageSize(GxTextureFormat.IA8, 4, 4)).toBe(32);
		expect(gxImageSize(GxTextureFormat.RGB565, 8, 8)).toBe(128);
		expect(gxImageSize(GxTextureFormat.RGB5A3, 5, 5)).toBe(128);
		expect(gxImageSize(GxTextureFormat.C14X2, 1, 1)).toBe(32);

		// 32 bpp, 4x4 blocks of two cache lines each.
		expect(gxImageSize(GxTextureFormat.RGBA32, 4, 4)).toBe(64);
		expect(gxImageSize(GxTextureFormat.RGBA32, 8, 8)).toBe(256);
		expect(gxImageSize(GxTextureFormat.RGBA32, 5, 5)).toBe(256);
	});

	it('matches the 1024x1024 hardware maximum for every format', () => {
		// Sanity: 1024x1024 at N bpp is exactly 1024*1024*N/8 bytes,
		// since 1024 is a multiple of every block dimension.
		expect(gxImageSize(GxTextureFormat.I4, 1024, 1024)).toBe(512 * 1024);
		expect(gxImageSize(GxTextureFormat.I8, 1024, 1024)).toBe(1024 * 1024);
		expect(gxImageSize(GxTextureFormat.RGB565, 1024, 1024)).toBe(
			2 * 1024 * 1024,
		);
		expect(gxImageSize(GxTextureFormat.RGBA32, 1024, 1024)).toBe(
			4 * 1024 * 1024,
		);
		expect(gxImageSize(GxTextureFormat.CMPR, 1024, 1024)).toBe(512 * 1024);
	});

	it('returns 0 for unknown formats and degenerate dimensions', () => {
		expect(gxImageSize(0x07, 8, 8)).toBe(0);
		expect(gxImageSize(0x0f, 8, 8)).toBe(0);
		expect(gxImageSize(GxTextureFormat.I4, 0, 8)).toBe(0);
		expect(gxImageSize(GxTextureFormat.I4, 8, 0)).toBe(0);
		expect(gxImageSize(GxTextureFormat.I4, -8, 8)).toBe(0);
		expect(gxImageSize(GxTextureFormat.I4, Number.NaN, 8)).toBe(0);
	});
});

describe('I4', () => {
	it('unpacks nibbles high-first and replicates intensity into alpha', () => {
		// One 8x8 block = 32 bytes. Byte 0 covers texels (0,0) and (1,0).
		const data = new Uint8Array(32);
		data[0] = 0x3c; // left nibble 0x3, right nibble 0xC
		data[1] = 0xf0; // left nibble 0xF, right nibble 0x0
		const out = decodeGxTexture(data, 0, 8, 8, GxTextureFormat.I4)!;
		expect(out).not.toBeNull();
		expect(out.length).toBe(8 * 8 * 4);
		// 4 → 8 bits is a nibble replication: 0x3 → 0x33.
		expect(px(out, 8, 0, 0)).toEqual([0x33, 0x33, 0x33, 0x33]);
		expect(px(out, 8, 1, 0)).toEqual([0xcc, 0xcc, 0xcc, 0xcc]);
		expect(px(out, 8, 2, 0)).toEqual([0xff, 0xff, 0xff, 0xff]);
		expect(px(out, 8, 3, 0)).toEqual([0x00, 0x00, 0x00, 0x00]);
	});

	it('lays 8x8 blocks out left-to-right, not as scanlines', () => {
		// 16x8 = two 8x8 blocks side by side, 32 bytes each.
		const data = concat(
			new Uint8Array(32).fill(0x0f), // block 0: left texel 0, right 15
			new Uint8Array(32).fill(0xf0), // block 1: left texel 15, right 0
		);
		expect(data.length).toBe(gxImageSize(GxTextureFormat.I4, 16, 8));
		const out = decodeGxTexture(data, 0, 16, 8, GxTextureFormat.I4)!;

		// Left half comes from block 0 …
		expect(px(out, 16, 0, 0)).toEqual([0, 0, 0, 0]);
		expect(px(out, 16, 1, 0)).toEqual([255, 255, 255, 255]);
		expect(px(out, 16, 0, 7)).toEqual([0, 0, 0, 0]);
		// … and the right half from block 1. A linear (scanline) reader
		// would have byte 32 land at texel (0,4) instead, so this is the
		// assertion that proves tiling is applied.
		expect(px(out, 16, 8, 0)).toEqual([255, 255, 255, 255]);
		expect(px(out, 16, 9, 0)).toEqual([0, 0, 0, 0]);
		expect(px(out, 16, 8, 7)).toEqual([255, 255, 255, 255]);
	});

	it('consumes padding texels for non-block-aligned sizes', () => {
		// 5x5 still reads a whole 8x8 block; only 25 texels come out.
		const data = new Uint8Array(32).fill(0xff);
		const out = decodeGxTexture(data, 0, 5, 5, GxTextureFormat.I4)!;
		expect(out.length).toBe(5 * 5 * 4);
		for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0xff);
	});
});

describe('I8', () => {
	it('walks 8x4 blocks in block-row order', () => {
		// 16x8 → 2 blocks across, 2 down; 4 blocks x 32 bytes = 128.
		const data = new Uint8Array(128);
		for (let i = 0; i < data.length; i++) data[i] = i;
		expect(data.length).toBe(gxImageSize(GxTextureFormat.I8, 16, 8));
		const out = decodeGxTexture(data, 0, 16, 8, GxTextureFormat.I8)!;

		// Source index for a texel: block = (py>>2)*2 + (px>>3), and
		// within the block index = (py&3)*8 + (px&7).
		const expected = (x: number, y: number) =>
			((y >> 2) * 2 + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7);
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 16; x++) {
				const v = expected(x, y);
				expect(px(out, 16, x, y)).toEqual([v, v, v, v]);
			}
		}

		// Spot-check the values a scanline reader would get wrong:
		// linearly, texel (8,0) would be byte 8, not byte 32.
		expect(px(out, 16, 8, 0)[0]).toBe(32);
		expect(px(out, 16, 3, 2)[0]).toBe(19);
		expect(px(out, 16, 15, 7)[0]).toBe(127);
	});
});

describe('IA4', () => {
	it('reads intensity from the low nibble and alpha from the high nibble', () => {
		const data = new Uint8Array(32);
		data[0] = 0x5a; // alpha 0x5 → 0x55, intensity 0xA → 0xAA
		data[1] = 0xf0; // alpha 0xF → 0xFF, intensity 0x0 → 0x00
		data[2] = 0x0f; // alpha 0x0 → 0x00, intensity 0xF → 0xFF
		const out = decodeGxTexture(data, 0, 8, 4, GxTextureFormat.IA4)!;
		expect(px(out, 8, 0, 0)).toEqual([0xaa, 0xaa, 0xaa, 0x55]);
		expect(px(out, 8, 1, 0)).toEqual([0x00, 0x00, 0x00, 0xff]);
		expect(px(out, 8, 2, 0)).toEqual([0xff, 0xff, 0xff, 0x00]);
	});
});

describe('IA8', () => {
	it('reads alpha from byte 0 and intensity from byte 1, in 4x4 blocks', () => {
		// 8x8 → four 4x4 blocks in TL, TR, BL, BR order.
		const data = concat(
			be16Repeat(0xff11, 16), // TL: alpha 0xFF, intensity 0x11
			be16Repeat(0x8022, 16), // TR
			be16Repeat(0x4033, 16), // BL
			be16Repeat(0x0044, 16), // BR
		);
		expect(data.length).toBe(gxImageSize(GxTextureFormat.IA8, 8, 8));
		const out = decodeGxTexture(data, 0, 8, 8, GxTextureFormat.IA8)!;

		expect(px(out, 8, 0, 0)).toEqual([0x11, 0x11, 0x11, 0xff]);
		expect(px(out, 8, 3, 3)).toEqual([0x11, 0x11, 0x11, 0xff]);
		expect(px(out, 8, 4, 0)).toEqual([0x22, 0x22, 0x22, 0x80]);
		expect(px(out, 8, 0, 4)).toEqual([0x33, 0x33, 0x33, 0x40]);
		expect(px(out, 8, 4, 4)).toEqual([0x44, 0x44, 0x44, 0x00]);
		// Linearly, bytes 0..31 would cover rows 0 and 1 entirely, so
		// texel (5,1) would read as TL. Tiled, it belongs to TR.
		expect(px(out, 8, 5, 1)).toEqual([0x22, 0x22, 0x22, 0x80]);
	});
});

describe('RGB565', () => {
	it('places each 4x4 block in the right quadrant of an 8x8 image', () => {
		const data = concat(
			be16Repeat(RED565, 16), // TL
			be16Repeat(GREEN565, 16), // TR
			be16Repeat(BLUE565, 16), // BL
			be16Repeat(WHITE565, 16), // BR
		);
		expect(data.length).toBe(128);
		const out = decodeGxTexture(data, 0, 8, 8, GxTextureFormat.RGB565)!;

		// Whole-quadrant check.
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				const quadrant =
					y < 4
						? x < 4
							? OPAQUE_RED
							: OPAQUE_GREEN
						: x < 4
							? OPAQUE_BLUE
							: OPAQUE_WHITE;
				expect(px(out, 8, x, y)).toEqual(quadrant);
			}
		}
		// The single most diagnostic texel: a linear reader puts the
		// first 32 bytes across rows 0-1, making (5,1) red.
		expect(px(out, 8, 5, 1)).toEqual(OPAQUE_GREEN);
	});

	it('expands 5- and 6-bit channels by replicating high bits', () => {
		// 0x0841 = R 00001, G 000010, B 00001.
		const data = be16Repeat(0x0841, 16);
		const out = decodeGxTexture(data, 0, 4, 4, GxTextureFormat.RGB565)!;
		expect(px(out, 4, 0, 0)).toEqual([8, 8, 8, 255]);

		// All-ones must saturate to 0xFF on every channel.
		const white = decodeGxTexture(
			be16Repeat(0xffff, 16),
			0,
			4,
			4,
			GxTextureFormat.RGB565,
		)!;
		expect(px(white, 4, 2, 2)).toEqual(OPAQUE_WHITE);
	});
});

describe('RGB5A3', () => {
	it('treats a set top bit as opaque 5:5:5 and a clear one as 4:4:4 + A3', () => {
		const values = [
			rgb555Opaque(31, 0, 0), // 0: opaque red
			rgb555Opaque(0, 31, 0), // 1: opaque green
			rgb555Opaque(0, 0, 31), // 2: opaque blue
			0xffff, // 3: opaque white
			rgb4443(0, 0, 0, 0), // 4: fully transparent
			rgb4443(7, 15, 15, 15), // 5: opaque white via the A3 branch
			rgb4443(4, 15, 0, 0), // 6: half-alpha red
			rgb4443(1, 2, 3, 4), // 7: assorted nibbles
			rgb555Opaque(1, 1, 0), // 8: low 5-bit values
			0,
			0,
			0,
			0,
			0,
			0,
			0,
		];
		const data = new Uint8Array(32);
		for (let i = 0; i < 16; i++) {
			data[i * 2] = (values[i] >> 8) & 0xff;
			data[i * 2 + 1] = values[i] & 0xff;
		}
		const out = decodeGxTexture(data, 0, 4, 4, GxTextureFormat.RGB5A3)!;
		const at = (t: number) => px(out, 4, t & 3, t >> 2);

		expect(at(0)).toEqual(OPAQUE_RED);
		expect(at(1)).toEqual(OPAQUE_GREEN);
		expect(at(2)).toEqual(OPAQUE_BLUE);
		expect(at(3)).toEqual(OPAQUE_WHITE);
		expect(at(4)).toEqual(TRANSPARENT);
		expect(at(5)).toEqual(OPAQUE_WHITE);
		// 3 → 8 bits: 4 → (4<<5)|(4<<2)|(4>>1) = 146.
		expect(at(6)).toEqual([255, 0, 0, 146]);
		// 4 → 8 bits is nibble replication; alpha 1 → 32|4|0 = 36.
		expect(at(7)).toEqual([0x22, 0x33, 0x44, 36]);
		// 5 → 8 bits: 1 → (1<<3)|(1>>2) = 8.
		expect(at(8)).toEqual([8, 8, 0, 255]);
		// Untouched texels are 0x0000 = transparent black.
		expect(at(15)).toEqual(TRANSPARENT);
	});

	it('does not confuse the two branches for the same bit pattern', () => {
		// 0x7FFF (top bit clear) is opaque white via 4:4:4 + A3 = 7,
		// whereas 0xFFFF (top bit set) is opaque white via 5:5:5.
		// Both are white here, but 0x0FFF must be *transparent* white.
		const data = concat(be16Repeat(0x0fff, 16));
		const out = decodeGxTexture(data, 0, 4, 4, GxTextureFormat.RGB5A3)!;
		expect(px(out, 4, 0, 0)).toEqual([255, 255, 255, 0]);
	});
});

describe('RGBA32', () => {
	it('reads the AR half-block then the GB half-block', () => {
		const data = new Uint8Array(64);
		// Texel 0 → (0,0).
		data[0] = 0x11; // A
		data[1] = 0x22; // R
		data[32] = 0x33; // G
		data[33] = 0x44; // B
		// Texel 5 → (1,1).
		data[5 * 2] = 0xff;
		data[5 * 2 + 1] = 0x10;
		data[32 + 5 * 2] = 0x20;
		data[32 + 5 * 2 + 1] = 0x30;
		// Texel 15 → (3,3).
		data[15 * 2] = 0x00;
		data[15 * 2 + 1] = 0xaa;
		data[32 + 15 * 2] = 0xbb;
		data[32 + 15 * 2 + 1] = 0xcc;

		const out = decodeGxTexture(data, 0, 4, 4, GxTextureFormat.RGBA32)!;
		expect(px(out, 4, 0, 0)).toEqual([0x22, 0x33, 0x44, 0x11]);
		expect(px(out, 4, 1, 1)).toEqual([0x10, 0x20, 0x30, 0xff]);
		expect(px(out, 4, 3, 3)).toEqual([0xaa, 0xbb, 0xcc, 0x00]);
		// An interleaved-RGBA misreading would give [0x11,0x22,0x33,0x44].
		expect(px(out, 4, 0, 0)).not.toEqual([0x11, 0x22, 0x33, 0x44]);
	});

	it('advances 64 bytes per block', () => {
		const block = (a: number, r: number, g: number, b: number) => {
			const out = new Uint8Array(64);
			for (let t = 0; t < 16; t++) {
				out[t * 2] = a;
				out[t * 2 + 1] = r;
				out[32 + t * 2] = g;
				out[32 + t * 2 + 1] = b;
			}
			return out;
		};
		const data = concat(block(1, 2, 3, 4), block(5, 6, 7, 8));
		expect(data.length).toBe(gxImageSize(GxTextureFormat.RGBA32, 8, 4));
		const out = decodeGxTexture(data, 0, 8, 4, GxTextureFormat.RGBA32)!;
		expect(px(out, 8, 0, 0)).toEqual([2, 3, 4, 1]);
		expect(px(out, 8, 3, 3)).toEqual([2, 3, 4, 1]);
		expect(px(out, 8, 4, 0)).toEqual([6, 7, 8, 5]);
		expect(px(out, 8, 7, 3)).toEqual([6, 7, 8, 5]);
	});
});

describe('CMPR', () => {
	it('orders sub-blocks TL, TR, BL, BR and handles both colour modes', () => {
		const data = concat(
			// TL: color0 > color1 → 4-colour mode, indices 0,1,2,3 on row 0.
			dxt1SubBlock(WHITE565, BLACK565, [idxRow(0, 1, 2, 3), 0, 0, 0]),
			// TR: color0 <= color1 → 3-colour mode; index 3 is transparent.
			dxt1SubBlock(BLACK565, WHITE565, [idxRow(0, 1, 2, 3), 0, 0, 0]),
			// BL: solid color0 (green).
			dxt1SubBlock(GREEN565, BLACK565, [0, 0, 0, 0]),
			// BR: 3-colour mode, every index 1 → color1 (red).
			dxt1SubBlock(BLACK565, RED565, [
				idxRow(1, 1, 1, 1),
				idxRow(1, 1, 1, 1),
				idxRow(1, 1, 1, 1),
				idxRow(1, 1, 1, 1),
			]),
		);
		expect(data.length).toBe(gxImageSize(GxTextureFormat.CMPR, 8, 8));
		const out = decodeGxTexture(data, 0, 8, 8, GxTextureFormat.CMPR)!;

		// 4-colour mode: endpoints plus 2/3 and 1/3 blends, all opaque.
		expect(px(out, 8, 0, 0)).toEqual(OPAQUE_WHITE);
		expect(px(out, 8, 1, 0)).toEqual(OPAQUE_BLACK);
		expect(px(out, 8, 2, 0)).toEqual([170, 170, 170, 255]);
		expect(px(out, 8, 3, 0)).toEqual([85, 85, 85, 255]);
		// Row 1 of TL is all index 0.
		expect(px(out, 8, 1, 1)).toEqual(OPAQUE_WHITE);

		// 3-colour mode: one midpoint, and index 3 = transparent black.
		expect(px(out, 8, 4, 0)).toEqual(OPAQUE_BLACK);
		expect(px(out, 8, 5, 0)).toEqual(OPAQUE_WHITE);
		expect(px(out, 8, 6, 0)).toEqual([127, 127, 127, 255]);
		expect(px(out, 8, 7, 0)).toEqual(TRANSPARENT);
		// Sub-block ordering along x: (5,1) is TR (opaque black), not TL.
		expect(px(out, 8, 5, 1)).toEqual(OPAQUE_BLACK);

		// Bottom-left and bottom-right sub-blocks.
		for (let y = 4; y < 8; y++) {
			for (let x = 0; x < 4; x++) {
				expect(px(out, 8, x, y)).toEqual(OPAQUE_GREEN);
			}
		}
		for (let y = 4; y < 8; y++) {
			for (let x = 4; x < 8; x++) {
				expect(px(out, 8, x, y)).toEqual(OPAQUE_RED);
			}
		}
	});

	it('reads endpoint colours big-endian', () => {
		// 0xF800 big-endian is red; byte-swapped (0x00F8) it would be a
		// dark blue-green, so this pins the endianness down.
		const data = concat(
			dxt1SubBlock(RED565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(RED565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(RED565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(RED565, BLACK565, [0, 0, 0, 0]),
		);
		const out = decodeGxTexture(data, 0, 8, 8, GxTextureFormat.CMPR)!;
		expect(px(out, 8, 0, 0)).toEqual(OPAQUE_RED);
	});

	it('groups sub-blocks into 8x8 blocks rather than raster 4x4 blocks', () => {
		const solid = (color: number) =>
			concat(
				dxt1SubBlock(color, BLACK565, [0, 0, 0, 0]),
				dxt1SubBlock(color, BLACK565, [0, 0, 0, 0]),
				dxt1SubBlock(color, BLACK565, [0, 0, 0, 0]),
				dxt1SubBlock(color, BLACK565, [0, 0, 0, 0]),
			);
		// 16x8 = two 8x8 blocks. If sub-blocks were laid out in plain
		// 4x4 raster order, texel (8,0) would come from block 0's third
		// sub-block and read white instead of red.
		const data = concat(solid(WHITE565), solid(RED565));
		expect(data.length).toBe(gxImageSize(GxTextureFormat.CMPR, 16, 8));
		const out = decodeGxTexture(data, 0, 16, 8, GxTextureFormat.CMPR)!;
		expect(px(out, 16, 0, 0)).toEqual(OPAQUE_WHITE);
		expect(px(out, 16, 7, 7)).toEqual(OPAQUE_WHITE);
		expect(px(out, 16, 8, 0)).toEqual(OPAQUE_RED);
		expect(px(out, 16, 15, 7)).toEqual(OPAQUE_RED);
	});

	it('crops a padded block for non-aligned sizes', () => {
		const data = concat(
			dxt1SubBlock(RED565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(GREEN565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(BLUE565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(WHITE565, BLACK565, [0, 0, 0, 0]),
		);
		const out = decodeGxTexture(data, 0, 5, 5, GxTextureFormat.CMPR)!;
		expect(out.length).toBe(5 * 5 * 4);
		expect(px(out, 5, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(out, 5, 4, 0)).toEqual(OPAQUE_GREEN);
		expect(px(out, 5, 0, 4)).toEqual(OPAQUE_BLUE);
		expect(px(out, 5, 4, 4)).toEqual(OPAQUE_WHITE);
	});
});

describe('paletted formats', () => {
	/** 16-entry IA8 palette: entry j = alpha j*0x11, intensity j*0x10. */
	const ia8Palette = (() => {
		const out = new Uint8Array(16 * 2);
		for (let j = 0; j < 16; j++) {
			out[j * 2] = j * 0x11;
			out[j * 2 + 1] = j * 0x10;
		}
		return out;
	})();

	/** 16-entry RGB565 palette with recognisable primaries up front. */
	const rgb565Palette = (() => {
		const values = [RED565, GREEN565, BLUE565, WHITE565];
		const out = new Uint8Array(16 * 2);
		for (let j = 0; j < 16; j++) {
			const v = values[j % values.length];
			out[j * 2] = (v >> 8) & 0xff;
			out[j * 2 + 1] = v & 0xff;
		}
		return out;
	})();

	/** 16-entry RGB5A3 palette exercising both branches. */
	const rgb5a3Palette = (() => {
		const values = [
			rgb555Opaque(31, 0, 0), // 0: opaque red
			rgb4443(0, 15, 15, 15), // 1: transparent white
			rgb4443(4, 0, 15, 0), // 2: half-alpha green
			0xffff, // 3: opaque white
		];
		const out = new Uint8Array(16 * 2);
		for (let j = 0; j < 16; j++) {
			const v = values[j % values.length];
			out[j * 2] = (v >> 8) & 0xff;
			out[j * 2 + 1] = v & 0xff;
		}
		return out;
	})();

	/**
	 * 8x8 C4 block whose first two bytes select palette indices
	 * 0, 1, 15, 2 for the first four texels.
	 */
	const c4Data = (() => {
		const out = new Uint8Array(32);
		out[0] = 0x01;
		out[1] = 0xf2;
		return out;
	})();

	it('C4 + IA8 palette', () => {
		const out = decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
			data: ia8Palette,
			offset: 0,
			format: GxPaletteFormat.IA8,
			count: 16,
		})!;
		expect(px(out, 8, 0, 0)).toEqual([0x00, 0x00, 0x00, 0x00]);
		expect(px(out, 8, 1, 0)).toEqual([0x10, 0x10, 0x10, 0x11]);
		expect(px(out, 8, 2, 0)).toEqual([0xf0, 0xf0, 0xf0, 0xff]);
		expect(px(out, 8, 3, 0)).toEqual([0x20, 0x20, 0x20, 0x22]);
	});

	it('C4 + RGB565 palette', () => {
		const out = decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
			data: rgb565Palette,
			offset: 0,
			format: GxPaletteFormat.RGB565,
			count: 16,
		})!;
		expect(px(out, 8, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(out, 8, 1, 0)).toEqual(OPAQUE_GREEN);
		expect(px(out, 8, 2, 0)).toEqual(OPAQUE_WHITE); // index 15 → 15%4 = 3
		expect(px(out, 8, 3, 0)).toEqual(OPAQUE_BLUE);
	});

	it('C4 + RGB5A3 palette', () => {
		const out = decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
			data: rgb5a3Palette,
			offset: 0,
			format: GxPaletteFormat.RGB5A3,
			count: 16,
		})!;
		expect(px(out, 8, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(out, 8, 1, 0)).toEqual([255, 255, 255, 0]);
		expect(px(out, 8, 2, 0)).toEqual(OPAQUE_WHITE);
		expect(px(out, 8, 3, 0)).toEqual([0, 255, 0, 146]);
	});

	it('C8 looks up whole bytes and tiles in 8x4 blocks', () => {
		// 16x4 → two 8x4 blocks; block 1 starts at byte 32.
		const data = new Uint8Array(64);
		data[0] = 0;
		data[1] = 1;
		data[2] = 2;
		data[3] = 3;
		data[4] = 200; // deliberately past the end of the palette
		data[32] = 3; // first texel of block 1 → (8,0)
		const out = decodeGxTexture(data, 0, 16, 4, GxTextureFormat.C8, {
			data: rgb565Palette,
			offset: 0,
			format: GxPaletteFormat.RGB565,
			count: 4,
		})!;
		expect(px(out, 16, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(out, 16, 1, 0)).toEqual(OPAQUE_GREEN);
		expect(px(out, 16, 2, 0)).toEqual(OPAQUE_BLUE);
		expect(px(out, 16, 3, 0)).toEqual(OPAQUE_WHITE);
		// Out-of-range indices become transparent black rather than
		// reading past the palette.
		expect(px(out, 16, 4, 0)).toEqual(TRANSPARENT);
		expect(px(out, 16, 8, 0)).toEqual(OPAQUE_WHITE);
	});

	it('C14X2 masks off the top two padding bits', () => {
		const data = new Uint8Array(32);
		// 0xC001: the 0xC000 bits are the unused "X2" padding, so the
		// effective index is 1.
		data[0] = 0xc0;
		data[1] = 0x01;
		// 0x0002 → index 2.
		data[2] = 0x00;
		data[3] = 0x02;
		const out = decodeGxTexture(data, 0, 4, 4, GxTextureFormat.C14X2, {
			data: rgb565Palette,
			offset: 0,
			format: GxPaletteFormat.RGB565,
			count: 4,
		})!;
		expect(px(out, 4, 0, 0)).toEqual(OPAQUE_GREEN);
		expect(px(out, 4, 1, 0)).toEqual(OPAQUE_BLUE);
	});

	it('honours a non-zero palette offset', () => {
		const padded = concat(new Uint8Array(7).fill(0xee), rgb565Palette);
		const out = decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
			data: padded,
			offset: 7,
			format: GxPaletteFormat.RGB565,
			count: 16,
		})!;
		expect(px(out, 8, 0, 0)).toEqual(OPAQUE_RED);
	});

	it('rejects missing, empty, overrunning or unknown palettes', () => {
		const good = {
			data: rgb565Palette,
			offset: 0,
			format: GxPaletteFormat.RGB565,
			count: 16,
		};
		// No palette at all.
		expect(
			decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4),
		).toBeNull();
		// Zero entries.
		expect(
			decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
				...good,
				count: 0,
			}),
		).toBeNull();
		// More entries than the buffer holds (16 entries = 32 bytes).
		expect(
			decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
				...good,
				count: 17,
			}),
		).toBeNull();
		// Offset pushes the entries past the end.
		expect(
			decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
				...good,
				offset: 2,
			}),
		).toBeNull();
		// Unknown palette format.
		expect(
			decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
				...good,
				format: 3,
			}),
		).toBeNull();
		// Negative offset.
		expect(
			decodeGxTexture(c4Data, 0, 8, 8, GxTextureFormat.C4, {
				...good,
				offset: -1,
			}),
		).toBeNull();
	});
});

describe('decodeGxTexture guards', () => {
	it('returns null for unsupported formats', () => {
		const data = new Uint8Array(1024);
		expect(decodeGxTexture(data, 0, 8, 8, 0x07)).toBeNull();
		expect(decodeGxTexture(data, 0, 8, 8, 0x0b)).toBeNull();
		expect(decodeGxTexture(data, 0, 8, 8, 0x0f)).toBeNull();
		expect(decodeGxTexture(data, 0, 8, 8, 0xff)).toBeNull();
	});

	it('returns null when the image data is truncated', () => {
		// 16x8 I4 needs 64 bytes.
		expect(gxImageSize(GxTextureFormat.I4, 16, 8)).toBe(64);
		expect(
			decodeGxTexture(new Uint8Array(64), 0, 16, 8, GxTextureFormat.I4),
		).not.toBeNull();
		expect(
			decodeGxTexture(new Uint8Array(63), 0, 16, 8, GxTextureFormat.I4),
		).toBeNull();
		// Enough total bytes, but not enough *after* the offset.
		expect(
			decodeGxTexture(new Uint8Array(64), 1, 16, 8, GxTextureFormat.I4),
		).toBeNull();
		expect(
			decodeGxTexture(new Uint8Array(0), 0, 8, 8, GxTextureFormat.CMPR),
		).toBeNull();
	});

	it('returns null for degenerate dimensions and offsets', () => {
		const data = new Uint8Array(1024);
		expect(decodeGxTexture(data, 0, 0, 8, GxTextureFormat.I4)).toBeNull();
		expect(decodeGxTexture(data, 0, 8, 0, GxTextureFormat.I4)).toBeNull();
		expect(decodeGxTexture(data, 0, -8, 8, GxTextureFormat.I4)).toBeNull();
		expect(decodeGxTexture(data, 0, 8.5, 8, GxTextureFormat.I4)).toBeNull();
		expect(decodeGxTexture(data, -1, 8, 8, GxTextureFormat.I4)).toBeNull();
	});

	it('decodes at a non-zero offset and from a subarray view', () => {
		const image = be16Repeat(RED565, 16);
		const padded = concat(new Uint8Array(5).fill(0x77), image);
		const out = decodeGxTexture(
			padded,
			5,
			4,
			4,
			GxTextureFormat.RGB565,
		)!;
		expect(px(out, 4, 0, 0)).toEqual(OPAQUE_RED);

		// The same bytes seen through a `subarray` (non-zero byteOffset).
		const view = padded.subarray(5);
		const out2 = decodeGxTexture(view, 0, 4, 4, GxTextureFormat.RGB565)!;
		expect(out2).toEqual(out);
	});

	it('always returns a tightly-packed top-down buffer', () => {
		const out = decodeGxTexture(
			new Uint8Array(gxImageSize(GxTextureFormat.CMPR, 13, 7)),
			0,
			13,
			7,
			GxTextureFormat.CMPR,
		)!;
		expect(out.length).toBe(13 * 7 * 4);
	});
});
