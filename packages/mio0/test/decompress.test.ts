import { describe, it, expect } from 'vitest';
import {
	MIO0_MAGIC,
	decompressMio0,
	decompressMio0Bytes,
	isMio0,
	readMio0Header,
} from '../src/index.js';

/**
 * Build a MIO0 block from explicit streams. Layout used by these
 * tests: [16-byte header][control bytes][compressed records][raw bytes].
 */
function makeMio0(opts: {
	uncompressedSize: number;
	control: number[];
	compressed: number[];
	raw: number[];
}): Uint8Array {
	const compressedOffset = 16 + opts.control.length;
	const rawOffset = compressedOffset + opts.compressed.length;
	const buf = new Uint8Array(rawOffset + opts.raw.length);
	buf[0] = 0x4d; // M
	buf[1] = 0x49; // I
	buf[2] = 0x4f; // O
	buf[3] = 0x30; // 0
	const view = new DataView(buf.buffer);
	view.setUint32(4, opts.uncompressedSize, false);
	view.setUint32(8, compressedOffset, false);
	view.setUint32(12, rawOffset, false);
	buf.set(opts.control, 16);
	buf.set(opts.compressed, compressedOffset);
	buf.set(opts.raw, rawOffset);
	return buf;
}

/** All-literal encoding: every control bit = 1. */
function makeMio0Literal(payload: Uint8Array): Uint8Array {
	const control: number[] = [];
	for (let i = 0; i < Math.ceil(payload.length / 8); i++) {
		control.push(0xff);
	}
	return makeMio0({
		uncompressedSize: payload.length,
		control,
		compressed: [],
		raw: Array.from(payload),
	});
}

/** Encode a 2-byte back-reference record. */
function backref(length: number, dist: number): [number, number] {
	if (length < 3 || length > 18) throw new Error(`Bad test length ${length}`);
	if (dist < 1 || dist > 4096) throw new Error(`Bad test dist ${dist}`);
	const d = dist - 1;
	return [((length - 3) << 4) | ((d >> 8) & 0x0f), d & 0xff];
}

describe('isMio0', () => {
	it('detects the magic', async () => {
		const mio0 = makeMio0Literal(new Uint8Array([1, 2, 3]));
		expect(await isMio0(new Blob([mio0 as BlobPart]))).toBe(true);
	});
	it('rejects non-MIO0 blobs', async () => {
		expect(
			await isMio0(new Blob([new Uint8Array([0, 0, 0, 0]) as BlobPart])),
		).toBe(false);
		expect(await isMio0(new Blob([new Uint8Array([1]) as BlobPart]))).toBe(
			false,
		);
	});
});

describe('readMio0Header', () => {
	it('parses magic, size, and stream offsets', async () => {
		const mio0 = makeMio0({
			uncompressedSize: 42,
			control: [0xff, 0xff],
			compressed: [0, 0],
			raw: [1, 2, 3],
		});
		const h = await readMio0Header(new Blob([mio0 as BlobPart]));
		expect(h.magic).toBe(MIO0_MAGIC);
		expect(h.uncompressedSize).toBe(42);
		expect(h.compressedOffset).toBe(18);
		expect(h.rawOffset).toBe(20);
	});
	it('throws on bad magic', async () => {
		await expect(
			readMio0Header(new Blob([new Uint8Array(16) as BlobPart])),
		).rejects.toThrow(/MIO0/);
	});
	it('throws on a too-small blob', async () => {
		await expect(
			readMio0Header(new Blob([new Uint8Array(8) as BlobPart])),
		).rejects.toThrow(/too small/);
	});
});

