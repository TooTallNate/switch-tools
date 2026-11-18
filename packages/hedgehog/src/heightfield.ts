/**
 * Sonic Frontiers open-zone terrain heightfields (`.heightfield`,
 * magic `HTFD`, little-endian), read from the files:
 *
 *   0x00  'HTFD', u32 size, u32 version (1), u32 (2), u32 (0)
 *   0x14  u32 width, u32 height        (texels; 4096 × 4096 on the islands)
 *   0x1C  f32 texel size X, f32 texel size Z (metres)
 *   0x24  f32 height scale (1000 / 32768), f32 max height (1000)
 *   0x2C  width × height u16 heights, row-major; 0x8000 marks no ground
 *
 * Then the material layer: u64 count, `count` 8-byte entries whose last
 * byte is a terrain texture id (`<island>_<id:03>_terrain_base_abd.dds`
 * in the stage's `_trr_height` pac), and a (width − 1) × (height − 1)
 * u8 map of entry indices, one per cell. The field is centred on the
 * world origin.
 */

export interface Heightfield {
	width: number;
	height: number;
	cellX: number;
	cellZ: number;
	heightScale: number;
	maxHeight: number;
	/** `width × height` raw heights (multiply by `heightScale`); {@link HEIGHTFIELD_HOLE} = none. */
	heights: Uint16Array;
	/** Terrain texture id per material entry. */
	materials: number[];
	/** (width − 1) × (height − 1) material entry per cell, when present. */
	splat: Uint8Array | null;
}

export const HEIGHTFIELD_HOLE = 0x8000;

export function isHeightfield(bytes: Uint8Array): boolean {
	return bytes.length >= 0x2c && bytes[0] === 0x48 && bytes[1] === 0x54 && bytes[2] === 0x46 && bytes[3] === 0x44;
}

export function parseHeightfield(bytes: Uint8Array): Heightfield {
	if (!isHeightfield(bytes)) throw new Error('Not an HTFD heightfield');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = dv.getUint32(0x14, true), height = dv.getUint32(0x18, true);
	const n = width * height;
	if (!width || !height || 0x2c + n * 2 > bytes.length) throw new Error('Heightfield is truncated');
	// Copy out so the heights are aligned regardless of where the file sits.
	const heights = new Uint16Array(n);
	for (let i = 0; i < n; i++) heights[i] = dv.getUint16(0x2c + i * 2, true);
	let materials: number[] = [];
	let splat: Uint8Array | null = null;
	const at = 0x2c + n * 2;
	if (at + 8 <= bytes.length) {
		const count = Number(dv.getBigUint64(at, true));
		if (count > 0 && count < 256 && at + 8 + count * 8 <= bytes.length) {
			for (let i = 0; i < count; i++) materials.push(bytes[at + 8 + i * 8 + 7]!);
			const s = at + 8 + count * 8;
			splat = bytes.slice(s, Math.min(bytes.length, s + (width - 1) * (height - 1)));
		} else materials = [];
	}
	return {
		width,
		height,
		cellX: dv.getFloat32(0x1c, true) || 1,
		cellZ: dv.getFloat32(0x20, true) || 1,
		heightScale: dv.getFloat32(0x24, true) || 1000 / 32768,
		maxHeight: dv.getFloat32(0x28, true),
		heights,
		materials,
		splat,
	};
}
