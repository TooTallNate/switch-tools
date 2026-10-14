import { describe, expect, it } from 'vitest';
import { f3dexMaterialTint, interpretDisplayList } from '../src/index.js';

/** Words → bytes, plus three vertices at 0x100. */
function buffer(words: number[]): Uint8Array {
	const b = new Uint8Array(0x200);
	const dv = new DataView(b.buffer);
	words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0));
	[[0, 0, 0], [10, 0, 0], [0, 10, 0]].forEach(([x, y, z], i) => {
		dv.setInt16(0x100 + i * 16, x!);
		dv.setInt16(0x102 + i * 16, y!);
		dv.setInt16(0x104 + i * 16, z!);
	});
	return b;
}

describe('F3DEX2 state', () => {
	it('loads G_MTX (params in the low byte) through resolveMatrix', () => {
		const m = new Float32Array(16);
		m[0] = m[5] = m[10] = m[15] = 1;
		m[13] = 100; // translate +100 Y
		const bytes = buffer([
			0xda380003, 0x0d000000, // gsSPMatrix(LOAD | NOPUSH)
			0x01003006, 0x00000100, // G_VTX 3 @ 0
			0x05000204, 0x00000000, // G_TRI1
			0xdf000000, 0,
		]);
		const mesh = interpretDisplayList(bytes, 0, { microcode: 'f3dex2', resolveMatrix: (a) => (a >>> 24 === 0x0d ? m : null) });
		expect(Array.from(mesh.positions.slice(0, 6))).toEqual([0, 100, 0, 10, 100, 0]);
	});

	it('takes the texel format from the render tile and records combiner colours', () => {
		const bytes = buffer([
			0xfd100000, 0x00000180, // G_SETTIMG RGBA16-sized block load (CI8 load)
			0xf5480000, 0x00000000, // G_SETTILE tile 0: CI (2) 8-bit (1)
			0xf2000000, 0x0001c01c, // G_SETTILESIZE tile 0: 8×8
			0xfa000000, 0xff8000ff, // G_SETPRIMCOLOR
			0xfc118000, 0xf0038000, // combine cycle 1: (TEXEL0 − 0) · PRIM + 0
			0x01003006, 0x00000100,
			0x05000204, 0x00000000,
			0xdf000000, 0,
		]);
		const mesh = interpretDisplayList(bytes, 0, { microcode: 'f3dex2' });
		const mat = mesh.materials[0]!;
		expect([mat.format, mat.size, mat.width, mat.height]).toEqual([2, 1, 8, 8]);
		expect(mat.primColor).toEqual([255, 128, 0, 255]);
		expect(f3dexMaterialTint(mat)).toEqual([255, 128, 0, 255]);
	});
});
