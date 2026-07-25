import { describe, it, expect } from 'vitest';
import {
	computeN64Crc,
	crc32,
	detectN64ByteOrder,
	isN64,
	normalizeN64,
	parseN64,
	scanN64Compression,
} from '../src/index.js';

/** Byteswap a big-endian ROM into v64 order (swap every byte pair). */
function toV64(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i += 2) {
		out[i] = bytes[i + 1];
		out[i + 1] = bytes[i];
	}
	return out;
}

/** Reorder a big-endian ROM into n64 order (reverse every 4-byte group). */
function toN64(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i += 4) {
		out[i] = bytes[i + 3];
		out[i + 1] = bytes[i + 2];
		out[i + 2] = bytes[i + 1];
		out[i + 3] = bytes[i];
	}
	return out;
}

/**
 * Build a synthetic big-endian (z64) ROM header + body. Bootcode
 * (0x40..0xFFF) is left zeroed — we can't forge a bootcode whose
 * CRC32 matches a real CIC, so `cic` is expected to be undefined.
 */
function makeRom(opts: {
	size?: number;
	name?: string;
	mediaFormat?: string;
	cartId?: string;
	region?: string;
	version?: number;
	clockRate?: number;
	bootAddress?: number;
	libultra?: number;
	crc1?: number;
	crc2?: number;
}): Uint8Array {
	const size = opts.size ?? 0x1000;
	const rom = new Uint8Array(size);
	const view = new DataView(rom.buffer);
	// z64 magic (PI BSD DOM1 config).
	rom[0] = 0x80;
	rom[1] = 0x37;
	rom[2] = 0x12;
	rom[3] = 0x40;
	view.setUint32(0x04, opts.clockRate ?? 0x0000000f, false);
	view.setUint32(0x08, opts.bootAddress ?? 0x80000400, false);
	view.setUint32(0x0c, opts.libultra ?? 0x0000144b, false); // "2.0K"
	view.setUint32(0x10, opts.crc1 ?? 0, false);
	view.setUint32(0x14, opts.crc2 ?? 0, false);
	const name = (opts.name ?? 'TEST ROM').padEnd(20, ' ');
	for (let i = 0; i < 20; i++) {
		rom[0x20 + i] = name.charCodeAt(i);
	}
	rom[0x3b] = (opts.mediaFormat ?? 'N').charCodeAt(0);
	const cartId = opts.cartId ?? 'SM';
	rom[0x3c] = cartId.charCodeAt(0);
	rom[0x3d] = cartId.charCodeAt(1);
	rom[0x3e] = (opts.region ?? 'E').charCodeAt(0);
	rom[0x3f] = opts.version ?? 0;
	return rom;
}

/** Deterministic pseudo-random fill (simple LCG). */
function fillPseudoRandom(bytes: Uint8Array, start: number, seed: number): void {
	let s = seed >>> 0;
	for (let i = start; i < bytes.length; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		bytes[i] = (s >>> 24) & 0xff;
	}
}

describe('detectN64ByteOrder / normalizeN64', () => {
	const be = new Uint8Array([
		0x80, 0x37, 0x12, 0x40, 0xaa, 0xbb, 0xcc, 0xdd,
	]);

	it('detects all three byte orders', () => {
		expect(detectN64ByteOrder(be)).toBe('z64');
		expect(detectN64ByteOrder(toV64(be))).toBe('v64');
		expect(detectN64ByteOrder(toN64(be))).toBe('n64');
		expect(detectN64ByteOrder(new Uint8Array([1, 2, 3, 4]))).toBe(null);
		expect(detectN64ByteOrder(new Uint8Array(2))).toBe(null);
	});

	it('returns the same array for z64 input (no copy)', () => {
		expect(normalizeN64(be)).toBe(be);
	});

	it('normalizes v64 (16-bit byteswapped) input', () => {
		const v64 = toV64(be);
		expect(detectN64ByteOrder(v64)).toBe('v64');
		expect(normalizeN64(v64)).toEqual(be);
	});

	it('normalizes n64 (32-bit little-endian) input', () => {
		const n64 = toN64(be);
		expect(detectN64ByteOrder(n64)).toBe('n64');
		expect(normalizeN64(n64)).toEqual(be);
	});

	it('throws on unknown byte order', () => {
		expect(() => normalizeN64(new Uint8Array([1, 2, 3, 4]))).toThrow(
			/byte order/,
		);
	});
});

