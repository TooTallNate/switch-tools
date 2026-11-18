import { describe, expect, it } from 'vitest';
import { parseDds } from '../src/index.js';

function dds(opts: { flags: number; fourCC?: number; bits?: number; dxgi?: number; w: number; h: number }, data: number[]): Uint8Array {
	const dx10 = opts.dxgi !== undefined;
	const head = 128 + (dx10 ? 20 : 0);
	const b = new Uint8Array(head + data.length);
	const dv = new DataView(b.buffer);
	b.set([0x44, 0x44, 0x53, 0x20], 0);
	dv.setUint32(4, 124, true);
	dv.setUint32(12, opts.h, true);
	dv.setUint32(16, opts.w, true);
	dv.setUint32(76, 32, true);
	dv.setUint32(80, opts.flags, true);
	dv.setUint32(84, dx10 ? 0x30315844 : (opts.fourCC ?? 0), true);
	dv.setUint32(88, opts.bits ?? 0, true);
	if (dx10) dv.setUint32(128, opts.dxgi!, true);
	b.set(data, head);
	return b;
}

describe('DDS', () => {
	it('decodes luminance', () => {
		const d = parseDds(dds({ flags: 0x20000, bits: 8, w: 2, h: 1 }, [0, 255]));
		expect(Array.from(d.pixels)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	});

	it('decodes a numeric fourCC (G16R16F)', () => {
		// 1.0 = 0x3c00, 0.5 = 0x3800
		const d = parseDds(dds({ flags: 0x4, fourCC: 112, w: 1, h: 1 }, [0x00, 0x3c, 0x00, 0x38]));
		expect(Array.from(d.pixels)).toEqual([255, 128, 0, 255]);
	});

	it('swaps B8G8R8A8', () => {
		const d = parseDds(dds({ flags: 0x4, dxgi: 87, w: 1, h: 1 }, [1, 2, 3, 4]));
		expect(Array.from(d.pixels)).toEqual([3, 2, 1, 4]);
	});
});
