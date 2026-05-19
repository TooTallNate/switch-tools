/**
 * @tootallnate/ff8-field — Final Fantasy VIII PC field-scene
 * background decoder. Each field has two sibling files:
 *
 *   <name>.map — tile layout (one 14-or-16-byte record per
 *                visible tile, terminated by a 0x7FFF X coord).
 *   <name>.mim — image data: palette table at the start +
 *                texture pages (128px × 256px each) laid out
 *                side-by-side as one big bitmap.
 *
 * MIM file size discriminates between two variants:
 *
 *   401408 bytes = "TypeOld" — 16 palettes + 1536×256 image
 *                  (12 texture pages × 128px wide)
 *   438272 bytes = "TypeNew" — 24 palettes + 1664×256 image
 *                  (13 texture pages × 128px wide). The first 8
 *                  palettes are unused junk; effective palettes
 *                  are 8..23 (indexed 0..15 from the tiles).
 *
 * .map record size discrimination:
 *
 *   Tile1 (PSX-era, 16 bytes) — used when MIM is TypeOld AND
 *     the record stride detected from the file ends with a
 *     0x7FFF sentinel at a 16-byte boundary.
 *   Tile1 (14 bytes) — older short variant.
 *   Tile2 (PC/Switch, 16 bytes) — used when MIM is TypeNew.
 *     Adds a `layerID` byte and a `blendType` byte not present
 *     in Tile1.
 *
 * Render: iterate tiles in descending Z order, for each one
 * sample the texture page (with 4-, 8-, or 16-bpp decode + per-
 * palette lookup) and blit a 16×16 patch into the output
 * canvas at `(tile.dstX - minX, tile.dstY - minY)`. Apply blend
 * mode per Tile2.blendType.
 *
 * Cross-referenced against `myst6re/deling`'s `BackgroundFile`
 * and `julianxhokaxhiu/FFNx`'s `background.cpp`.
 */

export const MIM_OLD_SIZE = 401_408 as const;
export const MIM_NEW_SIZE = 438_272 as const;

/** Tile sentinel — when a tile record's X field equals this, parsing stops. */
export const MAP_SENTINEL_X = 0x7fff as const;

export type MimType = 'old' | 'new';

export class Ff8FieldParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Ff8FieldParseError';
	}
}

/** Detect MIM variant from file size. */
export function detectMimType(byteCount: number): MimType {
	if (byteCount === MIM_OLD_SIZE) return 'old';
	if (byteCount === MIM_NEW_SIZE) return 'new';
	throw new Ff8FieldParseError(
		`Unrecognised .mim size ${byteCount} (expected ${MIM_OLD_SIZE} or ${MIM_NEW_SIZE})`,
	);
}

/**
 * Per-MIM-variant constants. The MIM is a single big bitmap:
 *
 *   bytes [0 .. palBytes)              palette data (RGB555 + mask)
 *   bytes [palBytes .. EOF)            image data (texturePages × 128 wide × 256 tall)
 *
 * `numPalettes` is the total slots in the file; `paletteBase`
 * is the first one actually referenced by tiles (palettes
 * 0..7 are junk in the new format).
 */
export interface MimLayout {
	type: MimType;
	numPalettes: number;
	paletteBase: number;
	paletteBytes: number;
	imageStride: number;
	numTexturePages: number;
}

export function mimLayoutFor(type: MimType): MimLayout {
	if (type === 'old') {
		return {
			type,
			numPalettes: 16,
			paletteBase: 0,
			paletteBytes: 16 * 256 * 2, // 0x2000
			imageStride: 1536,
			numTexturePages: 12,
		};
	}
	return {
		type,
		numPalettes: 24,
		paletteBase: 8,
		paletteBytes: 24 * 256 * 2, // 0x3000
		imageStride: 1664,
		numTexturePages: 13,
	};
}

export interface BackgroundTile {
	dstX: number;
	dstY: number;
	z: number;
	/** Source position inside the chosen 128×256 texture page. */
	srcX: number;
	srcY: number;
	/** 0..N where N depends on MIM type. */
	texturePage: number;
	/** Palette index. For TypeNew, 0..15 maps to MIM palettes 8..23. */
	paletteId: number;
	/** Pixel format: 0 = 4bpp, 1 = 8bpp, 2 = 16bpp direct color. */
	depth: number;
	/** When 0, tile is hidden (only used in some maps). */
	draw: 0 | 1;
	/** 0..7 — script-controlled layer (Tile2 only; Tile1 stores in `blend` instead). */
	layerID: number;
	/** Blend mode: 0=avg, 1=add, 2=sub, 3=add25, 4=replace. */
	blendType: BlendType;
	/** Animation group key (255 = always-on). */
	parameter: number;
	/** Animation state within that group. */
	state: number;
	/** Source byte offset (for diagnostics). */
	recordOffset: number;
}

