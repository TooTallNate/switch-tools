/**
 * PlatinumGames texture banks: `.wta` (headers, in the `.dat`) +
 * `.wtp` (pixels, in the paired `.dtt`), or `.wtb` (both in one file).
 *
 * Both start with the same `WTB\0` header (little-endian), from
 * Kerilk's `Astral Chain wta.bt` / `wtb.rb`:
 *
 *   0x00 'WTB\0'
 *   0x04 u32 version
 *   0x08 u32 texture count
 *   0x0c u32 offset of u32 texture data offsets (into the .wtp, or this file)
 *   0x10 u32 offset of u32 texture data sizes
 *   0x14 u32 offset of u32 texture flags
 *   0x18 u32 offset of u32 texture ids (the hashes materials refer to)
 *   0x1c u32 offset of the 0x38-byte XT1 texture infos (Switch)
 *
 * The Switch XT1 info describes a Tegra block-linear surface:
 *
 *   0x00 'XT1\0'
 *   0x04 u32 unknown
 *   0x08 u64 data size
 *   0x10 u32 header size (0x38)
 *   0x14 u32 mip count
 *   0x18 u32 type (0 1D, 1 2D, 2 3D, 3 cube, …)
 *   0x1c u32 format: an NVN texture format code
 *   0x20 u32 width, 0x24 height, 0x28 depth
 *   0x2c u32 special pad
 *   0x30 u8  block-height log2
 *   0x31 u8  flags
 *
 * The NVN format codes follow the public NVN enum (`RGBA8` = 0x25,
 * `RGBA8_SRGB` = 0x38, the DXT / RGTC / BPTC blocks at 0x42–0x50,
 * ASTC from 0x79), which we map onto BNTX format codes so the
 * `@tootallnate/bntx` deswizzler and block decoders do the work.
 */
import {
	decodeBntxLayer,
	formatInfo,
	type BntxAstcDecoder,
	type BntxTexture,
	type DecodedTexture,
} from '@tootallnate/bntx';

export interface WtaTexture {
	index: number;
	/** Texture id: the hash materials reference. */
	id: number;
	/** Data offset in the `.wtp` (or this file, for `.wtb`). */
	offset: number;
	size: number;
	flags: number;
	/** XT1 surface info (Switch). Absent for other platforms. */
	xt1?: Xt1Info;
}

export interface Xt1Info {
	mipCount: number;
	type: number;
	/** NVN format code. */
	format: number;
	width: number;
	height: number;
	depth: number;
	blockHeightLog2: number;
	flags: number;
	dataSize: number;
}

export interface Wta {
	version: number;
	textures: WtaTexture[];
}

export function isWtb(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x57 && head[1] === 0x54 && head[2] === 0x42 && head[3] === 0x00;
}

export function parseWta(bytes: Uint8Array): Wta {
	if (!isWtb(bytes)) throw new Error('Not a WTA / WTB (missing "WTB\\0" magic)');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint32(4, true);
	const count = dv.getUint32(8, true);
	const offOffsets = dv.getUint32(0x0c, true);
	const offSizes = dv.getUint32(0x10, true);
	const offFlags = dv.getUint32(0x14, true);
	const offIds = dv.getUint32(0x18, true);
	const offInfo = dv.getUint32(0x1c, true);
	if (count > 100_000) throw new Error('WTA texture count is implausible');
	const u32 = (table: number, i: number) => (table && table + i * 4 + 4 <= bytes.length ? dv.getUint32(table + i * 4, true) : 0);
	const textures: WtaTexture[] = [];
	for (let i = 0; i < count; i++) {
		const t: WtaTexture = {
			index: i,
			id: u32(offIds, i),
			offset: u32(offOffsets, i),
			size: u32(offSizes, i),
			flags: u32(offFlags, i),
		};
		const ib = offInfo + i * 0x38;
		if (offInfo && ib + 0x38 <= bytes.length && dv.getUint32(ib, false) === 0x58543100) {
			t.xt1 = {
				dataSize: Number(dv.getBigUint64(ib + 8, true)),
				mipCount: dv.getUint32(ib + 0x14, true),
				type: dv.getUint32(ib + 0x18, true),
				format: dv.getUint32(ib + 0x1c, true),
				width: dv.getUint32(ib + 0x20, true),
				height: dv.getUint32(ib + 0x24, true),
				depth: dv.getUint32(ib + 0x28, true),
				blockHeightLog2: bytes[ib + 0x30],
				flags: bytes[ib + 0x31],
			};
		}
		textures.push(t);
	}
	return { version, textures };
}

