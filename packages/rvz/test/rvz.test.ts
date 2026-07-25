import { describe, it, expect } from 'vitest';
import {
	Compression,
	DiscType,
	RVZ_MAGIC,
	WIA_MAGIC,
	compressionName,
	isRvz,
	parseFileHeader,
	parseRvz,
	unpackRvz,
} from '../src/index.js';

const w8 = (b: Uint8Array, o: number, v: number) => {
	b[o] = v & 0xff;
};
const w16 = (b: Uint8Array, o: number, v: number) => {
	b[o] = (v >>> 8) & 0xff;
	b[o + 1] = v & 0xff;
};
const w32 = (b: Uint8Array, o: number, v: number) => {
	b[o] = (v >>> 24) & 0xff;
	b[o + 1] = (v >>> 16) & 0xff;
	b[o + 2] = (v >>> 8) & 0xff;
	b[o + 3] = v & 0xff;
};
const w64 = (b: Uint8Array, o: number, v: number) => {
	w32(b, o, Math.floor(v / 0x1_0000_0000));
	w32(b, o + 4, v >>> 0);
};

/**
 * Build a minimal, uncompressed RVZ image.
 *
 * Layout: file header, disc struct, raw-data table, group table, then
 * one chunk of payload per group. NONE compression keeps the fixture
 * free of codec dependencies while still exercising every offset
 * calculation.
 */
function buildRvz(opts: {
	payload: Uint8Array;
	chunkSize?: number;
	magic?: number;
	discType?: number;
	/** Force specific groups to the "all zero" encoding. */
	zeroGroups?: Set<number>;
}) {
	const chunkSize = opts.chunkSize ?? 0x8000;
	const magic = opts.magic ?? RVZ_MAGIC;
	const isRvzFile = magic === RVZ_MAGIC;
	const groupStride = isRvzFile ? 12 : 8;
	const isoSize = opts.payload.length;
	const numGroups = Math.ceil(isoSize / chunkSize);

	const headSize = 0x48;
	const discSize = 0xdc;
	const rawTableOffset = headSize + discSize;
	const rawTableSize = 24;
	const groupTableOffset = rawTableOffset + rawTableSize;
	const groupTableSize = numGroups * groupStride;
	const dataOffset = groupTableOffset + groupTableSize;

	const total = dataOffset + isoSize;
	const file = new Uint8Array(total);

	// --- wia_file_head_t ---
	w32(file, 0x00, magic);
	w32(file, 0x04, 0x0100_0000);
	w32(file, 0x08, 0x0003_0000);
	w32(file, 0x0c, discSize);
	w64(file, 0x24, isoSize);
	w64(file, 0x2c, total);

	// --- wia_disc_t ---
	const d = headSize;
	w32(file, d + 0x00, opts.discType ?? DiscType.GAMECUBE);
	w32(file, d + 0x04, Compression.NONE);
	w32(file, d + 0x08, 0);
	w32(file, d + 0x0c, chunkSize);
	// disc_head: the first 0x80 bytes of the image.
	file.set(opts.payload.subarray(0, 0x80), d + 0x10);
	w32(file, d + 0x90, 0); // no partitions
	w32(file, d + 0x94, 0);
	w64(file, d + 0x98, 0);
	w32(file, d + 0xb4, 1); // one raw-data entry
	w64(file, d + 0xb8, rawTableOffset);
	w32(file, d + 0xc0, rawTableSize);
	w32(file, d + 0xc4, numGroups);
	w64(file, d + 0xc8, groupTableOffset);
	w32(file, d + 0xd0, groupTableSize);
	w8(file, d + 0xd4, 0);

	// --- wia_raw_data_t ---
	w64(file, rawTableOffset + 0, 0);
	w64(file, rawTableOffset + 8, isoSize);
	w32(file, rawTableOffset + 16, 0);
	w32(file, rawTableOffset + 20, numGroups);

	// --- rvz_group_t[] + payload ---
	for (let i = 0; i < numGroups; i++) {
		const start = i * chunkSize;
		const size = Math.min(chunkSize, isoSize - start);
		const o = groupTableOffset + i * groupStride;
		if (opts.zeroGroups?.has(i)) {
			w32(file, o, 0);
			w32(file, o + 4, 0);
			if (isRvzFile) w32(file, o + 8, 0);
			continue;
		}
		const at = dataOffset + start;
		w32(file, o, at / 4);
		// Top bit clear = stored uncompressed (RVZ only).
		w32(file, o + 4, size);
		if (isRvzFile) w32(file, o + 8, 0);
		file.set(opts.payload.subarray(start, start + size), at);
	}
	return file;
}

