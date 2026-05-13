import { describe, expect, it } from 'vitest';
import {
	decodeBC1,
	decodeBC2,
	decodeBC3,
	decodeBC4,
	decodeBC5,
	decodeBcn,
} from '../src/index.js';

/**
 * Build a single BC1 block (8 bytes) from two RGB565 colors and 16
 * pixel indices (each a number 0..3). Returns the raw block bytes
 * we can feed straight to {@link decodeBC1}.
 */
function buildBC1Block(c0: number, c1: number, indices: number[]): Uint8Array {
	if (indices.length !== 16) throw new Error('need 16 indices');
	const out = new Uint8Array(8);
	out[0] = c0 & 0xff;
	out[1] = (c0 >> 8) & 0xff;
	out[2] = c1 & 0xff;
	out[3] = (c1 >> 8) & 0xff;
	let v = 0;
	for (let i = 0; i < 16; i++) {
		v |= (indices[i]! & 0x3) << (i * 2);
	}
	// JS bitwise on 32-bit signed; emit as little-endian u32.
	out[4] = v & 0xff;
	out[5] = (v >>> 8) & 0xff;
	out[6] = (v >>> 16) & 0xff;
	out[7] = (v >>> 24) & 0xff;
	return out;
}

function rgb565(r5: number, g6: number, b5: number): number {
	return ((r5 & 0x1f) << 11) | ((g6 & 0x3f) << 5) | (b5 & 0x1f);
}

const RED_565 = rgb565(31, 0, 0);
const BLUE_565 = rgb565(0, 0, 31);

describe('decodeBC1', () => {
	it('decodes a single solid-red block', () => {
		// c0 > c1 forces 4-color mode. We use the same color for both
		// endpoints so all 16 pixels are red regardless of indices.
		const block = buildBC1Block(RED_565, RED_565 - 1, Array(16).fill(0));
		const img = decodeBC1(block, 4, 4);
		expect(img.width).toBe(4);
		expect(img.height).toBe(4);
		expect(img.pixels.length).toBe(64);
		for (let i = 0; i < 16; i++) {
			expect(img.pixels[i * 4]).toBe(255);
			expect(img.pixels[i * 4 + 1]).toBe(0);
			expect(img.pixels[i * 4 + 2]).toBe(0);
			expect(img.pixels[i * 4 + 3]).toBe(255);
		}
	});

	it('decodes punch-through alpha (c0 <= c1, index 3 = transparent black)', () => {
		// c0 < c1 → 3-color block. Index 3 must decode to (0,0,0,0).
		const indices = Array(16).fill(0);
		indices[5] = 3;
		indices[10] = 3;
		const block = buildBC1Block(BLUE_565, RED_565, indices);
		const img = decodeBC1(block, 4, 4);
		// Index 0 = c0 = blue, opaque.
		expect(img.pixels[0]).toBe(0);
		expect(img.pixels[3]).toBe(255);
		// Pixel 5 = index 3 = transparent black.
		const i5 = 5 * 4;
		expect(img.pixels[i5]).toBe(0);
		expect(img.pixels[i5 + 1]).toBe(0);
		expect(img.pixels[i5 + 2]).toBe(0);
		expect(img.pixels[i5 + 3]).toBe(0);
	});

	it('extrapolates interpolated colors (index 2 = 2/3*c0 + 1/3*c1)', () => {
		// Red ↔ blue 4-color block. Index 2 = 2/3 red + 1/3 blue.
		const indices = [
			0, 1, 2, 3,
			0, 1, 2, 3,
			0, 1, 2, 3,
			0, 1, 2, 3,
		];
		const block = buildBC1Block(RED_565, BLUE_565, indices);
		const img = decodeBC1(block, 4, 4);
		// Pixel 2 (top row, third column): index 2.
		const i2 = 2 * 4;
		// Expected R: 2/3 * 255 ≈ 170. B: 1/3 * 255 ≈ 85.
		expect(img.pixels[i2]).toBeGreaterThan(160);
		expect(img.pixels[i2]).toBeLessThan(180);
		expect(img.pixels[i2 + 2]).toBeGreaterThan(75);
		expect(img.pixels[i2 + 2]).toBeLessThan(95);
	});

	it('errors when input is too short for the declared size', () => {
		expect(() => decodeBC1(new Uint8Array(0), 4, 4)).toThrow(/expected/);
	});

	it('crops a non-multiple-of-4 image', () => {
		const block = buildBC1Block(RED_565, RED_565 - 1, Array(16).fill(0));
		const img = decodeBC1(block, 3, 3);
		expect(img.width).toBe(3);
		expect(img.height).toBe(3);
		expect(img.pixels.length).toBe(36);
	});
});

