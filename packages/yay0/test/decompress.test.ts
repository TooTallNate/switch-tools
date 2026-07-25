import { describe, it, expect } from 'vitest';
import {
	YAY0_MAGIC,
	decompressYay0,
	decompressYay0Bytes,
	isYay0,
	readYay0Header,
} from '../src/index.js';

/**
 * Build a Yay0 block from explicit streams. Layout used by these
 * tests: [16-byte header][control u32 words][link table][chunk bytes].
 *
 * `controlBits` is a string of '0'/'1' characters, MSB-first; it is
 * packed into as many big-endian u32 words as needed (trailing bits
 * are don't-care and left as 0).
 */
function makeYay0(opts: {
	uncompressedSize: number;
	controlBits: string;
	link: number[];
	chunk: number[];
}): Uint8Array {
	const wordCount = Math.max(1, Math.ceil(opts.controlBits.length / 32));
	const linkOffset = 16 + wordCount * 4;
	const chunkOffset = linkOffset + opts.link.length;
	const buf = new Uint8Array(chunkOffset + opts.chunk.length);
	buf[0] = 0x59; // Y
	buf[1] = 0x61; // a
	buf[2] = 0x79; // y
	buf[3] = 0x30; // 0
	const view = new DataView(buf.buffer);
	view.setUint32(4, opts.uncompressedSize, false);
	view.setUint32(8, linkOffset, false);
	view.setUint32(12, chunkOffset, false);
	for (let i = 0; i < opts.controlBits.length; i++) {
		if (opts.controlBits[i] === '1') {
			buf[16 + (i >> 3)] |= 1 << (7 - (i & 7));
		}
	}
	buf.set(opts.link, linkOffset);
	buf.set(opts.chunk, chunkOffset);
	return buf;
}

/** All-literal encoding: every control bit = 1. */
function makeYay0Literal(payload: Uint8Array): Uint8Array {
	return makeYay0({
		uncompressedSize: payload.length,
		controlBits: '1'.repeat(payload.length),
		link: [],
		chunk: Array.from(payload),
	});
}

/**
 * Encode a 2-byte link-table record. Extended lengths (>= 0x12) use
 * count=0 and require the caller to append `length - 0x12` to the
 * *chunk* stream.
 */
function link(count: number, dist: number): [number, number] {
	if (count < 0 || count > 15) throw new Error(`Bad test count ${count}`);
	if (dist < 1 || dist > 4096) throw new Error(`Bad test dist ${dist}`);
	const d = dist - 1;
	return [(count << 4) | ((d >> 8) & 0x0f), d & 0xff];
}

describe('isYay0', () => {
	it('detects the magic', async () => {
		const yay0 = makeYay0Literal(new Uint8Array([1, 2, 3]));
		expect(await isYay0(new Blob([yay0 as BlobPart]))).toBe(true);
	});
	it('rejects non-Yay0 blobs', async () => {
		expect(
			await isYay0(new Blob([new Uint8Array([0, 0, 0, 0]) as BlobPart])),
		).toBe(false);
		// "Yaz0" is NOT "Yay0".
		expect(
			await isYay0(
				new Blob([new Uint8Array([0x59, 0x61, 0x7a, 0x30]) as BlobPart]),
			),
		).toBe(false);
		expect(await isYay0(new Blob([new Uint8Array([1]) as BlobPart]))).toBe(
			false,
		);
	});
});

describe('readYay0Header', () => {
	it('parses magic, size, and stream offsets', async () => {
		const yay0 = makeYay0({
			uncompressedSize: 42,
			controlBits: '1'.repeat(3),
			link: [0, 0],
			chunk: [1, 2, 3],
		});
		const h = await readYay0Header(new Blob([yay0 as BlobPart]));
		expect(h.magic).toBe(YAY0_MAGIC);
		expect(h.uncompressedSize).toBe(42);
		expect(h.linkOffset).toBe(20);
		expect(h.chunkOffset).toBe(22);
	});
	it('throws on bad magic', async () => {
		await expect(
			readYay0Header(new Blob([new Uint8Array(16) as BlobPart])),
		).rejects.toThrow(/Yay0/);
	});
	it('throws on a too-small blob', async () => {
		await expect(
			readYay0Header(new Blob([new Uint8Array(8) as BlobPart])),
		).rejects.toThrow(/too small/);
	});
});