/** Deterministic pseudo-content so reads are verifiable. */
function pattern(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	let s = seed;
	for (let i = 0; i < size; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		out[i] = (s >> 16) & 0xff;
	}
	return out;
}

describe('header parsing', () => {
	it('recognises RVZ and WIA magics', () => {
		const rvz = buildRvz({ payload: pattern(0x8000) });
		expect(isRvz(rvz)).toBe(true);
		expect(parseFileHeader(rvz)!.isRvz).toBe(true);

		const wia = buildRvz({ payload: pattern(0x8000), magic: WIA_MAGIC });
		expect(isRvz(wia)).toBe(true);
		expect(parseFileHeader(wia)!.isRvz).toBe(false);
	});

	it('rejects other data', () => {
		expect(isRvz(new Uint8Array(64))).toBe(false);
		expect(isRvz(Uint8Array.from([1, 2]))).toBe(false);
		expect(parseFileHeader(new Uint8Array(0x48))).toBeNull();
	});

	it('reads the declared sizes', () => {
		const payload = pattern(0x20000);
		const file = buildRvz({ payload });
		const h = parseFileHeader(file)!;
		expect(h.isoFileSize).toBe(payload.length);
		expect(h.fileSize).toBe(file.length);
	});

	it('names compression methods', () => {
		expect(compressionName(Compression.NONE)).toBe('NONE');
		expect(compressionName(Compression.ZSTD)).toBe('ZSTD');
		expect(compressionName(99)).toMatch(/UNKNOWN/);
	});
});

describe('parseRvz', () => {
	it('reconstructs an uncompressed image byte for byte', async () => {
		const payload = pattern(0x20000);
		const img = await parseRvz(new Blob([buildRvz({ payload })]));
		expect(img.isoSize).toBe(payload.length);
		const out = await img.read(0, payload.length);
		expect(Array.from(out)).toEqual(Array.from(payload));
	});

	it('serves reads that span chunk boundaries', async () => {
		const payload = pattern(0x20000, 7);
		const img = await parseRvz(
			new Blob([buildRvz({ payload, chunkSize: 0x8000 })]),
		);
		// Straddle the first boundary.
		const out = await img.read(0x7ff0, 0x20);
		expect(Array.from(out)).toEqual(
			Array.from(payload.subarray(0x7ff0, 0x8010)),
		);
	});

	it('serves unaligned reads from the middle', async () => {
		const payload = pattern(0x18000, 3);
		const img = await parseRvz(new Blob([buildRvz({ payload })]));
		const out = await img.read(0x1234, 0x500);
		expect(Array.from(out)).toEqual(
			Array.from(payload.subarray(0x1234, 0x1734)),
		);
	});

	it('treats a zero-size group as an all-zero chunk', async () => {
		const payload = pattern(0x18000, 5);
		const file = buildRvz({ payload, zeroGroups: new Set([1]) });
		const img = await parseRvz(new Blob([file]));
		const out = await img.read(0x8000, 0x8000);
		expect(out.every((b) => b === 0)).toBe(true);
		// Neighbouring chunks are unaffected.
		const after = await img.read(0x10000, 16);
		expect(Array.from(after)).toEqual(
			Array.from(payload.subarray(0x10000, 0x10010)),
		);
	});

	it('takes the first 0x80 bytes from the header copy', async () => {
		const payload = pattern(0x8000, 9);
		const file = buildRvz({ payload });
		// Corrupt the payload copy of the head; the header's copy wins.
		const img = await parseRvz(new Blob([file]));
		const out = await img.read(0, 0x80);
		expect(Array.from(out)).toEqual(Array.from(payload.subarray(0, 0x80)));
	});

	it('rejects Wii images rather than mis-decoding them', async () => {
		const file = buildRvz({
			payload: pattern(0x8000),
			discType: DiscType.WII,
		});
		await expect(parseRvz(new Blob([file]))).rejects.toThrow(/Wii/i);
	});

	it('rejects a non-RVZ blob', async () => {
		await expect(parseRvz(new Blob([new Uint8Array(0x100)]))).rejects.toThrow(
			/magic/i,
		);
	});

	it('demands a decompressor for a compressed image', async () => {
		const file = buildRvz({ payload: pattern(0x8000) });
		// Claim Zstandard without supplying a decompressor.
		w32(file, 0x48 + 0x04, Compression.ZSTD);
		await expect(parseRvz(new Blob([file]))).rejects.toThrow(
			/no decompressor/i,
		);
	});

	it('routes compressed groups through the supplied decompressor', async () => {
		const payload = pattern(0x10000, 11);
		const file = buildRvz({ payload });
		w32(file, 0x48 + 0x04, Compression.ZSTD);
		// Mark both groups compressed so the hook is exercised, and
		// have the "decompressor" pass bytes through unchanged.
		const groupTable = 0x48 + 0xdc + 24;
		for (let i = 0; i < 2; i++) {
			const o = groupTable + i * 12;
			const size =
				((file[o + 4] << 24) |
					(file[o + 5] << 16) |
					(file[o + 6] << 8) |
					file[o + 7]) >>>
				0;
			w32(file, o + 4, size | 0x8000_0000);
		}
		let calls = 0;
		const img = await parseRvz(new Blob([file]), {
			decompress: async (c) => {
				calls++;
				return c;
			},
		});
		const out = await img.read(0, payload.length);
		expect(calls).toBeGreaterThan(0);
		expect(Array.from(out)).toEqual(Array.from(payload));
	});
});