export type BlendType = 0 | 1 | 2 | 3 | 4;

/**
 * Auto-detect tile record size from the map. The trailing
 * 12 or 14 bytes after the last `0x7FFF` sentinel tell us
 * whether records are 14 or 16 bytes.
 */
export function detectTileRecordSize(map: Uint8Array): 14 | 16 {
	// Scan for last 0x7FFF in u16-aligned positions; the offset
	// from EOF gives us record stride.
	for (let i = map.length - 2; i >= 0; i -= 2) {
		if (map[i] === 0xff && map[i + 1] === 0x7f) {
			const tail = map.length - i;
			// Tail = sentinel(2) + zeros(11 or 13) + maybe more
			if (tail >= 16 - 1 && tail <= 16 + 1) return 16;
			if (tail >= 14 - 1 && tail <= 14 + 1) return 14;
			// Inconclusive — fall back on the next sentinel up.
		}
	}
	// No sentinel found; assume 16-byte records (PC/Switch default).
	return 16;
}

function parseTile1(
	view: DataView,
	off: number,
	recordSize: 14 | 16,
): BackgroundTile {
	const dstX = view.getInt16(off + 0, true);
	const dstY = view.getInt16(off + 2, true);
	const srcXBig = view.getUint16(off + 4, true);
	const srcYBig = view.getUint16(off + 6, true);
	const z = view.getUint16(off + 8, true);
	const texID = view.getUint16(off + 10, true);
	const palID = view.getUint16(off + 12, true);
	let parameter = 0;
	let state = 0;
	if (recordSize === 16) {
		parameter = view.getUint8(off + 14);
		state = view.getUint8(off + 15);
	}
	return {
		dstX,
		dstY,
		z,
		srcX: srcXBig & 0xff,
		srcY: srcYBig & 0xff,
		texturePage: texID & 0xf,
		paletteId: (palID >> 6) & 0xf,
		depth: (texID >> 7) & 0x3,
		draw: ((texID >> 4) & 1) as 0 | 1,
		layerID: 0,
		blendType: ((texID >> 5) & 0x3) as BlendType,
		parameter,
		state,
		recordOffset: off,
	};
}

function parseTile2(view: DataView, off: number): BackgroundTile {
	const dstX = view.getInt16(off + 0, true);
	const dstY = view.getInt16(off + 2, true);
	const z = view.getUint16(off + 4, true);
	const texID = view.getUint16(off + 6, true);
	const palID = view.getUint16(off + 8, true);
	const srcX = view.getUint8(off + 10);
	const srcY = view.getUint8(off + 11);
	const layerID = view.getUint8(off + 12);
	const blendType = view.getUint8(off + 13);
	const parameter = view.getUint8(off + 14);
	const state = view.getUint8(off + 15);
	// Hack from deling: if blendType >= 60 we misdetected; this
	// is actually a Tile1 in disguise.
	let blend: BlendType = (blendType & 0x7) as BlendType;
	if (blendType > 4) blend = 4;
	return {
		dstX,
		dstY,
		z,
		srcX,
		srcY,
		texturePage: texID & 0xf,
		paletteId: (palID >> 6) & 0xf,
		depth: (texID >> 7) & 0x3,
		draw: ((texID >> 4) & 1) as 0 | 1,
		layerID,
		blendType: blend,
		parameter,
		state,
		recordOffset: off,
	};
}

export interface ParsedMap {
	recordSize: 14 | 16;
	tiles: BackgroundTile[];
}

/**
 * Parse a `.map` file. The MIM type tells us whether to read
 * Tile1 records (TypeOld) or Tile2 records (TypeNew). When the
 * map is empty or doesn't fit either variant, returns an empty
 * tile list.
 */
