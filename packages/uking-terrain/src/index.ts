/**
 * Breath of the Wild ("U-King") terrain.
 *
 * The world is a quadtree of areas listed in `Terrain/A/MainField.tscb`.
 * Each area has tiles, packed in `.sstera` archives:
 *
 *   - `.hght`: 256 × 256 little-endian u16 heights. Metres are
 *     `value / 65535 × max height` (the TSCB's max height, 800).
 *   - `.mate`: 256 × 256 × 4 bytes: material A, material B, blend weight
 *     (A → B), and a flag byte. The materials index the TSCB material table,
 *     whose entries name layers of the terrain texture array.
 *   - `.grass.extm`: 64 × 64 × 4 bytes: grass height, then RGB colour.
 *   - `.water.extm`: 64 × 64 × 8 bytes: u16 height, u16 X flow, u16 Z flow,
 *     u8 water type, u8 check byte.
 *
 * `MainField.tscb` is big-endian, even on Switch:
 *
 *   0x00 "TSCB", u32 version (0x0A000000), u32 1, u32 string table offset
 *   0x10 f32 world scale, f32 max height, u32 material count, u32 area count
 *   0x20 u32 0, u32 0, f32 tile size, u32 8
 *   0x30 u32 material table size, then self-relative offsets to materials
 *        { u32 index, f32 u scale, f32 v scale, f32, f32 }
 *   then self-relative offsets to areas
 *        { f32 x, f32 z, f32 edge, f32 min height, f32 max height,
 *          f32 min water, f32 max water, u32, u32 name offset (relative to
 *          its own field), u32, u32, u32 extra count, … }
 *
 * Sources: the ZeldaMods wiki (TSCB, terrain tiles) and the files
 * themselves.
 */

export const HGHT_SIZE = 256;
export const EXTM_SIZE = 64;

export type TerrainTileKind = 'hght' | 'mate' | 'grass' | 'water';

/** Which tile a file name denotes, or null. */
export function terrainTileKind(name: string): TerrainTileKind | null {
	const lower = name.toLowerCase();
	if (lower.endsWith('.hght')) return 'hght';
	if (lower.endsWith('.mate')) return 'mate';
	if (lower.endsWith('.grass.extm')) return 'grass';
	if (lower.endsWith('.water.extm')) return 'water';
	return null;
}

const EXPECTED_SIZE: Record<TerrainTileKind, number> = {
	hght: HGHT_SIZE * HGHT_SIZE * 2,
	mate: HGHT_SIZE * HGHT_SIZE * 4,
	grass: EXTM_SIZE * EXTM_SIZE * 4,
	water: EXTM_SIZE * EXTM_SIZE * 8,
};

export interface TerrainTileImage {
	width: number;
	height: number;
	/** RGBA8, row 0 at the top (north). */
	pixels: Uint8ClampedArray;
	/** Summary values for display. */
	stats: Record<string, string | number>;
}

function check(kind: TerrainTileKind, bytes: Uint8Array) {
	if (bytes.length !== EXPECTED_SIZE[kind]) {
		throw new Error(`${kind} tile should be ${EXPECTED_SIZE[kind]} bytes, got ${bytes.length}`);
	}
}

/** Heights as u16 (256 × 256). */
export function readHeights(bytes: Uint8Array): Uint16Array {
	check('hght', bytes);
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Uint16Array(HGHT_SIZE * HGHT_SIZE);
	for (let i = 0; i < out.length; i++) out[i] = v.getUint16(i * 2, true);
	return out;
}

/** A distinct, stable colour per material index (golden-angle hues). */
export function materialColor(index: number): [number, number, number] {
	const h = ((index * 137.508) % 360) / 60;
	const s = 0.55;
	const l = 0.5 + ((index % 3) - 1) * 0.12;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs((h % 2) - 1));
	const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
	const m = l - c / 2;
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Render a tile for previewing: heights as a hillshaded elevation ramp,
 * materials as blended palette colours, grass in its own colour (alpha by
 * height), water as depth-shaded blue.
 */
