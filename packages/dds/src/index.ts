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
 * BGRA/RGBA. DX10 (BC4..7) is partially handled (BC4/BC5 via the
 * bcn package).
 */

import {
	decodeBC1,
	decodeBC2,
	decodeBC3,
	decodeBC4,
	decodeBC5,
} from '@tootallnate/bcn';

export const DDS_MAGIC = 0x20534444 as const;

/** PixelFormat dwFlags. */
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;
void DDPF_ALPHAPIXELS;
void DDPF_LUMINANCE;

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
			default:
				throw new DdsParseError(
					`Unsupported DDS fourCC "${pf.fourCC}"`,
				);
		}
	}
	if (pf.flags & DDPF_RGB) {
		return decodeUncompressedRgb(width, height, pf, data);
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
	//   87 = R8G8B8A8_UNORM,  88 = R8G8B8A8_UNORM_SRGB
	//   28 = R8G8B8A8_UNORM (alt)
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
		case 87:
		case 88:
		case 28: {
			const out = new Uint8Array(width * height * 4);
			out.set(data.subarray(0, out.length));
			return { pixels: out, formatLabel: 'RGBA8 (DX10)' };
		}
		default:
			throw new DdsParseError(
				`Unsupported DDS DX10 dxgiFormat ${dxgiFormat}`,
			);
	}
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
