import { describe, expect, it } from 'vitest';
import {
	BTI_HEADER_SIZE,
	BtiAlphaMode,
	BtiWrapMode,
	GxPaletteFormat,
	GxTextureFormat,
	decodeBti,
	isBti,
	parseBtiHeader,
} from '../src/index.js';
import {
	be16Repeat,
	concat,
	dxt1SubBlock,
	makeBti,
	px,
	rgb565,
} from './fixtures.js';

const RED565 = rgb565(255, 0, 0);
const GREEN565 = rgb565(0, 255, 0);
const BLUE565 = rgb565(0, 0, 255);
const WHITE565 = 0xffff;
const BLACK565 = 0x0000;

const OPAQUE_RED = [255, 0, 0, 255];
const OPAQUE_GREEN = [0, 255, 0, 255];
const OPAQUE_BLUE = [0, 0, 255, 255];
const OPAQUE_WHITE = [255, 255, 255, 255];

/** An 8x8 RGB565 image: red, green, blue, white quadrants. */
const QUADRANTS_8X8 = concat(
	be16Repeat(RED565, 16),
	be16Repeat(GREEN565, 16),
	be16Repeat(BLUE565, 16),
	be16Repeat(WHITE565, 16),
);

/** A valid, minimal BTI wrapping {@link QUADRANTS_8X8}. */
function validBti(): Uint8Array {
	return makeBti({
		format: GxTextureFormat.RGB565,
		width: 8,
		height: 8,
		data: QUADRANTS_8X8,
		wrapS: BtiWrapMode.REPEAT,
		wrapT: BtiWrapMode.MIRROR,
	});
}

describe('parseBtiHeader', () => {
	it('reads every exposed field big-endian', () => {
		const bti = validBti();
		expect(bti.length).toBe(BTI_HEADER_SIZE + 128);

		const header = parseBtiHeader(bti)!;
		expect(header).not.toBeNull();
		expect(header.format).toBe(GxTextureFormat.RGB565);
		expect(header.formatName).toBe('RGB565');
		expect(header.width).toBe(8);
		expect(header.height).toBe(8);
		expect(header.wrapS).toBe(BtiWrapMode.REPEAT);
		expect(header.wrapT).toBe(BtiWrapMode.MIRROR);
		expect(header.paletteFormat).toBe(0);
		expect(header.paletteCount).toBe(0);
		expect(header.paletteOffset).toBe(0);
		expect(header.mipmapCount).toBe(1);
		expect(header.dataOffset).toBe(BTI_HEADER_SIZE);
	});

	it('reads 16-bit dimensions above one byte', () => {
		// 0x0100 = 256: a little-endian misread would give 1.
		const bti = makeBti({
			format: GxTextureFormat.CMPR,
			width: 256,
			height: 512,
			data: new Uint8Array(256 * 512 / 2),
		});
		const header = parseBtiHeader(bti)!;
		expect(header.width).toBe(256);
		expect(header.height).toBe(512);
	});

	it('reports the palette fields of a paletted texture', () => {
		const palette = be16Repeat(RED565, 4);
		const bti = makeBti({
			format: GxTextureFormat.C8,
			width: 8,
			height: 4,
			data: new Uint8Array(32),
			paletteFormat: GxPaletteFormat.RGB565,
			palette,
		});
		const header = parseBtiHeader(bti)!;
		expect(header.paletteFormat).toBe(GxPaletteFormat.RGB565);
		expect(header.paletteCount).toBe(4);
		expect(header.paletteOffset).toBe(BTI_HEADER_SIZE);
		expect(header.dataOffset).toBe(BTI_HEADER_SIZE + palette.length);
	});

	it('parses at a non-zero offset, since the offsets are self-relative', () => {
		const embedded = concat(new Uint8Array(0x10).fill(0xcd), validBti());
		const header = parseBtiHeader(embedded, 0x10)!;
		expect(header.width).toBe(8);
		expect(header.dataOffset).toBe(BTI_HEADER_SIZE);
	});

	it('returns null when the header is short or the offset is bad', () => {
		expect(parseBtiHeader(new Uint8Array(BTI_HEADER_SIZE - 1))).toBeNull();
		expect(parseBtiHeader(new Uint8Array(0))).toBeNull();
		expect(parseBtiHeader(validBti(), 1000)).toBeNull();
		expect(parseBtiHeader(validBti(), -1)).toBeNull();
	});

	it('names unknown formats instead of failing', () => {
		const bti = validBti();
		bti[0x00] = 0x07;
		const header = parseBtiHeader(bti)!;
		expect(header.format).toBe(0x07);
		expect(header.formatName).toBe('Unknown(0x07)');
	});
});

