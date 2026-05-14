/**
 * Parser for DirectXTK SpriteFont binaries (`DXTKfont` magic).
 *
 * SpriteFont is the bitmap-atlas font format produced by Microsoft's
 * MakeSpriteFont tool and consumed by SpriteFont at runtime. It's
 * widely used by games built on DirectXTK (Mojang's bedrock-engine
 * Switch ports, several Square Enix Switch releases, etc.).
 *
 * Wire format (little-endian throughout, NOT versioned):
 *
 *   0x00  u8[8]    magic "DXTKfont"
 *   0x08  u32      glyphCount
 *   0x0C  Glyph[glyphCount]                      32 bytes each
 *           u32 character    (UCS-4 codepoint)
 *           s32 subrectLeft, subrectTop, subrectRight, subrectBottom
 *           f32 xOffset, yOffset
 *           f32 xAdvance
 *   ----  f32 lineSpacing
 *         u32 defaultCharacter
 *         u32 textureWidth
 *         u32 textureHeight
 *         u32 textureFormat                      DXGI_FORMAT enum
 *         u32 textureStride                      bytes per row (or per 4-row block for BC)
 *         u32 textureRows                        height in pixels (or in 4-row blocks for BC)
 *         u8[stride * rows]  pixel data
 *
 * Three texture formats are emitted by the upstream MakeSpriteFont
 * tool, mapped to the canonical DXGI codes:
 *
 *   28  R8G8B8A8_UNORM   (uncompressed 32-bit, stride = w*4, rows = h)
 *   115 B4G4R4A4_UNORM   (uncompressed 16-bit, stride = w*2, rows = h)
 *   74  BC2_UNORM (DXT3) (block-compressed,    stride = w*4, rows = h/4)
 *
 * Reference: DirectXTK MakeSpriteFont/SpriteFontWriter.cs (MIT).
 */

import { decodeBC2 } from '@tootallnate/bcn';

export const DXTK_FONT_MAGIC = 'DXTKfont';

export const DXGI_FORMAT_R8G8B8A8_UNORM = 28;
export const DXGI_FORMAT_B4G4R4A4_UNORM = 115;
export const DXGI_FORMAT_BC2_UNORM = 74;

/** One glyph record from the SpriteFont's glyph table. */
export interface SpriteFontGlyph {
	/** UCS-4 codepoint. */
	character: number;
	/** Pixel rectangle within the atlas that holds this glyph's bitmap. */
	subrect: { left: number; top: number; right: number; bottom: number };
	/** Pen-position offset applied when drawing this glyph. */
	xOffset: number;
	yOffset: number;
	/** Distance to advance the pen after drawing this glyph. */
	xAdvance: number;
}

/** Decoded SpriteFont. */
export interface ParsedSpriteFont {
	glyphs: SpriteFontGlyph[];
	/** Distance between successive lines in pixels. */
	lineSpacing: number;
	/** Codepoint to substitute for any glyph not in the table. */
	defaultCharacter: number;
	/** Atlas width / height in pixels. */
	textureWidth: number;
	textureHeight: number;
	/** Raw DXGI_FORMAT value. */
	textureFormat: number;
	/**
	 * Friendly name for {@link textureFormat}: one of `'r8g8b8a8'`,
	 * `'b4g4r4a4'`, `'bc2'`, or `'unknown'`.
	 */
	textureFormatName: string;
	/** RGBA8 pixels of the decoded atlas (length = w * h * 4). */
	atlasRgba: Uint8Array;
}

export class SpriteFontParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SpriteFontParseError';
	}
}

