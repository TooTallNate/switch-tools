/**
 * Game Boy / Game Boy Color ROM cartridge header parser.
 *
 * GB ROMs are raw dumps of the cartridge address space with no
 * container format. The cartridge header lives at a fixed location —
 * 0x100..0x14F — right after the CPU entry point:
 *
 *   0x100..0x103 = entry point code (usually `nop; jp $0150`)
 *   0x104..0x133 = Nintendo logo bitmap, 48 bytes. The boot ROM
 *                  compares this against its own copy and locks up on
 *                  mismatch, so it's effectively a magic value.
 *   0x134..0x143 = title, up to 16 bytes of upper-case ASCII, zero or
 *                  space padded. Later cartridges reuse the tail:
 *                    0x13F..0x142 = manufacturer code (4 ASCII chars)
 *                    0x143        = CGB flag
 *   0x143        = CGB flag: 0x80 = CGB-compatible (also runs on DMG),
 *                  0xC0 = CGB-exclusive, anything else = DMG title.
 *   0x144..0x145 = "new" licensee code, 2 ASCII chars; only meaningful
 *                  when the old licensee code (0x14B) is 0x33.
 *   0x146        = SGB flag (0x03 = Super Game Boy support)
 *   0x147        = cartridge type (MBC + peripherals; see table below)
 *   0x148        = ROM size code; size = 32768 << code (codes 0..8)
 *   0x149        = RAM size code: 0/1 → 0, 2 → 8 KiB, 3 → 32 KiB,
 *                  4 → 128 KiB, 5 → 64 KiB
 *   0x14A        = destination: 0x00 = Japan, 0x01 = overseas
 *   0x14B        = old licensee code; 0x33 = "use new licensee code"
 *   0x14C        = mask ROM version number
 *   0x14D        = header checksum over 0x134..0x14C:
 *                    chk = 0
 *                    for i in 0x134..=0x14C: chk = (chk - byte[i] - 1) & 0xFF
 *                  The boot ROM verifies this, so a valid checksum is a
 *                  strong signal the file really is a GB ROM.
 *   0x14E..0x14F = global checksum, big-endian u16: the sum of every
 *                  byte in the ROM except these two, & 0xFFFF. Not
 *                  verified by hardware; often wrong in homebrew.
 *
 * References:
 *   - https://gbdev.io/pandocs/The_Cartridge_Header.html
 */

const HEADER_END = 0x150;

