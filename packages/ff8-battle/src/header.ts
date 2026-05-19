/**
 * FFVIII battle DAT (`c0m###.dat`) container header.
 *
 * Layout (all u32 LE):
 *
 *   offset    field
 *     0x00    nbSections        (number of section pointers)
 *     0x04    sectionOffsets[0..nbSections-1]  (file-relative byte offsets)
 *             fileSize          (u32; first byte past EOF — exclusive)
 *
 * For monster DAT files (`c0m###.dat`), `nbSections == 11` and the section
 * indexes are fixed:
 *
 *     0 = Skeleton
 *     1 = Geometry (model objects)
 *     2 = Animation (bit-packed frames)
 *     3 = ? (sequence / battle anims; unparsed by this package)
 *     4 = ? (unknown)
 *     5 = ? (unknown)
 *     6 = Information (380-byte stats record)
 *     7 = AI script (battle behaviour bytecode; unparsed)
 *     8 = AKAO #1 (sound effect bank; unparsed)
 *     9 = AKAO #2 (sound effect bank; unparsed)
 *    10 = Textures (TIM blobs)
 *
 * Special case: `c0m127.dat` has `nbSections == 2`, exposing only the
 * Information and AI sections (in that order).
 */

export class DatParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DatParseError';
	}
}

export interface DatHeader {
	nbSections: number;
	/** Section start offsets, file-relative (one per section). */
	sectionOffsets: number[];
	/** First byte past EOF (exclusive); used to compute the LAST section's length. */
	fileSize: number;
}

export function parseDatHeader(bytes: Uint8Array): DatHeader {
	if (bytes.length < 8) {
		throw new DatParseError(
			`DAT too short (${bytes.length} bytes); need at least 8 for header`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const nbSections = view.getUint32(0, true);
	if (nbSections === 0 || nbSections > 64) {
		throw new DatParseError(
			`DAT header has implausible nbSections=${nbSections}`,
		);
	}
	const headerSize = 4 + nbSections * 4 + 4;
	if (bytes.length < headerSize) {
		throw new DatParseError(
			`DAT header truncated: need ${headerSize} bytes for ${nbSections}-section header, got ${bytes.length}`,
		);
	}
	const sectionOffsets: number[] = [];
	for (let i = 0; i < nbSections; i++) {
		sectionOffsets.push(view.getUint32(4 + i * 4, true));
	}
	const fileSize = view.getUint32(4 + nbSections * 4, true);
	return { nbSections, sectionOffsets, fileSize };
}

/**
 * Section index conventions for monster DAT files (`c0m###.dat`).
 * Character and weapon DAT files use a different layout — not handled here.
 */
export const MONSTER_SECTIONS = {
	skeleton: 0,
	geometry: 1,
	animation: 2,
	information: 6,
	ai: 7,
	akao1: 8,
	akao2: 9,
	textures: 10,
} as const;

/**
 * Special-case section layout for `c0m127.dat` (2-section variant).
 *
 *   0 = Information
 *   1 = AI script
 */
export const MONSTER_127_SECTIONS = {
	information: 0,
	ai: 1,
} as const;

/**
 * Slice section `index` from `bytes` using the parsed header.
 * Returns undefined if the index is out of range.
 */
export function sectionSlice(
	bytes: Uint8Array,
	header: DatHeader,
	index: number,
): Uint8Array | undefined {
	if (index < 0 || index >= header.nbSections) return undefined;
	const start = header.sectionOffsets[index]!;
	const end =
		index + 1 < header.nbSections
			? header.sectionOffsets[index + 1]!
			: header.fileSize;
	if (start > end || end > bytes.length) {
		throw new DatParseError(
			`Section ${index} out of bounds: start=${start}, end=${end}, fileLen=${bytes.length}`,
		);
	}
	return bytes.subarray(start, end);
}
