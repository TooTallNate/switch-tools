/**
 * `TEX1` — textures.
 *
 * The simplest chunk in the format, and the one with the least to say, because
 * a `TEX1` entry *is* a BTI: the 0x20-byte structure here is byte-for-byte the
 * same one that a standalone `.bti` file starts with. That's not a coincidence
 * or a convention — it's the same C struct (`JUTTexture`'s header) written out
 * in two different places, which is exactly why its internal `dataOffset` and
 * `paletteOffset` are relative to the *header itself* rather than to the file:
 * relocatable offsets mean the identical bytes work whether the struct sits
 * alone in a file or in the middle of a 4 MB model.
 *
 * So we don't decode anything here. We locate the headers, read the names, and
 * hand the offsets to `@tootallnate/bti`, which already knows how to
 * un-tile every GX texture format.
 *
 * Payload layout:
 *
 *   0x00 u16 textureCount
 *   0x02 u16 padding
 *   0x04 u32 textureHeaderOffset
 *   0x08 u32 nameTableOffset
 *
 * Then `textureCount` × 0x20-byte BTI headers, a standard J3D string table of
 * names, and finally the pixel (and palette) data that the headers point into.
 *
 * One thing worth knowing when you look at a real model: two materials very
 * often point at the same `TEX1` index, and two *different* `TEX1` entries very
 * often share the same pixel data by pointing their `dataOffset` at the same
 * bytes while differing in wrap or filter mode. Sampler state lives in the
 * texture header on this hardware, not in the material, so "the same image with
 * clamp instead of repeat" has to be a second entry.
 */

import { BTI_HEADER_SIZE, parseBtiHeader, type BtiHeader } from '@tootallnate/bti';

import { chunkOffset, validateChunk, type J3dChunk } from './container.js';
import { CHUNK_HEADER_SIZE, readJ3dStringTable } from './util.js';

/** Size of one texture header. Identical to BTI's, by construction. */
export const TEX1_HEADER_SIZE = BTI_HEADER_SIZE;

export interface Tex1Texture {
	index: number;
	name: string;
	/**
	 * Absolute offset of this texture's 0x20-byte header in the source buffer.
	 * Pass it straight to `decodeBti(bytes, headerOffset)`.
	 */
	headerOffset: number;
	header: BtiHeader;
}

export interface Tex1 {
	textures: Tex1Texture[];
}

/**
 * Parse a `TEX1` chunk.
 *
 * Returns `null` when the header or the texture-header array is out of range.
 * A texture whose own header won't parse is skipped, so one bad entry doesn't
 * cost you the other forty.
 */
export function parseTex1(bytes: Uint8Array, chunk: J3dChunk): Tex1 | null {
	if (!validateChunk(bytes, chunk)) return null;
	if (chunk.size < CHUNK_HEADER_SIZE + 0x0c) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;
	const chunkEnd = chunk.offset + chunk.size;

	const textureCount = view.getUint16(payload + 0x00, false);
	const headerRel = view.getUint32(payload + 0x04, false);
	const nameRel = view.getUint32(payload + 0x08, false);

	if (textureCount === 0) return { textures: [] };

	const headerOffset = chunkOffset(
		chunk,
		headerRel,
		textureCount * TEX1_HEADER_SIZE,
	);
	if (headerOffset < 0) return null;

	const nameOffset = chunkOffset(chunk, nameRel, 4);
	const names = nameOffset >= 0 ? readJ3dStringTable(bytes, nameOffset, chunkEnd) : null;

	const textures: Tex1Texture[] = [];
	for (let i = 0; i < textureCount; i++) {
		const at = headerOffset + i * TEX1_HEADER_SIZE;
		const header = parseBtiHeader(bytes, at);
		if (!header) continue;
		textures.push({
			index: i,
			name: names && i < names.length ? names[i] : '',
			headerOffset: at,
			header,
		});
	}

	return { textures };
}
