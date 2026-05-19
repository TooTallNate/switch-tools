/**
 * Composite an FF7 field scene's tiles into a flat RGBA image.
 *
 * Layer order, back → front:
 *   - Layer 0 (`ID == 4095`): main background, 16×16 tiles, no
 *     blending, no z-test within the layer.
 *   - Layer 1 (`ID in [1, 4094]`): Z-tested movables, 16×16
 *     tiles. Render back-to-front (descending ID).
 *   - Layer 2 (`ID == 4096`): midground, 32×32 tiles.
 *   - Layer 3 (`ID == 0`): foreground occluders, 32×32 tiles.
 *
 * Within each layer (other than L1), tiles are drawn in author
 * order with later tiles overdrawing earlier ones.
 *
 * Per-pixel transparency rules:
 *   - `depth == 1` (paletted): the texel is the palette index.
 *     If `ignoreFirstPixel[paletteID]` is true and the index
 *     is 0, the pixel is transparent. Otherwise palette[idx].
 *   - `depth == 2` (direct color): the texel is an RGB16 with
 *     bit layout `RRRRRGGGGGABBBBB` (R = MSB; DIFFERENT FROM
 *     Section 4's palette colors!). Special values:
 *       - `0x0000` → transparent
 *       - `0x0821` → solid black (sentinel for "true black,
 *         not transparent")
 *   - `depth == 0` (4bpp paletted, rare): two indices per byte.
 *
 * Blending modes (`typeTrans`, only if `tile.blending == 1`):
 *    0 → `out = (dst + src) / 2`
 *    1 → `out = min(255, dst + src)`
 *    2 → `out = max(0, dst − src)`
 *    3 → `out = min(255, dst + src/4)`
 */

import type { BackgroundTile, ParsedBackground } from './background.js';
import type { ParsedPalette } from './palette.js';

export interface CompositeOptions {
	/**
	 * Filter to only render tiles where `(param == 0) ||
	 * (state == 0)` — i.e. the always-on baseline group only,
	 * not the script-toggleable sub-layers. Defaults to true
	 * (so static-image exports look "right" out of the box).
	 *
	 * Set false to render every tile regardless of visibility
	 * group (useful for diagnostic dumps).
	 */
	onlyBaselineState?: boolean;
	/**
	 * Whether to render foreground layers (L2/L3). Defaults to
	 * true. Set false to extract just the background plate (for
	 * use as a backdrop behind 3D characters at runtime).
	 */
	includeForeground?: boolean;
	/**
	 * Whether to render layer 1 movables. Defaults to true.
	 */
	includeMovables?: boolean;
}

export interface CompositeResult {
	width: number;
	height: number;
	/** RGBA8 pixels, row-major, top-down. Length = width * height * 4. */
	pixels: Uint8Array;
	/** Image-center destX/Y offset relative to top-left pixel (0,0). */
	centerX: number;
	centerY: number;
}

export function composite(
	bg: ParsedBackground,
	palette: ParsedPalette,
	options: CompositeOptions = {},
): CompositeResult {
	const {
		onlyBaselineState = true,
		includeForeground = true,
		includeMovables = true,
	} = options;

	// Visibility filter.
	const tiles = bg.tiles.filter((t) => {
		if (!includeMovables && t.layerID === 1) return false;
		if (!includeForeground && (t.layerID === 2 || t.layerID === 3)) return false;
		// Baseline = both param and state == 0. (FF7 scripts toggle
		// non-zero state bits dynamically; we render only the
		// always-on group.)
		if (onlyBaselineState && (t.param !== 0 || t.state !== 0)) {
			return false;
		}
		return true;
	});

	// Bounding box from filtered tiles.
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const t of tiles) {
		const size = t.layerID >= 2 ? 32 : 16;
		if (t.dstX < minX) minX = t.dstX;
		if (t.dstY < minY) minY = t.dstY;
		if (t.dstX + size > maxX) maxX = t.dstX + size;
		if (t.dstY + size > maxY) maxY = t.dstY + size;
	}
	if (!isFinite(minX)) {
		return { width: 0, height: 0, pixels: new Uint8Array(0), centerX: 0, centerY: 0 };
	}
	const width = maxX - minX;
	const height = maxY - minY;
	const pixels = new Uint8Array(width * height * 4);

	// Layer ordering: 0 (back), then 1 sorted by descending ID,
	// then 2, then 3 (front).
	const l0 = tiles.filter((t) => t.layerID === 0);
	const l1 = tiles
		.filter((t) => t.layerID === 1)
		.sort((a, b) => b.ID - a.ID);
	const l2 = tiles.filter((t) => t.layerID === 2);
	const l3 = tiles.filter((t) => t.layerID === 3);
	const order = [l0, l1, l2, l3];

	for (const layer of order) {
		for (const tile of layer) {
			drawTile(tile, bg, palette, pixels, width, minX, minY);
		}
	}

	return {
		width,
		height,
		pixels,
		centerX: -minX,
		centerY: -minY,
	};
}

