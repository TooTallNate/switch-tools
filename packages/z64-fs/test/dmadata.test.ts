import { describe, it, expect } from 'vitest';
import {
	findDmadata,
	parseDmadata,
	parseZ64Fs,
	extractDmaFile,
	dmaFileName,
	type DmaEntry,
} from '../src/index.js';

/**
 * Hand-construct a valid Yaz0 stream whose payload is `data`, using
 * only all-literal groups: a flag byte of 0xFF followed by up to 8
 * literal bytes, repeated.
 */
function makeYaz0(data: Uint8Array): Uint8Array {
	const groups = Math.ceil(data.length / 8);
	const out = new Uint8Array(16 + groups + data.length);
	// Magic 'Yaz0'
	out[0] = 0x59;
	out[1] = 0x61;
	out[2] = 0x7a;
	out[3] = 0x30;
	// Uncompressed size (u32 BE)
	new DataView(out.buffer).setUint32(4, data.length, false);
	// bytes 8..15 reserved (already zero)
	let pos = 16;
	for (let i = 0; i < data.length; i += 8) {
		out[pos++] = 0xff; // 8 literal flags
		const chunk = data.subarray(i, Math.min(i + 8, data.length));
		out.set(chunk, pos);
		pos += chunk.length;
	}
	return out;
}

/** Write one 16-byte dmadata entry (four u32 BE fields) at `offset`. */
function writeEntry(
	view: DataView,
	offset: number,
	vromStart: number,
	vromEnd: number,
	physStart: number,
	physEnd: number,
): void {
	view.setUint32(offset, vromStart, false);
	view.setUint32(offset + 4, vromEnd, false);
	view.setUint32(offset + 8, physStart, false);
	view.setUint32(offset + 12, physEnd, false);
}

const DMADATA_OFFSET = 0x1000;
const BOOT_PHYS = 0x2000;
const BOOT_SIZE = 0x2000 - 0x1060; // 0xfa0
const COMP_PHYS = 0x3000;
const COMP_SIZE = 0x100;

/** Known pattern for the boot file's payload. */
function bootPattern(): Uint8Array {
	const data = new Uint8Array(BOOT_SIZE);
	for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;
	return data;
}

/** Known pattern for the compressed file's decompressed payload. */
function compPattern(): Uint8Array {
	const data = new Uint8Array(COMP_SIZE);
	for (let i = 0; i < data.length; i++) data[i] = (0xa5 ^ i) & 0xff;
	return data;
}

/**
 * Build a synthetic ~64 KB mini-ROM containing a fake dmadata table at
 * a 16-byte-aligned offset:
 *
 *   0: makerom    vrom 0x0000-0x1060  uncompressed at phys 0
 *   1: boot       vrom 0x1060-0x2000  uncompressed at phys 0x2000
 *   2: dmadata    vrom 0x2000-0x2060  uncompressed at phys 0x1000
 *   3: (comp)     vrom 0x2060-0x2160  Yaz0 at phys [0x3000, 0x3000+n)
 *   4: (deleted)  vrom 0x2160-0x2200  physStart/physEnd = 0xFFFFFFFF
 *   5: zero terminator
 */
function makeRom(): Uint8Array {
	const rom = new Uint8Array(0x10000);
	const view = new DataView(rom.buffer);

	const yaz0 = makeYaz0(compPattern());
	const compPhysEnd = COMP_PHYS + yaz0.length;

	writeEntry(view, DMADATA_OFFSET + 0x00, 0x0000, 0x1060, 0x0000, 0);
	writeEntry(view, DMADATA_OFFSET + 0x10, 0x1060, 0x2000, BOOT_PHYS, 0);
	writeEntry(view, DMADATA_OFFSET + 0x20, 0x2000, 0x2060, DMADATA_OFFSET, 0);
	writeEntry(view, DMADATA_OFFSET + 0x30, 0x2060, 0x2160, COMP_PHYS, compPhysEnd);
	writeEntry(view, DMADATA_OFFSET + 0x40, 0x2160, 0x2200, 0xffffffff, 0xffffffff);
	// Entry at +0x50 is the all-zero terminator (already zero).

	rom.set(bootPattern(), BOOT_PHYS);
	rom.set(yaz0, COMP_PHYS);
	return rom;
}

