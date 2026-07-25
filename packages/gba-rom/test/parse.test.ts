import { describe, it, expect } from 'vitest';
import {
	parseGbaHeader,
	isGba,
	parseGba,
	decompressLz77,
	decompressRle,
	decompressHuffman,
	decompressGba,
	scanGbaCompression,
} from '../src/index.js';

/** First 16 bytes of the fixed Nintendo logo (header constant). */
const LOGO_PREFIX = [
	0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a,
	0x84, 0xe4, 0x09, 0xad,
];

/**
 * Build a synthetic 192-byte GBA cartridge header. Contains no game
 * content — just header fields.
 */
function makeGbaHeader(opts: {
	title?: string;
	gameCode?: string;
	makerCode?: string;
	version?: number;
	fixedValue?: number;
	mainUnitCode?: number;
	deviceType?: number;
	corruptLogo?: boolean;
	corruptChecksum?: boolean;
}): Uint8Array {
	const buf = new Uint8Array(0xc0);
	const view = new DataView(buf.buffer);
	view.setUint32(0x00, 0xea00002e, true); // typical ARM branch
	buf.set(LOGO_PREFIX, 0x04);
	if (opts.corruptLogo) buf[0x04] ^= 0xff;

	const enc = new TextEncoder();
	buf.set(enc.encode(opts.title ?? 'TESTGAME'), 0xa0);
	buf.set(enc.encode(opts.gameCode ?? 'AXVE'), 0xac);
	buf.set(enc.encode(opts.makerCode ?? '01'), 0xb0);
	buf[0xb2] = opts.fixedValue ?? 0x96;
	buf[0xb3] = opts.mainUnitCode ?? 0x00;
	buf[0xb4] = opts.deviceType ?? 0x00;
	buf[0xbc] = opts.version ?? 0;

	let chk = 0;
	for (let i = 0xa0; i <= 0xbc; i++) chk -= buf[i];
	chk = (chk - 0x19) & 0xff;
	buf[0xbd] = opts.corruptChecksum ? (chk ^ 0xff) & 0xff : chk;
	return buf;
}

/**
 * Tiny greedy LZ77 encoder producing GBA BIOS (type 0x10) streams.
 * Test-only; kept out of src on purpose.
 */
function encodeLz77(data: Uint8Array): Uint8Array {
	const out: number[] = [
		0x10,
		data.length & 0xff,
		(data.length >> 8) & 0xff,
		(data.length >> 16) & 0xff,
	];
	let pos = 0;
	while (pos < data.length) {
		const flagIndex = out.length;
		out.push(0);
		let flags = 0;
		for (let bit = 7; bit >= 0 && pos < data.length; bit--) {
			let bestLen = 0;
			let bestDisp = 0;
			const maxLen = Math.min(18, data.length - pos);
			const windowStart = Math.max(0, pos - 0x1000);
			for (let src = windowStart; src < pos; src++) {
				let len = 0;
				while (len < maxLen && data[src + len] === data[pos + len]) {
					len++;
				}
				if (len > bestLen) {
					bestLen = len;
					bestDisp = pos - src;
				}
			}
			if (bestLen >= 3) {
				flags |= 1 << bit;
				out.push(
					(((bestLen - 3) & 0xf) << 4) | (((bestDisp - 1) >> 8) & 0xf),
				);
				out.push((bestDisp - 1) & 0xff);
				pos += bestLen;
			} else {
				out.push(data[pos++]);
			}
		}
		out[flagIndex] = flags;
	}
	return new Uint8Array(out);
}

/** LZ77 "stored" encoder: all literals (never compresses). Test-only. */
function encodeLz77Stored(data: Uint8Array): Uint8Array {
	const out: number[] = [
		0x10,
		data.length & 0xff,
		(data.length >> 8) & 0xff,
		(data.length >> 16) & 0xff,
	];
	let pos = 0;
	while (pos < data.length) {
		out.push(0); // flag byte: 8 literals
		for (let bit = 7; bit >= 0 && pos < data.length; bit--) {
			out.push(data[pos++]);
		}
	}
	return new Uint8Array(out);
}