function drawTile(
	tile: BackgroundTile,
	bg: ParsedBackground,
	palette: ParsedPalette,
	pixels: Uint8Array,
	canvasW: number,
	minX: number,
	minY: number,
): void {
	const tex = bg.textures.get(tile.textureID);
	if (!tex) return; // missing texture: skip silently
	const tileSize = tile.layerID >= 2 ? 32 : 16;
	const palPage = palette.pages[tile.paletteID];
	const ignoreFirst =
		!!bg.ignoreFirstPixel[tile.paletteID] && tex.depth === 1;

	for (let dy = 0; dy < tileSize; dy++) {
		const sy = tile.srcY + dy;
		if (sy >= 256) break;
		const py = tile.dstY - minY + dy;
		if (py < 0 || py >= pixels.length / canvasW / 4) continue;
		for (let dx = 0; dx < tileSize; dx++) {
			const sx = tile.srcX + dx;
			if (sx >= 256) break;
			const px = tile.dstX - minX + dx;
			if (px < 0 || px >= canvasW) continue;

			let r: number;
			let g: number;
			let b: number;
			let a: number;

			if (tex.depth === 1) {
				// 8-bit paletted.
				const idx = tex.data[sy * 256 + sx]!;
				if (ignoreFirst && idx === 0) continue;
				if (!palPage) continue;
				r = palPage[idx * 4 + 0]!;
				g = palPage[idx * 4 + 1]!;
				b = palPage[idx * 4 + 2]!;
				a = palPage[idx * 4 + 3]!;
				if (a === 0) continue;
			} else if (tex.depth === 2) {
				// 16-bit direct color. Bit layout differs from §4 palette:
				//   RRRRR GGGGG A BBBBB  (R = MSB, B = LSB)
				const off = (sy * 256 + sx) * 2;
				const raw = tex.data[off]! | (tex.data[off + 1]! << 8);
				if (raw === 0x0000) continue; // transparent
				if (raw === 0x0821) {
					r = 0;
					g = 0;
					b = 0;
				} else {
					const b5 = raw & 0x1f;
					const g5 = (raw >> 6) & 0x1f; // skip alpha bit at position 5
					const r5 = (raw >> 11) & 0x1f;
					r = (r5 << 3) | (r5 >> 2);
					g = (g5 << 3) | (g5 >> 2);
					b = (b5 << 3) | (b5 >> 2);
				}
				a = 255;
			} else {
				// 4bpp paletted. Two nibbles per byte; even sx = low.
				const byte = tex.data[sy * 256 + (sx >> 1)]!;
				const idx = (sx & 1) === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
				if (ignoreFirst && idx === 0) continue;
				if (!palPage) continue;
				r = palPage[idx * 4 + 0]!;
				g = palPage[idx * 4 + 1]!;
				b = palPage[idx * 4 + 2]!;
				a = palPage[idx * 4 + 3]!;
				if (a === 0) continue;
			}

			const off = (py * canvasW + px) * 4;
			if (tile.layerID > 0 && tile.blending === 1) {
				const dr = pixels[off + 0]!;
				const dg = pixels[off + 1]!;
				const db = pixels[off + 2]!;
				const da = pixels[off + 3]!;
				switch (tile.typeTrans) {
					case 0:
						// 50% average; if dst is fully transparent treat
						// as if src draws solid (otherwise the blend
						// produces ghostly half-bright pixels on the
						// transparent canvas).
						if (da === 0) {
							pixels[off + 0] = r;
							pixels[off + 1] = g;
							pixels[off + 2] = b;
							pixels[off + 3] = 255;
						} else {
							pixels[off + 0] = (dr + r) >> 1;
							pixels[off + 1] = (dg + g) >> 1;
							pixels[off + 2] = (db + b) >> 1;
							pixels[off + 3] = 255;
						}
						break;
					case 1:
						pixels[off + 0] = Math.min(255, dr + r);
						pixels[off + 1] = Math.min(255, dg + g);
						pixels[off + 2] = Math.min(255, db + b);
						pixels[off + 3] = 255;
						break;
					case 2:
						pixels[off + 0] = Math.max(0, dr - r);
						pixels[off + 1] = Math.max(0, dg - g);
						pixels[off + 2] = Math.max(0, db - b);
						pixels[off + 3] = 255;
						break;
					case 3:
						pixels[off + 0] = Math.min(255, dr + (r >> 2));
						pixels[off + 1] = Math.min(255, dg + (g >> 2));
						pixels[off + 2] = Math.min(255, db + (b >> 2));
						pixels[off + 3] = 255;
						break;
				}
			} else {
				pixels[off + 0] = r;
				pixels[off + 1] = g;
				pixels[off + 2] = b;
				pixels[off + 3] = 255;
			}
		}
	}
}
