import { describe, it, expect } from 'vitest';
import {
	isNes,
	parseNes,
	parseNesHeader,
	NES_MAPPER_NAMES,
} from '../src/index.js';

/**
 * Build a synthetic iNES / NES 2.0 ROM. Payload contents are
 * irrelevant for header parsing; they're zero-filled and only sized
 * so that the file layout is realistic.
 */
function makeNes(opts: {
	prgUnits?: number; // 16 KiB units (header byte 4)
	chrUnits?: number; // 8 KiB units (header byte 5)
	flags6?: number;
	flags7?: number;
	byte8?: number;
	byte9?: number;
	byte10?: number;
	byte11?: number;
	byte12?: number;
	byte13?: number;
}): Uint8Array {
	const prgUnits = opts.prgUnits ?? 1;
	const chrUnits = opts.chrUnits ?? 0;
	const flags6 = opts.flags6 ?? 0;
	const trainer = (flags6 & 0b100) !== 0;

	const total =
		16 + (trainer ? 512 : 0) + prgUnits * 16384 + chrUnits * 8192;
	const buf = new Uint8Array(total);
	buf[0] = 0x4e; // N
	buf[1] = 0x45; // E
	buf[2] = 0x53; // S
	buf[3] = 0x1a;
	buf[4] = prgUnits;
	buf[5] = chrUnits;
	buf[6] = flags6;
	buf[7] = opts.flags7 ?? 0;
	buf[8] = opts.byte8 ?? 0;
	buf[9] = opts.byte9 ?? 0;
	buf[10] = opts.byte10 ?? 0;
	buf[11] = opts.byte11 ?? 0;
	buf[12] = opts.byte12 ?? 0;
	buf[13] = opts.byte13 ?? 0;
	return buf;
}