/** Tiny RLE encoder producing GBA BIOS (type 0x30) streams. Test-only. */
function encodeRle(data: Uint8Array): Uint8Array {
	const out: number[] = [
		0x30,
		data.length & 0xff,
		(data.length >> 8) & 0xff,
		(data.length >> 16) & 0xff,
	];
	let pos = 0;
	while (pos < data.length) {
		let runLen = 1;
		while (
			pos + runLen < data.length &&
			data[pos + runLen] === data[pos] &&
			runLen < 0x82
		) {
			runLen++;
		}
		if (runLen >= 3) {
			out.push(0x80 | (runLen - 3), data[pos]);
			pos += runLen;
		} else {
			let litLen = 0;
			while (pos + litLen < data.length && litLen < 0x80) {
				const p = pos + litLen;
				if (
					p + 2 < data.length &&
					data[p] === data[p + 1] &&
					data[p] === data[p + 2]
				) {
					break;
				}
				litLen++;
			}
			out.push(litLen - 1);
			for (let i = 0; i < litLen; i++) out.push(data[pos + i]);
			pos += litLen;
		}
	}
	return new Uint8Array(out);
}

/** Deterministic PRNG (mulberry32) for reproducible "random" seas. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomBytes(length: number, seed: number): Uint8Array {
	const rand = mulberry32(seed);
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		out[i] = Math.floor(rand() * 256);
	}
	return out;
}

describe('GBA header parser', () => {
	it('parses a well-formed header', () => {
		const bytes = makeGbaHeader({
			title: 'POKEMON RUBY',
			gameCode: 'AXVE',
			makerCode: '01',
			version: 3,
			deviceType: 0x80,
		});
		const info = parseGbaHeader(bytes);
		expect(info.entryPoint).toBe(0xea00002e);
		expect(info.title).toBe('POKEMON RUBY');
		expect(info.gameCode).toBe('AXVE');
		expect(info.makerCode).toBe('01');
		expect(info.region).toBe('USA');
		expect(info.version).toBe(3);
		expect(info.fixedValueValid).toBe(true);
		expect(info.logoValid).toBe(true);
		expect(info.headerChecksumValid).toBe(true);
		expect(info.deviceType).toBe(0x80);
		expect(info.mainUnitCode).toBe(0);
	});

	it('derives region from the game code last character', () => {
		expect(parseGbaHeader(makeGbaHeader({ gameCode: 'BPRJ' })).region).toBe(
			'Japan',
		);
		expect(parseGbaHeader(makeGbaHeader({ gameCode: 'BPRP' })).region).toBe(
			'Europe',
		);
		expect(parseGbaHeader(makeGbaHeader({ gameCode: 'BPRD' })).region).toBe(
			'Germany',
		);
		expect(parseGbaHeader(makeGbaHeader({ gameCode: 'BPRF' })).region).toBe(
			'France',
		);
		expect(parseGbaHeader(makeGbaHeader({ gameCode: 'BPRI' })).region).toBe(
			'Italy',
		);
		expect(parseGbaHeader(makeGbaHeader({ gameCode: 'BPRS' })).region).toBe(
			'Spain',
		);
		// Unknown region letter → no region.
		expect(
			parseGbaHeader(makeGbaHeader({ gameCode: 'BPRX' })).region,
		).toBeUndefined();
	});

	it('reports invalid fixed value / logo / checksum', () => {
		const info = parseGbaHeader(
			makeGbaHeader({
				fixedValue: 0x00,
				corruptLogo: true,
				corruptChecksum: true,
			}),
		);
		expect(info.fixedValueValid).toBe(false);
		expect(info.logoValid).toBe(false);
		expect(info.headerChecksumValid).toBe(false);
	});

	it('throws on a buffer too small for a header', () => {
		expect(() => parseGbaHeader(new Uint8Array(0x40))).toThrow(/[Tt]oo small/);
	});

	it('isGba() accepts valid ROMs and rejects invalid ones', async () => {
		const good = makeGbaHeader({});
		expect(await isGba(new Blob([good as BlobPart]))).toBe(true);

		// Valid logo but bad checksum → still accepted.
		const badChk = makeGbaHeader({ corruptChecksum: true });
		expect(await isGba(new Blob([badChk as BlobPart]))).toBe(true);

		// Bad logo but valid checksum → still accepted.
		const badLogo = makeGbaHeader({ corruptLogo: true });
		expect(await isGba(new Blob([badLogo as BlobPart]))).toBe(true);

		// Bad logo AND bad checksum → rejected.
		const badBoth = makeGbaHeader({
			corruptLogo: true,
			corruptChecksum: true,
		});
		expect(await isGba(new Blob([badBoth as BlobPart]))).toBe(false);

		// Bad fixed value → rejected.
		const badFixed = makeGbaHeader({ fixedValue: 0x42 });
		expect(await isGba(new Blob([badFixed as BlobPart]))).toBe(false);

		// Too small → rejected.
		expect(await isGba(new Blob([new Uint8Array(0x40) as BlobPart]))).toBe(
			false,
		);
	});

	it('parseGba() parses from a Blob', async () => {
		const bytes = makeGbaHeader({ title: 'BLOBTEST', gameCode: 'AAAJ' });
		const info = await parseGba(new Blob([bytes as BlobPart]));
		expect(info.title).toBe('BLOBTEST');
		expect(info.region).toBe('Japan');
	});

	it('parseGba() rejects a too-small Blob', async () => {
		await expect(
			parseGba(new Blob([new Uint8Array(0x40) as BlobPart])),
		).rejects.toThrow(/too small/);
	});
});

describe('LZ77 (type 0x10)', () => {
	it('round-trips arbitrary data', () => {
		const data = randomBytes(300, 1);
		// Make it compressible: duplicate a slice.
		data.set(data.subarray(0, 100), 150);
		const compressed = encodeLz77(data);
		expect(decompressLz77(compressed)).toEqual(data);
	});

	it('round-trips an overlapping copy run (disp < length)', () => {
		// 64 bytes of the same value forces disp=1 back-references that
		// overlap the bytes they are still writing.
		const data = new Uint8Array(64).fill(0xaa);
		const compressed = encodeLz77(data);
		expect(compressed.length).toBeLessThan(data.length);
		expect(decompressLz77(compressed)).toEqual(data);
	});

	it('respects a non-zero offset', () => {
		const data = new Uint8Array(64).fill(0x5a);
		const compressed = encodeLz77(data);
		const padded = new Uint8Array(16 + compressed.length);
		padded.set(compressed, 16);
		expect(decompressLz77(padded, 16)).toEqual(data);
	});

	it('throws on truncated input', () => {
		const data = randomBytes(128, 2);
		const compressed = encodeLz77(data);
		expect(() =>
			decompressLz77(compressed.subarray(0, compressed.length - 1)),
		).toThrow(RangeError);
		expect(() => decompressLz77(compressed.subarray(0, 4))).toThrow(
			RangeError,
		);
		expect(() => decompressLz77(new Uint8Array(2))).toThrow(RangeError);
	});

	it('throws when a back-reference reaches before output start', () => {
		// size=4, flag byte 0x80 (first token is a back-reference),
		// disp=17 with nothing written yet.
		const bad = new Uint8Array([0x10, 4, 0, 0, 0x80, 0x00, 0x10]);
		expect(() => decompressLz77(bad)).toThrow(RangeError);
	});

	it('throws on wrong type byte', () => {
		expect(() => decompressLz77(new Uint8Array([0x30, 4, 0, 0]))).toThrow(
			RangeError,
		);
	});
});

describe('RLE (type 0x30)', () => {
	it('round-trips mixed runs and literals', () => {
		const data = new Uint8Array(256);
		data.fill(0x11, 0, 100); // run
		data.set(randomBytes(56, 3), 100); // literals
		data.fill(0x22, 156, 256); // run
		const compressed = encodeRle(data);
		expect(compressed.length).toBeLessThan(data.length);
		expect(decompressRle(compressed)).toEqual(data);
	});

	it('respects a non-zero offset', () => {
		const data = new Uint8Array(80).fill(0x33);
		const compressed = encodeRle(data);
		const padded = new Uint8Array(8 + compressed.length);
		padded.set(compressed, 8);
		expect(decompressRle(padded, 8)).toEqual(data);
	});

	it('throws on truncated input', () => {
		const data = new Uint8Array(128).fill(0x44);
		const compressed = encodeRle(data);
		expect(() =>
			decompressRle(compressed.subarray(0, compressed.length - 1)),
		).toThrow(RangeError);
		expect(() => decompressRle(compressed.subarray(0, 4))).toThrow(
			RangeError,
		);
	});

	it('throws when a run overflows the declared output size', () => {
		// size=4, run of length (0x7F & 0x05) + 3 = 8 > 4.
		const bad = new Uint8Array([0x30, 4, 0, 0, 0x85, 0xaa]);
		expect(() => decompressRle(bad)).toThrow(RangeError);
	});
});

describe('Huffman (types 0x24/0x28)', () => {
	// Two-symbol tree: root 0xC0 (both children leaves), left = first
	// leaf byte, right = second. treeSize=1 → tree data is 3 bytes.
	function twoSymbolStream(
		type: number,
		size: number,
		left: number,
		right: number,
		words: number[],
	): Uint8Array {
		const out = [
			type,
			size & 0xff,
			(size >> 8) & 0xff,
			(size >> 16) & 0xff,
			1, // treeSize
			0xc0,
			left,
			right,
		];
		for (const w of words) {
			out.push(w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >>> 24) & 0xff);
		}
		return new Uint8Array(out);
	}

	it('decodes 8-bit symbols from a two-leaf tree', () => {
		// "ABBA": bits 0,1,1,0 MSB-first → 0x60000000.
		const stream = twoSymbolStream(0x28, 4, 0x41, 0x42, [0x60000000]);
		expect(decompressHuffman(stream)).toEqual(
			new Uint8Array([0x41, 0x42, 0x42, 0x41]),
		);
	});

	it('decodes 4-bit symbols, packing low nibble first', () => {
		// Symbols 3,A,A,3 → bits 0,1,1,0 → bytes [0xA3, 0x3A].
		const stream = twoSymbolStream(0x24, 2, 0x03, 0x0a, [0x60000000]);
		expect(decompressHuffman(stream)).toEqual(new Uint8Array([0xa3, 0x3a]));
	});

	it('decodes a deeper tree with internal nodes (8-bit)', () => {
		// Tree: root(rel 5)=0x80 → left child (rel 6) is leaf 'A',
		// right child (rel 7) is internal 0xC0 → children at rel 8/9,
		// both leaves: 'B' (rel 8), 'C' (rel 9). treeSize=2 (5 tree bytes).
		// Codes: A=0, B=10, C=11. "ABCA" = bits 0,1,0,1,1,0 → 0x58000000.
		const stream = new Uint8Array([
			0x28, 4, 0, 0, // header: 8-bit, size 4
			2, // treeSize
			0x80, 0x41, 0xc0, 0x42, 0x43, // tree
			0x00, 0x00, 0x00, 0x58, // bitstream word (LE)
		]);
		expect(decompressHuffman(stream)).toEqual(
			new Uint8Array([0x41, 0x42, 0x43, 0x41]),
		);
	});

	it('respects a non-zero offset', () => {
		const stream = twoSymbolStream(0x28, 4, 0x41, 0x42, [0x60000000]);
		const padded = new Uint8Array(12 + stream.length);
		padded.set(stream, 12);
		expect(decompressHuffman(padded, 12)).toEqual(
			new Uint8Array([0x41, 0x42, 0x42, 0x41]),
		);
	});

	it('throws on a truncated bitstream', () => {
		const stream = twoSymbolStream(0x28, 4, 0x41, 0x42, [0x60000000]);
		// Chop off the (only) bitstream word.
		expect(() =>
			decompressHuffman(stream.subarray(0, stream.length - 4)),
		).toThrow(RangeError);
	});

	it('throws on a truncated tree', () => {
		const stream = twoSymbolStream(0x28, 4, 0x41, 0x42, [0x60000000]);
		expect(() => decompressHuffman(stream.subarray(0, 6))).toThrow(
			RangeError,
		);
	});

	it('throws on wrong type byte', () => {
		expect(() => decompressHuffman(new Uint8Array([0x10, 4, 0, 0]))).toThrow(
			RangeError,
		);
	});
});

describe('decompressGba() dispatch', () => {
	it('dispatches on the type byte', () => {
		const data = new Uint8Array(64).fill(0x77);
		expect(decompressGba(encodeLz77(data))).toEqual(data);
		expect(decompressGba(encodeRle(data))).toEqual(data);

		const huff = new Uint8Array([
			0x28, 4, 0, 0, 1, 0xc0, 0x41, 0x42, 0x00, 0x00, 0x00, 0x60,
		]);
		expect(decompressGba(huff)).toEqual(
			new Uint8Array([0x41, 0x42, 0x42, 0x41]),
		);
	});

	it('throws on an unknown type byte', () => {
		expect(() => decompressGba(new Uint8Array([0x42, 4, 0, 0]))).toThrow(
			/Unknown/,
		);
		expect(() => decompressGba(new Uint8Array(0))).toThrow(RangeError);
	});
});

describe('scanGbaCompression()', () => {
	/** Compressible synthetic payload (repeating pattern). */
	function patternBytes(length: number, period: number): Uint8Array {
		const out = new Uint8Array(length);
		for (let i = 0; i < length; i++) out[i] = (i % period) * 17;
		return out;
	}

	it('finds planted LZ77 blocks in a sea of random bytes', () => {
		const sea = randomBytes(8192, 42);

		const data1 = patternBytes(256, 8);
		const block1 = encodeLz77(data1);
		expect(block1.length).toBeLessThan(data1.length);
		const off1 = 512;
		sea.set(block1, off1);

		const data2 = patternBytes(512, 5);
		const block2 = encodeLz77(data2);
		expect(block2.length).toBeLessThan(data2.length);
		const off2 = 4096;
		sea.set(block2, off2);

		const found = scanGbaCompression(sea);
		expect(found).toEqual([
			{
				offset: off1,
				type: 'lz77',
				decompressedSize: 256,
				compressedSize: block1.length,
			},
			{
				offset: off2,
				type: 'lz77',
				decompressedSize: 512,
				compressedSize: block2.length,
			},
		]);

		// The reported blocks decompress back to the planted data.
		expect(decompressLz77(sea, off1)).toEqual(data1);
		expect(decompressLz77(sea, off2)).toEqual(data2);
	});

	it('finds RLE and Huffman blocks when requested', () => {
		const sea = randomBytes(4096, 7);

		// A few literals up front so compressedSize clears the > 8 filter.
		const rleData = new Uint8Array(200).fill(0x99);
		rleData.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
		const rleBlock = encodeRle(rleData);
		expect(rleBlock.length).toBeGreaterThan(8);
		sea.set(rleBlock, 1024);

		// Two-leaf Huffman block: 64 'A'/'B' bytes from 2 bitstream words
		// (compressedSize = 4 + 4 tree + 8 bitstream = 16 < 64).
		const huffBlock = new Uint8Array([
			0x28, 64, 0, 0, 1, 0xc0, 0x41, 0x42, 0xff, 0xff, 0xff, 0xff, 0x00,
			0x00, 0x00, 0x00,
		]);
		sea.set(huffBlock, 2048);

		const found = scanGbaCompression(sea, { types: ['rle', 'huffman'] });
		expect(found).toEqual([
			{
				offset: 1024,
				type: 'rle',
				decompressedSize: 200,
				compressedSize: rleBlock.length,
			},
			{
				offset: 2048,
				type: 'huffman',
				decompressedSize: 64,
				compressedSize: huffBlock.length,
			},
		]);
	});

	it('respects alignment (skips unaligned candidates)', () => {
		const sea = new Uint8Array(1024);
		const data = patternBytes(128, 4);
		const block = encodeLz77(data);
		sea.set(block, 66); // NOT 4-aligned
		expect(scanGbaCompression(sea)).toEqual([]);
		// With finer alignment it is found.
		expect(scanGbaCompression(sea, { alignment: 2 })).toEqual([
			{
				offset: 66,
				type: 'lz77',
				decompressedSize: 128,
				compressedSize: block.length,
			},
		]);
	});

	it('respects min/max decompressed size', () => {
		const sea = new Uint8Array(1024);
		const data = patternBytes(128, 4);
		sea.set(encodeLz77(data), 64);
		expect(
			scanGbaCompression(sea, { minDecompressedSize: 256 }),
		).toEqual([]);
		expect(
			scanGbaCompression(sea, { maxDecompressedSize: 64 }),
		).toEqual([]);
	});

	it('rejects incompressible false positives', () => {
		// A perfectly valid "stored" LZ77 stream over random data: it
		// decompresses cleanly, but compressedSize > decompressedSize,
		// so the scanner must reject it.
		const sea = new Uint8Array(1024);
		const data = randomBytes(128, 99);
		const stored = encodeLz77Stored(data);
		expect(stored.length).toBeGreaterThan(data.length);
		sea.set(stored, 64);
		// Sanity: the stream itself is valid.
		expect(decompressLz77(sea, 64)).toEqual(data);
		expect(scanGbaCompression(sea)).toEqual([]);
	});
});
