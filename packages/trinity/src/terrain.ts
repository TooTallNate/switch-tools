/**
 * Legends: Arceus field terrain (`Hayabusa.Terrain`). Each area tile
 * (`area01_0_0`) is described by a `.trtrr`:
 *
 *   bounds          tile width, depth and maximum height (stored
 *                   Z-up; 1 unit = 1 heightmap texel)
 *   splat_material  a `TerrainMaterial` `.trmtr` binding `HeightMap`
 *                   (R32 float, 0–1 × max height), `HeightNormalMap`,
 *                   `SplatAlpha` (two RGBA array layers = eight layer
 *                   weights) and `SplatColor0`–`7` tiling albedos
 *   instances       vegetation models and their `.trins` placement
 *                   buffers (`SrtInstanceBuffer`)
 *   terrain_buffers `.trtbf` detail (grass density) maps
 *
 * The geometry isn't stored: the game displaces a grid by the
 * heightmap. {@link buildTerrainMesh} does the same on the CPU, and
 * {@link bakeTerrainColor} flattens the splat layers to one overview
 * texture using each layer's average colour (the layers tile every
 * few metres, far below an overview texel).
 *
 * Schemas: pkZukan/PokeDocs `LA/Flatbuffers/Terrain/{trtrr,trins}.fbs`.
 */

import { FlatBuffer, type Table } from '@tootallnate/gfbmdl';

import type { RgbaImage } from './material.js';

export interface TrtrrTerrain {
	/** Tile extent in X / Z, and maximum height (the heightmap's 1.0). */
	size: { x: number; y: number; z: number };
	cellSpan: number;
	cellTotal: number;
	splatSize: { width: number; height: number };
	/** Vegetation models with their `.trins` placement files. */
	instances: { model: string; files: string[] }[];
	/** Grass / detail models. */
	grass: string[];
	/** The `TerrainMaterial` `.trmtr`. */
	material: string | null;
	/** `.trtbf` detail maps. */
	buffers: string[];
}

function root(bytes: Uint8Array): Table {
	const t = new FlatBuffer(bytes).root();
	if (!t.isSane()) throw new Error('Not a FlatBuffer');
	return t;
}

export function parseTrtrr(bytes: Uint8Array): TrtrrTerrain {
	const t = root(bytes);
	const b = t.table(1);
	const sp = t.table(2);
	return {
		// `max_x, max_y, max_z` are Z-up: (width, depth, height). The
		// trailing Y-up bounds (`unk_10.max`) agree: (width, height, depth).
		size: { x: b?.f32(0) ?? 0, y: b?.f32(2) ?? 0, z: b?.f32(1) ?? 0 },
		cellSpan: b?.u32(3) ?? 0,
		cellTotal: b?.u32(4) ?? 0,
		splatSize: { width: sp?.u32(0) ?? 0, height: sp?.u32(1) ?? 0 },
		instances: t.tables(4).map((i) => ({ model: i.str(0) ?? '', files: i.strings(1) })),
		grass: t.tables(6).map((g) => g.str(0) ?? '').filter(Boolean),
		material: t.table(7)?.str(0) ?? null,
		buffers: t.strings(8),
	};
}

export interface TrinsInstances {
	/** e.g. `SrtInstanceBuffer`. */
	type: string;
	/** Raw instance data (layout depends on `type`). */
	data: Uint8Array;
}

export function parseTrins(bytes: Uint8Array): TrinsInstances {
	const t = root(bytes);
	return { type: t.str(0) ?? '', data: t.table(4)?.bytes(0) ?? new Uint8Array(0) };
}

export interface TerrainMesh {
	numVertices: number;
	positions: Float32Array;
	normals: Float32Array;
	/** 0–1 across the tile, V = 0 at heightmap row 0. */
	uv: Float32Array;
	indices: Uint32Array;
}

/**
 * A grid displaced by `heights` (row-major `width × height`, 0–1),
 * sampled every `step` texels, spanning `size.x × size.z` with height
 * `size.y`. Normals come from the height gradient.
 */
