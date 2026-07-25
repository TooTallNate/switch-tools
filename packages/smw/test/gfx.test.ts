import { describe, it, expect } from 'vitest';
import {
	SMW_GFX_COUNT,
	SMW_GFX_PTR_LOW,
	SMW_GFX_PTR_HIGH,
	SMW_GFX_PTR_BANK,
	SMW_PALETTE_BLOCK,
	SMW_TITLE,
	bppForSize,
	bytesPerTile,
	isSmw,
	listSmwGfx,
	loromToPc,
	readAllSmwGfx,
	readSmwGfx,
	readSmwPalette,
	readSmwPalettes,
	readTitle,
	stripCopierHeader,
} from '../src/index.js';

/**
 * Build a synthetic 512 KiB LoROM that mimics SMW's structure: the
 * internal header title, the three GFX pointer tables, LC_LZ2
 * streams at the pointed-to offsets, and a palette block.
 *
 * No commercial ROM data is used — the "graphics" are byte-fill
 * runs whose decompressed sizes exercise the bpp inference rules.
 */
function makeSmwLikeRom(opts: { title?: string; sizes?: number[] } = {}) {
	const rom = new Uint8Array(0x80000);
	const title = opts.title ?? SMW_TITLE;
	// Internal header title at 0x7FC0, space-padded to 21 bytes.
	for (let i = 0; i < 21; i++) {
		rom[0x7fc0 + i] = i < title.length ? title.charCodeAt(i) : 0x20;
	}
	rom[0x7fd5] = 0x20; // LoROM

	// Lay LC_LZ2 streams out back-to-back starting at 0x40000, and
	// point the tables at them.
	const sizes =
		opts.sizes ?? new Array(SMW_GFX_COUNT).fill(0).map(() => 3072);
	let write = 0x40000;
	sizes.forEach((size, i) => {
		// Encode `size` bytes as extended byte-fill runs (max 1024
		// per command), then the 0xFF terminator.
		const start = write;
		let remaining = size;
		let fill = 0x10 + i;
		while (remaining > 0) {
			const n = Math.min(1024, remaining);
			const encoded = n - 1;
			rom[write++] = 0xe0 | (1 << 2) | ((encoded >> 8) & 3);
			rom[write++] = encoded & 0xff;
			rom[write++] = fill & 0xff;
			remaining -= n;
			fill++;
		}
		rom[write++] = 0xff;

		// SNES address for this PC offset (LoROM, banks $80+).
		const bank = 0x80 | Math.floor(start / 0x8000);
		const addr = 0x8000 | (start % 0x8000);
		rom[SMW_GFX_PTR_LOW + i] = addr & 0xff;
		rom[SMW_GFX_PTR_HIGH + i] = (addr >> 8) & 0xff;
		rom[SMW_GFX_PTR_BANK + i] = bank;
	});

	// Palette block: slot 0 = a recognisable BGR555 ramp.
	// Pure red = 0x001F, pure green = 0x03E0, pure blue = 0x7C00.
	const pal = [0x001f, 0x03e0, 0x7c00, 0x7fff];
	pal.forEach((v, i) => {
		rom[SMW_PALETTE_BLOCK + i * 2] = v & 0xff;
		rom[SMW_PALETTE_BLOCK + i * 2 + 1] = (v >> 8) & 0xff;
	});
	return rom;
}

describe('loromToPc', () => {
	it('maps SNES LoROM addresses to file offsets', () => {
		expect(loromToPc(0x00, 0xb992)).toBe(0x3992);
		expect(loromToPc(0x00, 0x8000)).toBe(0x0000);
		expect(loromToPc(0x01, 0x8000)).toBe(0x8000);
		// The $80+ mirror maps to the same place as $00+.
		expect(loromToPc(0x80, 0xb992)).toBe(0x3992);
		expect(loromToPc(0x8a, 0xf000)).toBe(loromToPc(0x0a, 0xf000));
	});
});

describe('stripCopierHeader', () => {
	it('removes a 512-byte header when the size implies one', () => {
		const withHeader = new Uint8Array(0x80000 + 512);
		expect(stripCopierHeader(withHeader).length).toBe(0x80000);
	});

	it('leaves headerless ROMs alone', () => {
		const plain = new Uint8Array(0x80000);
		expect(stripCopierHeader(plain).length).toBe(0x80000);
	});
});

describe('isSmw / readTitle', () => {
	it('accepts a ROM with the SMW internal title', () => {
		const rom = makeSmwLikeRom();
		expect(readTitle(rom)).toBe(SMW_TITLE);
		expect(isSmw(rom)).toBe(true);
	});

	it('accepts a copier-headered dump', () => {
		const rom = makeSmwLikeRom();
		const headered = new Uint8Array(rom.length + 512);
		headered.set(rom, 512);
		expect(isSmw(headered)).toBe(true);
	});

	it('rejects other titles and undersized files', () => {
		expect(isSmw(makeSmwLikeRom({ title: 'SUPER METROID' }))).toBe(false);
		expect(isSmw(new Uint8Array(1024))).toBe(false);
	});
});