describe('findDmadata', () => {
	it('locates the dmadata table in a synthetic ROM', () => {
		expect(findDmadata(makeRom())).toBe(DMADATA_OFFSET);
	});

	it('returns null for a ROM without a table', () => {
		expect(findDmadata(new Uint8Array(0x10000))).toBe(null);
		const noise = new Uint8Array(0x10000);
		for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + 1) & 0xff;
		expect(findDmadata(noise)).toBe(null);
	});

	it('is not fooled by a lone makerom signature followed by garbage', () => {
		const rom = new Uint8Array(0x10000);
		const view = new DataView(rom.buffer);
		// makerom signature + a second entry with vromStart === 0x1060,
		// but the "table" is garbage: vromEnd < vromStart on a
		// non-deleted entry, then decreasing vromStart values.
		writeEntry(view, 0x100, 0x0000, 0x1060, 0x0000, 0);
		writeEntry(view, 0x110, 0x1060, 0x0900, 0x2000, 0);
		writeEntry(view, 0x120, 0x0800, 0x0900, 0x3000, 0);
		expect(findDmadata(rom)).toBe(null);
	});

	it('rejects a signature whose table has too few entries', () => {
		const rom = new Uint8Array(0x10000);
		const view = new DataView(rom.buffer);
		// makerom + one entry, then immediate zero terminator → only 2
		// entries, below the minimum of 3.
		writeEntry(view, 0x200, 0x0000, 0x1060, 0x0000, 0);
		writeEntry(view, 0x210, 0x1060, 0x2000, 0x1060, 0);
		expect(findDmadata(rom)).toBe(null);
	});

	it('rejects a signature whose table never terminates', () => {
		// Signature right at the end of the buffer — walking the table
		// runs off the end before finding a zero terminator.
		const rom = new Uint8Array(0x40);
		const view = new DataView(rom.buffer);
		writeEntry(view, 0x00, 0x0000, 0x1060, 0x0000, 0);
		writeEntry(view, 0x10, 0x1060, 0x2000, 0x1060, 0);
		writeEntry(view, 0x20, 0x2000, 0x3000, 0x2000, 0);
		writeEntry(view, 0x30, 0x3000, 0x4000, 0x3000, 0);
		expect(findDmadata(rom)).toBe(null);
	});
});

describe('parseDmadata', () => {
	it('decodes all entry fields', () => {
		const rom = makeRom();
		const entries = parseDmadata(rom, DMADATA_OFFSET);
		expect(entries.length).toBe(5);

		const [makerom, boot, dmadata, comp, deleted] = entries;

		expect(makerom.index).toBe(0);
		expect(makerom.vromStart).toBe(0);
		expect(makerom.vromEnd).toBe(0x1060);
		expect(makerom.physStart).toBe(0);
		expect(makerom.physEnd).toBe(0);
		expect(makerom.size).toBe(0x1060);
		expect(makerom.compressed).toBe(false);
		expect(makerom.deleted).toBe(false);
		expect(makerom.romStart).toBe(0);
		expect(makerom.romEnd).toBe(0x1060);
		expect(makerom.name).toBe('makerom');

		expect(boot.size).toBe(BOOT_SIZE);
		expect(boot.compressed).toBe(false);
		expect(boot.deleted).toBe(false);
		expect(boot.romStart).toBe(BOOT_PHYS);
		expect(boot.romEnd).toBe(BOOT_PHYS + BOOT_SIZE);
		expect(boot.name).toBe('boot');

		expect(dmadata.name).toBe('dmadata');
		expect(dmadata.romStart).toBe(DMADATA_OFFSET);

		expect(comp.compressed).toBe(true);
		expect(comp.deleted).toBe(false);
		expect(comp.size).toBe(COMP_SIZE);
		expect(comp.romStart).toBe(COMP_PHYS);
		expect(comp.romEnd).toBe(comp.physEnd);
		expect(comp.physEnd).toBeGreaterThan(COMP_PHYS);
		// Index 3 is a well-known name — naming is purely index-based.
		expect(comp.name).toBe('Audiobank');

		expect(deleted.deleted).toBe(true);
		expect(deleted.compressed).toBe(false);
		expect(deleted.physStart).toBe(0xffffffff);
		expect(deleted.physEnd).toBe(0xffffffff);
		expect(deleted.size).toBe(0x2200 - 0x2160);
		expect(deleted.name).toBe('Audioseq');
	});
});

