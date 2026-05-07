import { describe, it, expect } from 'vitest';
import {
	BNTX_MAGIC,
	formatName,
	isBntx,
	parseBntx,
} from '../src/index.js';
import { formatInfo } from '../src/format.js';
import { decodeBC1, decodeBC4 } from '../src/decode-bc.js';
import { decodeRgba8, decodeR8 } from '../src/decode-uncompressed.js';

describe('isBntx', () => {
	it('detects the magic', async () => {
		const buf = new Uint8Array([0x42, 0x4e, 0x54, 0x58]);
		expect(await isBntx(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects unrelated blobs', async () => {
		expect(await isBntx(new Blob([new Uint8Array([0x42, 0x59, 0, 0])]))).toBe(false);
		expect(await isBntx(new Blob([]))).toBe(false);
	});
});

describe('formatInfo', () => {
	it('decodes BC1 SRGB', () => {
		const i = formatInfo(0x1a06);
		expect(i.name).toBe('BC1_SRGB');
		expect(i.family).toBe(0x1a);
		expect(i.dataType).toBe(0x06);
		expect(i.blkWidth).toBe(4);
		expect(i.blkHeight).toBe(4);
		expect(i.bytesPerBlock).toBe(8);
		expect(i.srgb).toBe(true);
		expect(i.isBcn).toBe(true);
		expect(i.isAstc).toBe(false);
	});
	it('decodes BC7 UNORM', () => {
		const i = formatInfo(0x2001);
		expect(i.name).toBe('BC7_UNORM');
		expect(i.bytesPerBlock).toBe(16);
		expect(i.srgb).toBe(false);
	});
	it('decodes RGBA8', () => {
		const i = formatInfo(0x0b01);
		expect(i.name).toBe('R8_G8_B8_A8_UNORM');
		expect(i.blkWidth).toBe(1);
		expect(i.blkHeight).toBe(1);
		expect(i.bytesPerBlock).toBe(4);
		expect(i.isBcn).toBe(false);
	});
	it('decodes ASTC 8x8', () => {
		const i = formatInfo(0x3401);
		expect(i.name).toBe('ASTC_8x8_UNORM');
		expect(i.blkWidth).toBe(8);
		expect(i.blkHeight).toBe(8);
		expect(i.isAstc).toBe(true);
	});
	it('falls back to a hex name for unknown codes', () => {
		expect(formatName(0x9999)).toBe('0x9999');
	});
	it('throws for unknown families', () => {
		expect(() => formatInfo(0x9999)).toThrow(/format family/);
	});
});

describe('decodeRgba8', () => {
	it('passes through 4×bpp bytes unchanged', () => {
		const src = new Uint8Array([
			255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 128, 128, 128, 200,
		]);
		const out = decodeRgba8(src, 2, 2);
		expect(Array.from(out)).toEqual(Array.from(src));
	});
});

describe('decodeR8', () => {
	it('expands single-channel to opaque grayscale', () => {
		const src = new Uint8Array([0, 64, 128, 255]);
		const out = decodeR8(src, 2, 2);
		expect(Array.from(out)).toEqual([
			0, 0, 0, 255,
			64, 64, 64, 255,
			128, 128, 128, 255,
			255, 255, 255, 255,
		]);
	});
});

describe('decodeBC1', () => {
	it('decodes a single all-red block', () => {
		// Block: c0 = 0xF800 (red 31, green 0, blue 0), c1 = 0x0000.
		// Indices: all 0 → all e0 = pure red.
		const block = new Uint8Array([
			0x00, 0xf8, // c0 = 0xF800 (LE)
			0x00, 0x00, // c1 = 0x0000
			0x00, 0x00, 0x00, 0x00, // 16 indices, all 0
		]);
		const out = decodeBC1(block, 4, 4);
		// Pixel 0: red.
		expect(out[0]).toBe(0xff);
		expect(out[1]).toBe(0);
		expect(out[2]).toBe(0);
		expect(out[3]).toBe(255);
	});
});

describe('decodeBC4', () => {
	it('decodes a single all-zero alpha block to transparent (alpha mode)', () => {
		const block = new Uint8Array(8); // all zeros
		const out = decodeBC4(block, 4, 4, { mode: 'alpha' });
		// All pixels: white RGB, alpha 0
		for (let i = 0; i < 16; i++) {
			expect(out[i * 4 + 0]).toBe(255);
			expect(out[i * 4 + 1]).toBe(255);
			expect(out[i * 4 + 2]).toBe(255);
			expect(out[i * 4 + 3]).toBe(0);
		}
	});
});

describe('parseBntx — error paths', () => {
	it('throws on non-BNTX magic', () => {
		const buf = new Uint8Array(0x40);
		buf.set([0x42, 0x42, 0x42, 0x42]);
		expect(() => parseBntx(buf)).toThrow(/missing magic/);
	});
	it('throws on too-small blob', () => {
		const buf = new Uint8Array(4);
		buf.set([0x42, 0x4e, 0x54, 0x58]);
		expect(() => parseBntx(buf)).toThrow(/missing magic|too small|/);
	});
});

describe('BNTX_MAGIC export', () => {
	it('matches the on-disk value', () => {
		expect(BNTX_MAGIC).toBe('BNTX');
	});
});
