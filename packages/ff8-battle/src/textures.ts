/**
 * FFVIII battle DAT — Section 11: Textures.
 *
 * Layout (section-relative):
 *
 *   offset  type      field
 *     0x00  u32       cTim
 *     0x04  u32[cTim] pTim           (section-relative offsets to each TIM)
 *     ...   u32       eof            (section size — first byte past last TIM)
 *     ...   TIM[cTim]
 *
 * Each TIM blob starts with magic `0x10` and is parsed via
 * `@tootallnate/ff8-model`'s `parseTim`. We decode each blob to RGBA8 pixels
 * using palette 0 (callers that need a specific palette can re-decode the
 * raw bytes with `parseTim({ paletteIndex: n })` themselves).
 */

import { parseTim, isTim, type TimBpp } from '@tootallnate/ff8-model';
import { DatParseError } from './header.js';

export interface DatTexture {
	width: number;
	height: number;
	bpp: TimBpp; // 4 | 8 | 16 | 24
	/** Decoded RGBA8 pixels, top-down, palette 0 applied for paletted variants. */
	pixels: Uint8Array;
	/** How many palettes the TIM declares (4/8bpp only). */
	paletteCount?: number;
	/** Raw TIM bytes — useful for re-decoding with a different palette. */
	raw: Uint8Array;
}

export function parseTextures(
	bytes: Uint8Array,
	sectionOffset: number,
): DatTexture[] {
	if (sectionOffset + 4 > bytes.length) {
		throw new DatParseError(
			`Textures section truncated at offset ${sectionOffset}`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const cTim = view.getUint32(sectionOffset + 0, true);
	if (cTim > 1024) {
		throw new DatParseError(`Textures cTim=${cTim} implausibly large`);
	}
	const headerEnd = sectionOffset + 4 + cTim * 4 + 4;
	if (headerEnd > bytes.length) {
		throw new DatParseError(
			`Textures header truncated (needs ${cTim * 4 + 4} bytes after count)`,
		);
	}

	const offsets: number[] = [];
	for (let i = 0; i < cTim; i++) {
		offsets.push(view.getUint32(sectionOffset + 4 + i * 4, true));
	}
	const eofRel = view.getUint32(sectionOffset + 4 + cTim * 4, true);

	const textures: DatTexture[] = [];
	for (let i = 0; i < cTim; i++) {
		const start = sectionOffset + offsets[i]!;
		const end = sectionOffset + (i + 1 < cTim ? offsets[i + 1]! : eofRel);
		if (start >= bytes.length || end > bytes.length || end < start) {
			// Skip silently — bad offset table.
			continue;
		}
		const raw = bytes.subarray(start, end);
		if (!isTim(raw)) {
			// Not a TIM — skip.
			continue;
		}
		try {
			const tim = parseTim(raw);
			textures.push({
				width: tim.width,
				height: tim.height,
				bpp: tim.bpp,
				pixels: tim.pixels,
				paletteCount: tim.paletteCount,
				raw,
			});
		} catch {
			// Skip malformed TIMs.
		}
	}
	return textures;
}