describe('isN64', () => {
	it('accepts all three byte orders', async () => {
		const rom = makeRom({});
		expect(await isN64(new Blob([rom as BlobPart]))).toBe(true);
		expect(await isN64(new Blob([toV64(rom) as BlobPart]))).toBe(true);
		expect(await isN64(new Blob([toN64(rom) as BlobPart]))).toBe(true);
	});
	it('rejects other data', async () => {
		expect(await isN64(new Blob([new Uint8Array(64) as BlobPart]))).toBe(
			false,
		);
		expect(await isN64(new Blob([new Uint8Array(2) as BlobPart]))).toBe(
			false,
		);
	});
});

describe('parseN64 header fields', () => {
	it('extracts all header fields', async () => {
		const rom = makeRom({
			name: 'SUPER MARIO 64',
			mediaFormat: 'N',
			cartId: 'SM',
			region: 'E',
			version: 1,
			clockRate: 0x0000000f,
			bootAddress: 0x80000400,
			libultra: 0x0000144b,
			crc1: 0x12345678,
			crc2: 0x9abcdef0,
		});
		const info = await parseN64(new Blob([rom as BlobPart]));
		expect(info.byteOrder).toBe('z64');
		expect(info.name).toBe('SUPER MARIO 64');
		expect(info.gameCode).toBe('NSME');
		expect(info.mediaFormat).toBe('Cartridge');
		expect(info.cartId).toBe('SM');
		expect(info.region).toBe('E');
		expect(info.regionName).toBe('North America');
		expect(info.version).toBe(1);
		expect(info.clockRate).toBe(0x0000000f);
		expect(info.bootAddress).toBe(0x80000400);
		expect(info.libultraVersion).toBe('2.0K');
		expect(info.crc1).toBe(0x12345678);
		expect(info.crc2).toBe(0x9abcdef0);
		// Zeroed bootcode → unknown CIC.
		expect(info.cic).toBeUndefined();
		// Too small (< 0x101000) → CRC not computable.
		expect(info.crcValid).toBeUndefined();
	});

	it('reports the original byte order after normalizing', async () => {
		const rom = makeRom({ region: 'J', cartId: 'ZL' });
		const info = await parseN64(new Blob([toV64(rom) as BlobPart]));
		expect(info.byteOrder).toBe('v64');
		expect(info.gameCode).toBe('NZLJ');
		expect(info.regionName).toBe('Japan');
	});

	it('maps unknown region/media chars to "Unknown"', async () => {
		const rom = makeRom({ region: '9', mediaFormat: 'Q' });
		const info = await parseN64(new Blob([rom as BlobPart]));
		expect(info.regionName).toBe('Unknown');
		expect(info.mediaFormat).toBe('Unknown');
	});

	it('rejects non-N64 data', async () => {
		await expect(
			parseN64(new Blob([new Uint8Array(0x1000) as BlobPart])),
		).rejects.toThrow(/byte-order magic/);
		await expect(
			parseN64(new Blob([new Uint8Array(8) as BlobPart])),
		).rejects.toThrow(/too small/);
	});
});

