/**
 * @tootallnate/dds — Microsoft DirectDraw Surface (`.dds`)
 * texture decoder. Pure JS, no native deps.
 *
 * On-disk layout:
 *
 *   offset  size  field
 *     0     4     magic `'DDS '` (0x20534444)
 *     4     124   DDS_HEADER
 *   [128    20    DDS_HEADER_DXT10 — present only when
 *                  pixelFormat.fourCC == 'DX10']
 *     N     ...   pixel data (mip 0, then mip 1, ...)
 *
 * DDS_HEADER fields we use:
 *
 *   off 0   u32 dwSize          (always 124)
 *   off 4   u32 dwFlags
 *   off 8   u32 dwHeight
 *   off 12  u32 dwWidth
 *   off 16  u32 dwPitchOrLinearSize
 *   off 20  u32 dwDepth
 *   off 24  u32 dwMipMapCount
 *   off 28  u32[11] dwReserved1
 *   off 72  DDS_PIXELFORMAT (32 bytes):
 *           +0   u32 dwSize       (always 32)
 *           +4   u32 dwFlags
 *           +8   u32 dwFourCC      (DXT1/DXT3/DXT5/DX10/...)
 *           +12  u32 dwRGBBitCount
 *           +16  u32 dwRBitMask
 *           +20  u32 dwGBitMask
 *           +24  u32 dwBBitMask
 *           +28  u32 dwABitMask
 *   off 104 u32 dwCaps
 *   off 108 u32 dwCaps2
 *   off 112 u32 dwCaps3
 *   off 116 u32 dwCaps4
 *   off 120 u32 dwReserved2
 *
 * We support the most common formats — DXT1/3/5 + uncompressed
 * BGRA/RGBA, and DX10 BC1..BC7 via the bcn package (BC6H tone-mapped).
 */

import {
	decodeBC1,
	decodeBC2,
	decodeBC3,
	decodeBC4,
	decodeBC5,
	decodeBC6H,
	decodeBC7,
} from '@tootallnate/bcn';

export const DDS_MAGIC = 0x20534444 as const;

/** PixelFormat dwFlags. */
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;


export class DdsParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DdsParseError';
	}
}

export interface DdsPixelFormat {
	flags: number;
	fourCC: string;
	rgbBitCount: number;
	redMask: number;
	greenMask: number;
	blueMask: number;
	alphaMask: number;
}

export interface DdsHeader {
	width: number;
	height: number;
	depth: number;
	mipMapCount: number;
	pixelFormat: DdsPixelFormat;
	hasDX10Extension: boolean;
	dxgiFormat?: number;
}

export interface ParsedDds {
	header: DdsHeader;
	/** Detected human-readable format name (e.g. "BC3 (DXT5)", "BGRA8"). */
	formatLabel: string;
	/** Decoded RGBA8 pixels, row-major top-down. width × height × 4 bytes. */
	pixels: Uint8Array;
	width: number;
	height: number;
}

function fourCCToString(value: number): string {
	return (
		String.fromCharCode(value & 0xff) +
		String.fromCharCode((value >> 8) & 0xff) +
		String.fromCharCode((value >> 16) & 0xff) +
		String.fromCharCode((value >> 24) & 0xff)
	);
}

export function isDds(bytes: Uint8Array): boolean {
	if (bytes.length < 128) return false;
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	return view.getUint32(0, true) === DDS_MAGIC;
}

