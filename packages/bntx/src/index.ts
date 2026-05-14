/**
 * BNTX — "Binary NinTeXture", Nintendo's standard texture format
 * on Switch / Wii U.
 *
 * Used by every NintendoWare-based game on Switch / Wii U for
 * everything from character textures to UI atlases to
 * normal maps. Each `.bntx` file is a small container that holds
 * one or more 2D textures (or 2D arrays); each texture has a fixed
 * format (BC1..BC7, ASTC, RGBA8, …) and is stored in Tegra X1
 * block-linear layout.
 *
 * This package exposes:
 *
 *   - {@link parseBntx}: header + BRTI walk → array of texture
 *     metadata records.
 *   - {@link decodeBntxLayer}: deswizzle + format-decode a single
 *     array layer to RGBA8.
 *   - {@link decodeBntxToRgba}: convenience wrapper that returns
 *     `{ width, height, pixels }` for the texture's first layer
 *     (mip-0, layer-0).
 *
 * The deswizzler and decoders are direct ports from
 * `aboood40091/BNTX-Extractor` (the Python reference) plus the
 * Microsoft BC7 spec for the high-quality block formats.
 *
 * References (read line-by-line):
 *   - https://github.com/aboood40091/BNTX-Extractor
 *   - https://learn.microsoft.com/en-us/windows/win32/direct3d11/bc7-format-mode-reference
 */

export const BNTX_MAGIC = 'BNTX';

import { formatInfo, formatName, type FormatInfo } from './format.js';
import { deswizzle, blockHeightFromLog2 } from './swizzle.js';
import {
	decodeRgba8,
	decodeBgra8,
	decodeR8,
	decodeRg8,
	decodeR4G4,
	decodeR5G6B5,
	decodeB5G6R5,
	decodeR4G4B4A4,
	decodeR5G5B5A1,
} from './decode-uncompressed.js';
import {
	decodeBC1,
	decodeBC2,
	decodeBC3,
	decodeBC4,
	decodeBC5,
} from './decode-bc.js';
import { decodeBC7 } from './decode-bc7.js';

export { formatName, type FormatInfo } from './format.js';
export { deswizzle, type DeswizzleOptions, pickBlockHeight } from './swizzle.js';

export type Endian = 'big' | 'little';

/**
 * Per-texture metadata, parsed from a BNTX BRTI block.
 */
export interface BntxTexture {
	/** Sequential index in the BNTX. */
	index: number;
	/** Texture name from the BNTX string table, or the empty string. */
	name: string;
	/** Format code (the original u32 value). */
	format: number;
	/** Convenient format breakdown — see {@link FormatInfo}. */
	formatInfo: FormatInfo;
	width: number;
	height: number;
	/** Number of mipmap levels (we only decode mip-0). */
	mipCount: number;
	/** Number of array layers (1 for a normal 2D, >1 for arrays / cube faces). */
	arrayLength: number;
	/** Tegra block-height exponent (`textureLayout & 7`). */
	blockHeightLog2: number;
	/** Total swizzled-data size in bytes (across all mips and layers). */
	imageSize: number;
	/** Per-layer swizzled-data size in bytes (`imageSize / arrayLength`). */
	layerSize: number;
	/** Absolute offset (in the source bytes) of mip-0 data. */
	mipOffset: number;
	/** Whether the texture is sRGB-encoded (low byte of format == 0x06). */
	srgb: boolean;
}

export interface ParsedBntx {
	endian: Endian;
	/** Source target (`"NX  "` for Switch, `"Gen "` for Wii U). */
	target: string;
	/** Total texture count. */
	textureCount: number;
	/** Decoded textures, in declaration order. */
	textures: BntxTexture[];
}

/** Cheap (4-byte) magic check. */
export async function isBntx(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return head[0] === 0x42 && head[1] === 0x4e && head[2] === 0x54 && head[3] === 0x58;
}

/**
 * Parse a BNTX container's header and all of its BRTI texture-info
 * blocks. The texture's image data is left as-is in the source
 * `Uint8Array` — call {@link decodeBntxLayer} or
 * {@link decodeBntxToRgba} to decode the actual pixels.
 *
 * Memory: we hold a reference to the source `Uint8Array` and read
 * it lazily in the decoders, so callers should keep it alive until
 * they're done.
 */
