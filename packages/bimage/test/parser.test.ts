import { describe, expect, it } from 'vitest';

import {
	BIMAGE_MAGIC,
	BimageColorFormat,
	BimageFormat,
	BimageTextureType,
	isBimage,
	parseBimage,
} from '../src/index.js';

/**
 * Build a synthetic .bimage in-memory. Mirrors the BFG writer's
 * layout exactly so we can round-trip parse it.
 */
function buildBimage(opts: {
	width: number;
	height: number;
	format: BimageFormat;
	colorFormat?: BimageColorFormat;
	textureType?: BimageTextureType;
	mips: Array<{ width: number; height: number; data: Uint8Array; destZ?: number }>;
	sourceFileTime?: bigint;
}): Blob {
	const textureType = opts.textureType ?? BimageTextureType.Texture2D;
	const colorFormat = opts.colorFormat ?? BimageColorFormat.Default;
	const sourceFileTime = opts.sourceFileTime ?? 0n;
	// numLevels = mips per face (cube => 6 faces).
	const facesPerLevel = textureType === BimageTextureType.Cubic ? 6 : 1;
	const numLevels = opts.mips.length / facesPerLevel;

	const HEADER = 36;
	const MIP_HDR = 20;
	let total = HEADER;
	for (const m of opts.mips) total += MIP_HDR + m.data.length;

	const buf = new Uint8Array(total);
	const view = new DataView(buf.buffer);

	view.setBigUint64(0, sourceFileTime, false);
	view.setUint32(8, BIMAGE_MAGIC, false);
	view.setInt32(12, textureType, false);
	view.setInt32(16, opts.format, false);
	view.setInt32(20, colorFormat, false);
	view.setInt32(24, opts.width, false);
	view.setInt32(28, opts.height, false);
	view.setInt32(32, numLevels, false);

	let p = HEADER;
	for (let i = 0; i < opts.mips.length; i++) {
		const m = opts.mips[i];
		view.setInt32(p, i % numLevels, false);
		view.setInt32(p + 4, m.destZ ?? 0, false);
		view.setInt32(p + 8, m.width, false);
		view.setInt32(p + 12, m.height, false);
		view.setInt32(p + 16, m.data.length, false);
		buf.set(m.data, p + MIP_HDR);
		p += MIP_HDR + m.data.length;
	}
	return new Blob([buf]);
}

describe('isBimage', () => {
	it('returns true for a valid header magic at offset 8', async () => {
		const buf = new Uint8Array(16);
		new DataView(buf.buffer).setUint32(8, BIMAGE_MAGIC, false);
		expect(await isBimage(new Blob([buf]))).toBe(true);
	});
	it('returns false for non-matching bytes', async () => {
		expect(await isBimage(new Blob([new Uint8Array(16)]))).toBe(false);
	});
});

describe('parseBimage', () => {
	it('parses a single-mip 2D RGBA texture', async () => {
		const pixels = new Uint8Array(4 * 4 * 4); // 4x4 RGBA8
		pixels.fill(0x80);
		const arc = buildBimage({
			width: 4,
			height: 4,
			format: BimageFormat.RGBA8,
			mips: [{ width: 4, height: 4, data: pixels }],
		});
		const parsed = await parseBimage(arc);
		expect(parsed.width).toBe(4);
		expect(parsed.height).toBe(4);
		expect(parsed.format).toBe(BimageFormat.RGBA8);
		expect(parsed.numLevels).toBe(1);
		expect(parsed.mips).toHaveLength(1);
		const mipBytes = new Uint8Array(await parsed.mips[0].data.arrayBuffer());
		expect(mipBytes).toEqual(pixels);
	});

	it('parses a multi-mip texture with DXT1 + GreenAlpha colorFormat', async () => {
		const arc = buildBimage({
			width: 16,
			height: 16,
			format: BimageFormat.DXT1,
			colorFormat: BimageColorFormat.GreenAlpha,
			mips: [
				{ width: 16, height: 16, data: new Uint8Array(16 * 16 / 2).fill(0x42) },
				{ width: 8, height: 8, data: new Uint8Array(8 * 8 / 2).fill(0x43) },
				{ width: 4, height: 4, data: new Uint8Array(4 * 4 / 2).fill(0x44) },
			],
		});
		const parsed = await parseBimage(arc);
		expect(parsed.format).toBe(BimageFormat.DXT1);
		expect(parsed.colorFormat).toBe(BimageColorFormat.GreenAlpha);
		expect(parsed.numLevels).toBe(3);
		expect(parsed.mips).toHaveLength(3);
		expect(parsed.mips[0].width).toBe(16);
		expect(parsed.mips[2].width).toBe(4);
	});

	it('parses a cube map (6 faces × N levels)', async () => {
		const mips = [];
		for (let face = 0; face < 6; face++) {
			mips.push({ width: 4, height: 4, data: new Uint8Array(64).fill(face), destZ: face });
		}
		const arc = buildBimage({
			width: 4,
			height: 4,
			format: BimageFormat.RGBA8,
			textureType: BimageTextureType.Cubic,
			mips,
		});
		const parsed = await parseBimage(arc);
		expect(parsed.textureType).toBe(BimageTextureType.Cubic);
		expect(parsed.numLevels).toBe(1);
		expect(parsed.mips).toHaveLength(6);
		for (let face = 0; face < 6; face++) {
			expect(parsed.mips[face].destZ).toBe(face);
		}
	});

	it('rejects a bad magic', async () => {
		const buf = new Uint8Array(36);
		await expect(parseBimage(new Blob([buf]))).rejects.toThrow(/magic/i);
	});

	it('rejects a too-small blob', async () => {
		await expect(parseBimage(new Blob([new Uint8Array(10)]))).rejects.toThrow(
			/too small/i,
		);
	});

	it('preserves the build-time timestamp', async () => {
		const ts = 1234567890n;
		const arc = buildBimage({
			width: 2,
			height: 2,
			format: BimageFormat.RGBA8,
			mips: [{ width: 2, height: 2, data: new Uint8Array(16) }],
			sourceFileTime: ts,
		});
		const parsed = await parseBimage(arc);
		expect(parsed.sourceFileTime).toBe(ts);
	});
});
