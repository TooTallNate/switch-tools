/**
 * Breath of the Wild engine data tables. Sources: the ZeldaMods wiki
 * (PrOD, ecosystem, RSTB, XLINK2) and the files themselves (STAT).
 *
 * - STAT (`Game/Stats/*.agstats`, big-endian): per-area maps such as
 *   forest density, water depth or material ids.
 *     0x00 "STAT", u32 version, u32, u32 0x28
 *     0x10 f32 origin x, f32 origin z, f32 x size, f32 z size
 *     0x20 u32 width, u32 height, u32 value kind, u32, u32 8, u32 data size
 *     0x38 width × height cells of (data size − 4) / (w × h) bytes each,
 *          then the stat's name
 * - PrOD (`.sblwp`, big-endian): placements of instanced meshes (flowers,
 *   rocks, distant trees).
 *     0x00 "PrOD", u32 1, u32 1, u32, u32 file size, u32 mesh count,
 *     u32 string table offset, u32 0, then per mesh { u32 instances' byte
 *     size, u32 count, u32 name offset, u32 } and its 0x20-byte instances
 *     { f32 position[3], f32 rotation[3], f32 scale, u32 }. The string table
 *     is { u32 count, u32 size, 4-aligned names }, names relative to it.
 * - Ecosystem (`.sbeco`): a run-length encoded map of area ids.
 *     u32 0x00112233, u32 rows, u32 divisor, u32, then a u32 offset per row
 *     (in 2-byte units, relative to the end of that table) to { u16 value, u16 length }
 *     runs filling the row's width. Identical rows share one run list.
 * - RSTB (`ResourceSizeTable.product.srsizetable`): the memory each
 *   resource needs. Entries are keyed by CRC32 of the resource path:
 *     "RSTB", u32 CRC entries, u32 name entries,
 *     { u32 crc32, u32 size } …, { char name[128], u32 size } …
 * - XLNK (`SLink2DB` / `ELink2DB`): the sound and effect link databases.
 *   A header of table counts (0x08 version, 0x0C resource params, 0x10
 *   asset params, 0x3C users, 0x44 name table offset), then users keyed by
 *   CRC32 of actor names. The name table at the end holds the names.
 * - Hash lists (`.sfmc` far-model culling, `.blal` loop asset list): a
 *   count and a sorted array of u32 hashes, then per-hash data.
 */

