import { describe, it, expect } from 'vitest';
import {
	detectMimType,
	mimLayoutFor,
	parseMap,
	composite,
	detectTileRecordSize,
	MIM_OLD_SIZE,
	MIM_NEW_SIZE,
	Ff8FieldParseError,
} from '../src/index.js';

describe('detectMimType', () => {
	it('recognises the old size', () => {
		expect(detectMimType(MIM_OLD_SIZE)).toBe('old');
	});
	it('recognises the new size', () => {
		expect(detectMimType(MIM_NEW_SIZE)).toBe('new');
	});
	it('rejects unknown sizes', () => {
		expect(() => detectMimType(123)).toThrow(Ff8FieldParseError);
	});
});

describe('mimLayoutFor', () => {
	it('old: 16 palettes × 256 colors + 1536-wide image', () => {
		const layout = mimLayoutFor('old');
		expect(layout.numPalettes).toBe(16);
		expect(layout.paletteBase).toBe(0);
		expect(layout.paletteBytes).toBe(0x2000);
		expect(layout.imageStride).toBe(1536);
		expect(layout.numTexturePages).toBe(12);
	});
	it('new: 24 palettes (effective 16 starting at index 8) + 1664-wide image', () => {
		const layout = mimLayoutFor('new');
		expect(layout.numPalettes).toBe(24);
		expect(layout.paletteBase).toBe(8);
		expect(layout.paletteBytes).toBe(0x3000);
		expect(layout.imageStride).toBe(1664);
		expect(layout.numTexturePages).toBe(13);
	});
});

describe('detectTileRecordSize', () => {
	it('finds 16-byte stride when sentinel is 16 bytes before EOF', () => {
		const buf = new Uint8Array(32);
		// First record at offset 0; second (sentinel) at offset 16.
		buf[16] = 0xff;
		buf[17] = 0x7f;
		expect(detectTileRecordSize(buf)).toBe(16);
	});
	it('finds 14-byte stride when sentinel is 14 bytes before EOF', () => {
		const buf = new Uint8Array(28);
		buf[14] = 0xff;
		buf[15] = 0x7f;
		expect(detectTileRecordSize(buf)).toBe(14);
	});
	it('defaults to 16 when no sentinel is found', () => {
		expect(detectTileRecordSize(new Uint8Array(64))).toBe(16);
	});
});

describe('parseMap', () => {
	it('returns an empty list when the buffer starts with the sentinel', () => {
		const buf = new Uint8Array(16);
		buf[0] = 0xff;
		buf[1] = 0x7f;
		const parsed = parseMap(buf, 'old');
		expect(parsed.tiles).toHaveLength(0);
	});

	it('reads a single Tile1 record (16-byte, MIM old)', () => {
		const buf = new Uint8Array(32);
		const v = new DataView(buf.buffer);
		// Tile #0
		v.setInt16(0, 10, true); // dstX
		v.setInt16(2, 20, true); // dstY
		v.setUint16(4, 0x12, true); // srcXBig — low byte = srcX
		v.setUint16(6, 0x34, true); // srcYBig
		v.setUint16(8, 0x100, true); // z
		// texID: depth=1 (8bpp), draw=1, blend=4? blend max is 3 in 2 bits.
		// Set depth=1 → bits 7-8 = 01 → 0b0_1_xxxxx (low bits: page = 5)
		v.setUint16(10, (1 << 7) | (1 << 4) | 0x5, true);
		v.setUint16(12, 3 << 6, true); // paletteID = 3
		v.setUint8(14, 255); // parameter (always-on)
		v.setUint8(15, 0); // state
		// Tile #1 = sentinel
		v.setInt16(16, 0x7fff, true);
		const parsed = parseMap(buf, 'old');
		expect(parsed.tiles).toHaveLength(1);
		const t = parsed.tiles[0]!;
		expect(t.dstX).toBe(10);
		expect(t.dstY).toBe(20);
		expect(t.srcX).toBe(0x12);
		expect(t.srcY).toBe(0x34);
		expect(t.z).toBe(0x100);
		expect(t.depth).toBe(1);
		expect(t.draw).toBe(1);
		expect(t.texturePage).toBe(5);
		expect(t.paletteId).toBe(3);
		expect(t.parameter).toBe(255);
	});

	it('reads a Tile2 record (16-byte, MIM new)', () => {
		const buf = new Uint8Array(32);
		const v = new DataView(buf.buffer);
		v.setInt16(0, -8, true);
		v.setInt16(2, 4, true);
		v.setUint16(4, 0x100, true);
		v.setUint16(6, (1 << 7) | (1 << 4) | 3, true); // 8bpp, draw=1, page=3
		v.setUint16(8, 7 << 6, true);
		v.setUint8(10, 0x21); // srcX
		v.setUint8(11, 0x42); // srcY
		v.setUint8(12, 4); // layerID
		v.setUint8(13, 1); // blendType = additive
		v.setUint8(14, 0xff);
		v.setUint8(15, 0);
		v.setInt16(16, 0x7fff, true);
		const parsed = parseMap(buf, 'new');
		expect(parsed.tiles).toHaveLength(1);
		const t = parsed.tiles[0]!;
		expect(t.dstX).toBe(-8);
		expect(t.dstY).toBe(4);
		expect(t.srcX).toBe(0x21);
		expect(t.srcY).toBe(0x42);
		expect(t.layerID).toBe(4);
		expect(t.blendType).toBe(1);
	});
});

describe('composite', () => {
	it('returns an empty image when the map is just a sentinel', () => {
		const map = new Uint8Array(16);
		map[0] = 0xff;
		map[1] = 0x7f;
		const mim = new Uint8Array(MIM_OLD_SIZE);
		const r = composite(map, mim);
		expect(r.width).toBe(0);
		expect(r.height).toBe(0);
		expect(r.pixels).toHaveLength(0);
		expect(r.renderedTiles).toBe(0);
	});

	it('paints one solid-color 8bpp tile', () => {
		// Build a minimal MIM (old layout): palette 0 entry 1 = pure red.
		const mim = new Uint8Array(MIM_OLD_SIZE);
		const v = new DataView(mim.buffer);
		// RGB555: red = R=31, G=0, B=0 → 0x001F
		v.setUint16(0 + 1 * 2, 0x001f, true); // palette 0, color 1
		// Image data: byte 0 of first row of texture page 0 = 1
		const imageBase = mimLayoutFor('old').paletteBytes;
		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				mim[imageBase + y * 1536 + x] = 1;
			}
		}
		// Map: one tile at (0,0), srcX=srcY=0, page=0, palette=0, depth=1, draw=1.
		const map = new Uint8Array(32);
		const mv = new DataView(map.buffer);
		mv.setInt16(0, 0, true);
		mv.setInt16(2, 0, true);
		mv.setUint16(4, 0, true);
		mv.setUint16(6, 0, true);
		mv.setUint16(8, 0x100, true);
		mv.setUint16(10, (1 << 7) | (1 << 4) | 0, true);
		mv.setUint16(12, 0, true);
		mv.setUint8(14, 255);
		mv.setUint8(15, 0);
		mv.setInt16(16, 0x7fff, true);
		const r = composite(map, mim);
		expect(r.width).toBe(16);
		expect(r.height).toBe(16);
		// Top-left pixel should be red.
		expect(r.pixels[0]).toBe(255);
		expect(r.pixels[1]).toBe(0);
		expect(r.pixels[2]).toBe(0);
		expect(r.pixels[3]).toBe(255);
	});
});