describe('NES ROM parser', () => {
	it('parses a basic iNES header', () => {
		// Mapper 4 (MMC3), vertical mirroring, battery
		const rom = makeNes({
			prgUnits: 2,
			chrUnits: 1,
			flags6: (4 << 4) | 0b011, // mapper low=4, battery, vertical
		});
		const info = parseNesHeader(rom);
		expect(info.format).toBe('ines');
		expect(info.prgRomSize).toBe(32768);
		expect(info.chrRomSize).toBe(8192);
		expect(info.mapper).toBe(4);
		expect(info.mapperName).toBe('MMC3');
		expect(info.mirroring).toBe('vertical');
		expect(info.battery).toBe(true);
		expect(info.trainer).toBe(false);
		expect(info.consoleType).toBe('nes');
		expect(info.trainerOffset).toBeUndefined();
		expect(info.prgRomOffset).toBe(16);
		expect(info.chrRomOffset).toBe(16 + 32768);
		// NES 2.0-only fields are absent for plain iNES
		expect(info.submapper).toBeUndefined();
		expect(info.timing).toBeUndefined();
		expect(info.prgRamSize).toBeUndefined();
	});

	it('detects NES 2.0 and decodes submapper, RAM shifts and timing', () => {
		const rom = makeNes({
			prgUnits: 2,
			chrUnits: 1,
			flags6: 1 << 4, // mapper low nibble = 1
			flags7: 0b1000 | (0x1 << 4), // NES 2.0, mapper mid nibble = 1
			byte8: (3 << 4) | 0x1, // submapper 3, mapper high nibble = 1
			byte10: (7 << 4) | 5, // PRG-RAM shift 5, PRG-NVRAM shift 7
			byte11: (0 << 4) | 6, // CHR-RAM shift 6, CHR-NVRAM shift 0
			byte12: 1, // PAL
		});
		const info = parseNesHeader(rom);
		expect(info.format).toBe('nes2');
		expect(info.mapper).toBe(0x111); // 273
		expect(info.submapper).toBe(3);
		expect(info.prgRamSize).toBe(64 << 5); // 2048
		expect(info.prgNvramSize).toBe(64 << 7); // 8192
		expect(info.chrRamSize).toBe(64 << 6); // 4096
		expect(info.chrNvramSize).toBe(0);
		expect(info.timing).toBe('pal');
		expect(info.prgRomSize).toBe(32768);
		expect(info.chrRomSize).toBe(8192);
	});

	it('extends ROM sizes with the NES 2.0 high nibbles', () => {
		const rom = makeNes({
			prgUnits: 0x34,
			chrUnits: 0x12,
			flags7: 0b1000,
			byte9: (0x1 << 4) | 0x2, // PRG high = 0x2, CHR high = 0x1
		});
		const info = parseNesHeader(rom);
		expect(info.prgRomSize).toBe(0x234 * 16384);
		expect(info.chrRomSize).toBe(0x112 * 8192);
	});

	it('decodes NES 2.0 exponent-form ROM sizes', () => {
		const rom = makeNes({
			// low byte: exponent = 10 (bits 2-7), multiplier = 1 (bits 0-1)
			prgUnits: (10 << 2) | 1,
			chrUnits: 0,
			flags7: 0b1000,
			byte9: 0x0f, // PRG size high nibble = 0xF → exponent form
		});
		const info = parseNesHeader(rom);
		// 2^10 * (1*2 + 1) = 3072
		expect(info.prgRomSize).toBe(3072);
	});

	it('accounts for the 512-byte trainer in offsets', () => {
		const rom = makeNes({
			prgUnits: 1,
			chrUnits: 1,
			flags6: 0b100, // trainer
		});
		const info = parseNesHeader(rom);
		expect(info.trainer).toBe(true);
		expect(info.trainerOffset).toBe(16);
		expect(info.prgRomOffset).toBe(16 + 512);
		expect(info.chrRomOffset).toBe(16 + 512 + 16384);
	});

	it('four-screen VRAM overrides the mirroring bit', () => {
		const rom = makeNes({ flags6: 0b1001 }); // four-screen + vertical bit
		expect(parseNesHeader(rom).mirroring).toBe('four-screen');
	});

	it('reports CHR-RAM boards (chrRomSize 0) without a chrRomOffset', () => {
		const rom = makeNes({ prgUnits: 1, chrUnits: 0 });
		const info = parseNesHeader(rom);
		expect(info.chrRomSize).toBe(0);
		expect(info.chrRomOffset).toBeUndefined();
	});

	it('maps flags7 bits 0-1 to a console type', () => {
		expect(parseNesHeader(makeNes({ flags7: 0b01 })).consoleType).toBe(
			'vs-system',
		);
		expect(parseNesHeader(makeNes({ flags7: 0b10 })).consoleType).toBe(
			'playchoice-10',
		);
		expect(
			parseNesHeader(makeNes({ flags7: 0b1000 | 0b11 })).consoleType,
		).toBe('extended');
	});

	it('throws on a bad magic', () => {
		const bad = makeNes({});
		bad[3] = 0x00;
		expect(() => parseNesHeader(bad)).toThrow(/bad magic/i);
	});

	it('throws on inputs shorter than the header', () => {
		expect(() => parseNesHeader(new Uint8Array(8))).toThrow(/too small/i);
	});

	it('isNes() sniffs the magic from a Blob', async () => {
		const rom = makeNes({});
		expect(await isNes(new Blob([rom as BlobPart]))).toBe(true);
		expect(
			await isNes(new Blob([new Uint8Array(64) as BlobPart])),
		).toBe(false);
		expect(
			await isNes(new Blob([new Uint8Array(4) as BlobPart])),
		).toBe(false);
	});

	it('parseNes() parses from a Blob', async () => {
		const rom = makeNes({ prgUnits: 2, chrUnits: 1 });
		const info = await parseNes(new Blob([rom as BlobPart]));
		expect(info.prgRomSize).toBe(32768);
		expect(info.chrRomSize).toBe(8192);
	});

	it('exposes a mapper name table', () => {
		expect(NES_MAPPER_NAMES[0]).toBe('NROM');
		expect(NES_MAPPER_NAMES[1]).toBe('MMC1');
		expect(NES_MAPPER_NAMES[69]).toBe('Sunsoft FME-7');
		expect(NES_MAPPER_NAMES[85]).toBe('VRC7');
	});
});