describe('decompressMio0 (literal-only)', () => {
	it('round-trips an all-literal payload', () => {
		const payload = new Uint8Array(73);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const mio0 = makeMio0Literal(payload);
		const out = decompressMio0Bytes(mio0);
		expect(out).toEqual(payload);
	});

	it('round-trips an empty payload', () => {
		const mio0 = makeMio0Literal(new Uint8Array(0));
		const out = decompressMio0Bytes(mio0);
		expect(out.length).toBe(0);
	});

	it('returns a Blob from the high-level API', async () => {
		const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const mio0 = makeMio0Literal(payload);
		const blob = await decompressMio0(new Blob([mio0 as BlobPart]));
		expect(blob.size).toBe(4);
		const got = new Uint8Array(await blob.arrayBuffer());
		expect(got).toEqual(payload);
	});
});

describe('decompressMio0 (back-references)', () => {
	it('decodes a back-reference producing a repeated pattern', () => {
		// Literals "ABC" then back-ref length=3 dist=3 → "ABCABC".
		// Control bits: 1 1 1 0 (then don't-care).
		const mio0 = makeMio0({
			uncompressedSize: 6,
			control: [0b1110_0000],
			compressed: backref(3, 3),
			raw: [0x41, 0x42, 0x43], // ABC
		});
		const out = decompressMio0Bytes(mio0);
		expect(Array.from(out)).toEqual([0x41, 0x42, 0x43, 0x41, 0x42, 0x43]);
	});

	it('handles overlapping (run-length) back-references', () => {
		// Classic RLE trick: emit 1 byte, then back-ref dist=1 length=18
		// (the maximum) → 19 copies of that byte.
		const mio0 = makeMio0({
			uncompressedSize: 19,
			control: [0b1000_0000],
			compressed: backref(18, 1),
			raw: [0x5a], // 'Z'
		});
		const out = decompressMio0Bytes(mio0);
		expect(out.length).toBe(19);
		for (let i = 0; i < 19; i++) expect(out[i]).toBe(0x5a);
	});

	it('decodes a block embedded at a non-zero offset', () => {
		const mio0 = makeMio0({
			uncompressedSize: 6,
			control: [0b1110_0000],
			compressed: backref(3, 3),
			raw: [0x41, 0x42, 0x43],
		});
		const container = new Uint8Array(mio0.length + 8);
		container.fill(0xee, 0, 8);
		container.set(mio0, 8);
		const out = decompressMio0Bytes(container, 8);
		expect(Array.from(out)).toEqual([0x41, 0x42, 0x43, 0x41, 0x42, 0x43]);
	});
});

describe('decompressMio0 error handling', () => {
	it('throws on a truncated raw stream', () => {
		const mio0 = makeMio0Literal(new Uint8Array([1, 2, 3, 4]));
		// Cut off inside the raw literal stream.
		const truncated = mio0.subarray(0, mio0.length - 2);
		expect(() => decompressMio0Bytes(truncated)).toThrow(/Truncated/);
	});

	it('throws on a truncated compressed stream', () => {
		const mio0 = makeMio0({
			uncompressedSize: 6,
			control: [0b1110_0000],
			compressed: backref(3, 3),
			raw: [0x41, 0x42, 0x43],
		});
		// Point the compressed stream past the end of the input.
		new DataView(mio0.buffer).setUint32(8, mio0.length, false);
		expect(() => decompressMio0Bytes(mio0)).toThrow(/Truncated/);
	});

	it('throws on bad magic', () => {
		expect(() => decompressMio0Bytes(new Uint8Array(20))).toThrow(/magic/);
	});

	it('throws when a back-reference reaches before the output start', () => {
		// dist=4 with only 3 bytes emitted so far.
		const mio0 = makeMio0({
			uncompressedSize: 6,
			control: [0b1110_0000],
			compressed: backref(3, 4),
			raw: [0x41, 0x42, 0x43],
		});
		expect(() => decompressMio0Bytes(mio0)).toThrow(/before start/);
	});

	it('throws when the Blob API sees bad magic', async () => {
		await expect(
			decompressMio0(new Blob([new Uint8Array(20) as BlobPart])),
		).rejects.toThrow(/magic/);
	});
});
