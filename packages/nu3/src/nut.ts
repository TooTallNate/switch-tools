/**
 * NUT texture packs (`NTWD` little-endian, `NTP3` big-endian), from
 * Bandai Namco's NU3 engine (Pokkén Tournament, Smash 4).
 *
 *     0x00  magic       0x04  version (u16, always BE)
 *     0x06  count (u16) 0x08  8 bytes of zero
 *
 * Texture headers follow from 0x10. Each one (all fields in the file's
 * byte order) is:
 *
 *     +0x00  total size   +0x04  0   +0x08  data size
 *     +0x0C  header size (u16)
 *     +0x11  mip count (u8)   +0x13  pixel format (u8)
 *     +0x14  width (u16)      +0x16  height (u16)
 *     +0x18  0                +0x1C  DDS caps2 (0xFE00 = cubemap, all faces)
 *     +0x20  data offset, relative to this header (version ≥ 0x200)
 *     +0x24  12 bytes         [+0x30 cubemap face sizes, 0x10 bytes]
 *     then, with more than one mip, per-mip sizes (aligned to 0x10),
 *     an `eXt\0` block and a `GIDX` block whose +0x08 is the hash ID
 *     that NUD materials reference.
 *
 * Version ≥ 0x200 headers are consecutive (the next is at +header
 * size) and the data comes after all of them; older versions put each
 * texture's data straight after its header (next at +total size).
 *
 * Pixel formats: 0 / 1 / 2 = BC1 / BC2 / BC3, 8 = RGB565, 12 = RGBA16,
 * 14 / 17 = 8-bit RGBA stored ARGB, 16 = ABGR, 21 = BC4, 22 = BC5.
 * Pokkén DX also uses 47 for BC4 (its bitmap-font glyph atlases: the
 * data is exactly 4 bits per pixel and decodes cleanly as BC4), and
 * surfaces of exactly w × h × 4 bytes are plain RGBA8 whatever the code.
 * Switch (Pokkén DX) data is linear, not Tegra-swizzled.
 *
 * Source: Smash Forge `Filetypes/Textures/NUT.cs` (`ReadNTP3`).
 */
import { decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5 } from '@tootallnate/bcn';

export interface NutTexture {
	/** GIDX hash ID; NUD materials refer to textures by this. */
	hashId: number;
	width: number;
	height: number;
	/** NUT pixel format code (see the module comment). */
	format: number;
	mipCount: number;
	cubemap: boolean;
	/** Absolute offset and size of each surface's first mip (1 or 6 surfaces). */
	surfaces: { offset: number; size: number }[];
}

export interface NutFile {
	littleEndian: boolean;
	version: number;
	textures: NutTexture[];
}

const CUBEMAP = 0x200;
const CUBEMAP_ALL = 0xfe00;

export function isNut(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 0x10) return false;
	const m = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
	return m === 'NTWD' || m === 'NTP3';
}

export function parseNut(bytes: Uint8Array): NutFile {
	if (!isNut(bytes)) throw new Error('Not an NTWD / NTP3 NUT');
	const le = bytes[3] === 0x44; // 'D'
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint16(4, false);
	const count = dv.getUint16(6, le);
	const textures: NutTexture[] = [];
	let ptr = 0x10;
	for (let i = 0; i < count; i++) {
		if (ptr + 0x50 > bytes.byteLength) throw new Error(`NUT: texture ${i} header is out of bounds`);
		const totalSize = dv.getInt32(ptr, le);
		const dataSize = dv.getInt32(ptr + 0x08, le);
		const headerSize = dv.getUint16(ptr + 0x0c, le);
		const mipCount = Math.max(1, bytes[ptr + 0x11]!);
		const format = bytes[ptr + 0x13]!;
		const width = dv.getUint16(ptr + 0x14, le);
		const height = dv.getUint16(ptr + 0x16, le);
		const caps2 = dv.getUint32(ptr + 0x1c, le);
		const cubemap = (caps2 & CUBEMAP) !== 0 && (caps2 & CUBEMAP_ALL) === CUBEMAP_ALL;
		let q = ptr + 0x20;
		const dataOffset = version >= 0x200 ? dv.getInt32(q, le) + ptr : ptr + headerSize;
		q += 0x10;
		let faceSize = 0;
		if (cubemap) {
			faceSize = dv.getInt32(q, le);
			q += 0x10;
		}
		let firstMip = cubemap ? faceSize : dataSize;
		const mipSizes: number[] = [];
		if (mipCount > 1) {
			for (let m = 0; m < mipCount; m++) mipSizes.push(dv.getInt32(q + m * 4, le));
			q += mipCount * 4;
			q = (q + 15) & ~15;
			firstMip = mipSizes[0]!;
		}
		// `eXt\0` (0x10) then `GIDX`: u32 0x10, u32 hash.
		const gidx = q + 0x10;
		const hashId = gidx + 0x0c <= bytes.byteLength ? dv.getUint32(gidx + 0x08, le) : 0;
		const surfaceStride = mipCount > 1 ? mipSizes.reduce((s, n) => s + n, 0) : firstMip;
		const surfaces: NutTexture['surfaces'] = [];
		for (let s = 0; s < (cubemap ? 6 : 1); s++) {
			surfaces.push({ offset: dataOffset + s * surfaceStride, size: firstMip });
		}
		textures.push({ hashId, width, height, format, mipCount, cubemap, surfaces });
		ptr += version >= 0x200 ? headerSize : totalSize;
	}
	return { littleEndian: le, version, textures };
}

