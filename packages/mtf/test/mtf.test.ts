import { describe, expect, it } from 'vitest';

import { MT_TYPES, mtHash, parseMtArc, parseMtTex } from '../src/index.js';

describe('MT Framework', () => {
	it('hashes class names like the engine', () => {
		expect(mtHash('rTexture') & 0x7fffffff).toBe(0x241f5deb);
		expect(MT_TYPES[0x241f5deb]).toBe('tex');
		expect(MT_TYPES[0x58a15856]).toBe('mod');
	});

	it('lists a v9 ARC', () => {
		const b = new Uint8Array(8 + 84);
		const dv = new DataView(b.buffer);
		b.set([0x41, 0x52, 0x43, 0]);
		dv.setUint16(4, 9, true);
		dv.setUint16(6, 1, true);
		const path = 'model\\textures\\em02_BM';
		for (let i = 0; i < path.length; i++) b[8 + i] = path.charCodeAt(i);
		dv.setUint32(8 + 64, 0x241f5deb, true);
		dv.setUint32(8 + 68, 100, true);
		dv.setUint32(8 + 72, 200 | (2 << 29), true);
		dv.setUint32(8 + 76, 2, true);
		dv.setUint32(8 + 80, 0x8000, true);
		expect(parseMtArc(b)).toEqual([{ name: 'model/textures/em02_BM.tex', typeHash: 0x241f5deb, compressedSize: 100, size: 200, offset: 0x8000 }]);
	});

	it('reads a TEX header', () => {
		const b = new Uint8Array(64);
		const dv = new DataView(b.buffer);
		b.set([0x54, 0x45, 0x58, 0]);
		dv.setUint32(4, 0xa1 | (2 << 28), true);
		dv.setUint32(8, 11 | (1024 << 6) | (512 << 19), true);
		b[12] = 1;
		b[13] = 0x31;
		const t = parseMtTex(b);
		expect(t).toMatchObject({ version: 0xa1, width: 1024, height: 512, mips: 11, format: 0x31, cube: false, dataOffset: 16 + 4 + 44 });
	});
});