/** The 48-byte Nintendo logo bitmap at 0x104..0x133. */
const NINTENDO_LOGO = new Uint8Array([
	0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
	0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
	0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
	0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

/** Cartridge type byte (0x147) → hardware name. */
const CARTRIDGE_TYPE_NAMES: Record<number, string> = {
	0x00: 'ROM ONLY',
	0x01: 'MBC1',
	0x02: 'MBC1+RAM',
	0x03: 'MBC1+RAM+BATTERY',
	0x05: 'MBC2',
	0x06: 'MBC2+BATTERY',
	0x08: 'ROM+RAM',
	0x09: 'ROM+RAM+BATTERY',
	0x0b: 'MMM01',
	0x0c: 'MMM01+RAM',
	0x0d: 'MMM01+RAM+BATTERY',
	0x0f: 'MBC3+TIMER+BATTERY',
	0x10: 'MBC3+TIMER+RAM+BATTERY',
	0x11: 'MBC3',
	0x12: 'MBC3+RAM',
	0x13: 'MBC3+RAM+BATTERY',
	0x19: 'MBC5',
	0x1a: 'MBC5+RAM',
	0x1b: 'MBC5+RAM+BATTERY',
	0x1c: 'MBC5+RUMBLE',
	0x1d: 'MBC5+RUMBLE+RAM',
	0x1e: 'MBC5+RUMBLE+RAM+BATTERY',
	0x20: 'MBC6',
	0x22: 'MBC7+SENSOR+RUMBLE+RAM+BATTERY',
	0xfc: 'POCKET CAMERA',
	0xfd: 'BANDAI TAMA5',
	0xfe: 'HuC3',
	0xff: 'HuC1+RAM+BATTERY',
};

/** Common licensee codes → publisher name. */
const LICENSEE_NAMES: Record<string, string> = {
	'01': 'Nintendo',
	'08': 'Capcom',
	'13': 'EA',
	'18': 'Hudson',
	'20': 'KSS',
	'28': 'Kemco',
	'31': 'Nintendo',
	'34': 'Konami',
	'38': 'Hudson',
	'41': 'Ubisoft',
	'50': 'Absolute',
	'51': 'Acclaim',
	'52': 'Activision',
	'54': 'Konami',
	'5A': 'Mindscape',
	'69': 'EA',
	'70': 'Infogrames',
	'71': 'Interplay',
	'78': 'THQ',
	'79': 'Accolade',
	'92': 'Video System',
	A4: 'Konami',
	B2: 'Bandai',
};

/** RAM size code (0x149) → bytes. */
const RAM_SIZES: Record<number, number> = {
	0: 0,
	1: 0, // listed but unused in licensed software
	2: 8192,
	3: 32768,
	4: 131072,
	5: 65536,
};

export interface GbRomInfo {
	title: string;
	manufacturerCode?: string;
	cgb: 'none' | 'compatible' | 'exclusive';
	sgb: boolean;
	cartridgeType: number;
	cartridgeTypeName?: string;
	/** ROM size in bytes. */
	romSize: number;
	/** Cartridge RAM size in bytes. */
	ramSize: number;
	destination: 'japan' | 'overseas';
	/** Resolved publisher name, when known. */
	licensee?: string;
	/** Hex old licensee code, or the 2-char new code when old == 0x33. */
	licenseeCode: string;
	/** Mask ROM version number. */
	version: number;
	logoValid: boolean;
	headerChecksumValid: boolean;
	/** Global checksum as stored in the header (big-endian u16). */
	globalChecksum: number;
	globalChecksumValid: boolean;
}

function logoMatches(bytes: Uint8Array): boolean {
	for (let i = 0; i < NINTENDO_LOGO.length; i++) {
		if (bytes[0x104 + i] !== NINTENDO_LOGO[i]) return false;
	}
	return true;
}

/** `chk = 0; for (i = 0x134..=0x14C) chk = (chk - byte[i] - 1) & 0xFF` */
function computeHeaderChecksum(bytes: Uint8Array): number {
	let chk = 0;
	for (let i = 0x134; i <= 0x14c; i++) {
		chk = (chk - bytes[i] - 1) & 0xff;
	}
	return chk;
}

/** Sum of every ROM byte except the two global-checksum bytes. */
function computeGlobalChecksum(bytes: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (i === 0x14e || i === 0x14f) continue;
		sum = (sum + bytes[i]) & 0xffff;
	}
	return sum;
}

function isUpperOrDigit(b: number): boolean {
	return (b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39);
}

/**
 * Parse the cartridge header of a Game Boy ROM. `bytes` should be the
 * *whole* ROM (at least 0x150 bytes); `globalChecksumValid` is
 * computed over every byte given.
 */
export function parseGbHeader(bytes: Uint8Array): GbRomInfo {
	if (bytes.length < HEADER_END) {
		throw new Error(
			`Input too small to be a Game Boy ROM (${bytes.length} bytes, need ${HEADER_END})`,
		);
	}

	const cgbFlag = bytes[0x143];
	const cgb: GbRomInfo['cgb'] =
		cgbFlag === 0x80
			? 'compatible'
			: cgbFlag === 0xc0
				? 'exclusive'
				: 'none';

	// Title: 0x134..0x143 inclusive on early carts; when the CGB flag
	// is set, byte 0x143 is not part of the title (max 15 bytes).
	const titleEnd = cgb === 'none' ? 0x144 : 0x143;
	let titleBytes = bytes.subarray(0x134, titleEnd);
	const nul = titleBytes.indexOf(0);
	if (nul !== -1) titleBytes = titleBytes.subarray(0, nul);
	const title = new TextDecoder('ascii')
		.decode(titleBytes)
		.replace(/[ \0]+$/, '');

	// Manufacturer code: 0x13F..0x142, only when the CGB flag is set
	// and all four bytes are printable upper-case ASCII / digits.
	let manufacturerCode: string | undefined;
	if (cgb !== 'none') {
		const mfg = bytes.subarray(0x13f, 0x143);
		if (mfg.every(isUpperOrDigit)) {
			manufacturerCode = new TextDecoder('ascii').decode(mfg);
		}
	}

	const oldLicensee = bytes[0x14b];
	let licenseeCode: string;
	if (oldLicensee === 0x33) {
		licenseeCode = String.fromCharCode(bytes[0x144], bytes[0x145]);
	} else {
		licenseeCode = oldLicensee
			.toString(16)
			.toUpperCase()
			.padStart(2, '0');
	}
	const licensee: string | undefined = LICENSEE_NAMES[licenseeCode];

	const cartridgeType = bytes[0x147];
	const romSizeCode = bytes[0x148];
	const romSize = romSizeCode <= 0x08 ? 32768 << romSizeCode : 0;
	const ramSize = RAM_SIZES[bytes[0x149]] ?? 0;

	const globalChecksum = (bytes[0x14e] << 8) | bytes[0x14f];

	return {
		title,
		manufacturerCode,
		cgb,
		sgb: bytes[0x146] === 0x03,
		cartridgeType,
		cartridgeTypeName: CARTRIDGE_TYPE_NAMES[cartridgeType],
		romSize,
		ramSize,
		destination: bytes[0x14a] === 0x00 ? 'japan' : 'overseas',
		licensee,
		licenseeCode,
		version: bytes[0x14c],
		logoValid: logoMatches(bytes),
		headerChecksumValid: computeHeaderChecksum(bytes) === bytes[0x14d],
		globalChecksum,
		globalChecksumValid: computeGlobalChecksum(bytes) === globalChecksum,
	};
}

/**
 * Sniff whether a `Blob` looks like a Game Boy ROM: the Nintendo logo
 * must match *or* the header checksum must validate (some homebrew
 * ships a bad logo and relies on flash carts not checking it).
 */
export async function isGb(blob: Blob): Promise<boolean> {
	if (blob.size < HEADER_END) return false;
	const head = new Uint8Array(
		await blob.slice(0, HEADER_END).arrayBuffer(),
	);
	return (
		logoMatches(head) ||
		computeHeaderChecksum(head) === head[0x14d]
	);
}

/**
 * Parse the cartridge header of a Game Boy ROM `Blob`. Reads the whole
 * file (GB ROMs top out at 8 MiB) so the global checksum can be
 * verified.
 */
export async function parseGb(blob: Blob): Promise<GbRomInfo> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return parseGbHeader(bytes);
}
