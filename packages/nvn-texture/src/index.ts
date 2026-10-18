/**
 * NVN texture files (`DFvN`): textures serialised straight from an NVN
 * texture builder. The Switch SDK's debug-text font
 * (`System/font/nvn_font/nvn_font.ntx`, `nvn_font_jis1.ntx`) ships this way.
 *
 * Layout (little-endian), from the files themselves:
 *
 *   0x00 "DFvN", u32 header size (0x10), u32 texture count, u32
 *   0x10 "HBvN" texture block: u32 0x24, u32 block size (0x70), …
 *        0x3C u32 width, 0x40 u32 height, 0x50 u32 NVN format
 *   then another "HBvN" block whose u32 at +0x10 is its size. The texture
 *   data starts at its end (0x200), as Tegra block-linear layers of
 *   width × height, followed by a short trailer.
 *
 * NVN format numbers follow `nvn::Format` (R8 = 0x01, RGBA8 = 0x25,
 * RGBA8 sRGB = 0x38, DXT1/3/5 = 0x42–0x44 and 0x46–0x48 sRGB,
 * RGTC1 = 0x49 / 0x4A, RGTC2 = 0x4B / 0x4C).
 */
import { decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5, deswizzle } from '@tootallnate/bntx';

interface FormatInfo {
	name: string;
	block: boolean;
	bytes: number;
	decode: (data: Uint8Array, w: number, h: number) => Uint8Array;
}

const grey = (data: Uint8Array, w: number, h: number) => {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) out.set([data[i]!, data[i]!, data[i]!, 255], i * 4);
	return out;
};

const FORMATS: Record<number, FormatInfo> = {
	0x01: { name: 'R8', block: false, bytes: 1, decode: grey },
	0x25: { name: 'RGBA8', block: false, bytes: 4, decode: (d) => d },
	0x38: { name: 'RGBA8_SRGB', block: false, bytes: 4, decode: (d) => d },
	0x42: { name: 'DXT1', block: true, bytes: 8, decode: decodeBC1 },
	0x43: { name: 'DXT3', block: true, bytes: 16, decode: decodeBC2 },
	0x44: { name: 'DXT5', block: true, bytes: 16, decode: decodeBC3 },
	0x46: { name: 'DXT1_SRGB', block: true, bytes: 8, decode: decodeBC1 },
	0x47: { name: 'DXT3_SRGB', block: true, bytes: 16, decode: decodeBC2 },
	0x48: { name: 'DXT5_SRGB', block: true, bytes: 16, decode: decodeBC3 },
	0x49: { name: 'RGTC1', block: true, bytes: 8, decode: (d, w, h) => decodeBC4(d, w, h, { mode: 'rgb' }) },
	0x4a: { name: 'RGTC1_SNORM', block: true, bytes: 8, decode: (d, w, h) => decodeBC4(d, w, h, { signed: true, mode: 'rgb' }) },
	0x4b: { name: 'RGTC2', block: true, bytes: 16, decode: (d, w, h) => decodeBC5(d, w, h, { mode: 'rg' }) },
	0x4c: { name: 'RGTC2_SNORM', block: true, bytes: 16, decode: (d, w, h) => decodeBC5(d, w, h, { signed: true, mode: 'rg' }) },
};

export interface ParsedNvnTexture {
	width: number;
	height: number;
	format: number;
	formatName: string;
	dataOffset: number;
	layerSize: number;
	layers: number;
}

export function isNvnTexture(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'DFvN';
}

export function parseNvnTexture(bytes: Uint8Array): ParsedNvnTexture {
	if (!isNvnTexture(bytes)) throw new Error('Not an NVN texture (bad magic)');
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 0x80) throw new Error('NVN texture too small');
	const width = v.getUint32(0x3c, true);
	const height = v.getUint32(0x40, true);
	const format = v.getUint32(0x50, true);
	const fmt = FORMATS[format];
	if (!fmt) throw new Error(`Unsupported NVN format 0x${format.toString(16)}`);
	// The data follows the last HBvN block.
	let dataOffset = 0;
	for (let o = 0x10 + v.getUint32(0x18, true); o + 0x14 <= bytes.length && o < 0x1000; o += 4) {
		if (String.fromCharCode(...bytes.subarray(o, o + 4)) === 'HBvN') {
			dataOffset = o + v.getUint32(o + 0x10, true);
			break;
		}
	}
	if (!dataOffset || dataOffset >= bytes.length) throw new Error('NVN texture data not found');
	const elems = fmt.block ? Math.ceil(width / 4) * Math.ceil(height / 4) : width * height;
	const layerSize = elems * fmt.bytes;
	const layers = Math.floor((bytes.length - dataOffset) / layerSize);
	if (layers < 1) throw new Error('NVN texture data is truncated');
	return { width, height, format, formatName: fmt.name, dataOffset, layerSize, layers };
}

/** Decode one layer to RGBA8 (row 0 at the top). */
export function decodeNvnTexture(bytes: Uint8Array, tex: ParsedNvnTexture, layer = 0): Uint8Array {
	const fmt = FORMATS[tex.format]!;
	const start = tex.dataOffset + layer * tex.layerSize;
	const linear = deswizzle({
		width: tex.width,
		height: tex.height,
		blkWidth: fmt.block ? 4 : 1,
		blkHeight: fmt.block ? 4 : 1,
		bytesPerBlock: fmt.bytes,
		data: bytes.subarray(start, start + tex.layerSize),
		blockHeight: 16,
	});
	return fmt.decode(linear, tex.width, tex.height);
}