describe('listSmwGfx', () => {
	it('reads all pointer-table entries with conventional names', () => {
		const entries = listSmwGfx(makeSmwLikeRom());
		expect(entries).toHaveLength(SMW_GFX_COUNT);
		expect(entries[0].name).toBe('GFX00');
		expect(entries[0x0a].name).toBe('GFX0A');
		expect(entries[0x31].name).toBe('GFX31');
		// Offsets must resolve inside the ROM.
		for (const e of entries) {
			expect(e.romOffset).toBeGreaterThanOrEqual(0);
			expect(e.romOffset).toBeLessThan(0x80000);
		}
	});
});

describe('bppForSize / bytesPerTile', () => {
	it('treats multiples of 24 as 3bpp and everything else as 2bpp', () => {
		expect(bppForSize(3072)).toBe(3); // 128 tiles, the common case
		expect(bppForSize(1536)).toBe(3); // 64 tiles (GFX30/31)
		expect(bppForSize(2048)).toBe(2); // 128 tiles (GFX28-2B font)
		expect(bppForSize(1024)).toBe(2); // 64 tiles (GFX2F)
	});

	it('reports tile strides', () => {
		expect(bytesPerTile(3)).toBe(24);
		expect(bytesPerTile(2)).toBe(16);
	});
});

describe('readSmwGfx', () => {
	it('decompresses a GFX file and infers its geometry', () => {
		const gfx = readSmwGfx(makeSmwLikeRom(), 0);
		expect(gfx.name).toBe('GFX00');
		expect(gfx.bytes.length).toBe(3072);
		expect(gfx.bpp).toBe(3);
		expect(gfx.tiles).toBe(128);
		expect(gfx.compressedSize).toBeLessThan(gfx.bytes.length);
	});

	it('infers 2bpp for sizes that are not multiples of 24', () => {
		const sizes = new Array(SMW_GFX_COUNT).fill(3072);
		sizes[0x28] = 2048;
		sizes[0x2f] = 1024;
		const rom = makeSmwLikeRom({ sizes });
		expect(readSmwGfx(rom, 0x28)).toMatchObject({ bpp: 2, tiles: 128 });
		expect(readSmwGfx(rom, 0x2f)).toMatchObject({ bpp: 2, tiles: 64 });
	});

	it('rejects out-of-range indices', () => {
		const rom = makeSmwLikeRom();
		expect(() => readSmwGfx(rom, -1)).toThrow(RangeError);
		expect(() => readSmwGfx(rom, SMW_GFX_COUNT)).toThrow(RangeError);
	});

	it('reports a helpful error when a pointer targets non-LC_LZ2 data', () => {
		const rom = makeSmwLikeRom();
		// Repoint GFX05 at a region of zeros: command 0 (direct
		// copy) runs to the end of the ROM without a terminator.
		rom[SMW_GFX_PTR_BANK + 5] = 0x8f;
		rom[SMW_GFX_PTR_HIGH + 5] = 0xff;
		rom[SMW_GFX_PTR_LOW + 5] = 0xf0;
		expect(() => readSmwGfx(rom, 5)).toThrow(/GFX05.*not valid LC_LZ2/s);
	});

	it('works through a copier header', () => {
		const rom = makeSmwLikeRom();
		const headered = new Uint8Array(rom.length + 512);
		headered.set(rom, 512);
		expect(readSmwGfx(headered, 0).bytes.length).toBe(3072);
	});
});

describe('readAllSmwGfx', () => {
	it('returns every file for an intact ROM', () => {
		expect(readAllSmwGfx(makeSmwLikeRom())).toHaveLength(SMW_GFX_COUNT);
	});

	it('skips unreadable entries instead of throwing', () => {
		const rom = makeSmwLikeRom();
		rom[SMW_GFX_PTR_BANK + 3] = 0x8f;
		rom[SMW_GFX_PTR_HIGH + 3] = 0xff;
		rom[SMW_GFX_PTR_LOW + 3] = 0xf0;
		const all = readAllSmwGfx(rom);
		expect(all).toHaveLength(SMW_GFX_COUNT - 1);
		expect(all.find((g) => g.index === 3)).toBeUndefined();
	});
});

describe('readSmwPalette', () => {
	it('decodes BGR555 entries to 8-bit RGB', () => {
		const pal = readSmwPalette(makeSmwLikeRom(), 0);
		expect(pal).toHaveLength(16);
		expect(pal[0]).toEqual([255, 0, 0]); // 0x001F pure red
		expect(pal[1]).toEqual([0, 255, 0]); // 0x03E0 pure green
		expect(pal[2]).toEqual([0, 0, 255]); // 0x7C00 pure blue
		expect(pal[3]).toEqual([255, 255, 255]); // 0x7FFF white
	});

	it('reads all slots without running off the end', () => {
		const pals = readSmwPalettes(makeSmwLikeRom());
		expect(pals).toHaveLength(60);
		for (const p of pals) expect(p).toHaveLength(16);
	});
});
