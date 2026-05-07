/**
 * BNTX format codes — Nintendo's encoding of texture format and
 * data type into a single u32.
 *
 * High byte = format family (R8, R8G8B8A8, BC1, BC2, BC3, BC4, BC5,
 * BC6, BC7, ASTC variants…).
 * Low byte = data type (UNORM, SNORM, FLOAT, SRGB, UFLOAT).
 *
 * Reference: aboood40091/BNTX-Editor `globals.py`'s `formats`
 * dictionary, which is in turn derived from the official Switch
 * graphics SDK (NN.NN.NN.GFX).
 */

export const BNTX_FORMATS: Record<number, string> = {
	0x0101: 'R4_G4_UNORM',
	0x0201: 'R8_UNORM',
	0x0301: 'R4_G4_B4_A4_UNORM',
	0x0401: 'A4_B4_G4_R4_UNORM',
	0x0501: 'R5_G5_B5_A1_UNORM',
	0x0601: 'A1_B5_G5_R5_UNORM',
	0x0701: 'R5_G6_B5_UNORM',
	0x0801: 'B5_G6_R5_UNORM',
	0x0901: 'R8_G8_UNORM',
	0x0b01: 'R8_G8_B8_A8_UNORM',
	0x0b06: 'R8_G8_B8_A8_SRGB',
	0x0c01: 'B8_G8_R8_A8_UNORM',
	0x0c06: 'B8_G8_R8_A8_SRGB',
	0x0e01: 'R10_G10_B10_A2_UNORM',
	0x1a01: 'BC1_UNORM',
	0x1a06: 'BC1_SRGB',
	0x1b01: 'BC2_UNORM',
	0x1b06: 'BC2_SRGB',
	0x1c01: 'BC3_UNORM',
	0x1c06: 'BC3_SRGB',
	0x1d01: 'BC4_UNORM',
	0x1d02: 'BC4_SNORM',
	0x1e01: 'BC5_UNORM',
	0x1e02: 'BC5_SNORM',
	0x1f05: 'BC6_FLOAT',
	0x1f0a: 'BC6_UFLOAT',
	0x2001: 'BC7_UNORM',
	0x2006: 'BC7_SRGB',
	0x2d01: 'ASTC_4x4_UNORM',
	0x2d06: 'ASTC_4x4_SRGB',
	0x2e01: 'ASTC_5x4_UNORM',
	0x2e06: 'ASTC_5x4_SRGB',
	0x2f01: 'ASTC_5x5_UNORM',
	0x2f06: 'ASTC_5x5_SRGB',
	0x3001: 'ASTC_6x5_UNORM',
	0x3006: 'ASTC_6x5_SRGB',
	0x3101: 'ASTC_6x6_UNORM',
	0x3106: 'ASTC_6x6_SRGB',
	0x3201: 'ASTC_8x5_UNORM',
	0x3206: 'ASTC_8x5_SRGB',
	0x3301: 'ASTC_8x6_UNORM',
	0x3306: 'ASTC_8x6_SRGB',
	0x3401: 'ASTC_8x8_UNORM',
	0x3406: 'ASTC_8x8_SRGB',
	0x3501: 'ASTC_10x5_UNORM',
	0x3506: 'ASTC_10x5_SRGB',
	0x3601: 'ASTC_10x6_UNORM',
	0x3606: 'ASTC_10x6_SRGB',
	0x3701: 'ASTC_10x8_UNORM',
	0x3706: 'ASTC_10x8_SRGB',
	0x3801: 'ASTC_10x10_UNORM',
	0x3806: 'ASTC_10x10_SRGB',
	0x3901: 'ASTC_12x10_UNORM',
	0x3906: 'ASTC_12x10_SRGB',
	0x3a01: 'ASTC_12x12_UNORM',
	0x3a06: 'ASTC_12x12_SRGB',
	0x3b01: 'B5_G5_R5_A1_UNORM',
};

/** Friendly name for a format code, e.g. `0x2001 → "BC7_UNORM"`. */
export function formatName(code: number): string {
	return BNTX_FORMATS[code] ?? `0x${code.toString(16).padStart(4, '0')}`;
}

/** Format families that use 4×4 BCn block compression. */
const BCN_FAMILIES = new Set([0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20]);

/** Format families that use ASTC block compression (variable block sizes). */
const ASTC_FAMILIES = new Set([
	0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
	0x39, 0x3a,
]);