describe('decompressYay0 (literal-only)', () => {
	it('round-trips an all-literal payload', () => {
		// 73 bytes needs 3 control words — exercises word refills.
		const payload = new Uint8Array(73);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const yay0 = makeYay0Literal(payload);
		const out = decompressYay0Bytes(yay0);
		expect(out).toEqual(payload);
	});

	it('round-trips an empty payload', () => {
		const yay0 = makeYay0Literal(new Uint8Array(0));
		const out = decompressYay0Bytes(yay0);
		expect(out.length).toBe(0);
	});

	it('returns a Blob from the high-level API', async () => {
		const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const yay0 = makeYay0Literal(payload);
		const blob = await decompressYay0(new Blob([yay0 as BlobPart]));
		expect(blob.size).toBe(4);
		const got = new Uint8Array(await blob.arrayBuffer());
		expect(got).toEqual(payload);
	});
});

describe('decompressYay0 (back-references)', () => {
	it('decodes a back-reference producing a repeated pattern', () => {
		// Literals "ABC" then back-ref count=1 (length 3), dist=3 → "ABCABC".
		const yay0 = makeYay0({
			uncompressedSize: 6,
			controlBits: '1110',
			link: link(1, 3),
			chunk: [0x41, 0x42, 0x43], // ABC
		});
		const out = decompressYay0Bytes(yay0);
		expect(Array.from(out)).toEqual([0x41, 0x42, 0x43, 0x41, 0x42, 0x43]);
	});

	it('decodes an extended-length (count=0) back-reference', () => {
		// Literal 'Z', then count=0 with extra byte 0x03 from the CHUNK
		// stream → length = 3 + 0x12 = 21, dist=1 → 22 copies of 'Z'.
		const yay0 = makeYay0({
			uncompressedSize: 22,
			controlBits: '10',
			link: link(0, 1),
			chunk: [0x5a, 0x03], // literal, then extended-length byte
		});
		const out = decompressYay0Bytes(yay0);
		expect(out.length).toBe(22);
		for (let i = 0; i < 22; i++) expect(out[i]).toBe(0x5a);
	});

	it('handles overlapping (run-length) back-references', () => {
		// dist=1 with count=15 (length 17) → 18 copies of one byte.
		const yay0 = makeYay0({
			uncompressedSize: 18,
			controlBits: '10',
			link: link(15, 1),
			chunk: [0x99],
		});
		const out = decompressYay0Bytes(yay0);
		expect(out.length).toBe(18);
		for (let i = 0; i < 18; i++) expect(out[i]).toBe(0x99);
	});

	it('decodes a block embedded at a non-zero offset', () => {
		const yay0 = makeYay0({
			uncompressedSize: 6,
			controlBits: '1110',
			link: link(1, 3),
			chunk: [0x41, 0x42, 0x43],
		});
		const container = new Uint8Array(yay0.length + 4);
		container.fill(0xee, 0, 4);
		container.set(yay0, 4);
		const out = decompressYay0Bytes(container, 4);
		expect(Array.from(out)).toEqual([0x41, 0x42, 0x43, 0x41, 0x42, 0x43]);
	});
});

describe('decompressYay0 error handling', () => {
	it('throws on a truncated chunk stream', () => {
		const yay0 = makeYay0Literal(new Uint8Array([1, 2, 3, 4]));
		// Cut off inside the chunk (literal) stream.
		const truncated = yay0.subarray(0, yay0.length - 2);
		expect(() => decompressYay0Bytes(truncated)).toThrow(/Truncated/);
	});

	it('throws on a truncated link table', () => {
		const yay0 = makeYay0({
			uncompressedSize: 6,
			controlBits: '1110',
			link: link(1, 3),
			chunk: [0x41, 0x42, 0x43],
		});
		// Point the link table past the end of the input.
		new DataView(yay0.buffer).setUint32(8, yay0.length, false);
		expect(() => decompressYay0Bytes(yay0)).toThrow(/Truncated/);
	});

	it('throws on a truncated control stream', () => {
		// Declares 4 output bytes but the file ends right after the header.
		const buf = new Uint8Array(16);
		buf[0] = 0x59;
		buf[1] = 0x61;
		buf[2] = 0x79;
		buf[3] = 0x30;
		const view = new DataView(buf.buffer);
		view.setUint32(4, 4, false);
		view.setUint32(8, 16, false);
		view.setUint32(12, 16, false);
		expect(() => decompressYay0Bytes(buf)).toThrow(/Truncated/);
	});

	it('throws on bad magic', () => {
		expect(() => decompressYay0Bytes(new Uint8Array(20))).toThrow(/magic/);
	});

	it('throws when a back-reference reaches before the output start', () => {
		const yay0 = makeYay0({
			uncompressedSize: 6,
			controlBits: '1110',
			link: link(1, 4), // dist=4 with only 3 bytes emitted
			chunk: [0x41, 0x42, 0x43],
		});
		expect(() => decompressYay0Bytes(yay0)).toThrow(/before start/);
	});

	it('throws when the Blob API sees bad magic', async () => {
		await expect(
			decompressYay0(new Blob([new Uint8Array(20) as BlobPart])),
		).rejects.toThrow(/magic/);
	});
});
