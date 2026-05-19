/**
 * @tootallnate/ff8-battle — Final Fantasy VIII battle model
 * (`c0m###.dat`) file-format decoder.
 *
 * Each enemy in FFVIII's `battle.fs` archive has a `c0m###.dat`
 * file containing a multi-section container:
 *
 *     0  Skeleton          (bones)
 *     1  Geometry          (mesh objects: vertices, triangles, quads)
 *     2  Animation         (bit-packed frames)
 *     3  Sequence          (battle-anim sequences — NOT PARSED, raw bytes)
 *     4  Unknown           (raw bytes)
 *     5  Unknown           (raw bytes)
 *     6  Information       (380-byte stats record)
 *     7  AI script         (battle behaviour bytecode — NOT PARSED, raw bytes)
 *     8  AKAO sound bank   (raw bytes)
 *     9  AKAO sound bank   (raw bytes)
 *    10  Textures          (TIM blobs)
 *
 * The special case `c0m127.dat` has only 2 sections (information + AI).
 *
 * Top-level usage:
 *
 * ```ts
 * import { parseDat } from '@tootallnate/ff8-battle';
 *
 * const dat = parseDat(bytes);
 * dat.information?.name;              // e.g. "Bite Bug"
 * dat.skeleton?.bones.length;
 * dat.geometry?.objects[0].triangles;
 * dat.textures?.[0].pixels;           // RGBA8, top-down
 * ```
 */

export * from './header.js';
export * from './skeleton.js';
export * from './geometry.js';
export * from './animation.js';
export * from './information.js';
export * from './textures.js';
export * from './text.js';

import {
	parseDatHeader,
	sectionSlice,
	MONSTER_SECTIONS,
	MONSTER_127_SECTIONS,
	DatParseError,
	type DatHeader,
} from './header.js';
import { parseSkeleton, type DatSkeleton } from './skeleton.js';
import { parseGeometry, type DatGeometry } from './geometry.js';
import { parseAnimations, type DatAnimation } from './animation.js';
import { parseInformation, type DatInformation } from './information.js';
import { parseTextures, type DatTexture } from './textures.js';

export interface ParsedDat {
	header: DatHeader;
	skeleton?: DatSkeleton;
	geometry?: DatGeometry;
	animations?: DatAnimation[];
	information?: DatInformation;
	textures?: DatTexture[];
	/**
	 * Raw section bytes by index (length == `header.nbSections`).
	 * Useful for sections this package doesn't parse (3, 4, 5, 7, 8, 9)
	 * so callers can "Download .dat-section" / hand them to an
	 * external decoder.
	 */
	rawSections: (Uint8Array | undefined)[];
}

/**
 * Parse a monster DAT file (`c0m###.dat`). The 11-section layout is
 * assumed; the 2-section variant (c0m127) is detected and routed
 * accordingly. Character / weapon DAT variants (different section
 * indexing) are NOT handled here.
 */
export function parseDat(bytes: Uint8Array): ParsedDat {
	const header = parseDatHeader(bytes);
	const rawSections: (Uint8Array | undefined)[] = [];
	for (let i = 0; i < header.nbSections; i++) {
		rawSections.push(sectionSlice(bytes, header, i));
	}

	const out: ParsedDat = { header, rawSections };

	if (header.nbSections === 2) {
		// c0m127-style variant: only information + AI.
		try {
			out.information = parseInformation(
				bytes,
				header.sectionOffsets[MONSTER_127_SECTIONS.information]!,
			);
		} catch (e) {
			// Best-effort.
			if (!(e instanceof DatParseError)) throw e;
		}
		return out;
	}

	// Standard 11-section monster layout.
	try {
		out.skeleton = parseSkeleton(
			bytes,
			header.sectionOffsets[MONSTER_SECTIONS.skeleton]!,
		);
	} catch (e) {
		if (!(e instanceof DatParseError)) throw e;
	}

	try {
		out.geometry = parseGeometry(
			bytes,
			header.sectionOffsets[MONSTER_SECTIONS.geometry]!,
		);
	} catch (e) {
		if (!(e instanceof DatParseError)) throw e;
	}

	if (out.skeleton) {
		try {
			out.animations = parseAnimations(
				bytes,
				header.sectionOffsets[MONSTER_SECTIONS.animation]!,
				out.skeleton.cBones,
			);
		} catch (e) {
			if (!(e instanceof DatParseError)) throw e;
		}
	}

	try {
		out.information = parseInformation(
			bytes,
			header.sectionOffsets[MONSTER_SECTIONS.information]!,
		);
	} catch (e) {
		if (!(e instanceof DatParseError)) throw e;
	}

	try {
		out.textures = parseTextures(
			bytes,
			header.sectionOffsets[MONSTER_SECTIONS.textures]!,
		);
	} catch (e) {
		if (!(e instanceof DatParseError)) throw e;
	}

	return out;
}
