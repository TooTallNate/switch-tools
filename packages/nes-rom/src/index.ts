/**
 * iNES / NES 2.0 ROM image parser.
 *
 * Nearly every NES ROM dump in the wild is wrapped in the iNES
 * container format (or its backwards-compatible successor, NES 2.0).
 * The container is a fixed 16-byte header followed by the raw ROM
 * segments — no compression, no checksums.
 *
 * Header layout:
 *
 *   bytes 0..3  = magic ('N','E','S',0x1A)
 *   byte  4     = PRG-ROM size in 16384-byte units
 *   byte  5     = CHR-ROM size in 8192-byte units (0 = board uses CHR-RAM)
 *   byte  6     = flags6:
 *                   bit 0    nametable arrangement (0=horizontal mirroring,
 *                            1=vertical)
 *                   bit 1    battery-backed PRG-RAM present
 *                   bit 2    512-byte trainer present (before PRG-ROM)
 *                   bit 3    four-screen VRAM (overrides mirroring)
 *                   bits 4-7 mapper number, low nibble
 *   byte  7     = flags7:
 *                   bit 0    VS Unisystem
 *                   bit 1    PlayChoice-10
 *                   bits 2-3 == 0b10 → header is NES 2.0
 *                   bits 4-7 mapper number, high nibble
 *
 * NES 2.0 extends bytes 8..15 (which are junk/zero in plain iNES):
 *
 *   byte  8     = bits 0-3 mapper bits 8-11, bits 4-7 submapper
 *   byte  9     = bits 0-3 PRG-ROM size high nibble,
 *                 bits 4-7 CHR-ROM size high nibble.
 *                 A size nibble of 0xF selects *exponent form*: the
 *                 corresponding low byte (4 or 5) is reinterpreted as
 *                 multiplier (bits 0-1) and exponent (bits 2-7), and
 *                 size = 2^exponent * (multiplier*2 + 1) bytes.
 *   byte 10     = bits 0-3 PRG-RAM shift, bits 4-7 PRG-NVRAM shift.
 *                 Size = shift == 0 ? 0 : 64 << shift.
 *   byte 11     = same encoding for CHR-RAM / CHR-NVRAM.
 *   byte 12     = bits 0-1 CPU/PPU timing: 0=NTSC (RP2C02),
 *                 1=PAL (RP2C07), 2=multi-region, 3=Dendy.
 *   byte 13     = console type detail (VS PPU/hardware type, or the
 *                 extended console type when flags7 bits 0-1 == 3).
 *
 * File layout after the header:
 *
 *   [512-byte trainer, only when flags6 bit 2 is set]
 *   PRG-ROM
 *   CHR-ROM (absent when CHR-ROM size is 0)
 *
 * References:
 *   - https://www.nesdev.org/wiki/INES
 *   - https://www.nesdev.org/wiki/NES_2.0
 */

const HEADER_SIZE = 16;
const TRAINER_SIZE = 512;
const PRG_ROM_UNIT = 16384;
const CHR_ROM_UNIT = 8192;

export interface NesRomInfo {
	format: 'ines' | 'nes2';
	/** PRG-ROM size in bytes. */
	prgRomSize: number;
	/** CHR-ROM size in bytes (0 = board uses CHR-RAM). */
	chrRomSize: number;
	mapper: number;
	/** NES 2.0 only. */
	submapper?: number;
	/** Human-readable mapper name, from {@link NES_MAPPER_NAMES}. */
	mapperName?: string;
	mirroring: 'horizontal' | 'vertical' | 'four-screen';
	battery: boolean;
	trainer: boolean;
	consoleType: 'nes' | 'vs-system' | 'playchoice-10' | 'extended';
	/** NES 2.0 only. */
	timing?: 'ntsc' | 'pal' | 'multi' | 'dendy';
	/** NES 2.0 only; bytes. */
	prgRamSize?: number;
	/** NES 2.0 only; bytes. */
	prgNvramSize?: number;
	/** NES 2.0 only; bytes. */
	chrRamSize?: number;
	/** NES 2.0 only; bytes. */
	chrNvramSize?: number;
	/** Byte offset of the 512-byte trainer, when present. */
	trainerOffset?: number;
	/** Byte offset of PRG-ROM within the file. */
	prgRomOffset: number;
	/** Byte offset of CHR-ROM within the file (undefined when chrRomSize is 0). */
	chrRomOffset?: number;
}

/** Names for the most common iNES mapper numbers. */
export const NES_MAPPER_NAMES: Record<number, string> = {
	0: 'NROM',
	1: 'MMC1',
	2: 'UxROM',
	3: 'CNROM',
	4: 'MMC3',
	5: 'MMC5',
	7: 'AxROM',
	9: 'MMC2',
	10: 'MMC4',
	11: 'Color Dreams',
	13: 'CPROM',
	16: 'Bandai FCG',
	18: 'Jaleco SS88006',
	19: 'Namco 163',
	21: 'VRC4a/c',
	22: 'VRC2a',
	23: 'VRC4e/f/VRC2b',
	24: 'VRC6a',
	25: 'VRC4b/d/VRC2c',
	26: 'VRC6b',
	28: 'Action 53',
	30: 'UNROM 512',
	33: 'Taito TC0190',
	34: 'BNROM/NINA-001',
	48: 'Taito TC0690',
	64: 'RAMBO-1',
	65: 'Irem H3001',
	66: 'GxROM',
	68: 'Sunsoft-4',
	69: 'Sunsoft FME-7',
	70: 'Bandai',
	71: 'Camerica',
	73: 'VRC3',
	75: 'VRC1',
	76: 'Namco 3446',
	79: 'NINA-03/06',
	85: 'VRC7',
	87: 'Jaleco JF-05',
	105: 'NES-EVENT',
	118: 'TxSROM',
	119: 'TQROM',
	206: 'Namco 118',
	210: 'Namco 175/340',
	228: 'Action 52',
	232: 'Camerica Quattro',
};

