/**
 * Parser for FF7 PC field-scene FieldModule containers.
 *
 * Each `flevel.lgp` entry, after LZSS decompression, begins
 * with a 9-section header:
 *
 *   offset  size   field
 *     0     u16    blank          (always 0)
 *     2     u32    numSections    (always 9 for field files)
 *     6     u32[9] sectionOffsets — absolute offsets from the
 *                                  decompressed buffer's start
 *
 * Each section starts with `u32 length` (just the payload
 * length, not including this prefix), then the payload. Section
 * offsets are technically redundant with the lengths but should
 * be trusted (they're authoritative for misaligned files).
 *
 * Sections in order:
 *   0: Script + dialog
 *   1: Camera matrix
 *   2: Model loader (referenced by ff7-pc-model parsers)
 *   3: Palette                                  ← we decode this
 *   4: Walkmesh
 *   5: TileMap                                  ← PSX, junk on PC
 *   6: Encounter data
 *   7: Triggers
 *   8: Background                               ← we decode this
 *
 * `parseFieldModule` returns ONLY the section boundary table.
 * Decoding individual section payloads is left to format-
 * specific parsers (`parsePalette`, `parseBackground`).
 */

export const FIELD_MODULE_NUM_SECTIONS = 9 as const;

/**
 * Section indices, named for clarity. Use these instead of
 * raw integers when slicing sections.
 */
export const FieldSection = {
	Script: 0,
	Camera: 1,
	Model: 2,
	Palette: 3,
	Walkmesh: 4,
	TileMap: 5,
	Encounter: 6,
	Triggers: 7,
	Background: 8,
} as const;
export type FieldSectionKey = keyof typeof FieldSection;

export class FieldModuleParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FieldModuleParseError';
	}
}

export interface FieldModule {
	/** Raw decompressed FieldModule bytes (so callers can slice further). */
	bytes: Uint8Array;
	/** Per-section payload Uint8Arrays (sliced views into `bytes`). */
	sections: Uint8Array[];
}

export function parseFieldModule(bytes: Uint8Array): FieldModule {
	if (bytes.length < 2 + 4 + FIELD_MODULE_NUM_SECTIONS * 4) {
		throw new FieldModuleParseError(
			`FieldModule too short (${bytes.length} bytes); need at least the 42-byte header`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const blank = view.getUint16(0, true);
	if (blank !== 0) {
		throw new FieldModuleParseError(
			`FieldModule: expected leading u16 == 0, got 0x${blank.toString(16)}`,
		);
	}
	const numSections = view.getUint32(2, true);
	if (numSections !== FIELD_MODULE_NUM_SECTIONS) {
		throw new FieldModuleParseError(
			`FieldModule: expected ${FIELD_MODULE_NUM_SECTIONS} sections, got ${numSections}`,
		);
	}

	const offsets = new Array<number>(FIELD_MODULE_NUM_SECTIONS);
	for (let i = 0; i < FIELD_MODULE_NUM_SECTIONS; i++) {
		offsets[i] = view.getUint32(6 + i * 4, true);
	}
	// Each section's payload starts AFTER its 4-byte length
	// prefix. The next section's offset is `prevOffset + 4 + len`.
	const sections: Uint8Array[] = new Array(FIELD_MODULE_NUM_SECTIONS);
	for (let i = 0; i < FIELD_MODULE_NUM_SECTIONS; i++) {
		const start = offsets[i]!;
		if (start + 4 > bytes.length) {
			throw new FieldModuleParseError(
				`FieldModule section ${i} offset 0x${start.toString(16)} past EOF (${bytes.length})`,
			);
		}
		const len = view.getUint32(start, true);
		const payloadStart = start + 4;
		const payloadEnd = payloadStart + len;
		if (payloadEnd > bytes.length) {
			throw new FieldModuleParseError(
				`FieldModule section ${i} declares length ${len} but only ${
					bytes.length - payloadStart
				} bytes remain`,
			);
		}
		sections[i] = bytes.subarray(payloadStart, payloadEnd);
	}

	return { bytes, sections };
}

/** Slice a named section out of a parsed FieldModule. */
export function getSection(
	module: FieldModule,
	key: FieldSectionKey,
): Uint8Array {
	return module.sections[FieldSection[key]]!;
}