describe('unpackRvz', () => {
	it('copies literal runs verbatim', () => {
		const literal = Uint8Array.from([1, 2, 3, 4, 5]);
		const packed = new Uint8Array(4 + literal.length);
		w32(packed, 0, literal.length);
		packed.set(literal, 4);
		expect(Array.from(unpackRvz(packed, literal.length, 0))).toEqual([
			1, 2, 3, 4, 5,
		]);
	});

	it('concatenates multiple literal runs', () => {
		const packed = new Uint8Array(4 + 2 + 4 + 3);
		w32(packed, 0, 2);
		packed.set([0xaa, 0xbb], 4);
		w32(packed, 6, 3);
		packed.set([0x11, 0x22, 0x33], 10);
		expect(Array.from(unpackRvz(packed, 5, 0))).toEqual([
			0xaa, 0xbb, 0x11, 0x22, 0x33,
		]);
	});

	it('expands a PRNG run to the requested length', () => {
		// Top bit set = PRNG run, followed by 68 bytes of seed.
		const packed = new Uint8Array(4 + 68);
		w32(packed, 0, 0x8000_0000 | 256);
		for (let i = 0; i < 68; i++) packed[4 + i] = i * 3 + 1;
		const out = unpackRvz(packed, 256, 0);
		expect(out.length).toBe(256);
		// Padding is pseudorandom, so it must not be all one value.
		expect(new Set(out).size).toBeGreaterThan(8);
	});

	it('generates padding deterministically', () => {
		const packed = new Uint8Array(4 + 68);
		w32(packed, 0, 0x8000_0000 | 128);
		for (let i = 0; i < 68; i++) packed[4 + i] = (i * 7) & 0xff;
		const a = unpackRvz(packed, 128, 0);
		const b = unpackRvz(packed, 128, 0);
		expect(Array.from(a)).toEqual(Array.from(b));
	});

	it('phase-shifts padding by the disc offset within a sector', () => {
		const packed = new Uint8Array(4 + 68);
		w32(packed, 0, 0x8000_0000 | 64);
		for (let i = 0; i < 68; i++) packed[4 + i] = (i * 5 + 2) & 0xff;
		// Sector-aligned versus mid-sector must differ: padding is
		// locked to 32 KiB boundaries.
		const aligned = unpackRvz(packed, 64, 0);
		const shifted = unpackRvz(packed, 64, 0x40);
		expect(Array.from(aligned)).not.toEqual(Array.from(shifted));
		// The same phase reproduces the same bytes.
		const again = unpackRvz(packed, 64, 0x8000);
		expect(Array.from(again)).toEqual(Array.from(aligned));
	});

	it('stops cleanly at the requested output size', () => {
		const packed = new Uint8Array(4 + 10);
		w32(packed, 0, 10);
		packed.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
		expect(unpackRvz(packed, 4, 0).length).toBe(4);
	});

	it('tolerates truncated input', () => {
		const packed = new Uint8Array(4 + 2);
		w32(packed, 0, 100); // claims more than is present
		expect(() => unpackRvz(packed, 100, 0)).not.toThrow();
	});
});