/**
 * ASTC block dimensions for each family (`blkWidth × blkHeight`).
 * BCn families always use 4×4.
 */
const ASTC_BLOCK_DIMS: Record<number, [number, number]> = {
	0x2d: [4, 4],
	0x2e: [5, 4],
	0x2f: [5, 5],
	0x30: [6, 5],
	0x31: [6, 6],
	0x32: [8, 5],
	0x33: [8, 6],
	0x34: [8, 8],
	0x35: [10, 5],
	0x36: [10, 6],
	0x37: [10, 8],
	0x38: [10, 10],
	0x39: [12, 10],
	0x3a: [12, 12],
};

/**
 * Bytes per "block" for each format family — for uncompressed
 * formats this equals bytes per pixel; for BCn / ASTC it's the
 * compressed block size (8 or 16 bytes).
 */
const BPP: Record<number, number> = {
	0x01: 0x01, // R4_G4
	0x02: 0x01, // R8
	0x03: 0x02, // R4_G4_B4_A4
	0x04: 0x02, // A4_B4_G4_R4
	0x05: 0x02, // R5_G5_B5_A1
	0x06: 0x02, // A1_B5_G5_R5
	0x07: 0x02, // R5_G6_B5
	0x08: 0x02, // B5_G6_R5
	0x09: 0x02, // R8_G8
	0x0b: 0x04, // R8_G8_B8_A8
	0x0c: 0x04, // B8_G8_R8_A8
	0x0e: 0x04, // R10_G10_B10_A2
	0x1a: 0x08, // BC1
	0x1b: 0x10, // BC2
	0x1c: 0x10, // BC3
	0x1d: 0x08, // BC4
	0x1e: 0x10, // BC5
	0x1f: 0x10, // BC6
	0x20: 0x10, // BC7
	0x2d: 0x10, // all ASTC variants are 16-byte blocks
	0x2e: 0x10,
	0x2f: 0x10,
	0x30: 0x10,
	0x31: 0x10,
	0x32: 0x10,
	0x33: 0x10,
	0x34: 0x10,
	0x35: 0x10,
	0x36: 0x10,
	0x37: 0x10,
	0x38: 0x10,
	0x39: 0x10,
	0x3a: 0x10,
	0x3b: 0x02, // B5_G5_R5_A1
};

export interface FormatInfo {
	/** Format code (the original u32 value). */
	code: number;
	/** Human-readable name, e.g. `"BC7_UNORM"`. */
	name: string;
	/** Format family (high byte). */
	family: number;
	/** Data type (low byte): 0x01 UNORM, 0x02 SNORM, 0x05 FLOAT, 0x06 SRGB, 0x0a UFLOAT. */
	dataType: number;
	/** Block width in pixels (4 for BCn, 1 for uncompressed, varies for ASTC). */
	blkWidth: number;
	/** Block height in pixels. */
	blkHeight: number;
	/** Bytes per block (8 / 16 for compressed; 1..4 for uncompressed). */
	bytesPerBlock: number;
	/** Whether the format uses sRGB encoding for the colour channels. */
	srgb: boolean;
	/** True for BC1..BC7. */
	isBcn: boolean;
	/** True for any ASTC variant. */
	isAstc: boolean;
}

/**
 * Decode a BNTX format code into a structured {@link FormatInfo}.
 * Throws for unknown codes — callers should `try`/`catch` if they
 * want to surface a graceful "unsupported format" error to the UI.
 */
export function formatInfo(code: number): FormatInfo {
	const family = (code >> 8) & 0xff;
	const dataType = code & 0xff;
	const bpp = BPP[family];
	if (bpp === undefined) {
		throw new Error(
			`Unsupported BNTX format family 0x${family.toString(16)} (code 0x${code.toString(16)})`,
		);
	}
	const isBcn = BCN_FAMILIES.has(family);
	const isAstc = ASTC_FAMILIES.has(family);
	let blkWidth = 1;
	let blkHeight = 1;
	if (isBcn) {
		blkWidth = 4;
		blkHeight = 4;
	} else if (isAstc) {
		const dims = ASTC_BLOCK_DIMS[family];
		blkWidth = dims[0];
		blkHeight = dims[1];
	}
	return {
		code,
		name: formatName(code),
		family,
		dataType,
		blkWidth,
		blkHeight,
		bytesPerBlock: bpp,
		srgb: dataType === 0x06,
		isBcn,
		isAstc,
	};
}
