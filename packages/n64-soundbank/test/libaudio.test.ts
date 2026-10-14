import { describe, expect, it } from 'vitest';
import { decodeAlSample, findAlBankFiles, parseAlBankFile } from '../src/index.js';

/**
 * A one-bank, one-instrument, one-sound ctl whose wavetable is RAW16
 * (so the tbl needs no codebook), followed by its tbl.
 */
function romFixture(): { rom: Uint8Array; tblAt: number } {
	const rom = new Uint8Array(0x400);
	const dv = new DataView(rom.buffer);
	const C = 0x100; // ctl start
	dv.setUint16(C, 0x4231);
	dv.setUint16(C + 2, 1);
	dv.setUint32(C + 4, 0x10); // bank
	dv.setUint16(C + 0x10, 1); // instCount
	dv.setUint32(C + 0x14, 22050); // sampleRate
	dv.setUint32(C + 0x1c, 0x20); // inst[0]
	dv.setUint16(C + 0x20 + 14, 1); // soundCount
	dv.setUint32(C + 0x20 + 16, 0x40); // sound[0]
	dv.setUint32(C + 0x40, 0x60); // envelope
	dv.setUint32(C + 0x44, 0x70); // key map
	dv.setUint32(C + 0x48, 0x80); // wavetable
	dv.setUint32(C + 0x80, 0); // base
	dv.setUint32(C + 0x84, 8); // len
	rom[C + 0x88] = 1; // RAW16
	const tblAt = C + 0x80 + 20; // right after the ctl's last struct
	[1000, -1000, 2000, -2000].forEach((v, i) => dv.setInt16(tblAt + i * 2, v));
	return { rom, tblAt };
}

describe('libaudio ALBankFile', () => {
	it('parses banks, instruments and wavetables', () => {
		const { rom } = romFixture();
		const f = parseAlBankFile(rom.subarray(0x100))!;
		expect(f.samples).toHaveLength(1);
		expect(f.samples[0]).toMatchObject({ base: 0, length: 8, type: 'raw16', sampleRate: 22050, bank: 0, instrument: 0 });
		expect(f.extent).toBe(0x80 + 20);
	});

	it('locates the tbl after the ctl and decodes RAW16', () => {
		const { rom, tblAt } = romFixture();
		const [bank] = findAlBankFiles(rom);
		expect(bank!.ctlOffset).toBe(0x100);
		expect(bank!.tblOffset).toBe(tblAt);
		const r = decodeAlSample(rom.subarray(bank!.tblOffset), bank!.samples[0]!);
		expect(Array.from(r.samples)).toEqual([1000, -1000, 2000, -2000]);
	});

	it('rejects a B1 magic with implausible pointers', () => {
		const rom = new Uint8Array(0x100);
		rom.set([0x42, 0x31, 0, 1, 0xff, 0xff, 0xff, 0xf0]);
		expect(parseAlBankFile(rom)).toBeNull();
	});
});