describe('isBti', () => {
	it('accepts a well-formed header', () => {
		expect(isBti(validBti())).toBe(true);
	});

	it('accepts a paletted header with its palette in range', () => {
		const bti = makeBti({
			format: GxTextureFormat.C4,
			width: 8,
			height: 8,
			data: new Uint8Array(32),
			paletteFormat: GxPaletteFormat.RGB5A3,
			palette: be16Repeat(0xffff, 16),
		});
		expect(isBti(bti)).toBe(true);
	});

	it('accepts a header found at a non-zero offset', () => {
		const embedded = concat(new Uint8Array(0x40).fill(0xcd), validBti());
		expect(isBti(embedded, 0x40)).toBe(true);
		// The junk prefix itself must not look like a BTI.
		expect(isBti(embedded, 0)).toBe(false);
	});

	it('rejects buffers that are too small for a header', () => {
		expect(isBti(new Uint8Array(BTI_HEADER_SIZE - 1))).toBe(false);
		expect(isBti(new Uint8Array(0))).toBe(false);
		expect(isBti(validBti(), validBti().length - 4)).toBe(false);
	});

	it('rejects bad offsets', () => {
		expect(isBti(validBti(), -1)).toBe(false);
		expect(isBti(validBti(), 1.5)).toBe(false);
	});

	/** Poke a single byte in an otherwise-valid BTI. */
	const poke = (index: number, value: number) => {
		const bti = validBti();
		bti[index] = value;
		return bti;
	};

	/** Poke a big-endian u32 in an otherwise-valid BTI. */
	const pokeU32 = (index: number, value: number) => {
		const bti = validBti();
		new DataView(bti.buffer).setUint32(index, value, false);
		return bti;
	};

	it('rejects formats outside the GX enumeration', () => {
		expect(isBti(poke(0x00, 0x07))).toBe(false);
		expect(isBti(poke(0x00, 0x0b))).toBe(false);
		expect(isBti(poke(0x00, 0x0f))).toBe(false);
		expect(isBti(poke(0x00, 0xff))).toBe(false);
	});

	it('rejects a non-boolean paletteEnabled', () => {
		expect(isBti(poke(0x08, 2))).toBe(false);
	});

	it('accepts every documented alphaMode, including "special"', () => {
		// This byte is an enum, not a boolean. 1205 of the 1810 BTI files in
		// Wind Waker's archives store 2, so rejecting it here would make the
		// sniffer useless on real data.
		expect(isBti(poke(0x01, BtiAlphaMode.OPAQUE))).toBe(true);
		expect(isBti(poke(0x01, BtiAlphaMode.ALPHA))).toBe(true);
		expect(isBti(poke(0x01, BtiAlphaMode.SPECIAL))).toBe(true);
		// Still bounded: 3 and up is not a value the format defines.
		expect(isBti(poke(0x01, 3))).toBe(false);
		expect(isBti(poke(0x01, 0xff))).toBe(false);
	});

	it('surfaces alphaMode on the parsed header', () => {
		const h = parseBtiHeader(poke(0x01, BtiAlphaMode.SPECIAL));
		expect(h?.alphaMode).toBe(BtiAlphaMode.SPECIAL);
	});

	it('rejects zero or absurd dimensions', () => {
		const zeroWidth = validBti();
		new DataView(zeroWidth.buffer).setUint16(0x02, 0, false);
		expect(isBti(zeroWidth)).toBe(false);

		const zeroHeight = validBti();
		new DataView(zeroHeight.buffer).setUint16(0x04, 0, false);
		expect(isBti(zeroHeight)).toBe(false);

		const hugeWidth = validBti();
		new DataView(hugeWidth.buffer).setUint16(0x02, 8192, false);
		expect(isBti(hugeWidth)).toBe(false);

		const hugeHeight = validBti();
		new DataView(hugeHeight.buffer).setUint16(0x04, 0xffff, false);
		expect(isBti(hugeHeight)).toBe(false);
	});

	it('rejects out-of-range wrap and palette-format enums', () => {
		expect(isBti(poke(0x06, 3))).toBe(false); // wrapS
		expect(isBti(poke(0x07, 0xff))).toBe(false); // wrapT
		expect(isBti(poke(0x09, 3))).toBe(false); // paletteFormat
	});

	it('rejects a zero mipmap count', () => {
		// Even a texture with no mips reports 1 level.
		expect(isBti(poke(0x18, 0))).toBe(false);
	});

	it('rejects data offsets that overlap the header or leave the buffer', () => {
		expect(isBti(pokeU32(0x1c, 0))).toBe(false);
		expect(isBti(pokeU32(0x1c, BTI_HEADER_SIZE - 1))).toBe(false);
		expect(isBti(pokeU32(0x1c, 0x10000))).toBe(false);
		expect(isBti(pokeU32(0x1c, 0xffffffff))).toBe(false);
		// Exactly at the end of the buffer is still out of range.
		expect(isBti(pokeU32(0x1c, validBti().length))).toBe(false);
	});

	it('rejects palette offsets that overlap the header or leave the buffer', () => {
		const base = () =>
			makeBti({
				format: GxTextureFormat.C8,
				width: 8,
				height: 4,
				data: new Uint8Array(32),
				paletteFormat: GxPaletteFormat.RGB565,
				palette: be16Repeat(RED565, 4),
			});
		expect(isBti(base())).toBe(true);

		const lowOffset = base();
		new DataView(lowOffset.buffer).setUint32(0x0c, 0x04, false);
		expect(isBti(lowOffset)).toBe(false);

		const highOffset = base();
		new DataView(highOffset.buffer).setUint32(0x0c, 0x10000, false);
		expect(isBti(highOffset)).toBe(false);

		// paletteEnabled set but zero entries is self-contradictory.
		const noEntries = base();
		new DataView(noEntries.buffer).setUint16(0x0a, 0, false);
		expect(isBti(noEntries)).toBe(false);
	});

	it('rejects a paletted format with no palette', () => {
		const bti = makeBti({
			format: GxTextureFormat.C4,
			width: 8,
			height: 8,
			data: new Uint8Array(32),
		});
		expect(isBti(bti)).toBe(false);
	});

	it('rejects unrelated file headers', () => {
		// All zeros: format 0x00 (I4) is valid but the dimensions are not.
		expect(isBti(new Uint8Array(256))).toBe(false);
		// All 0xFF: format 0xFF is not a GX format.
		expect(isBti(new Uint8Array(256).fill(0xff))).toBe(false);
		// A Yaz0 header: 'Y' = 0x59 is not a GX format.
		const yaz0 = new Uint8Array(256);
		yaz0.set([0x59, 0x61, 0x7a, 0x30], 0);
		expect(isBti(yaz0)).toBe(false);
		// A SARC header: 'S' = 0x53 is not a GX format either.
		const sarc = new Uint8Array(256);
		sarc.set([0x53, 0x41, 0x52, 0x43], 0);
		expect(isBti(sarc)).toBe(false);
	});
});