export function parseMap(
	mapBytes: Uint8Array,
	mimType: MimType,
): ParsedMap {
	const recordSize = detectTileRecordSize(mapBytes);
	const view = new DataView(
		mapBytes.buffer,
		mapBytes.byteOffset,
		mapBytes.byteLength,
	);
	const tiles: BackgroundTile[] = [];
	const isTile2 = mimType === 'new' && recordSize === 16;
	for (let off = 0; off + recordSize <= mapBytes.length; off += recordSize) {
		// Sentinel check (signed int16 X).
		const dstX = view.getInt16(off + 0, true);
		if ((dstX & 0xffff) === MAP_SENTINEL_X) break;
		const tile = isTile2
			? parseTile2(view, off)
			: parseTile1(view, off, recordSize);
		tiles.push(tile);
	}
	return { recordSize, tiles };
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

export interface CompositeOptions {
	/**
	 * Visibility filter. Returns `true` to keep the tile.
	 * Defaults to "show always-on tiles (parameter == 255) plus
	 * the first observed state for every other parameter group".
	 */
	tileVisible?: (tile: BackgroundTile) => boolean;
	/** Render layers 0..7 (Tile2). Defaults to all on. */
	visibleLayers?: boolean[];
}

export interface CompositeResult {
	width: number;
	height: number;
	pixels: Uint8Array;
	/** Image-center destX/Y offset relative to top-left pixel (0,0). */
	centerX: number;
	centerY: number;
	/** Number of tiles included in the final render. */
	renderedTiles: number;
}

function rgb555ToRgba(color: number): [number, number, number, number] {
	const r5 = color & 0x1f;
	const g5 = (color >> 5) & 0x1f;
	const b5 = (color >> 10) & 0x1f;
	const mask = (color >> 15) & 1;
	const r = (r5 << 3) | (r5 >> 2);
	const g = (g5 << 3) | (g5 >> 2);
	const b = (b5 << 3) | (b5 >> 2);
	// PSX convention: when mask=0 and RGB=0, fully transparent.
	// Otherwise, opaque (mask bit semantics are inverted from
	// what the name suggests — see deling FF8Color::fromPsColor).
	const a = mask === 0 && r === 0 && g === 0 && b === 0 ? 0 : 255;
	return [r, g, b, a];
}

function applyBlend(
	dst: Uint8Array,
	off: number,
	r: number,
	g: number,
	b: number,
	a: number,
	blendType: BlendType,
): void {
	if (a === 0) return;
	switch (blendType) {
		case 0: {
			// Average of dst + src. If dst transparent, replace.
			if (dst[off + 3]! === 0) {
				dst[off + 0] = r;
				dst[off + 1] = g;
				dst[off + 2] = b;
				dst[off + 3] = 255;
				return;
			}
			dst[off + 0] = (dst[off + 0]! + r) >> 1;
			dst[off + 1] = (dst[off + 1]! + g) >> 1;
			dst[off + 2] = (dst[off + 2]! + b) >> 1;
			dst[off + 3] = 255;
			break;
		}
		case 1: {
			// Additive clamp
			dst[off + 0] = Math.min(255, dst[off + 0]! + r);
			dst[off + 1] = Math.min(255, dst[off + 1]! + g);
			dst[off + 2] = Math.min(255, dst[off + 2]! + b);
			dst[off + 3] = 255;
			break;
		}
		case 2: {
			// Subtractive clamp
			dst[off + 0] = Math.max(0, dst[off + 0]! - r);
			dst[off + 1] = Math.max(0, dst[off + 1]! - g);
			dst[off + 2] = Math.max(0, dst[off + 2]! - b);
			dst[off + 3] = 255;
			break;
		}
		case 3: {
			// Additive at 25%
			dst[off + 0] = Math.min(255, dst[off + 0]! + (r >> 2));
			dst[off + 1] = Math.min(255, dst[off + 1]! + (g >> 2));
			dst[off + 2] = Math.min(255, dst[off + 2]! + (b >> 2));
			dst[off + 3] = 255;
			break;
		}
		case 4:
		default:
			// Replace
			dst[off + 0] = r;
			dst[off + 1] = g;
			dst[off + 2] = b;
			dst[off + 3] = 255;
			break;
	}
}

/**
 * Default visibility predicate — keep "always-on" tiles
 * (parameter == 255) plus the first observed state of each
 * varying parameter group. This is what the game shows when
 * you first walk into a scene before any script has run.
 */
function defaultVisible(tiles: BackgroundTile[]): (t: BackgroundTile) => boolean {
	const firstStateByParam = new Map<number, number>();
	for (const t of tiles) {
		if (t.parameter === 255) continue;
		if (!firstStateByParam.has(t.parameter)) {
			firstStateByParam.set(t.parameter, t.state);
		}
	}
	return (t) => {
		if (t.draw === 0) return false;
		if (t.parameter === 255) return true;
		return firstStateByParam.get(t.parameter) === t.state;
	};
}

export function composite(
	mapBytes: Uint8Array,
	mimBytes: Uint8Array,
	options: CompositeOptions = {},
): CompositeResult {
	const mimType = detectMimType(mimBytes.length);
	const layout = mimLayoutFor(mimType);
	const parsed = parseMap(mapBytes, mimType);
	const visible = options.tileVisible ?? defaultVisible(parsed.tiles);
	const visibleLayers = options.visibleLayers;

	const filtered = parsed.tiles.filter((t) => {
		if (!visible(t)) return false;
		if (visibleLayers && !visibleLayers[t.layerID]) return false;
		return true;
	});

	// Compute bounds.
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const t of filtered) {
		if (t.dstX < minX) minX = t.dstX;
		if (t.dstY < minY) minY = t.dstY;
		if (t.dstX + 16 > maxX) maxX = t.dstX + 16;
		if (t.dstY + 16 > maxY) maxY = t.dstY + 16;
	}
	if (!isFinite(minX)) {
		return {
			width: 0,
			height: 0,
			pixels: new Uint8Array(0),
			centerX: 0,
			centerY: 0,
			renderedTiles: 0,
		};
	}
	const width = maxX - minX;
	const height = maxY - minY;
	const pixels = new Uint8Array(width * height * 4);
	const mimView = new DataView(
		mimBytes.buffer,
		mimBytes.byteOffset,
		mimBytes.byteLength,
	);

	// Sort by descending Z (far→near) so closer tiles overwrite.
	const sorted = filtered.slice().sort((a, b) => b.z - a.z);

	for (const tile of sorted) {
		drawTile(tile, mimBytes, mimView, layout, pixels, width, minX, minY);
	}

	return {
		width,
		height,
		pixels,
		centerX: -minX,
		centerY: -minY,
		renderedTiles: sorted.length,
	};
}

