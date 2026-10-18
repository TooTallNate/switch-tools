/**
 * GX2 "Gfx2" files: Wii U texture (`.gtx`) and shader (`.gsh`) containers.
 * Breath of the Wild's Switch port still ships a few (the terrain brush
 * textures in `tera_resource`).
 *
 * Big-endian. File header: "Gfx2", u32 header size (0x20), u32 major
 * (7), u32 minor, u32 GPU version, … Then blocks, each with the header
 * "BLK{", u32 header size (0x20), u32 major, u32 minor, u32 type, u32 data
 * size, u32 id, u32 index, followed by the data. Block types (v7):
 * 0x0B surface info (GX2Surface), 0x0C image data, 0x0D mip data,
 * 0x03 / 0x05 / 0x06 vertex / pixel / geometry shader headers,
 * 0x07 / 0x09 shader programs, 0x01 end.
 *
 * GX2Surface (0x9C bytes): u32 dim, width, height, depth, mip count,
 * format, AA mode, use, image size, image pointer, mip size, mip pointer,
 * tile mode, swizzle, alignment, pitch, then mip offsets.
 *
 * Tiled surfaces follow the R600 address library (AMD's addrlib). This
 * implements the linear, 1D-tiled and 2D-tiled thin layouts for one
 * sample, after decaf-emu's addrlib and AboodXD's `addrlib.py` (GTX
 * Extractor).
 */
import { decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5 } from '@tootallnate/bntx';

export interface Gx2Block {
	type: number;
	offset: number;
	size: number;
}

export interface Gx2Surface {
	dim: number;
	width: number;
	height: number;
	depth: number;
	mipCount: number;
	format: number;
	formatName: string;
	imageSize: number;
	tileMode: number;
	swizzle: number;
	pitch: number;
	/** Image data (mip 0 and the other mips of the first level). */
	image: Uint8Array | null;
}

export interface ParsedGx2 {
	major: number;
	blocks: Gx2Block[];
	surfaces: Gx2Surface[];
	shaders: { vertex: number; pixel: number; geometry: number };
}

const BLOCK_SURFACE = 0x0b;
const BLOCK_IMAGE = 0x0c;

/** Formats we decode, by low byte of the GX2 format (the high byte is sRGB / snorm). */
const FORMATS: Record<number, { name: string; bpp: number; block: boolean }> = {
	0x01: { name: 'R8', bpp: 8, block: false },
	0x07: { name: 'RG8', bpp: 16, block: false },
	0x1a: { name: 'RGBA8', bpp: 32, block: false },
	0x31: { name: 'BC1', bpp: 64, block: true },
	0x32: { name: 'BC2', bpp: 128, block: true },
	0x33: { name: 'BC3', bpp: 128, block: true },
	0x34: { name: 'BC4', bpp: 64, block: true },
	0x35: { name: 'BC5', bpp: 128, block: true },
};

export function isGx2(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'Gfx2';
}