describe('decodeBC2', () => {
	it('produces explicit 4-bit alpha overlaid on a BC1 color block', () => {
		// 16-byte block: first 8 bytes = alpha (4 bits per pixel),
		// last 8 = BC1 color (solid red).
		const alphaNibbles = [
			0, 1, 2, 3,
			4, 5, 6, 7,
			8, 9, 10, 11,
			12, 13, 14, 15,
		];
		const alphaBytes = new Uint8Array(8);
		for (let i = 0; i < 16; i += 2) {
			alphaBytes[i / 2] = (alphaNibbles[i + 1]! << 4) | alphaNibbles[i]!;
		}
		const colorBlock = buildBC1Block(RED_565, RED_565 - 1, Array(16).fill(0));
		const block = new Uint8Array(16);
		block.set(alphaBytes, 0);
		block.set(colorBlock, 8);
		const img = decodeBC2(block, 4, 4);
		// Each pixel's alpha should be the nibble × 17 (4→8 bit expand).
		for (let i = 0; i < 16; i++) {
			expect(img.pixels[i * 4 + 3]).toBe(alphaNibbles[i]! * 17);
		}
	});
});

describe('decodeBC4', () => {
	it('decodes 8-bit single-channel into greyscale RGBA', () => {
		// Solid mid-grey block: endpoints (128, 128).
		const block = new Uint8Array([128, 128, 0, 0, 0, 0, 0, 0]);
		const img = decodeBC4(block, 4, 4);
		for (let i = 0; i < 16; i++) {
			expect(img.pixels[i * 4]).toBe(128);
			expect(img.pixels[i * 4 + 1]).toBe(128);
			expect(img.pixels[i * 4 + 2]).toBe(128);
			expect(img.pixels[i * 4 + 3]).toBe(255);
		}
	});

	it('respects the 6-step+endpoints palette when a0 ≤ a1', () => {
		// a0=0, a1=255 → palette is [0, 255, 51, 102, 153, 204, 0, 255].
		// All indices = 6 should produce 0; index 7 = 255.
		// Index byte layout: 16 × 3-bit indices, little-endian.
		// Set every pixel to index 6 (==0).
		const indices = Array(16).fill(6);
		const bits = packIndices3(indices);
		const block = new Uint8Array([0, 255, ...bits]);
		const img = decodeBC4(block, 4, 4);
		for (let i = 0; i < 16; i++) {
			expect(img.pixels[i * 4]).toBe(0);
		}
	});
});

describe('decodeBC5', () => {
	it('writes R from the first BC4 block, G from the second', () => {
		// First BC4: solid R = 64. Second BC4: solid G = 192.
		const blockR = new Uint8Array([64, 64, 0, 0, 0, 0, 0, 0]);
		const blockG = new Uint8Array([192, 192, 0, 0, 0, 0, 0, 0]);
		const block = new Uint8Array(16);
		block.set(blockR, 0);
		block.set(blockG, 8);
		const img = decodeBC5(block, 4, 4);
		for (let i = 0; i < 16; i++) {
			expect(img.pixels[i * 4]).toBe(64);     // R
			expect(img.pixels[i * 4 + 1]).toBe(192); // G
			expect(img.pixels[i * 4 + 2]).toBe(0);   // B (unused)
			expect(img.pixels[i * 4 + 3]).toBe(255); // A
		}
	});
});

describe('decodeBC3', () => {
	it('combines BC4-style alpha with BC1 color', () => {
		// BC4 alpha endpoints: a0=200, a1=200 → all pixels get alpha=200.
		// BC1 color: solid red.
		const block = new Uint8Array(16);
		block[0] = 200;
		block[1] = 200;
		const colorBlock = buildBC1Block(RED_565, RED_565 - 1, Array(16).fill(0));
		block.set(colorBlock, 8);
		const img = decodeBC3(block, 4, 4);
		for (let i = 0; i < 16; i++) {
			expect(img.pixels[i * 4]).toBe(255);
			expect(img.pixels[i * 4 + 3]).toBe(200);
		}
	});
});

describe('decodeBcn dispatcher', () => {
	it('routes to the right decoder', () => {
		const block = buildBC1Block(RED_565, RED_565 - 1, Array(16).fill(0));
		const img = decodeBcn('BC1', block, 4, 4);
		expect(img.pixels[0]).toBe(255);
	});
	it('multi-block grids tile correctly', () => {
		// 8×4 image: two BC1 blocks side-by-side. Left = red, right = blue.
		const left = buildBC1Block(RED_565, RED_565 - 1, Array(16).fill(0));
		const right = buildBC1Block(BLUE_565, BLUE_565 - 1, Array(16).fill(0));
		const buf = new Uint8Array(16);
		buf.set(left, 0);
		buf.set(right, 8);
		const img = decodeBC1(buf, 8, 4);
		expect(img.width).toBe(8);
		expect(img.height).toBe(4);
		// Top-left pixel = red.
		expect(img.pixels[0]).toBe(255);
		expect(img.pixels[2]).toBe(0);
		// Top-right pixel (x=7, y=0) = blue.
		const i7 = (0 * 8 + 7) * 4;
		expect(img.pixels[i7]).toBe(0);
		expect(img.pixels[i7 + 2]).toBe(255);
	});
});

/**
 * Pack 16 × 3-bit indices into 6 bytes in little-endian bit order
 * (matches the BC4/BC5 spec).
 */
function packIndices3(indices: number[]): Uint8Array {
	let bits = 0n;
	for (let i = 0; i < 16; i++) {
		bits |= BigInt(indices[i]! & 0x7) << BigInt(i * 3);
	}
	const out = new Uint8Array(6);
	for (let i = 0; i < 6; i++) {
		out[i] = Number(bits & 0xffn);
		bits = bits >> 8n;
	}
	return out;
}
