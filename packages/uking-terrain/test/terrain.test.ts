import { describe, expect, it } from 'vitest';
import { parseTscb, readHeights, renderTerrainTile, terrainTileKind } from '../src/index.js';

function hght(): Uint8Array {
	const b = new Uint8Array(256 * 256 * 2);
	const v = new DataView(b.buffer);
	for (let i = 0; i < 256 * 256; i++) v.setUint16(i * 2, (i % 256) * 100, true);
	return b;
}

/** TSCB with 1 material and 1 area named "5000000000". */
function tscb(): Uint8Array {
	const b = new Uint8Array(0x100);
	const v = new DataView(b.buffer);
	b.set(new TextEncoder().encode('TSCB'));
	v.setUint32(4, 0x0a000000);
	v.setFloat32(0x10, 500);
	v.setFloat32(0x14, 800);
	v.setUint32(0x18, 1);
	v.setUint32(0x1c, 1);
	v.setFloat32(0x28, 32);
	// material table: size, one offset → entry at 0x38
	v.setUint32(0x30, 0x1c);
	v.setUint32(0x34, 4);
	v.setUint32(0x38, 7);
	v.setFloat32(0x3c, 0.1);
	v.setFloat32(0x40, 0.2);
	// area table at 0x30 + 0x1c = 0x4c: one offset → area at 0x50
	v.setUint32(0x4c, 4);
	const a = 0x50;
	v.setFloat32(a, 1);
	v.setFloat32(a + 4, 2);
	v.setFloat32(a + 8, 32);
	v.setFloat32(a + 16, 1);
	v.setUint32(a + 0x20, 0x40); // name at a + 0x60
	b.set(new TextEncoder().encode('5000000000'), a + 0x60);
	return b;
}

describe('uking terrain', () => {
	it('names tile kinds', () => {
		expect(terrainTileKind('5000000000.hght')).toBe('hght');
		expect(terrainTileKind('580000C000.grass.extm')).toBe('grass');
		expect(terrainTileKind('580000C0A0.water.extm')).toBe('water');
		expect(terrainTileKind('foo.extm')).toBeNull();
	});

	it('reads and renders heights', () => {
		const h = readHeights(hght());
		expect(h[255]).toBe(25500);
		const img = renderTerrainTile('hght', hght());
		expect(img.width).toBe(256);
		expect(img.pixels.length).toBe(256 * 256 * 4);
		expect(img.stats).toEqual({ 'Min height': 0, 'Max height': 25500 });
	});

	it('rejects wrongly sized tiles', () => {
		expect(() => renderTerrainTile('mate', new Uint8Array(10))).toThrow(/262144/);
	});

	it('renders grass with transparency where there is none', () => {
		const g = new Uint8Array(64 * 64 * 4);
		g.set([5, 10, 200, 20], 0);
		const img = renderTerrainTile('grass', g);
		expect(Array.from(img.pixels.subarray(0, 8))).toEqual([10, 200, 20, 255, 0, 0, 0, 0]);
	});

	it('parses the TSCB scene table', () => {
		const t = parseTscb(tscb());
		expect(t.worldScale).toBe(500);
		expect(t.maxHeight).toBe(800);
		expect(t.materials).toHaveLength(1);
		expect(t.materials[0]!.index).toBe(7);
		expect(t.areas).toEqual([
			{ name: '5000000000', x: 1, z: 2, edge: 32, minHeight: 0, maxHeight: 1, minWater: 0, maxWater: 0 },
		]);
	});
});