export function parseGx2(bytes: Uint8Array): ParsedGx2 {
	if (!isGx2(bytes)) throw new Error('Not a GX2 file (bad magic)');
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerSize = v.getUint32(4, false);
	const major = v.getUint32(8, false);
	const blocks: Gx2Block[] = [];
	let o = headerSize;
	while (o + 0x20 <= bytes.length) {
		if (String.fromCharCode(...bytes.subarray(o, o + 4)) !== 'BLK{') throw new Error(`Bad GX2 block at 0x${o.toString(16)}`);
		const bh = v.getUint32(o + 4, false);
		const type = v.getUint32(o + 0x10, false);
		const size = v.getUint32(o + 0x14, false);
		if (o + bh + size > bytes.length) throw new Error('GX2 block out of range');
		blocks.push({ type, offset: o + bh, size });
		if (type === 0x01) break;
		o += bh + size;
	}
	const surfaces: Gx2Surface[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!;
		if (b.type !== BLOCK_SURFACE || b.size < 0x9c) continue;
		const s = b.offset;
		const u = (k: number) => v.getUint32(s + k * 4, false);
		const format = u(5);
		const image = blocks.slice(i + 1).find((x) => x.type === BLOCK_IMAGE || x.type === BLOCK_SURFACE);
		surfaces.push({
			dim: u(0),
			width: u(1),
			height: u(2),
			depth: u(3),
			mipCount: u(4),
			format,
			formatName: FORMATS[format & 0xff]?.name ?? `0x${format.toString(16)}`,
			imageSize: u(8),
			tileMode: u(12),
			swizzle: u(13),
			pitch: u(15),
			image: image?.type === BLOCK_IMAGE ? bytes.subarray(image.offset, image.offset + image.size) : null,
		});
	}
	const count = (t: number) => blocks.filter((b) => b.type === t).length;
	return { major, blocks, surfaces, shaders: { vertex: count(0x03), pixel: count(0x05), geometry: count(0x06) } };
}

// ------------------------------------------------------------ addrlib (R600)

const BANKS = 4;
const BANK_BITS = 2;
const PIPES = 2;
const PIPE_BITS = 1;
const PIPE_INTERLEAVE = 256;
const PIPE_INTERLEAVE_BITS = 8;

function pixelIndexInMicroTile(x: number, y: number, bpp: number): number {
	let b0: number, b1: number, b2: number, b3: number, b4: number, b5: number;
	const x0 = x & 1, x1 = (x >> 1) & 1, x2 = (x >> 2) & 1;
	const y0 = y & 1, y1 = (y >> 1) & 1, y2 = (y >> 2) & 1;
	if (bpp === 8) [b0, b1, b2, b3, b4, b5] = [x0, x1, x2, y1, y0, y2];
	else if (bpp === 16) [b0, b1, b2, b3, b4, b5] = [x0, x1, x2, y0, y1, y2];
	else if (bpp === 32 || bpp === 96) [b0, b1, b2, b3, b4, b5] = [x0, x1, y0, x2, y1, y2];
	else if (bpp === 64) [b0, b1, b2, b3, b4, b5] = [x0, y0, x1, x2, y1, y2];
	else [b0, b1, b2, b3, b4, b5] = [y0, x0, x1, x2, y1, y2];
	return b0 | (b1 << 1) | (b2 << 2) | (b3 << 3) | (b4 << 4) | (b5 << 5);
}

function addrMicroTiled(x: number, y: number, bpp: number, pitch: number): number {
	const microTileBytes = (64 * bpp) / 8;
	const tileOffset = (Math.floor(y / 8) * Math.floor(pitch / 8) + Math.floor(x / 8)) * microTileBytes;
	return tileOffset + (pixelIndexInMicroTile(x, y, bpp) * bpp) / 8;
}

function addrMacroTiled(x: number, y: number, bpp: number, pitch: number, swizzle: number): number {
	const pipeSwizzle = (swizzle >> 8) & 1;
	const bankSwizzle = (swizzle >> 9) & 3;
	const elemOffset = (pixelIndexInMicroTile(x, y, bpp) * bpp) / 8;
	let pipe = ((y >> 3) ^ (x >> 3)) & 1;
	let bank = (((y >> 5) ^ (x >> 3)) & 1) | ((((y >> 4) ^ (x >> 4)) & 1) << 1);
	let bankPipe = pipe + PIPES * bank;
	// Slice rotation only matters past slice 0; 2D surfaces have one slice.
	bankPipe ^= pipeSwizzle + PIPES * bankSwizzle;
	bankPipe %= PIPES * BANKS;
	pipe = bankPipe % PIPES;
	bank = Math.floor(bankPipe / PIPES);
	const macroTilePitch = 8 * BANKS;
	const macroTileHeight = 8 * PIPES;
	const macroTilesPerRow = Math.floor(pitch / macroTilePitch);
	const macroTileBytes = (bpp * macroTileHeight * macroTilePitch) / 8;
	const macroTileOffset =
		(Math.floor(x / macroTilePitch) + macroTilesPerRow * Math.floor(y / macroTileHeight)) * macroTileBytes;
	const total = elemOffset + (macroTileOffset >> (BANK_BITS + PIPE_BITS));
	const high = (total & ~(PIPE_INTERLEAVE - 1)) * (1 << (BANK_BITS + PIPE_BITS));
	const low = total & (PIPE_INTERLEAVE - 1);
	return high + (bank << (PIPE_INTERLEAVE_BITS + PIPE_BITS)) + (pipe << PIPE_INTERLEAVE_BITS) + low;
}