function drawTile(
	tile: BackgroundTile,
	mim: Uint8Array,
	view: DataView,
	layout: MimLayout,
	out: Uint8Array,
	canvasW: number,
	minX: number,
	minY: number,
): void {
	const palOffset = (layout.paletteBase + tile.paletteId) * 256 * 2;
	if (palOffset < 0 || palOffset + 512 > layout.paletteBytes) return;
	const imageBase = layout.paletteBytes;
	const pageBase = imageBase + tile.texturePage * 128;
	for (let dy = 0; dy < 16; dy++) {
		const sy = tile.srcY + dy;
		if (sy >= 256) break;
		const py = tile.dstY - minY + dy;
		if (py < 0 || py >= out.length / canvasW / 4) continue;
		const rowBase = pageBase + sy * layout.imageStride;
		for (let dx = 0; dx < 16; dx++) {
			const px = tile.dstX - minX + dx;
			if (px < 0 || px >= canvasW) continue;
			let r = 0,
				g = 0,
				b = 0,
				a = 0;
			if (tile.depth === 2) {
				// 16bpp direct: srcX is in u16 units.
				const sx = tile.srcX + dx;
				if (sx >= 128) break;
				const off = rowBase + sx * 2;
				if (off + 1 >= mim.length) continue;
				const color = mim[off]! | (mim[off + 1]! << 8);
				const rgba = rgb555ToRgba(color);
				r = rgba[0];
				g = rgba[1];
				b = rgba[2];
				a = rgba[3];
			} else if (tile.depth === 1) {
				// 8bpp paletted.
				const sx = tile.srcX + dx;
				if (sx >= 128) break;
				const off = rowBase + sx;
				if (off >= mim.length) continue;
				const idx = mim[off]!;
				if (idx === 0) continue; // transparent
				const palColor = view.getUint16(palOffset + idx * 2, true);
				const rgba = rgb555ToRgba(palColor);
				r = rgba[0];
				g = rgba[1];
				b = rgba[2];
				a = rgba[3];
			} else {
				// 4bpp paletted: two indices per byte.
				const sx = tile.srcX + dx;
				if (sx >= 128) break;
				const off = rowBase + (sx >> 1);
				if (off >= mim.length) continue;
				const byte = mim[off]!;
				const idx = (sx & 1) === 0 ? byte & 0xf : (byte >> 4) & 0xf;
				if (idx === 0) continue;
				const palColor = view.getUint16(palOffset + idx * 2, true);
				const rgba = rgb555ToRgba(palColor);
				r = rgba[0];
				g = rgba[1];
				b = rgba[2];
				a = rgba[3];
			}
			if (a === 0) continue;
			const off = (py * canvasW + px) * 4;
			applyBlend(out, off, r, g, b, a, tile.blendType);
		}
	}
}