describe('decodeBti', () => {
	it('decodes an RGB565 texture through the container', () => {
		const decoded = decodeBti(validBti())!;
		expect(decoded).not.toBeNull();
		expect(decoded.width).toBe(8);
		expect(decoded.height).toBe(8);
		expect(decoded.pixels.length).toBe(8 * 8 * 4);
		expect(px(decoded.pixels, 8, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(decoded.pixels, 8, 4, 0)).toEqual(OPAQUE_GREEN);
		expect(px(decoded.pixels, 8, 0, 4)).toEqual(OPAQUE_BLUE);
		expect(px(decoded.pixels, 8, 4, 4)).toEqual(OPAQUE_WHITE);
		// Tiling, again, through the full container path.
		expect(px(decoded.pixels, 8, 5, 1)).toEqual(OPAQUE_GREEN);
	});

	it('honours a dataOffset that is larger than the header', () => {
		// Some tools align the payload; 0x40 is common.
		const bti = makeBti({
			format: GxTextureFormat.RGB565,
			width: 8,
			height: 8,
			data: QUADRANTS_8X8,
			leadingPadding: 0x20,
		});
		expect(parseBtiHeader(bti)!.dataOffset).toBe(0x40);
		const decoded = decodeBti(bti)!;
		expect(px(decoded.pixels, 8, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(decoded.pixels, 8, 4, 4)).toEqual(OPAQUE_WHITE);
	});

	it('decodes a paletted texture, resolving the palette offset', () => {
		// 8x4 C8: indices 0..3 across the top row.
		const data = new Uint8Array(32);
		data[0] = 0;
		data[1] = 1;
		data[2] = 2;
		data[3] = 3;
		const bti = makeBti({
			format: GxTextureFormat.C8,
			width: 8,
			height: 4,
			data,
			paletteFormat: GxPaletteFormat.RGB565,
			palette: concat(
				be16Repeat(RED565, 1),
				be16Repeat(GREEN565, 1),
				be16Repeat(BLUE565, 1),
				be16Repeat(WHITE565, 1),
			),
		});
		const decoded = decodeBti(bti)!;
		expect(decoded.width).toBe(8);
		expect(decoded.height).toBe(4);
		expect(px(decoded.pixels, 8, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(decoded.pixels, 8, 1, 0)).toEqual(OPAQUE_GREEN);
		expect(px(decoded.pixels, 8, 2, 0)).toEqual(OPAQUE_BLUE);
		expect(px(decoded.pixels, 8, 3, 0)).toEqual(OPAQUE_WHITE);
	});

	it('decodes a CMPR texture and ignores extra mip levels', () => {
		const level0 = concat(
			dxt1SubBlock(RED565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(GREEN565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(BLUE565, BLACK565, [0, 0, 0, 0]),
			dxt1SubBlock(WHITE565, BLACK565, [0, 0, 0, 0]),
		);
		// A 4x4 mip level 1 still costs a whole 32-byte block.
		const level1 = dxt1SubBlock(WHITE565, BLACK565, [0, 0, 0, 0]);
		const bti = makeBti({
			format: GxTextureFormat.CMPR,
			width: 8,
			height: 8,
			data: concat(level0, new Uint8Array(24), level1, new Uint8Array(24)),
			mipmapCount: 2,
			alphaEnabled: 1,
		});
		expect(parseBtiHeader(bti)!.mipmapCount).toBe(2);
		const decoded = decodeBti(bti)!;
		expect(decoded.width).toBe(8);
		expect(decoded.height).toBe(8);
		expect(px(decoded.pixels, 8, 0, 0)).toEqual(OPAQUE_RED);
		expect(px(decoded.pixels, 8, 4, 0)).toEqual(OPAQUE_GREEN);
		expect(px(decoded.pixels, 8, 0, 4)).toEqual(OPAQUE_BLUE);
		expect(px(decoded.pixels, 8, 4, 4)).toEqual(OPAQUE_WHITE);
	});

	it('decodes an embedded BTI at a non-zero offset', () => {
		const embedded = concat(new Uint8Array(0x30).fill(0xcd), validBti());
		const decoded = decodeBti(embedded, 0x30)!;
		expect(px(decoded.pixels, 8, 0, 0)).toEqual(OPAQUE_RED);
		// Reading from offset 0 must not succeed by accident.
		expect(decodeBti(embedded, 0)).toBeNull();
	});

	it('decodes through a subarray view', () => {
		const embedded = concat(new Uint8Array(0x30).fill(0xcd), validBti());
		const decoded = decodeBti(embedded.subarray(0x30))!;
		expect(decoded.width).toBe(8);
		expect(px(decoded.pixels, 8, 4, 4)).toEqual(OPAQUE_WHITE);
	});

	it('returns null for a truncated payload', () => {
		const bti = validBti();
		expect(decodeBti(bti.subarray(0, bti.length - 1))).toBeNull();
		expect(decodeBti(bti.subarray(0, BTI_HEADER_SIZE))).toBeNull();
		expect(decodeBti(new Uint8Array(BTI_HEADER_SIZE - 1))).toBeNull();
	});

	it('returns null for an unsupported format', () => {
		const bti = validBti();
		bti[0x00] = 0x07;
		expect(decodeBti(bti)).toBeNull();
	});

	it('returns null for zero dimensions', () => {
		const bti = validBti();
		new DataView(bti.buffer).setUint16(0x02, 0, false);
		expect(decodeBti(bti)).toBeNull();
	});

	it('returns null for a paletted texture with no palette', () => {
		const bti = makeBti({
			format: GxTextureFormat.C8,
			width: 8,
			height: 4,
			data: new Uint8Array(32),
		});
		expect(decodeBti(bti)).toBeNull();
	});

	it('returns null when the palette runs past the end of the buffer', () => {
		const bti = makeBti({
			format: GxTextureFormat.C8,
			width: 8,
			height: 4,
			data: new Uint8Array(32),
			paletteFormat: GxPaletteFormat.RGB565,
			palette: be16Repeat(RED565, 4),
		});
		// Claim 4096 entries where only 4 exist.
		new DataView(bti.buffer).setUint16(0x0a, 4096, false);
		expect(decodeBti(bti)).toBeNull();
	});
});