export function buildTerrainMesh(
	heights: Float32Array,
	width: number,
	height: number,
	size: { x: number; y: number; z: number },
	step = 1,
): TerrainMesh {
	const cols = Math.floor((width - 1) / step) + 1;
	const rows = Math.floor((height - 1) / step) + 1;
	const n = cols * rows;
	const positions = new Float32Array(n * 3);
	const normals = new Float32Array(n * 3);
	const uv = new Float32Array(n * 2);
	const sx = size.x / Math.max(1, width - 1);
	const sz = size.z / Math.max(1, height - 1);
	const h = (x: number, y: number) => {
		const v = heights[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;
		return (Number.isFinite(v) ? v : 0) * size.y;
	};
	for (let r = 0; r < rows; r++) {
		const y = Math.min(height - 1, r * step);
		for (let c = 0; c < cols; c++) {
			const x = Math.min(width - 1, c * step);
			const i = r * cols + c;
			positions[i * 3] = x * sx;
			positions[i * 3 + 1] = h(x, y);
			positions[i * 3 + 2] = y * sz;
			// Central differences → normal of the height field.
			const dx = (h(x + step, y) - h(x - step, y)) / (2 * step * sx);
			const dz = (h(x, y + step) - h(x, y - step)) / (2 * step * sz);
			const len = Math.hypot(dx, 1, dz);
			normals[i * 3] = -dx / len;
			normals[i * 3 + 1] = 1 / len;
			normals[i * 3 + 2] = -dz / len;
			uv[i * 2] = x / Math.max(1, width - 1);
			uv[i * 2 + 1] = y / Math.max(1, height - 1);
		}
	}
	const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
	let o = 0;
	for (let r = 0; r < rows - 1; r++) {
		for (let c = 0; c < cols - 1; c++) {
			const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
			// Counter-clockwise seen from above (+Y).
			indices[o++] = a; indices[o++] = d; indices[o++] = b;
			indices[o++] = b; indices[o++] = d; indices[o++] = e;
		}
	}
	return { numVertices: n, positions, normals, uv, indices };
}

const toLinear = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toSrgb8 = (l: number) => {
	const c = l <= 0 ? 0 : l >= 1 ? 1 : l;
	return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

/** Mean colour of an image, in linear RGB. */
export function averageColor(img: RgbaImage): [number, number, number] {
	let r = 0, g = 0, b = 0;
	const n = img.width * img.height;
	for (let i = 0; i < n; i++) {
		r += toLinear(img.pixels[i * 4]!);
		g += toLinear(img.pixels[i * 4 + 1]!);
		b += toLinear(img.pixels[i * 4 + 2]!);
	}
	return n ? [r / n, g / n, b / n] : [0.5, 0.5, 0.5];
}

/**
 * Overview colour of a terrain tile: per splat texel, the layer
 * colours weighted by the control textures' channels (control layer
 * `k` channel `c` weights splat layer `4k + c`). Texels with no weight
 * take layer 0. `colors` are linear RGB, `null` for missing layers.
 */
export function bakeTerrainColor(control: RgbaImage[], colors: ([number, number, number] | null)[]): RgbaImage {
	const { width, height } = control[0]!;
	const pixels = new Uint8Array(width * height * 4);
	const fallback = colors.find((c) => c) ?? [0.3, 0.3, 0.3];
	for (let i = 0; i < width * height; i++) {
		let r = 0, g = 0, b = 0, total = 0;
		control.forEach((img, k) => {
			for (let c = 0; c < 4; c++) {
				const col = colors[k * 4 + c];
				const w = (img.pixels[i * 4 + c] ?? 0) / 255;
				if (!col || w <= 0) continue;
				r += col[0] * w;
				g += col[1] * w;
				b += col[2] * w;
				total += w;
			}
		});
		if (total <= 0) {
			[r, g, b] = fallback;
			total = 1;
		}
		pixels[i * 4] = toSrgb8(r / total);
		pixels[i * 4 + 1] = toSrgb8(g / total);
		pixels[i * 4 + 2] = toSrgb8(b / total);
		pixels[i * 4 + 3] = 255;
	}
	return { width, height, pixels };
}
