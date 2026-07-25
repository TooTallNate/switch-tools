/**
 * The whole-model parse: container walk plus every chunk we understand.
 *
 * Each chunk is parsed independently and every one of them is allowed to fail.
 * That's deliberate. `MAT3` in particular is a maze of indirection (see
 * `mat3.ts`) and it would be perverse to lose a model's geometry because its
 * material table used a layout we don't recognise — so a `null` chunk is just a
 * `null` field, and {@link parseJ3d} only fails when the *container* is
 * unreadable.
 *
 * `MDL3` is deliberately *not* parsed. It's a pre-baked blob of GX register
 * writes that only exists so the game can bind a material without walking
 * `MAT3`, so it holds no information `MAT3` doesn't already have — it's
 * enumerated in {@link J3dModel.chunks} and otherwise skipped.
 *
 * The parsed model holds no reference to the source bytes. `VTX1` arrays are
 * decoded eagerly into `Float32Array`s (they're the only thing that needs
 * decoding, and the fixed-point conversion has to happen sometime), while
 * textures stay as offsets: a model's textures are typically far larger than
 * its geometry, and a viewer wants to decode them lazily, one at a time, as it
 * uploads them. That's why {@link decodeJ3dTexture} asks for the bytes again.
 */

import { decodeBti } from '@tootallnate/bti';

import { findChunk, parseJ3dContainer, type J3dChunk } from './container.js';
import { parseInf1, type Inf1 } from './inf1.js';
import { parseJnt1, type Jnt1 } from './jnt1.js';
import { parseMat3, type Mat3 } from './mat3.js';
import { parseShp1, type Shp1 } from './shp1.js';
import { parseDrw1, parseEvp1, type Drw1, type Evp1 } from './skin.js';
import { parseTex1, type Tex1 } from './tex1.js';
import { parseVtx1, type Vtx1 } from './vtx1.js';

export interface J3dModel {
	/** 'bmd' or 'bdl'; the latter additionally carries a baked `MDL3`. */
	kind: 'bmd' | 'bdl';
	/** The full 8-character magic, e.g. `J3D2bmd3`. */
	version: string;
	/** Every chunk found, in file order, including ones we don't parse. */
	chunks: { magic: string; offset: number; size: number }[];
	vtx1: Vtx1 | null;
	shp1: Shp1 | null;
	mat3: Mat3 | null;
	tex1: Tex1 | null;
	inf1: Inf1 | null;
	jnt1: Jnt1 | null;
	/** Smooth-skinning envelopes. Parsed but not applied. */
	evp1: Evp1 | null;
	/** The matrix indirection table shapes index through. Parsed but not applied. */
	drw1: Drw1 | null;
}

/**
 * Parse a `.bmd` / `.bdl` model. Returns `null` when the bytes aren't a J3D
 * container or the chunk table is malformed, rather than throwing, so this can
 * be used as a sniff-and-parse in one step when walking an archive.
 *
 * If the file might be Yaz0-compressed, decompress it first — as with `RARC`,
 * this function deliberately does no decompression of its own.
 */
export function parseJ3d(bytes: Uint8Array, offset = 0): J3dModel | null {
	const container = parseJ3dContainer(bytes, offset);
	if (!container) return null;

	const chunk = (magic: string): J3dChunk | null =>
		findChunk(container.chunks, magic);

	const vtx1Chunk = chunk('VTX1');
	const shp1Chunk = chunk('SHP1');
	const mat3Chunk = chunk('MAT3');
	const tex1Chunk = chunk('TEX1');
	const inf1Chunk = chunk('INF1');
	const jnt1Chunk = chunk('JNT1');
	const evp1Chunk = chunk('EVP1');
	const drw1Chunk = chunk('DRW1');

	return {
		kind: container.kind,
		version: container.version,
		chunks: container.chunks.map((c) => ({
			magic: c.magic,
			offset: c.offset,
			size: c.size,
		})),
		vtx1: vtx1Chunk ? parseVtx1(bytes, vtx1Chunk) : null,
		shp1: shp1Chunk ? parseShp1(bytes, shp1Chunk) : null,
		mat3: mat3Chunk ? parseMat3(bytes, mat3Chunk) : null,
		tex1: tex1Chunk ? parseTex1(bytes, tex1Chunk) : null,
		inf1: inf1Chunk ? parseInf1(bytes, inf1Chunk) : null,
		jnt1: jnt1Chunk ? parseJnt1(bytes, jnt1Chunk) : null,
		evp1: evp1Chunk ? parseEvp1(bytes, evp1Chunk) : null,
		drw1: drw1Chunk ? parseDrw1(bytes, drw1Chunk) : null,
	};
}

/** A decoded `TEX1` texture: tightly-packed, top-down RGBA8. */
export interface DecodedJ3dTexture {
	width: number;
	height: number;
	/** `width * height * 4` bytes of RGBA8, top row first. */
	pixels: Uint8Array;
	name: string;
}

/**
 * Decode `TEX1` texture `index` to RGBA8 via `@tootallnate/bti`.
 *
 * `bytes` must be the same buffer (and the model must have been parsed at the
 * same offset) that produced `model`, since `Tex1Texture.headerOffset` is an
 * absolute offset into it.
 *
 * Returns `null` for a missing index or a texture BTI can't decode — an
 * unsupported format, or pixel data that runs off the end of the buffer.
 */
export function decodeJ3dTexture(
	model: J3dModel,
	bytes: Uint8Array,
	index: number,
): DecodedJ3dTexture | null {
	const tex1 = model.tex1;
	if (!tex1) return null;
	if (!Number.isInteger(index) || index < 0 || index >= tex1.textures.length) {
		return null;
	}
	const texture = tex1.textures[index];
	const decoded = decodeBti(bytes, texture.headerOffset);
	if (!decoded) return null;
	return {
		width: decoded.width,
		height: decoded.height,
		pixels: decoded.pixels,
		name: texture.name,
	};
}

/** The `TEX1` index a material samples, or -1. Convenience for viewers. */
export function materialTextureIndex(
	model: J3dModel,
	materialIndex: number,
): number {
	const mat3 = model.mat3;
	if (!mat3) return -1;
	if (materialIndex < 0 || materialIndex >= mat3.materials.length) return -1;
	return mat3.materials[materialIndex].textureIndex;
}
