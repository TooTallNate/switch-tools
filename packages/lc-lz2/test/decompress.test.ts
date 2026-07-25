import { describe, it, expect } from 'vitest';
import {
	decompressLz2,
	decompressLz2Bytes,
	tryDecompressLz2,
} from '../src/index.js';

/** Build a normal (short-form) command header. */
function hdr(command: number, length: number): number {
	return ((command & 7) << 5) | ((length - 1) & 0x1f);
}

/** Build an extended (long-form) command header pair. */
function hdrExt(command: number, length: number): number[] {
	const n = length - 1;
	return [0xe0 | ((command & 7) << 2) | ((n >> 8) & 3), n & 0xff];
}

const END = 0xff;

describe('decompressLz2', () => {
	it('command 0: direct copy', () => {
		const src = Uint8Array.from([hdr(0, 4), 1, 2, 3, 4, END]);
		const { bytes, consumed } = decompressLz2(src);
		expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
		expect(consumed).toBe(6);
	});

	it('command 1: byte fill', () => {
		const src = Uint8Array.from([hdr(1, 5), 0xab, END]);
		expect(Array.from(decompressLz2Bytes(src))).toEqual([
			0xab, 0xab, 0xab, 0xab, 0xab,
		]);
	});

	it('command 2: word fill alternates and honours odd lengths', () => {
		const src = Uint8Array.from([hdr(2, 5), 0xaa, 0xbb, END]);
		expect(Array.from(decompressLz2Bytes(src))).toEqual([
			0xaa, 0xbb, 0xaa, 0xbb, 0xaa,
		]);
	});

	it('command 3: increasing fill wraps at 256', () => {
		const src = Uint8Array.from([hdr(3, 4), 0xfe, END]);
		expect(Array.from(decompressLz2Bytes(src))).toEqual([
			0xfe, 0xff, 0x00, 0x01,
		]);
	});

	it('command 4: repeat copies from an absolute output offset', () => {
		// Emit "ABCD", then repeat 2 bytes from offset 1 → "BC".
		const src = Uint8Array.from([
			hdr(0, 4),
			0x41,
			0x42,
			0x43,
			0x44,
			hdr(4, 2),
			0x00,
			0x01, // big-endian offset 1
			END,
		]);
		expect(Array.from(decompressLz2Bytes(src))).toEqual([
			0x41, 0x42, 0x43, 0x44, 0x42, 0x43,
		]);
	});

	it('command 4: overlapping copy produces run-length behaviour', () => {
		// Emit one byte, then copy 6 bytes starting at offset 0 —
		// the copy reads bytes it is itself producing.
		const src = Uint8Array.from([
			hdr(0, 1),
			0x5a,
			hdr(4, 6),
			0x00,
			0x00,
			END,
		]);
		expect(Array.from(decompressLz2Bytes(src))).toEqual([
			0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a,
		]);
	});

	it('supports the extended header for long runs', () => {
		const src = Uint8Array.from([...hdrExt(1, 1000), 0x7f, END]);
		const bytes = decompressLz2Bytes(src);
		expect(bytes.length).toBe(1000);
		expect(bytes.every((b) => b === 0x7f)).toBe(true);
	});

	it('extended header reaches the 1024-byte maximum', () => {
		const src = Uint8Array.from([...hdrExt(1, 1024), 0x01, END]);
		expect(decompressLz2Bytes(src).length).toBe(1024);
	});

	it('decompresses from a non-zero offset', () => {
		const src = Uint8Array.from([
			0xde,
			0xad,
			hdr(1, 3),
			0x11,
			END,
		]);
		const { bytes, consumed } = decompressLz2(src, 2);
		expect(Array.from(bytes)).toEqual([0x11, 0x11, 0x11]);
		expect(consumed).toBe(3);
	});

	it('concatenated streams: consumed allows walking to the next block', () => {
		const first = [hdr(1, 3), 0xaa, END];
		const second = [hdr(1, 2), 0xbb, END];
		const src = Uint8Array.from([...first, ...second]);
		const a = decompressLz2(src, 0);
		expect(Array.from(a.bytes)).toEqual([0xaa, 0xaa, 0xaa]);
		const b = decompressLz2(src, a.consumed);
		expect(Array.from(b.bytes)).toEqual([0xbb, 0xbb]);
	});

	it('throws on truncated input (no terminator)', () => {
		const src = Uint8Array.from([hdr(1, 3), 0xaa]);
		expect(() => decompressLz2(src)).toThrow(/truncated/i);
	});

	it('throws on a truncated direct copy', () => {
		const src = Uint8Array.from([hdr(0, 8), 1, 2, 3]);
		expect(() => decompressLz2(src)).toThrow(/truncated/i);
	});

	it('throws on a back-reference past the output end', () => {
		const src = Uint8Array.from([hdr(4, 2), 0x10, 0x00, END]);
		expect(() => decompressLz2(src)).toThrow(/back-reference/i);
	});

	it('throws on unused commands 5 and 6', () => {
		for (const cmd of [5, 6]) {
			const src = Uint8Array.from([hdr(cmd, 2), 0, 0, END]);
			expect(() => decompressLz2(src)).toThrow(/unused command/i);
		}
	});

	it('throws when output exceeds maxOutputSize', () => {
		const src = Uint8Array.from([...hdrExt(1, 1024), 0x00, END]);
		expect(() =>
			decompressLz2(src, 0, { maxOutputSize: 512 }),
		).toThrow(/exceeds/i);
	});

	it('rejects an out-of-range start offset', () => {
		const src = Uint8Array.from([END]);
		expect(() => decompressLz2(src, 5)).toThrow(RangeError);
	});

	it('handles an empty stream (bare terminator)', () => {
		expect(decompressLz2Bytes(Uint8Array.from([END])).length).toBe(0);
	});
});

describe('tryDecompressLz2', () => {
	it('returns a result for a well-formed, actually-compressed stream', () => {
		const src = Uint8Array.from([...hdrExt(1, 200), 0x42, END]);
		const r = tryDecompressLz2(src, 0);
		expect(r).not.toBeNull();
		expect(r!.bytes.length).toBe(200);
	});

	it('returns null on malformed input instead of throwing', () => {
		expect(tryDecompressLz2(Uint8Array.from([hdr(0, 8), 1]), 0)).toBeNull();
	});

	it('returns null when output is below minOutputSize', () => {
		const src = Uint8Array.from([hdr(1, 4), 0x11, END]);
		expect(tryDecompressLz2(src, 0)).toBeNull();
		expect(tryDecompressLz2(src, 0, { minOutputSize: 2 })).not.toBeNull();
	});

	it('returns null when the stream does not actually compress', () => {
		// 100 literal bytes cost 100 + 2 bytes of input to produce
		// 100 bytes of output — no compression, so it is rejected.
		const literals = new Array(100).fill(0).map((_, i) => i & 0xff);
		const src = Uint8Array.from([...hdrExt(0, 100), ...literals, END]);
		expect(tryDecompressLz2(src, 0)).toBeNull();
	});
});