export interface NutImage {
	width: number;
	height: number;
	/** RGBA8, top row first. */
	pixels: Uint8Array;
}

/** Human-readable name for a NUT pixel format code. */
export function nutFormatName(format: number): string {
	return (
		{ 0: 'BC1', 1: 'BC2', 2: 'BC3', 8: 'RGB565', 12: 'RGBA16', 14: 'RGBA8', 16: 'ABGR8', 17: 'RGBA8', 21: 'BC4', 22: 'BC5', 47: 'BC4' }[format] ??
		`format ${format}`
	);
}

/** Decode a texture's first mip of `surface` (0..5 for cubemaps) to RGBA8. */
export function decodeNutTexture(bytes: Uint8Array, tex: NutTexture, surface = 0): NutImage {
	const { width, height } = tex;
	const s = tex.surfaces[surface] ?? tex.surfaces[0]!;
	const data = bytes.subarray(s.offset, Math.min(bytes.byteLength, s.offset + s.size));
	const n = width * height;
	// Pokkén DX reuses some codes for uncompressed 32-bit RGBA (its button
	// font atlas says 21 but holds w × h × 4 bytes): trust the data size.
	if (s.size === n * 4 && tex.format !== 14 && tex.format !== 16 && tex.format !== 17) {
		return { width, height, pixels: data.slice(0, n * 4) };
	}
	switch (tex.format) {
		case 0:
			return decodeBC1(data, width, height);
		case 1:
			return decodeBC2(data, width, height);
		case 2:
			return decodeBC3(data, width, height);
		case 21:
		case 47:
			return grey(decodeBC4(data, width, height));
		case 22:
			return decodeBC5(data, width, height);
		case 8: {
			const out = new Uint8Array(n * 4);
			const le = bytes[3] === 0x44;
			const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
			for (let i = 0; i < n && i * 2 + 1 < data.byteLength; i++) {
				const v = dv.getUint16(i * 2, le);
				out[i * 4] = ((v >> 11) & 31) * 255 / 31;
				out[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63;
				out[i * 4 + 2] = (v & 31) * 255 / 31;
				out[i * 4 + 3] = 255;
			}
			return { width, height, pixels: out };
		}
		case 12: {
			// 16 bits per channel: keep the high byte.
			const out = new Uint8Array(n * 4);
			for (let i = 0; i < n * 4 && i * 2 + 1 < data.byteLength; i++) out[i] = data[i * 2 + (bytes[3] === 0x44 ? 1 : 0)]!;
			return { width, height, pixels: out };
		}
		case 14:
		case 16:
		case 17: {
			const out = new Uint8Array(n * 4);
			for (let i = 0; i < n && i * 4 + 3 < data.byteLength; i++) {
				const a = data[i * 4]!, b = data[i * 4 + 1]!, c = data[i * 4 + 2]!, d = data[i * 4 + 3]!;
				if (tex.format === 16) out.set([d, c, b, a], i * 4);
				else out.set([b, c, d, a], i * 4); // ARGB → RGBA
			}
			return { width, height, pixels: out };
		}
		default:
			throw new Error(`NUT: unsupported pixel format ${tex.format}`);
	}
}

/** BC4 decodes to red only; show it as greyscale. */
function grey(img: NutImage): NutImage {
	const p = img.pixels;
	for (let i = 0; i < p.length; i += 4) {
		p[i + 1] = p[i]!;
		p[i + 2] = p[i]!;
		p[i + 3] = 255;
	}
	return img;
}