/** Undo GX2 tiling of mip 0 into a linear array of elements (pixels or 4×4 blocks). */
export function untileGx2(surface: Gx2Surface): { data: Uint8Array; elemW: number; elemH: number; bpp: number } {
	const fmt = FORMATS[surface.format & 0xff];
	if (!fmt) throw new Error(`Unsupported GX2 format 0x${surface.format.toString(16)}`);
	if (!surface.image) throw new Error('GX2 surface has no image data');
	const elemW = fmt.block ? Math.ceil(surface.width / 4) : surface.width;
	const elemH = fmt.block ? Math.ceil(surface.height / 4) : surface.height;
	const bytes = fmt.bpp / 8;
	const out = new Uint8Array(elemW * elemH * bytes);
	const src = surface.image;
	const mode = surface.tileMode;
	// 0 (default) and 16 (linear special) are linear like 1.
	if (![0, 1, 2, 4, 16].includes(mode)) throw new Error(`Unsupported GX2 tile mode ${mode}`);
	for (let y = 0; y < elemH; y++) {
		for (let x = 0; x < elemW; x++) {
			const addr =
				mode === 0 || mode === 1 || mode === 16
					? (y * surface.pitch + x) * bytes
					: mode === 2
						? addrMicroTiled(x, y, fmt.bpp, surface.pitch)
						: addrMacroTiled(x, y, fmt.bpp, surface.pitch, surface.swizzle);
			if (addr + bytes <= src.length) out.set(src.subarray(addr, addr + bytes), (y * elemW + x) * bytes);
		}
	}
	return { data: out, elemW, elemH, bpp: fmt.bpp };
}

/** Decode mip 0 of a surface to RGBA8 (row 0 at the top). */
export function decodeGx2Surface(surface: Gx2Surface): { width: number; height: number; pixels: Uint8Array } {
	const { data } = untileGx2(surface);
	const { width: w, height: h } = surface;
	const low = surface.format & 0xff;
	const snorm = (surface.format & 0x200) !== 0;
	let pixels: Uint8Array;
	switch (low) {
		case 0x01:
			pixels = new Uint8Array(w * h * 4);
			for (let i = 0; i < w * h; i++) pixels.set([data[i]!, data[i]!, data[i]!, 255], i * 4);
			break;
		case 0x07:
			pixels = new Uint8Array(w * h * 4);
			for (let i = 0; i < w * h; i++) pixels.set([data[i * 2]!, data[i * 2 + 1]!, 0, 255], i * 4);
			break;
		case 0x1a:
			pixels = data;
			break;
		case 0x31:
			pixels = decodeBC1(data, w, h);
			break;
		case 0x32:
			pixels = decodeBC2(data, w, h);
			break;
		case 0x33:
			pixels = decodeBC3(data, w, h);
			break;
		case 0x34:
			pixels = decodeBC4(data, w, h, { signed: snorm, mode: 'rgb' });
			break;
		case 0x35:
			pixels = decodeBC5(data, w, h, { signed: snorm, mode: 'rg' });
			break;
		default:
			throw new Error(`Unsupported GX2 format 0x${surface.format.toString(16)}`);
	}
	return { width: w, height: h, pixels };
}
