import { describe, expect, it } from 'vitest';
import { decodeNvnTexture, isNvnTexture, parseNvnTexture } from '../src/index.js';

/** DFvN header + two HBvN blocks, data at 0x200: `layers` R8 layers of one value each. */
function build(width: number, height: number, layers: number[]): Uint8Array {
	const size = width * height;
	const b = new Uint8Array(0x200 + size * layers.length + 0x3c);
	const v = new DataView(b.buffer);
	b.set(new TextEncoder().encode('DFvN'));
	v.setUint32(4, 0x10, true);
	v.setUint32(8, 1, true);
	b.set(new TextEncoder().encode('HBvN'), 0x10);
	v.setUint32(0x14, 0x24, true);
	v.setUint32(0x18, 0x70, true);
	v.setUint32(0x3c, width, true);
	v.setUint32(0x40, height, true);
	v.setUint32(0x50, 0x01, true); // R8
	b.set(new TextEncoder().encode('HBvN'), 0xa4);
	v.setUint32(0xa4 + 0x10, 0x200 - 0xa4, true);
	layers.forEach((val, i) => b.fill(val, 0x200 + i * size, 0x200 + (i + 1) * size));
	return b;
}

describe('nvn texture', () => {
	it('parses the header and counts layers', () => {
		const b = build(64, 64, [10, 200]);
		expect(isNvnTexture(b)).toBe(true);
		expect(parseNvnTexture(b)).toEqual({
			width: 64,
			height: 64,
			format: 1,
			formatName: 'R8',
			dataOffset: 0x200,
			layerSize: 4096,
			layers: 2,
		});
	});

	it('decodes a layer to RGBA', () => {
		const b = build(64, 64, [10, 200]);
		const t = parseNvnTexture(b);
		expect(Array.from(decodeNvnTexture(b, t, 1).subarray(0, 4))).toEqual([200, 200, 200, 255]);
	});

	it('rejects unknown formats', () => {
		const b = build(64, 64, [0]);
		new DataView(b.buffer).setUint32(0x50, 0x7f, true);
		expect(() => parseNvnTexture(b)).toThrow(/Unsupported NVN format/);
	});
});