describe('parseZ64Fs', () => {
	it('finds and parses in one call', () => {
		const fs = parseZ64Fs(makeRom());
		expect(fs).not.toBe(null);
		expect(fs!.dmadataOffset).toBe(DMADATA_OFFSET);
		expect(fs!.entries.length).toBe(5);
		expect(fs!.entries[1].name).toBe('boot');
	});

	it('returns null when no table is present', () => {
		expect(parseZ64Fs(new Uint8Array(0x10000))).toBe(null);
	});
});

describe('extractDmaFile', () => {
	function setup(): { rom: Blob; entries: DmaEntry[] } {
		const bytes = makeRom();
		const entries = parseDmadata(bytes, DMADATA_OFFSET);
		// Cast: TS lib.dom.d.ts insists on `ArrayBufferView<ArrayBuffer>`
		// for `BlobPart`.
		return { rom: new Blob([bytes as BlobPart]), entries };
	}

	it('slices uncompressed files straight out of the ROM', async () => {
		const { rom, entries } = setup();
		const file = await extractDmaFile(rom, entries[1]); // boot
		expect(file.size).toBe(BOOT_SIZE);
		const got = new Uint8Array(await file.arrayBuffer());
		expect(got).toEqual(bootPattern());
	});

	it('Yaz0-decompresses compressed files', async () => {
		const { rom, entries } = setup();
		const file = await extractDmaFile(rom, entries[3]);
		expect(file.size).toBe(COMP_SIZE);
		const got = new Uint8Array(await file.arrayBuffer());
		expect(got).toEqual(compPattern());
	});

	it('throws for deleted entries', async () => {
		const { rom, entries } = setup();
		await expect(extractDmaFile(rom, entries[4])).rejects.toThrow(
			/not present in this ROM/,
		);
	});

	it('throws on decompressed-size mismatch', async () => {
		const { rom, entries } = setup();
		// Corrupt the entry's virtual size so it no longer matches the
		// Yaz0 stream's decompressed size.
		const corrupt: DmaEntry = {
			...entries[3],
			vromEnd: entries[3].vromEnd + 0x10,
			size: entries[3].size + 0x10,
		};
		await expect(extractDmaFile(rom, corrupt)).rejects.toThrow(
			/size mismatch/,
		);
	});
});

describe('dmaFileName', () => {
	it('returns well-known names for the first indices', () => {
		expect(dmaFileName(0, { vromStart: 0 })).toBe('makerom');
		expect(dmaFileName(1, { vromStart: 0x1060 })).toBe('boot');
		expect(dmaFileName(2, { vromStart: 0x2000 })).toBe('dmadata');
		expect(dmaFileName(3, { vromStart: 0 })).toBe('Audiobank');
		expect(dmaFileName(4, { vromStart: 0 })).toBe('Audioseq');
		expect(dmaFileName(5, { vromStart: 0 })).toBe('Audiotable');
	});

	it('generates padded generic names for everything else', () => {
		expect(dmaFileName(6, { vromStart: 0x2060 })).toBe(
			'file_0006_0x00002060',
		);
		expect(dmaFileName(42, { vromStart: 0xabcdef0 })).toBe(
			'file_0042_0x0ABCDEF0',
		);
		expect(dmaFileName(1234, { vromStart: 0 })).toBe(
			'file_1234_0x00000000',
		);
	});
});