/** NVN format code → BNTX format code (family << 8 | data type). */
const NVN_TO_BNTX: Record<number, number> = {
	0x01: 0x0201, // R8
	0x0d: 0x0901, // RG8
	0x25: 0x0b01, // RGBA8
	0x37: 0x0b06, // RGBX8_SRGB
	0x38: 0x0b06, // RGBA8_SRGB
	0x39: 0x0301, // RGBA4
	0x3b: 0x0501, // RGB5A1
	0x3c: 0x0701, // RGB565
	0x3d: 0x0e01, // RGB10A2
	0x41: 0x1a01, // RGB_DXT1
	0x42: 0x1a01, // RGBA_DXT1
	0x43: 0x1b01, // RGBA_DXT3
	0x44: 0x1c01, // RGBA_DXT5
	0x45: 0x1a06, // RGB_DXT1_SRGB
	0x46: 0x1a06, // RGBA_DXT1_SRGB
	0x47: 0x1b06, // RGBA_DXT3_SRGB
	0x48: 0x1c06, // RGBA_DXT5_SRGB
	0x49: 0x1d01, // RGTC1_UNORM (BC4)
	0x4a: 0x1d02, // RGTC1_SNORM
	0x4b: 0x1e01, // RGTC2_UNORM (BC5)
	0x4c: 0x1e02, // RGTC2_SNORM
	0x4d: 0x2001, // BPTC_UNORM (BC7)
	0x4e: 0x2006, // BPTC_UNORM_SRGB
	0x4f: 0x1f05, // BPTC_SFLOAT (BC6H signed)
	0x50: 0x1f0a, // BPTC_UFLOAT (BC6H)
};
// ASTC: 14 block sizes, UNORM from 0x79 then SRGB from 0x87; BNTX
// families 0x2d..0x3a in the same order.
for (let i = 0; i < 14; i++) {
	NVN_TO_BNTX[0x79 + i] = ((0x2d + i) << 8) | 0x01;
	NVN_TO_BNTX[0x87 + i] = ((0x2d + i) << 8) | 0x06;
}

/** Human-readable name for an XT1 (NVN) format, or `0x..` when unknown. */
export function xt1FormatName(format: number): string {
	const code = NVN_TO_BNTX[format];
	if (code === undefined) return `NVN 0x${format.toString(16)}`;
	try {
		return formatInfo(code).name;
	} catch {
		return `NVN 0x${format.toString(16)}`;
	}
}

export function xt1Supported(format: number): boolean {
	return NVN_TO_BNTX[format] !== undefined;
}

/**
 * Decode mip 0 (first layer / face) of a texture to RGBA8.
 * `data` is the `.wtp` (or `.wtb`) holding the pixels.
 */
export function decodeWtaTexture(
	data: Uint8Array,
	tex: WtaTexture,
	options: { astcDecoder?: BntxAstcDecoder } = {},
): DecodedTexture {
	const x = tex.xt1;
	if (!x) throw new Error('Only Switch (XT1) textures are supported');
	const code = NVN_TO_BNTX[x.format];
	if (code === undefined) throw new Error(`Unsupported XT1 texture format 0x${x.format.toString(16)}`);
	const info = formatInfo(code);
	const layers = x.type === 3 || x.type === 8 ? 6 * Math.max(1, x.depth) : Math.max(1, x.depth);
	const bt: BntxTexture = {
		index: tex.index,
		name: '',
		format: code,
		formatInfo: info,
		width: x.width,
		height: x.height,
		mipCount: x.mipCount,
		arrayLength: layers,
		blockHeightLog2: x.blockHeightLog2,
		imageSize: tex.size,
		layerSize: Math.floor(tex.size / layers),
		mipOffset: tex.offset,
		srgb: info.srgb,
	};
	return decodeBntxLayer(data, bt, 0, options);
}