function dv(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function magic(bytes: Uint8Array, m: string): boolean {
	return bytes.length >= m.length && String.fromCharCode(...bytes.subarray(0, m.length)) === m;
}

function cstr(bytes: Uint8Array, off: number, max = 256): string {
	let end = off;
	const limit = Math.min(bytes.length, off + max);
	while (end < limit && bytes[end] !== 0) end++;
	return new TextDecoder().decode(bytes.subarray(off, end));
}

/** A distinct colour per category value. */
export function categoryColor(value: number): [number, number, number] {
	if (value === 0) return [24, 24, 28];
	let h = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
	h ^= h >>> 13;
	return [64 + (h & 0xbf), 64 + ((h >>> 8) & 0xbf), 64 + ((h >>> 16) & 0xbf)];
}

export interface RgbaImage {
	width: number;
	height: number;
	pixels: Uint8ClampedArray;
}

// ---------------------------------------------------------------- STAT

export interface ParsedStat {
	name: string;
	originX: number;
	originZ: number;
	sizeX: number;
	sizeZ: number;
	width: number;
	height: number;
	valueKind: number;
	bytesPerCell: number;
	/** Cell values, row-major (u64 cells are split into their low words). */
	values: Float64Array;
}

export function isStat(bytes: Uint8Array): boolean {
	return magic(bytes, 'STAT');
}

export function parseStat(bytes: Uint8Array): ParsedStat {
	if (!isStat(bytes)) throw new Error('Not a STAT file (bad magic)');
	const v = dv(bytes);
	const width = v.getUint32(0x20, false);
	const height = v.getUint32(0x24, false);
	const dataSize = v.getUint32(0x34, false);
	const cells = width * height;
	if (!cells || cells > 4096 * 4096) throw new Error('STAT grid size out of range');
	const bytesPerCell = Math.floor((dataSize - 4) / cells);
	if (![1, 2, 4, 8].includes(bytesPerCell) || 0x38 + cells * bytesPerCell > bytes.length) {
		throw new Error(`Unsupported STAT cell size (${dataSize} bytes for ${width} × ${height})`);
	}
	const values = new Float64Array(cells);
	for (let i = 0; i < cells; i++) {
		const o = 0x38 + i * bytesPerCell;
		values[i] =
			bytesPerCell === 1 ? bytes[o]! : bytesPerCell === 2 ? v.getUint16(o, false) : v.getUint32(o + (bytesPerCell === 8 ? 4 : 0), false);
	}
	return {
		name: cstr(bytes, 0x38 + cells * bytesPerCell, 64),
		originX: v.getFloat32(0x10, false),
		originZ: v.getFloat32(0x14, false),
		sizeX: v.getFloat32(0x18, false),
		sizeZ: v.getFloat32(0x1c, false),
		width,
		height,
		valueKind: v.getUint32(0x28, false),
		bytesPerCell,
		values,
	};
}

/** Render a STAT map: 1–2 byte cells as a grey ramp, wider cells as categories. */
export function renderStat(stat: ParsedStat): RgbaImage & { distinct: number; min: number; max: number } {
	const { width, height, values } = stat;
	let min = Infinity;
	let max = -Infinity;
	const distinct = new Set<number>();
	for (const x of values) {
		if (x < min) min = x;
		if (x > max) max = x;
		if (distinct.size < 4096) distinct.add(x);
	}
	const pixels = new Uint8ClampedArray(width * height * 4);
	const categorical = stat.bytesPerCell >= 4;
	for (let i = 0; i < values.length; i++) {
		const x = values[i]!;
		if (categorical) {
			const [r, g, b] = categoryColor(x);
			pixels.set([r, g, b, 255], i * 4);
		} else {
			const t = max > min ? (x - min) / (max - min) : 0;
			pixels.set([255 * t, 255 * t, 255 * t, 255], i * 4);
		}
	}
	return { width, height, pixels, distinct: distinct.size, min, max };
}

// ---------------------------------------------------------------- PrOD

export interface ProdInstance {
	position: [number, number, number];
	rotation: [number, number, number];
	scale: number;
}

export interface ParsedProd {
	meshes: { name: string; instances: ProdInstance[] }[];
}

export function isProd(bytes: Uint8Array): boolean {
	return magic(bytes, 'PrOD');
}

export function parseProd(bytes: Uint8Array): ParsedProd {
	if (!isProd(bytes)) throw new Error('Not a PrOD file (bad magic)');
	const v = dv(bytes);
	const meshCount = v.getUint32(0x14, false);
	const strings = v.getUint32(0x18, false);
	const meshes: ParsedProd['meshes'] = [];
	let o = 0x20;
	for (let m = 0; m < meshCount; m++) {
		if (o + 16 > bytes.length) throw new Error('PrOD mesh table out of range');
		const total = v.getUint32(o, false);
		const count = v.getUint32(o + 4, false);
		const name = cstr(bytes, strings + v.getUint32(o + 8, false), 128);
		o += 16;
		const size = count ? total / count : 0x20;
		if ((count && size < 0x1c) || o + total > bytes.length) throw new Error('PrOD instances out of range');
		const instances: ProdInstance[] = [];
		for (let i = 0; i < count; i++, o += size) {
			const f = (k: number) => v.getFloat32(o + k * 4, false);
			instances.push({ position: [f(0), f(1), f(2)], rotation: [f(3), f(4), f(5)], scale: f(6) });
		}
		meshes.push({ name, instances });
	}
	return { meshes };
}

// ---------------------------------------------------------------- ecosystem

export interface ParsedEco {
	width: number;
	rows: number;
	divisor: number;
	/** Distinct area values and how many cells each covers. */
	areas: [number, number][];
	/** Downsample the map to an image `scale` times smaller. */
	render(scale: number): RgbaImage;
}

export function isEco(bytes: Uint8Array): boolean {
	return bytes.length >= 16 && dv(bytes).getUint32(0, true) === 0x00112233;
}

export function parseEco(bytes: Uint8Array): ParsedEco {
	if (!isEco(bytes)) throw new Error('Not an ecosystem file (bad magic)');
	const v = dv(bytes);
	const rows = v.getUint32(4, true);
	const divisor = v.getUint32(8, true) || 1;
	const base = 0x10 + rows * 4;
	if (base > bytes.length) throw new Error('Ecosystem row table out of range');
	// Identical rows share their runs, so a row ends at the next larger
	// distinct offset, not at the next row's.
	// Row offsets count 2-byte units.
	const offsets = Array.from({ length: rows }, (_, r) => v.getUint32(0x10 + r * 4, true) * 2);
	const sorted = [...new Set(offsets)].sort((a, b) => a - b);
	const endOf = new Map<number, number>();
	sorted.forEach((o, i) => endOf.set(o, i + 1 < sorted.length ? sorted[i + 1]! : bytes.length - base));
	const runs = (row: number): [number, number][] => {
		const out: [number, number][] = [];
		const start = offsets[row]!;
		const end = base + endOf.get(start)!;
		for (let o = base + start; o + 4 <= end; o += 4) out.push([v.getUint16(o, true), v.getUint16(o + 2, true)]);
		return out;
	};
	let width = 0;
	for (const [, len] of runs(0)) width += len;
	const counts = new Map<number, number>();
	for (let r = 0; r < rows; r++) for (const [val, len] of runs(r)) counts.set(val, (counts.get(val) ?? 0) + len);
	return {
		width,
		rows,
		divisor,
		areas: [...counts].sort((a, b) => a[0] - b[0]),
		render(scale: number) {
			const w = Math.max(1, Math.floor(width / scale));
			const h = Math.max(1, Math.floor(rows / scale));
			const pixels = new Uint8ClampedArray(w * h * 4);
			for (let y = 0; y < h; y++) {
				let x = 0;
				for (const [val, len] of runs(y * scale)) {
					const [r, g, b] = categoryColor(val + 1);
					const x1 = x + len;
					for (let px = Math.ceil(x / scale); px * scale < x1 && px < w; px++) pixels.set([r, g, b, 255], (y * w + px) * 4);
					x = x1;
				}
			}
			return { width: w, height: h, pixels };
		},
	};
}

// ---------------------------------------------------------------- RSTB

export interface ParsedRstb {
	crcEntries: { crc: number; size: number }[];
	nameEntries: { name: string; size: number }[];
}

export function isRstb(bytes: Uint8Array): boolean {
	return magic(bytes, 'RSTB');
}

export function parseRstb(bytes: Uint8Array): ParsedRstb {
	if (!isRstb(bytes)) throw new Error('Not an RSTB file (bad magic)');
	const v = dv(bytes);
	const crcCount = v.getUint32(4, true);
	const nameCount = v.getUint32(8, true);
	if (0x0c + crcCount * 8 + nameCount * 132 > bytes.length) throw new Error('RSTB tables out of range');
	const crcEntries = Array.from({ length: crcCount }, (_, i) => ({
		crc: v.getUint32(0x0c + i * 8, true),
		size: v.getUint32(0x10 + i * 8, true),
	}));
	const names = 0x0c + crcCount * 8;
	const nameEntries = Array.from({ length: nameCount }, (_, i) => ({
		name: cstr(bytes, names + i * 132, 128),
		size: v.getUint32(names + i * 132 + 128, true),
	}));
	return { crcEntries, nameEntries };
}

// ---------------------------------------------------------------- XLNK

export interface ParsedXlnk {
	version: number;
	resourceParams: number;
	assetParams: number;
	users: number;
	userHashes: number[];
	/** Strings from the name table: asset, property and key names. */
	names: string[];
}

export function isXlnk(bytes: Uint8Array): boolean {
	return magic(bytes, 'XLNK');
}

export function parseXlnk(bytes: Uint8Array): ParsedXlnk {
	if (!isXlnk(bytes)) throw new Error('Not an XLNK file (bad magic)');
	const v = dv(bytes);
	const users = v.getUint32(0x3c, true);
	const nameTable = v.getUint32(0x44, true);
	if (0x48 + users * 4 > bytes.length || nameTable > bytes.length) throw new Error('XLNK tables out of range');
	const userHashes = Array.from({ length: users }, (_, i) => v.getUint32(0x48 + i * 4, true));
	const names: string[] = [];
	for (let o = nameTable; o < bytes.length; ) {
		const s = cstr(bytes, o, bytes.length - o);
		if (s) names.push(s);
		o += s.length + 1;
	}
	return {
		version: v.getUint32(0x08, true),
		resourceParams: v.getUint32(0x0c, true),
		assetParams: v.getUint32(0x10, true),
		users,
		userHashes,
		names,
	};
}

// ---------------------------------------------------------------- hash lists

/**
 * A leading count then that many ascending u32 hashes, in either byte
 * order. Returns the hashes, or null when the data doesn't look like one.
 */
export function readSortedHashList(bytes: Uint8Array, offset: number, littleEndian: boolean): number[] | null {
	const v = dv(bytes);
	if (offset + 4 > bytes.length) return null;
	const count = v.getUint32(offset, littleEndian);
	if (!count || offset + 4 + count * 4 > bytes.length) return null;
	const out: number[] = [];
	let prev = -1;
	for (let i = 0; i < count; i++) {
		const h = v.getUint32(offset + 4 + i * 4, littleEndian);
		if (h <= prev) return null;
		out.push(h);
		prev = h;
	}
	return out;
}