describe('crc32', () => {
	it('matches the standard test vector', () => {
		const input = new TextEncoder().encode('123456789');
		expect(crc32(input)).toBe(0xcbf43926);
	});
	it('of the empty input is 0', () => {
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
});

describe('computeN64Crc / crcValid', () => {
	it('returns null when the ROM is too small', () => {
		expect(computeN64Crc(new Uint8Array(0x1000))).toBe(null);
		expect(computeN64Crc(new Uint8Array(0x101000 - 4))).toBe(null);
	});

	it('self-consistency: patched CRCs verify, corruption fails', async () => {
		const rom = makeRom({ size: 0x101000, name: 'CRC TEST' });
		fillPseudoRandom(rom, 0x1000, 0xc0ffee);

		const computed = computeN64Crc(rom);
		expect(computed).not.toBe(null);
		const { crc1, crc2 } = computed!;
		const view = new DataView(rom.buffer);
		view.setUint32(0x10, crc1, false);
		view.setUint32(0x14, crc2, false);

		const info = await parseN64(new Blob([rom as BlobPart]));
		expect(info.crc1).toBe(crc1);
		expect(info.crc2).toBe(crc2);
		// Zeroed bootcode → unknown CIC → default (6102) seed was used
		// both for computeN64Crc() and inside parseN64().
		expect(info.cic).toBeUndefined();
		expect(info.crcValid).toBe(true);

		// Corrupt one byte inside the checksummed region.
		rom[0x2000] ^= 0xff;
		const corrupted = await parseN64(new Blob([rom as BlobPart]));
		expect(corrupted.crcValid).toBe(false);
	});

	it('verifies through byte-order normalization', async () => {
		const rom = makeRom({ size: 0x101000 });
		fillPseudoRandom(rom, 0x1000, 0xdeadbeef);
		const { crc1, crc2 } = computeN64Crc(rom)!;
		const view = new DataView(rom.buffer);
		view.setUint32(0x10, crc1, false);
		view.setUint32(0x14, crc2, false);
		const info = await parseN64(new Blob([toN64(rom) as BlobPart]));
		expect(info.byteOrder).toBe('n64');
		expect(info.crcValid).toBe(true);
	});

	it('different CIC seeds produce different CRCs', () => {
		const rom = makeRom({ size: 0x101000 });
		fillPseudoRandom(rom, 0x1000, 42);
		const def = computeN64Crc(rom)!;
		const c6103 = computeN64Crc(rom, '6103')!;
		const c6105 = computeN64Crc(rom, '6105')!;
		const c6106 = computeN64Crc(rom, '6106')!;
		expect(c6103.crc1).not.toBe(def.crc1);
		expect(c6105.crc1).not.toBe(def.crc1);
		expect(c6106.crc1).not.toBe(def.crc1);
	});
});

describe('scanN64Compression', () => {
	/** Plant a valid-looking 16-byte compression header at `offset`. */
	function plant(
		bytes: Uint8Array,
		offset: number,
		magic: string,
		decompressedSize: number,
		o1 = 0x20,
		o2 = 0x30,
	): void {
		for (let i = 0; i < 4; i++) {
			bytes[offset + i] = magic.charCodeAt(i);
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		view.setUint32(offset + 4, decompressedSize, false);
		view.setUint32(offset + 8, o1, false);
		view.setUint32(offset + 12, o2, false);
	}

	it('finds MIO0, Yay0 and Yaz0 blocks at aligned offsets', () => {
		const rom = new Uint8Array(0x200);
		plant(rom, 0x40, 'MIO0', 0x100);
		plant(rom, 0x80, 'Yay0', 0x200);
		plant(rom, 0xc0, 'Yaz0', 0x300, 0, 0); // Yaz0 has no stream offsets
		const found = scanN64Compression(rom);
		expect(found).toEqual([
			{ offset: 0x40, type: 'MIO0', decompressedSize: 0x100 },
			{ offset: 0x80, type: 'Yay0', decompressedSize: 0x200 },
			{ offset: 0xc0, type: 'Yaz0', decompressedSize: 0x300 },
		]);
	});

	it('skips unaligned magics', () => {
		const rom = new Uint8Array(0x100);
		plant(rom, 0x42, 'MIO0', 0x100); // not 4-byte aligned
		expect(scanN64Compression(rom)).toEqual([]);
		// ...but a 2-byte alignment option finds it.
		expect(scanN64Compression(rom, { alignment: 2 })).toEqual([
			{ offset: 0x42, type: 'MIO0', decompressedSize: 0x100 },
		]);
	});

	it('rejects blocks with implausible decompressed sizes', () => {
		const rom = new Uint8Array(0x100);
		plant(rom, 0x00, 'MIO0', 0); // zero size
		plant(rom, 0x40, 'Yaz0', 0x900000); // > default max (8 MiB)
		expect(scanN64Compression(rom)).toEqual([]);
		expect(
			scanN64Compression(rom, { maxDecompressedSize: 0xa00000 }),
		).toEqual([{ offset: 0x40, type: 'Yaz0', decompressedSize: 0x900000 }]);
	});

	it('rejects MIO0/Yay0 blocks with bad stream offsets', () => {
		const rom = new Uint8Array(0x100);
		// Offsets must be > 0x10...
		plant(rom, 0x00, 'MIO0', 0x100, 0x10, 0x30);
		// ...and within the remaining bytes.
		plant(rom, 0x40, 'Yay0', 0x100, 0x20, 0x10000);
		expect(scanN64Compression(rom)).toEqual([]);
	});

	it('accepts stream offsets in either order', () => {
		const rom = new Uint8Array(0x100);
		plant(rom, 0x00, 'Yay0', 0x100, 0x30, 0x20); // link after chunk
		expect(scanN64Compression(rom)).toEqual([
			{ offset: 0x00, type: 'Yay0', decompressedSize: 0x100 },
		]);
	});

	it('resumes scanning right after an accepted 16-byte header', () => {
		const rom = new Uint8Array(0x100);
		plant(rom, 0x00, 'MIO0', 0x100);
		plant(rom, 0x10, 'Yaz0', 0x100, 0, 0); // immediately after header
		const found = scanN64Compression(rom);
		expect(found.map((f) => f.offset)).toEqual([0x00, 0x10]);
	});

	it('does not match near the end without a full header', () => {
		const rom = new Uint8Array(0x48);
		plant(rom, 0x38, 'Yaz0', 0x100, 0, 0); // full header fits exactly
		expect(scanN64Compression(rom).length).toBe(1);
		const short = rom.subarray(0, 0x44); // header would overrun
		expect(scanN64Compression(short)).toEqual([]);
	});
});