const CONSOLE_TYPES = ['nes', 'vs-system', 'playchoice-10', 'extended'] as const;
const TIMINGS = ['ntsc', 'pal', 'multi', 'dendy'] as const;

function hasNesMagic(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x4e /* N */ &&
		bytes[1] === 0x45 /* E */ &&
		bytes[2] === 0x53 /* S */ &&
		bytes[3] === 0x1a
	);
}

/**
 * Decode a NES 2.0 ROM size from its low byte (header byte 4 or 5)
 * and high nibble (from header byte 9). Returns the size in *bytes*.
 */
function nes2RomSize(low: number, high: number, unit: number): number {
	if (high === 0xf) {
		// Exponent form: size = 2^exponent * (multiplier*2 + 1)
		const exponent = low >> 2;
		const multiplier = low & 0b11;
		return 2 ** exponent * (multiplier * 2 + 1);
	}
	return ((high << 8) | low) * unit;
}

/** Decode a NES 2.0 RAM shift nibble: 0 → 0 bytes, else 64 << shift. */
function nes2RamSize(shift: number): number {
	return shift === 0 ? 0 : 64 << shift;
}

/**
 * Parse an iNES / NES 2.0 header from the raw file bytes. Only the
 * first 16 bytes are examined (segment offsets are computed, not
 * bounds-checked against `bytes.length`).
 *
 * Throws when the magic is missing or the input is too short.
 */
export function parseNesHeader(bytes: Uint8Array): NesRomInfo {
	if (bytes.length < HEADER_SIZE) {
		throw new Error(
			`Input too small to be a NES ROM (${bytes.length} bytes, need ${HEADER_SIZE})`,
		);
	}
	if (!hasNesMagic(bytes)) {
		throw new Error('Not a NES ROM (bad magic, expected "NES\\x1A")');
	}

	const flags6 = bytes[6];
	const flags7 = bytes[7];
	const isNes2 = (flags7 & 0b1100) === 0b1000;

	const battery = (flags6 & 0b0010) !== 0;
	const trainer = (flags6 & 0b0100) !== 0;
	const fourScreen = (flags6 & 0b1000) !== 0;
	const mirroring: NesRomInfo['mirroring'] = fourScreen
		? 'four-screen'
		: (flags6 & 0b0001) !== 0
			? 'vertical'
			: 'horizontal';

	let mapper = (flags7 & 0xf0) | (flags6 >> 4);
	const consoleType = CONSOLE_TYPES[flags7 & 0b11];

	let prgRomSize = bytes[4] * PRG_ROM_UNIT;
	let chrRomSize = bytes[5] * CHR_ROM_UNIT;

	let submapper: number | undefined;
	let timing: NesRomInfo['timing'];
	let prgRamSize: number | undefined;
	let prgNvramSize: number | undefined;
	let chrRamSize: number | undefined;
	let chrNvramSize: number | undefined;

	if (isNes2) {
		mapper |= (bytes[8] & 0x0f) << 8;
		submapper = bytes[8] >> 4;
		prgRomSize = nes2RomSize(bytes[4], bytes[9] & 0x0f, PRG_ROM_UNIT);
		chrRomSize = nes2RomSize(bytes[5], bytes[9] >> 4, CHR_ROM_UNIT);
		prgRamSize = nes2RamSize(bytes[10] & 0x0f);
		prgNvramSize = nes2RamSize(bytes[10] >> 4);
		chrRamSize = nes2RamSize(bytes[11] & 0x0f);
		chrNvramSize = nes2RamSize(bytes[11] >> 4);
		timing = TIMINGS[bytes[12] & 0b11];
	}

	const trainerOffset = trainer ? HEADER_SIZE : undefined;
	const prgRomOffset = HEADER_SIZE + (trainer ? TRAINER_SIZE : 0);
	const chrRomOffset =
		chrRomSize > 0 ? prgRomOffset + prgRomSize : undefined;

	return {
		format: isNes2 ? 'nes2' : 'ines',
		prgRomSize,
		chrRomSize,
		mapper,
		submapper,
		mapperName: NES_MAPPER_NAMES[mapper],
		mirroring,
		battery,
		trainer,
		consoleType,
		timing,
		prgRamSize,
		prgNvramSize,
		chrRamSize,
		chrNvramSize,
		trainerOffset,
		prgRomOffset,
		chrRomOffset,
	};
}

/** Cheap (16-byte) check for the iNES magic. */
export async function isNes(blob: Blob): Promise<boolean> {
	if (blob.size < HEADER_SIZE) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return hasNesMagic(head);
}

/** Parse the iNES / NES 2.0 header of a `Blob`. */
export async function parseNes(blob: Blob): Promise<NesRomInfo> {
	const head = new Uint8Array(
		await blob.slice(0, HEADER_SIZE).arrayBuffer(),
	);
	return parseNesHeader(head);
}