export function renderTerrainTile(kind: TerrainTileKind, bytes: Uint8Array): TerrainTileImage {
	check(kind, bytes);
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (kind === 'hght') {
		const h = readHeights(bytes);
		let lo = 65535;
		let hi = 0;
		for (const x of h) {
			if (x < lo) lo = x;
			if (x > hi) hi = x;
		}
		const n = HGHT_SIZE;
		const px = new Uint8ClampedArray(n * n * 4);
		const range = Math.max(1, hi - lo);
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				const i = y * n + x;
				const t = (h[i]! - lo) / range;
				// Light from the north-west: slope along the diagonal.
				const dx = h[y * n + Math.min(n - 1, x + 1)]! - h[y * n + Math.max(0, x - 1)]!;
				const dy = h[Math.min(n - 1, y + 1) * n + x]! - h[Math.max(0, y - 1) * n + x]!;
				const shade = Math.max(0.35, Math.min(1.25, 1 - ((dx + dy) / range) * 6));
				// Green lowlands → brown → white peaks.
				const base = t < 0.5 ? [70 + 200 * t, 110 + 60 * t, 60 + 20 * t] : [170 + 170 * (t - 0.5), 140 + 230 * (t - 0.5), 70 + 370 * (t - 0.5)];
				px.set([base[0]! * shade, base[1]! * shade, base[2]! * shade, 255], i * 4);
			}
		}
		return { width: n, height: n, pixels: px, stats: { 'Min height': lo, 'Max height': hi } };
	}
	if (kind === 'mate') {
		const n = HGHT_SIZE;
		const px = new Uint8ClampedArray(n * n * 4);
		const used = new Set<number>();
		for (let i = 0; i < n * n; i++) {
			const a = bytes[i * 4]!;
			const b = bytes[i * 4 + 1]!;
			const w = bytes[i * 4 + 2]! / 255;
			used.add(a);
			if (w > 0) used.add(b);
			const ca = materialColor(a);
			const cb = materialColor(b);
			px.set([ca[0] * (1 - w) + cb[0] * w, ca[1] * (1 - w) + cb[1] * w, ca[2] * (1 - w) + cb[2] * w, 255], i * 4);
		}
		return {
			width: n,
			height: n,
			pixels: px,
			stats: { Materials: [...used].sort((x, y) => x - y).join(', ') },
		};
	}
	const n = EXTM_SIZE;
	const px = new Uint8ClampedArray(n * n * 4);
	if (kind === 'grass') {
		let covered = 0;
		for (let i = 0; i < n * n; i++) {
			const height = bytes[i * 4]!;
			if (height) covered++;
			px.set([bytes[i * 4 + 1]!, bytes[i * 4 + 2]!, bytes[i * 4 + 3]!, height ? 255 : 0], i * 4);
		}
		return { width: n, height: n, pixels: px, stats: { 'Grass coverage': `${Math.round((covered / (n * n)) * 100)}%` } };
	}
	let lo = 65535;
	let hi = 0;
	const types = new Set<number>();
	for (let i = 0; i < n * n; i++) {
		const height = v.getUint16(i * 8, true);
		if (!height) continue;
		types.add(bytes[i * 8 + 6]!);
		lo = Math.min(lo, height);
		hi = Math.max(hi, height);
	}
	for (let i = 0; i < n * n; i++) {
		const height = v.getUint16(i * 8, true);
		if (!height) continue;
		const t = (height - lo) / Math.max(1, hi - lo);
		px.set([30 + 40 * t, 90 + 80 * t, 170 + 70 * t, 230], i * 4);
	}
	return {
		width: n,
		height: n,
		pixels: px,
		stats: types.size ? { 'Water types': [...types].join(', '), 'Height range': `${lo}–${hi}` } : { Water: 'none' },
	};
}

export interface TscbMaterial {
	index: number;
	uScale: number;
	vScale: number;
	params: [number, number];
}

export interface TscbArea {
	name: string;
	x: number;
	z: number;
	edge: number;
	minHeight: number;
	maxHeight: number;
	minWater: number;
	maxWater: number;
}

export interface ParsedTscb {
	version: number;
	worldScale: number;
	maxHeight: number;
	tileSize: number;
	materials: TscbMaterial[];
	areas: TscbArea[];
}

export function parseTscb(bytes: Uint8Array): ParsedTscb {
	if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'TSCB') throw new Error('Not a TSCB file (bad magic)');
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => {
		if (o < 0 || o + 4 > bytes.length) throw new Error(`TSCB offset 0x${o.toString(16)} out of range`);
		return v.getUint32(o, false);
	};
	const f32 = (o: number) => v.getFloat32(o, false);
	const materialCount = u32(0x18);
	const areaCount = u32(0x1c);
	if (materialCount > 4096 || areaCount > 1_000_000) throw new Error('TSCB counts out of range');
	const materials: TscbMaterial[] = [];
	const matTable = 0x34;
	for (let i = 0; i < materialCount; i++) {
		const o = matTable + i * 4 + u32(matTable + i * 4);
		materials.push({ index: u32(o), uScale: f32(o + 4), vScale: f32(o + 8), params: [f32(o + 12), f32(o + 16)] });
	}
	const areaTable = 0x30 + u32(0x30);
	const areas: TscbArea[] = [];
	for (let i = 0; i < areaCount; i++) {
		const o = areaTable + i * 4 + u32(areaTable + i * 4);
		const nameOff = o + 0x20 + u32(o + 0x20);
		let end = nameOff;
		while (end < bytes.length && bytes[end] !== 0 && end - nameOff < 64) end++;
		areas.push({
			name: String.fromCharCode(...bytes.subarray(nameOff, end)),
			x: f32(o),
			z: f32(o + 4),
			edge: f32(o + 8),
			minHeight: f32(o + 12),
			maxHeight: f32(o + 16),
			minWater: f32(o + 20),
			maxWater: f32(o + 24),
		});
	}
	return { version: u32(4), worldScale: f32(0x10), maxHeight: f32(0x14), tileSize: f32(0x28), materials, areas };
}