/** Sniff the `DXTKfont` magic at the start of the bytes. */
export function isSpriteFontMagic(bytes: Uint8Array): boolean {
	if (bytes.length < 8) return false;
	for (let i = 0; i < 8; i++) {
		if (bytes[i] !== DXTK_FONT_MAGIC.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * Parse a SpriteFont binary into its glyph table + decoded atlas.
 *
 * The atlas is decoded to RGBA8 regardless of the source format so
 * downstream consumers can hand it to a canvas without branching on
 * the format. For R8G8B8A8 we pass the bytes through; for
 * B4G4R4A4 we expand each nibble to a full byte; for BC2 we run
 * the block decoder.
 */
export function parseSpriteFont(bytes: Uint8Array): ParsedSpriteFont {
	if (!isSpriteFontMagic(bytes)) {
		throw new SpriteFontParseError(
			`Bad DXTKfont magic at offset 0; expected "${DXTK_FONT_MAGIC}", got 0x${Array.from(bytes.subarray(0, Math.min(8, bytes.length)))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')}`,
		);
	}
	if (bytes.length < 0x0c) {
		throw new SpriteFontParseError(`SpriteFont too short (${bytes.length} bytes)`);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let p = 0x08;
	const glyphCount = dv.getUint32(p, true);
	p += 4;
	if (glyphCount < 0 || glyphCount > 1_000_000) {
		throw new SpriteFontParseError(
			`Implausible glyphCount=${glyphCount}; refusing to allocate.`,
		);
	}
	const glyphTableEnd = p + glyphCount * 32;
	if (glyphTableEnd > bytes.length) {
		throw new SpriteFontParseError(
			`Glyph table truncated: need ${glyphTableEnd} bytes, have ${bytes.length}`,
		);
	}
	const glyphs: SpriteFontGlyph[] = new Array(glyphCount);
	for (let i = 0; i < glyphCount; i++) {
		const character = dv.getUint32(p, true);
		const left = dv.getInt32(p + 4, true);
		const top = dv.getInt32(p + 8, true);
		const right = dv.getInt32(p + 12, true);
		const bottom = dv.getInt32(p + 16, true);
		const xOffset = dv.getFloat32(p + 20, true);
		const yOffset = dv.getFloat32(p + 24, true);
		const xAdvance = dv.getFloat32(p + 28, true);
		glyphs[i] = {
			character,
			subrect: { left, top, right, bottom },
			xOffset,
			yOffset,
			xAdvance,
		};
		p += 32;
	}

	// lineSpacing + defaultCharacter + 5 texture-info u32s = 28 bytes.
	if (p + 28 > bytes.length) {
		throw new SpriteFontParseError(
			`SpriteFont texture header truncated at offset ${p}`,
		);
	}
	const lineSpacing = dv.getFloat32(p, true);
	p += 4;
	const defaultCharacter = dv.getUint32(p, true);
	p += 4;
	const textureWidth = dv.getUint32(p, true);
	p += 4;
	const textureHeight = dv.getUint32(p, true);
	p += 4;
	const textureFormat = dv.getUint32(p, true);
	p += 4;
	const textureStride = dv.getUint32(p, true);
	p += 4;
	const textureRows = dv.getUint32(p, true);
	p += 4;

	const pixelBytes = textureStride * textureRows;
	if (p + pixelBytes > bytes.length) {
		throw new SpriteFontParseError(
			`SpriteFont texture truncated: need ${pixelBytes} bytes at offset ${p}, have ${bytes.length - p}`,
		);
	}
	const raw = bytes.subarray(p, p + pixelBytes);

	let atlasRgba: Uint8Array;
	let textureFormatName: string;
	switch (textureFormat) {
		case DXGI_FORMAT_R8G8B8A8_UNORM:
			textureFormatName = 'r8g8b8a8';
			atlasRgba = decodeR8G8B8A8(raw, textureWidth, textureHeight);
			break;
		case DXGI_FORMAT_B4G4R4A4_UNORM:
			textureFormatName = 'b4g4r4a4';
			atlasRgba = decodeB4G4R4A4(raw, textureWidth, textureHeight);
			break;
		case DXGI_FORMAT_BC2_UNORM:
			textureFormatName = 'bc2';
			atlasRgba = decodeBC2(raw, textureWidth, textureHeight).pixels;
			break;
		default:
			textureFormatName = 'unknown';
			atlasRgba = new Uint8Array(textureWidth * textureHeight * 4);
			break;
	}

	return {
		glyphs,
		lineSpacing,
		defaultCharacter,
		textureWidth,
		textureHeight,
		textureFormat,
		textureFormatName,
		atlasRgba,
	};
}

/** R8G8B8A8 is already in our target layout; just copy/extract. */
function decodeR8G8B8A8(
	raw: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const expected = width * height * 4;
	if (raw.length === expected) {
		// Defensive copy — caller may mutate, and the input was a
		// subarray view over the source file.
		return new Uint8Array(raw);
	}
	// The writer pads each row to `textureStride`. Slice row by row.
	const stride = raw.length / height;
	const out = new Uint8Array(expected);
	for (let y = 0; y < height; y++) {
		out.set(raw.subarray(y * stride, y * stride + width * 4), y * width * 4);
	}
	return out;
}

/**
 * Expand B4G4R4A4 (16 bits per pixel; 4 bits per channel) to RGBA8.
 * Each pixel is `aaaa rrrr gggg bbbb` packed BGRA but written as a
 * u16 — DirectXTK's writer composes it as `b | (g << 4) | (r << 8) |
 * (a << 12)` and writes that u16 little-endian.
 */
function decodeB4G4R4A4(
	raw: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const stride = raw.length / height;
	const out = new Uint8Array(width * height * 4);
	const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	for (let y = 0; y < height; y++) {
		const rowOff = y * stride;
		for (let x = 0; x < width; x++) {
			const packed = dv.getUint16(rowOff + x * 2, true);
			// Expand each nibble to 8 bits by replicating it
			// (standard 4→8 widening).
			const b4 = packed & 0xf;
			const g4 = (packed >> 4) & 0xf;
			const r4 = (packed >> 8) & 0xf;
			const a4 = (packed >> 12) & 0xf;
			const off = (y * width + x) * 4;
			out[off] = (r4 << 4) | r4;
			out[off + 1] = (g4 << 4) | g4;
			out[off + 2] = (b4 << 4) | b4;
			out[off + 3] = (a4 << 4) | a4;
		}
	}
	return out;
}