export function parseBntx(bytes: Uint8Array): ParsedBntx {
	if (bytes.length < 0x40 || !isBntxBytes(bytes)) {
		throw new Error('Not a BNTX (missing magic)');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// BNTX BOM at 0x0c: 0xFFFE = LE (Switch), 0xFEFF = BE (Wii U).
	const bom = view.getUint16(0x0c, false);
	const endian: Endian = bom === 0xfeff ? 'big' : 'little';
	const le = endian === 'little';
	const target = String.fromCharCode(
		bytes[0x20],
		bytes[0x21],
		bytes[0x22],
		bytes[0x23],
	);
	const count = view.getUint32(0x24, le);
	const infoPtrsAddr = Number(view.getBigUint64(0x28, le));
	const strDictAddr = Number(view.getBigUint64(0x30, le));

	if (count === 0) {
		return { endian, target, textureCount: 0, textures: [] };
	}

	const textures: BntxTexture[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const brtiOff = Number(view.getBigUint64(infoPtrsAddr + i * 8, le));
		if (
			bytes[brtiOff] !== 0x42 ||
			bytes[brtiOff + 1] !== 0x52 ||
			bytes[brtiOff + 2] !== 0x54 ||
			bytes[brtiOff + 3] !== 0x49
		) {
			throw new Error(`Expected BRTI at offset ${brtiOff} (texture ${i})`);
		}
		// BRTI starts with a 16-byte block header, then TextureInfo.
		const ti = brtiOff + 0x10;
		const format = view.getUint32(ti + 0x0c, le);
		const width = view.getInt32(ti + 0x14, le);
		const height = view.getInt32(ti + 0x18, le);
		const mipCount = view.getUint16(ti + 0x06, le);
		const arrayLength = view.getUint32(ti + 0x20, le);
		const textureLayout = view.getUint32(ti + 0x24, le);
		const blockHeightLog2 = textureLayout & 0x07;
		const imageSize = view.getUint32(ti + 0x40, le);
		const nameAddr = Number(view.getBigInt64(ti + 0x50, le));
		const ptrsAddr = Number(view.getBigUint64(ti + 0x60, le));
		const mipOffset = Number(view.getBigUint64(ptrsAddr, le));
		const layerSize = arrayLength > 0 ? Math.floor(imageSize / arrayLength) : imageSize;

		// Names live in a separate string-dictionary table referenced
		// from `nameAddr`; the format is `(u16 length, utf-8 bytes)`.
		// `strDictAddr` is the dictionary header but we just use the
		// per-texture pointer.
		let name = '';
		if (nameAddr > 0 && nameAddr + 2 <= bytes.length) {
			const nameLen = view.getUint16(nameAddr, le);
			if (nameAddr + 2 + nameLen <= bytes.length) {
				name = new TextDecoder('utf-8').decode(
					bytes.subarray(nameAddr + 2, nameAddr + 2 + nameLen),
				);
			}
		}
		void strDictAddr;

		let info: FormatInfo;
		try {
			info = formatInfo(format);
		} catch {
			info = {
				code: format,
				name: formatName(format),
				family: (format >> 8) & 0xff,
				dataType: format & 0xff,
				blkWidth: 1,
				blkHeight: 1,
				bytesPerBlock: 1,
				srgb: false,
				isBcn: false,
				isAstc: false,
			};
		}

		textures[i] = {
			index: i,
			name,
			format,
			formatInfo: info,
			width,
			height,
			mipCount,
			arrayLength: Math.max(1, arrayLength),
			blockHeightLog2,
			imageSize,
			layerSize,
			mipOffset,
			srgb: info.srgb,
		};
	}
	return { endian, target, textureCount: count, textures };
}

function isBntxBytes(bytes: Uint8Array): boolean {
	return bytes[0] === 0x42 && bytes[1] === 0x4e && bytes[2] === 0x54 && bytes[3] === 0x58;
}

export interface DecodedTexture {
	width: number;
	height: number;
	/** Row-major RGBA8 pixels, top-left origin. */
	pixels: Uint8Array;
}

/**
 * Decode a single array layer of a BNTX texture to row-major RGBA8.
 *
 * Throws for unsupported format families (currently BC6 HDR, ASTC,
 * and the 10-10-10-2 / RGB565 BGRA8 variants we haven't seen in
 * the wild).
 */
/**
 * Synchronous ASTC block-stream → RGBA8 decoder, supplied by the
 * caller. Allows decoding ASTC-compressed BNTX layers without
 * baking a WASM dep into this package.
 *
 * The caller is expected to await `AstcDecoder.create()` once and
 * pass a closure that calls the resulting `decoder.decode(...)`.
 * `decodeBntxLayer` stays synchronous so the BFRES viewer's
 * texture-cache loop and other tight call sites don't have to
 * become async.
 *
 * Contract:
 *   - `src` holds `ceil(w/blkW) * ceil(h/blkH) * 16` bytes of ASTC
 *     blocks (post-deswizzle, linear order).
 *   - Returns a fresh `Uint8Array(w * h * 4)` of RGBA8 pixels,
 *     top-down rows.
 *
 * Pass `null` / undefined to fall back to the legacy "ASTC not
 * supported" error path; useful when the caller is intentionally
 * BCn-only.
 */
export type BntxAstcDecoder = (
	width: number,
	height: number,
	blockW: number,
	blockH: number,
	src: Uint8Array,
) => Uint8Array;

export interface DecodeBntxLayerOptions {
	/** Optional sync ASTC decoder, used when the texture is ASTC-format. */
	astcDecoder?: BntxAstcDecoder;
}

export function decodeBntxLayer(
	bytes: Uint8Array,
	tex: BntxTexture,
	layerIndex: number = 0,
	options: DecodeBntxLayerOptions = {},
): DecodedTexture {
	if (layerIndex < 0 || layerIndex >= tex.arrayLength) {
		throw new Error(
			`Layer index ${layerIndex} out of range (0..${tex.arrayLength - 1})`,
		);
	}
	const info = tex.formatInfo;
	const layerStart = tex.mipOffset + layerIndex * tex.layerSize;
	const layerEnd = Math.min(bytes.length, layerStart + tex.layerSize);
	const swizzled = bytes.subarray(layerStart, layerEnd);

	if (info.isAstc) {
		if (!options.astcDecoder) {
			throw new Error(
				`ASTC textures need an ASTC decoder (format ${info.name}). ` +
					`Pass \`options.astcDecoder\` from a host-loaded WASM module ` +
					`(e.g. @tootallnate/astc-wasm). Most Switch BNTXes use BCn so ` +
					`BCn-only callers can omit this.`,
			);
		}
		// Deswizzle first — same path as BCn, just with a different
		// bytes-per-block (16) and the ASTC block dimensions.
		const linear = deswizzle({
			width: tex.width,
			height: tex.height,
			blkWidth: info.blkWidth,
			blkHeight: info.blkHeight,
			bytesPerBlock: info.bytesPerBlock,
			data: swizzled,
			blockHeight: blockHeightFromLog2(tex.blockHeightLog2),
		});
		const pixels = options.astcDecoder(
			tex.width,
			tex.height,
			info.blkWidth,
			info.blkHeight,
			linear,
		);
		return { width: tex.width, height: tex.height, pixels };
	}

	const linear = deswizzle({
		width: tex.width,
		height: tex.height,
		blkWidth: info.blkWidth,
		blkHeight: info.blkHeight,
		bytesPerBlock: info.bytesPerBlock,
		data: swizzled,
		blockHeight: blockHeightFromLog2(tex.blockHeightLog2),
	});

	const w = tex.width;
	const h = tex.height;
	let pixels: Uint8Array;

	switch (info.code) {
		// Uncompressed
		case 0x0b01:
		case 0x0b06:
			pixels = decodeRgba8(linear, w, h);
			break;
		case 0x0c01:
		case 0x0c06:
			pixels = decodeBgra8(linear, w, h);
			break;
		case 0x0201:
			pixels = decodeR8(linear, w, h);
			break;
		case 0x0901:
			pixels = decodeRg8(linear, w, h);
			break;
		case 0x0101:
			pixels = decodeR4G4(linear, w, h);
			break;
		case 0x0701:
			pixels = decodeR5G6B5(linear, w, h);
			break;
		case 0x0801:
			pixels = decodeB5G6R5(linear, w, h);
			break;
		case 0x0301:
			pixels = decodeR4G4B4A4(linear, w, h);
			break;
		case 0x0501:
			pixels = decodeR5G5B5A1(linear, w, h);
			break;
		// BCn
		case 0x1a01:
		case 0x1a06:
			pixels = decodeBC1(linear, w, h);
			break;
		case 0x1b01:
		case 0x1b06:
			pixels = decodeBC2(linear, w, h);
			break;
		case 0x1c01:
		case 0x1c06:
			pixels = decodeBC3(linear, w, h);
			break;
		case 0x1d01:
			pixels = decodeBC4(linear, w, h, { signed: false, mode: 'rgb' });
			break;
		case 0x1d02:
			pixels = decodeBC4(linear, w, h, { signed: true, mode: 'rgb' });
			break;
		case 0x1e01:
			pixels = decodeBC5(linear, w, h, { signed: false, mode: 'normal' });
			break;
		case 0x1e02:
			pixels = decodeBC5(linear, w, h, { signed: true, mode: 'normal' });
			break;
		case 0x2001:
		case 0x2006:
			pixels = decodeBC7(linear, w, h);
			break;
		default:
			throw new Error(
				`Unsupported BNTX format ${info.name} (0x${info.code.toString(16)}). ` +
					`Supported: BC1/BC2/BC3/BC4/BC5/BC7 + RGBA8/BGRA8/R8/RG8/R4G4/R5G6B5/B5G6R5/R4G4B4A4/R5G5B5A1.`,
			);
	}

	return { width: w, height: h, pixels };
}

/**
 * Convenience: parse a BNTX, find its first texture, and decode
 * its first layer to RGBA8. Throws for empty containers or
 * unsupported formats.
 */
export function decodeBntxToRgba(
	bytes: Uint8Array,
	options: DecodeBntxLayerOptions = {},
): DecodedTexture & {
	texture: BntxTexture;
} {
	const parsed = parseBntx(bytes);
	if (parsed.textureCount === 0) {
		throw new Error('BNTX has no textures');
	}
	const tex = parsed.textures[0];
	const decoded = decodeBntxLayer(bytes, tex, 0, options);
	return { ...decoded, texture: tex };
}