export function parseDds(bytes: Uint8Array): ParsedDds {
	if (!isDds(bytes)) {
		throw new DdsParseError('Buffer is not a DDS file (magic mismatch)');
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const headerSize = view.getUint32(4, true);
	if (headerSize !== 124) {
		throw new DdsParseError(
			`DDS header size is ${headerSize}, expected 124`,
		);
	}
	const height = view.getUint32(12, true);
	const width = view.getUint32(16, true);
	const depth = view.getUint32(24, true);
	const mipMapCount = view.getUint32(28, true);
	const pfFlags = view.getUint32(80, true);
	const pfFourCC = view.getUint32(84, true);
	const pfRgbBitCount = view.getUint32(88, true);
	const pfRedMask = view.getUint32(92, true);
	const pfGreenMask = view.getUint32(96, true);
	const pfBlueMask = view.getUint32(100, true);
	const pfAlphaMask = view.getUint32(104, true);

	const pixelFormat: DdsPixelFormat = {
		flags: pfFlags,
		fourCC: fourCCToString(pfFourCC),
		rgbBitCount: pfRgbBitCount,
		redMask: pfRedMask,
		greenMask: pfGreenMask,
		blueMask: pfBlueMask,
		alphaMask: pfAlphaMask,
	};

	let pixelOffset = 128;
	let hasDX10Extension = false;
	let dxgiFormat: number | undefined;
	if (pixelFormat.fourCC === 'DX10') {
		hasDX10Extension = true;
		if (bytes.length < 148) {
			throw new DdsParseError(
				'DX10 extension declared but file too short',
			);
		}
		dxgiFormat = view.getUint32(128, true);
		pixelOffset = 148;
	}

	const header: DdsHeader = {
		width,
		height,
		depth,
		mipMapCount,
		pixelFormat,
		hasDX10Extension,
		dxgiFormat,
	};

	// Decode mip 0.
	const compressedData = bytes.subarray(pixelOffset);
	const { pixels, formatLabel } = decodePixels(header, compressedData);
	return { header, formatLabel, pixels, width, height };
}

function decodePixels(
	header: DdsHeader,
	data: Uint8Array,
): { pixels: Uint8Array; formatLabel: string } {
	const { width, height, pixelFormat: pf, hasDX10Extension, dxgiFormat } = header;
	if (pf.flags & DDPF_FOURCC) {
		switch (pf.fourCC) {
			case 'DXT1':
				return { pixels: decodeBC1(data, width, height).pixels, formatLabel: 'BC1 (DXT1)' };
			case 'DXT3':
				return { pixels: decodeBC2(data, width, height).pixels, formatLabel: 'BC2 (DXT3)' };
			case 'DXT5':
				return { pixels: decodeBC3(data, width, height).pixels, formatLabel: 'BC3 (DXT5)' };
			case 'BC4U':
			case 'ATI1':
				return { pixels: decodeBC4(data, width, height).pixels, formatLabel: 'BC4U (ATI1)' };
			case 'BC5U':
			case 'ATI2':
				return { pixels: decodeBC5(data, width, height).pixels, formatLabel: 'BC5U (ATI2)' };
			case 'DX10':
				return decodeDX10(width, height, dxgiFormat ?? 0, data);
			default: {
				// Legacy D3DFORMAT codes stored as a number instead of four characters.
				const code = pf.fourCC.charCodeAt(0) | (pf.fourCC.charCodeAt(1) << 8);
				const legacy = D3DFMT_CHANNELS[code];
				if (legacy && pf.fourCC.charCodeAt(2) === 0) return { pixels: decodeChannels(width, height, data, legacy), formatLabel: legacy.label };
				throw new DdsParseError(`Unsupported DDS fourCC "${pf.fourCC}"`);
			}
		}
	}
	if (pf.flags & DDPF_RGB) {
		return decodeUncompressedRgb(width, height, pf, data);
	}
	if (pf.flags & DDPF_LUMINANCE) {
		const alpha = (pf.flags & DDPF_ALPHAPIXELS) !== 0;
		const bpp = pf.rgbBitCount;
		const layout: ChannelLayout | null =
			bpp === 8 && !alpha ? { label: 'L8', type: 'u8', channels: 1 } : bpp === 16 && alpha ? { label: 'A8L8', type: 'u8', channels: 2, luminanceAlpha: true } : bpp === 16 ? { label: 'L16', type: 'u16', channels: 1 } : null;
		if (layout) return { pixels: decodeChannels(width, height, data, layout), formatLabel: layout.label };
	}
	throw new DdsParseError(
		`Unsupported DDS pixel format (flags=0x${pf.flags.toString(16)}, fourCC="${pf.fourCC}")`,
	);
	void hasDX10Extension;
}

function decodeDX10(
	width: number,
	height: number,
	dxgiFormat: number,
	data: Uint8Array,
): { pixels: Uint8Array; formatLabel: string } {
	// Common DXGI_FORMAT values used by DDS:
	//   71 / 72 = BC1_UNORM / BC1_UNORM_SRGB
	//   74 / 75 = BC2_UNORM / BC2_UNORM_SRGB
	//   77 / 78 = BC3_UNORM / BC3_UNORM_SRGB
	//   80 / 81 = BC4_UNORM / BC4_SNORM
	//   83 / 84 = BC5_UNORM / BC5_SNORM
	//   95 / 96 = BC6H_UF16 / BC6H_SF16 (tone-mapped to 8-bit)
	//   98 / 99 = BC7_UNORM / BC7_UNORM_SRGB
	//   28 / 29 = R8G8B8A8_UNORM / _SRGB
	//   87 / 91 = B8G8R8A8_UNORM / _SRGB, 88 = B8G8R8X8_UNORM
	switch (dxgiFormat) {
		case 71:
		case 72:
			return { pixels: decodeBC1(data, width, height).pixels, formatLabel: `BC1 (DXGI ${dxgiFormat})` };
		case 74:
		case 75:
			return { pixels: decodeBC2(data, width, height).pixels, formatLabel: `BC2 (DXGI ${dxgiFormat})` };
		case 77:
		case 78:
			return { pixels: decodeBC3(data, width, height).pixels, formatLabel: `BC3 (DXGI ${dxgiFormat})` };
		case 80:
		case 81:
			return { pixels: decodeBC4(data, width, height).pixels, formatLabel: `BC4 (DXGI ${dxgiFormat})` };
		case 83:
		case 84:
			return { pixels: decodeBC5(data, width, height).pixels, formatLabel: `BC5 (DXGI ${dxgiFormat})` };
		case 95:
		case 96:
			return { pixels: decodeBC6H(data, width, height, dxgiFormat === 96).pixels, formatLabel: `BC6H (DXGI ${dxgiFormat})` };
		case 98:
		case 99:
			return { pixels: decodeBC7(data, width, height).pixels, formatLabel: `BC7 (DXGI ${dxgiFormat})` };
		case 28:
		case 29: {
			const out = new Uint8Array(width * height * 4);
			out.set(data.subarray(0, out.length));
			return { pixels: out, formatLabel: 'RGBA8 (DX10)' };
		}
		case 87:
		case 88:
		case 91: {
			// B8G8R8A8 (87/91 sRGB) and B8G8R8X8 (88).
			const out = new Uint8Array(width * height * 4);
			for (let i = 0; i < width * height && i * 4 + 3 < data.length; i++) {
				out[i * 4] = data[i * 4 + 2]!;
				out[i * 4 + 1] = data[i * 4 + 1]!;
				out[i * 4 + 2] = data[i * 4]!;
				out[i * 4 + 3] = dxgiFormat === 88 ? 255 : data[i * 4 + 3]!;
			}
			return { pixels: out, formatLabel: 'BGRA8 (DX10)' };
		}
		default:
			if (DXGI_CHANNELS[dxgiFormat]) {
				const l = DXGI_CHANNELS[dxgiFormat]!;
				return { pixels: decodeChannels(width, height, data, l), formatLabel: l.label };
			}
			throw new DdsParseError(
				`Unsupported DDS DX10 dxgiFormat ${dxgiFormat}`,
			);
	}
}

interface ChannelLayout {
	label: string;
	type: 'u8' | 'u16' | 'f16' | 'f32';
	channels: 1 | 2 | 3 | 4;
	/** Two channels are luminance + alpha rather than red + green. */
	luminanceAlpha?: boolean;
}

/** D3DFMT codes found as numeric fourCCs. */
const D3DFMT_CHANNELS: Record<number, ChannelLayout> = {
	36: { label: 'A16B16G16R16', type: 'u16', channels: 4 },
	111: { label: 'R16F', type: 'f16', channels: 1 },
	112: { label: 'G16R16F', type: 'f16', channels: 2 },
	113: { label: 'A16B16G16R16F', type: 'f16', channels: 4 },
	114: { label: 'R32F', type: 'f32', channels: 1 },
	115: { label: 'G32R32F', type: 'f32', channels: 2 },
	116: { label: 'A32B32G32R32F', type: 'f32', channels: 4 },
};

/** Plain-channel DXGI formats (one value per channel, R first). */
const DXGI_CHANNELS: Record<number, ChannelLayout> = {
	2: { label: 'R32G32B32A32_FLOAT', type: 'f32', channels: 4 },
	6: { label: 'R32G32B32_FLOAT', type: 'f32', channels: 3 },
	10: { label: 'R16G16B16A16_FLOAT', type: 'f16', channels: 4 },
	11: { label: 'R16G16B16A16_UNORM', type: 'u16', channels: 4 },
	16: { label: 'R32G32_FLOAT', type: 'f32', channels: 2 },
	34: { label: 'R16G16_FLOAT', type: 'f16', channels: 2 },
	35: { label: 'R16G16_UNORM', type: 'u16', channels: 2 },
	41: { label: 'R32_FLOAT', type: 'f32', channels: 1 },
	49: { label: 'R8G8_UNORM', type: 'u8', channels: 2 },
	54: { label: 'R16_FLOAT', type: 'f16', channels: 1 },
	56: { label: 'R16_UNORM', type: 'u16', channels: 1 },
	61: { label: 'R8_UNORM', type: 'u8', channels: 1 },
	65: { label: 'A8_UNORM', type: 'u8', channels: 1 },
};

function half(h: number): number {
	const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? 0 : s * 65504;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * Plain channels to RGBA8, values clamped to 0..1 (these are mostly data
 * textures: lookup tables, vertex-animation positions). One channel is
 * grey, two are red and green (or luminance and alpha).
 */
function decodeChannels(width: number, height: number, data: Uint8Array, l: ChannelLayout): Uint8Array {
	const size = l.type === 'u8' ? 1 : l.type === 'f32' ? 4 : 2;
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const read = (o: number) => {
		if (o + size > data.length) return 0;
		switch (l.type) {
			case 'u8':
				return data[o]! / 255;
			case 'u16':
				return dv.getUint16(o, true) / 65535;
			case 'f16':
				return half(dv.getUint16(o, true));
			default:
				return dv.getFloat32(o, true);
		}
	};
	const to8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
	const out = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const o = i * l.channels * size;
		const c = [0, 1, 2, 3].map((k) => (k < l.channels ? read(o + k * size) : 0));
		let r: number, g: number, b: number, a: number;
		if (l.channels === 1) [r, g, b, a] = [c[0]!, c[0]!, c[0]!, 1];
		else if (l.channels === 2) [r, g, b, a] = l.luminanceAlpha ? [c[0]!, c[0]!, c[0]!, c[1]!] : [c[0]!, c[1]!, 0, 1];
		else [r, g, b, a] = [c[0]!, c[1]!, c[2]!, l.channels === 4 ? c[3]! : 1];
		out[i * 4] = to8(r);
		out[i * 4 + 1] = to8(g);
		out[i * 4 + 2] = to8(b);
		out[i * 4 + 3] = to8(a);
	}
	return out;
}

function decodeUncompressedRgb(
	width: number,
	height: number,
	pf: DdsPixelFormat,
	data: Uint8Array,
): { pixels: Uint8Array; formatLabel: string } {
	const bpp = pf.rgbBitCount;
	if (bpp !== 32 && bpp !== 24) {
		throw new DdsParseError(
			`Unsupported uncompressed DDS bit count ${bpp}`,
		);
	}
	const out = new Uint8Array(width * height * 4);
	const bytesPerPixel = bpp >> 3;
	const stride = width * bytesPerPixel;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * stride + x * bytesPerPixel;
			const r = data[i + 2] ?? 0;
			const g = data[i + 1] ?? 0;
			const b = data[i + 0] ?? 0;
			const a = bpp === 32 ? (data[i + 3] ?? 255) : 255;
			const o = (y * width + x) * 4;
			out[o + 0] = r;
			out[o + 1] = g;
			out[o + 2] = b;
			out[o + 3] = a;
		}
	}
	return {
		pixels: out,
		formatLabel: bpp === 32 ? 'BGRA8' : 'BGR8',
	};
}
