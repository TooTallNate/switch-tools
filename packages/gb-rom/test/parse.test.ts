import { describe, it, expect } from 'vitest';
import { isGb, parseGb, parseGbHeader } from '../src/index.js';

const NINTENDO_LOGO = new Uint8Array([
	0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
	0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
	0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
	0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

/**
 * Assemble a synthetic 32 KiB Game Boy ROM with a correct Nintendo
 * logo and valid header + global checksums (unless corrupted after
 * the fact by the caller).
 */
function makeGbRom(opts: {
	title?: string;
	cgbFlag?: number;
	sgbFlag?: number;
	cartridgeType?: number;
	ramSizeCode?: number;
	destination?: number;
	oldLicensee?: number;
	newLicensee?: string;
	version?: number;
	manufacturerCode?: string;
} = {}): Uint8Array {
	const rom = new Uint8Array(0x8000); // ROM size code 0 = 32 KiB

	rom.set(NINTENDO_LOGO, 0x104);

	const enc = new TextEncoder();
	const title = opts.title ?? 'TEST';
	rom.set(enc.encode(title), 0x134);
	if (opts.manufacturerCode !== undefined) {
		rom.set(enc.encode(opts.manufacturerCode), 0x13f);
	}
	rom[0x143] = opts.cgbFlag ?? 0x00;
	const newLicensee = opts.newLicensee ?? '01';
	rom[0x144] = newLicensee.charCodeAt(0);
	rom[0x145] = newLicensee.charCodeAt(1);
	rom[0x146] = opts.sgbFlag ?? 0x00;
	rom[0x147] = opts.cartridgeType ?? 0x00;
	rom[0x148] = 0x00; // 32 KiB
	rom[0x149] = opts.ramSizeCode ?? 0x00;
	rom[0x14a] = opts.destination ?? 0x01;
	rom[0x14b] = opts.oldLicensee ?? 0x33;
	rom[0x14c] = opts.version ?? 0x00;

	// Header checksum over 0x134..0x14C
	let chk = 0;
	for (let i = 0x134; i <= 0x14c; i++) {
		chk = (chk - rom[i] - 1) & 0xff;
	}
	rom[0x14d] = chk;

	// Global checksum: sum of all bytes except 0x14E/0x14F, big-endian
	let sum = 0;
	for (let i = 0; i < rom.length; i++) {
		if (i === 0x14e || i === 0x14f) continue;
		sum = (sum + rom[i]) & 0xffff;
	}
	rom[0x14e] = sum >> 8;
	rom[0x14f] = sum & 0xff;

	return rom;
}

describe('GB ROM parser', () => {
	it('parses a basic DMG header', () => {
		const rom = makeGbRom({ title: 'TETRIS' });
		const info = parseGbHeader(rom);
		expect(info.title).toBe('TETRIS');
		expect(info.cgb).toBe('none');
		expect(info.sgb).toBe(false);
		expect(info.cartridgeType).toBe(0x00);
		expect(info.cartridgeTypeName).toBe('ROM ONLY');
		expect(info.romSize).toBe(32768);
		expect(info.ramSize).toBe(0);
		expect(info.destination).toBe('overseas');
		expect(info.version).toBe(0);
		expect(info.logoValid).toBe(true);
		expect(info.headerChecksumValid).toBe(true);
		expect(info.globalChecksumValid).toBe(true);
		expect(info.manufacturerCode).toBeUndefined();
	});

	it('decodes CGB flag variants', () => {
		expect(parseGbHeader(makeGbRom({})).cgb).toBe('none');
		expect(parseGbHeader(makeGbRom({ cgbFlag: 0x80 })).cgb).toBe(
			'compatible',
		);
		expect(parseGbHeader(makeGbRom({ cgbFlag: 0xc0 })).cgb).toBe(
			'exclusive',
		);
	});

	it('excludes the CGB flag byte from the title', () => {
		// 16-char title would collide with the CGB flag at 0x143
		const rom = makeGbRom({ title: 'ABCDEFGHIJKLMNO', cgbFlag: 0x80 });
		const info = parseGbHeader(rom);
		expect(info.title).toBe('ABCDEFGHIJKLMNO'); // 15 chars max
	});

	it('exposes the manufacturer code on CGB carts', () => {
		const rom = makeGbRom({
			title: 'ZELDA',
			manufacturerCode: 'AZ8P',
			cgbFlag: 0xc0,
		});
		const info = parseGbHeader(rom);
		expect(info.manufacturerCode).toBe('AZ8P');
		expect(info.title).toBe('ZELDA');
	});

	it('does not report a manufacturer code without the CGB flag', () => {
		const rom = makeGbRom({ title: 'ZELDA', manufacturerCode: 'AZ8P' });
		expect(parseGbHeader(rom).manufacturerCode).toBeUndefined();
	});

	it('decodes the SGB flag', () => {
		expect(parseGbHeader(makeGbRom({ sgbFlag: 0x03 })).sgb).toBe(true);
		expect(parseGbHeader(makeGbRom({ sgbFlag: 0x00 })).sgb).toBe(false);
	});

	it('looks up MBC cartridge type names', () => {
		const rom = makeGbRom({ cartridgeType: 0x03 });
		const info = parseGbHeader(rom);
		expect(info.cartridgeType).toBe(0x03);
		expect(info.cartridgeTypeName).toBe('MBC1+RAM+BATTERY');
		expect(
			parseGbHeader(makeGbRom({ cartridgeType: 0x1b })).cartridgeTypeName,
		).toBe('MBC5+RAM+BATTERY');
	});

	it('decodes RAM size codes', () => {
		expect(parseGbHeader(makeGbRom({ ramSizeCode: 2 })).ramSize).toBe(8192);
		expect(parseGbHeader(makeGbRom({ ramSizeCode: 3 })).ramSize).toBe(
			32768,
		);
		expect(parseGbHeader(makeGbRom({ ramSizeCode: 4 })).ramSize).toBe(
			131072,
		);
		expect(parseGbHeader(makeGbRom({ ramSizeCode: 5 })).ramSize).toBe(
			65536,
		);
	});

	it('resolves the new licensee code when old code is 0x33', () => {
		const rom = makeGbRom({ oldLicensee: 0x33, newLicensee: '01' });
		const info = parseGbHeader(rom);
		expect(info.licenseeCode).toBe('01');
		expect(info.licensee).toBe('Nintendo');
	});

	it('resolves the old licensee code otherwise', () => {
		const rom = makeGbRom({ oldLicensee: 0x08 });
		const info = parseGbHeader(rom);
		expect(info.licenseeCode).toBe('08');
		expect(info.licensee).toBe('Capcom');
	});

	it('decodes destination', () => {
		expect(
			parseGbHeader(makeGbRom({ destination: 0x00 })).destination,
		).toBe('japan');
		expect(
			parseGbHeader(makeGbRom({ destination: 0x01 })).destination,
		).toBe('overseas');
	});

	it('flags a corrupted header checksum', () => {
		const rom = makeGbRom({});
		rom[0x14d] ^= 0xff;
		const info = parseGbHeader(rom);
		expect(info.headerChecksumValid).toBe(false);
		expect(info.logoValid).toBe(true);
	});

	it('flags a corrupted global checksum', () => {
		const rom = makeGbRom({});
		rom[0x14e] ^= 0xff;
		const info = parseGbHeader(rom);
		expect(info.globalChecksumValid).toBe(false);
		expect(info.headerChecksumValid).toBe(true); // header untouched
	});

	it('flags a corrupted logo', () => {
		const rom = makeGbRom({});
		rom[0x104] = 0x00;
		expect(parseGbHeader(rom).logoValid).toBe(false);
	});

	it('throws on inputs shorter than 0x150 bytes', () => {
		expect(() => parseGbHeader(new Uint8Array(0x100))).toThrow(
			/too small/i,
		);
	});

	it('isGb() accepts a valid ROM and rejects garbage', async () => {
		const rom = makeGbRom({});
		expect(await isGb(new Blob([rom as BlobPart]))).toBe(true);

		// Bad logo but valid header checksum → still accepted (lenient)
		const badLogo = makeGbRom({});
		badLogo[0x104] = 0x00;
		expect(await isGb(new Blob([badLogo as BlobPart]))).toBe(true);

		// Garbage: neither logo nor checksum
		const garbage = new Uint8Array(0x8000).fill(0x55);
		expect(await isGb(new Blob([garbage as BlobPart]))).toBe(false);

		// Too small
		expect(
			await isGb(new Blob([new Uint8Array(0x100) as BlobPart])),
		).toBe(false);
	});

	it('parseGb() parses from a Blob and validates the global checksum', async () => {
		const rom = makeGbRom({ title: 'POCKET' });
		const info = await parseGb(new Blob([rom as BlobPart]));
		expect(info.title).toBe('POCKET');
		expect(info.globalChecksumValid).toBe(true);
	});
});
