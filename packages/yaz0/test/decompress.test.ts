import { describe, it, expect } from 'vitest';
import {
	YAZ0_MAGIC,
	decompressYaz0,
	decompressYaz0ToBytes,
	isYaz0,
	readYaz0Header,
} from '../src/index.js';

/**
 * Build a *minimal* Yaz0 file from an in-memory payload.
 *
 * We use the simplest valid encoding: every flag bit = 1 (= literal copy).
 * That gives 9 output bytes per 8 input bytes, which is a worst-case
 * encoding but is fine for testing the decoder logic.
 */
function makeYaz0Literal(payload: Uint8Array): Uint8Array {
	const groupCount = Math.ceil(payload.length / 8);
	const out = new Uint8Array(16 + groupCount + payload.length);
	out[0] = 0x59;
	out[1] = 0x61;
	out[2] = 0x7a;
	out[3] = 0x30;
	new DataView(out.buffer).setUint32(4, payload.length, false);
	let dst = 16;
	let src = 0;
	while (src < payload.length) {
		const remaining = payload.length - src;
		const nBytes = Math.min(8, remaining);
		// Flag byte: bits set = literal. Bits set must match the bytes we'll
		// actually emit; if fewer than 8 remain, the trailing flag bits are
		// don't-care (the decoder stops on outPos === outSize).
		out[dst++] = nBytes === 8 ? 0xff : (0xff << (8 - nBytes)) & 0xff;
		for (let i = 0; i < nBytes; i++) {
			out[dst++] = payload[src++];
		}
	}
	return out.subarray(0, dst);
}

/**
 * Build a Yaz0 file that uses *only* one big back-reference at the
 * end: emit `prefix` as literals, then a back-reference of length
 * `length` pointing back `offset` bytes. This exercises the back-ref
 * decode paths (both 2-byte and 3-byte forms).
 */
function makeYaz0WithBackref(opts: {
	prefix: Uint8Array;
	offset: number;
	length: number;
	uncompressedSize: number;
}): Uint8Array {
	// Flag bits: prefix.length × 1 ('literal') + 1 × 0 ('backref').
	const prefixGroups = Math.ceil(opts.prefix.length / 8);
	const totalFlags = opts.prefix.length + 1;
	const groupCount = Math.ceil(totalFlags / 8);
	const backrefBytes = opts.length >= 0x12 ? 3 : 2;
	const buf = new Uint8Array(
		16 + groupCount + opts.prefix.length + backrefBytes,
	);
	buf[0] = 0x59;
	buf[1] = 0x61;
	buf[2] = 0x7a;
	buf[3] = 0x30;
	new DataView(buf.buffer).setUint32(4, opts.uncompressedSize, false);

	let dst = 16;
	// Group 0..prefixGroups-2: 8 literal bits each (full groups).
	let src = 0;
	for (let g = 0; g < Math.floor(opts.prefix.length / 8); g++) {
		buf[dst++] = 0xff;
		for (let i = 0; i < 8; i++) buf[dst++] = opts.prefix[src++];
	}
	// Final group: remaining literals (high bits) + 1 back-reference (next bit = 0).
	const literalsLeft = opts.prefix.length - src;
	let flag = 0;
	for (let i = 0; i < literalsLeft; i++) flag |= 1 << (7 - i);
	// back-ref bit at position literalsLeft is 0 → no-op
	buf[dst++] = flag;
	for (let i = 0; i < literalsLeft; i++) buf[dst++] = opts.prefix[src++];

	// Encode back-reference.
	const offsetMinus1 = opts.offset - 1;
	if (offsetMinus1 < 0 || offsetMinus1 > 0xfff) {
		throw new Error(`Bad test offset ${opts.offset}`);
	}
	if (backrefBytes === 2) {
		const lengthMinus2 = opts.length - 2;
		if (lengthMinus2 < 1 || lengthMinus2 > 15) {
			throw new Error(`Bad test length ${opts.length}`);
		}
		buf[dst++] = (lengthMinus2 << 4) | ((offsetMinus1 >> 8) & 0x0f);
		buf[dst++] = offsetMinus1 & 0xff;
	} else {
		const lengthMinus0x12 = opts.length - 0x12;
		if (lengthMinus0x12 < 0 || lengthMinus0x12 > 0xff) {
			throw new Error(`Bad test length ${opts.length}`);
		}
		buf[dst++] = (offsetMinus1 >> 8) & 0x0f;
		buf[dst++] = offsetMinus1 & 0xff;
		buf[dst++] = lengthMinus0x12;
	}
	return buf.subarray(0, dst);
}

describe('isYaz0', () => {
	it('detects the magic', async () => {
		const yaz0 = makeYaz0Literal(new Uint8Array([1, 2, 3]));
		expect(await isYaz0(new Blob([yaz0]))).toBe(true);
	});
	it('rejects non-Yaz0 blobs', async () => {
		expect(await isYaz0(new Blob([new Uint8Array([0, 0, 0, 0])]))).toBe(
			false,
		);
		expect(await isYaz0(new Blob([new Uint8Array([1])]))).toBe(false);
	});
});

describe('readYaz0Header', () => {
	it('parses magic + uncompressed size', async () => {
		const yaz0 = makeYaz0Literal(new Uint8Array(42));
		const h = await readYaz0Header(new Blob([yaz0]));
		expect(h.magic).toBe(YAZ0_MAGIC);
		expect(h.uncompressedSize).toBe(42);
	});
	it('throws on bad magic', async () => {
		await expect(
			readYaz0Header(new Blob([new Uint8Array(16)])),
		).rejects.toThrow(/Yaz0/);
	});
});

describe('decompressYaz0 (literal-only)', () => {
	it('round-trips an all-literal payload', async () => {
		const payload = new Uint8Array(73);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const yaz0 = makeYaz0Literal(payload);
		const out = await decompressYaz0ToBytes(new Blob([yaz0]));
		expect(out).toEqual(payload);
	});

	it('round-trips an empty payload', async () => {
		const yaz0 = makeYaz0Literal(new Uint8Array(0));
		const out = await decompressYaz0ToBytes(new Blob([yaz0]));
		expect(out.length).toBe(0);
	});

	it('returns a Blob from the high-level API', async () => {
		const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const yaz0 = makeYaz0Literal(payload);
		const blob = await decompressYaz0(new Blob([yaz0]));
		expect(blob.size).toBe(4);
		const got = new Uint8Array(await blob.arrayBuffer());
		expect(got).toEqual(payload);
	});
});

describe('decompressYaz0 (back-references)', () => {
	it('decodes a short (2-byte) back-reference', async () => {
		// "ABCDEFG" then back-ref offset=4 length=4 → "ABCDEFGCDEFG"... wait,
		// offset 4 from current pos = re-emit last 4 bytes: "DEFG" → "ABCDEFGDEFG"
		const prefix = new Uint8Array([
			0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
		]); // ABCDEFG
		const yaz0 = makeYaz0WithBackref({
			prefix,
			offset: 4,
			length: 4,
			uncompressedSize: prefix.length + 4,
		});
		const out = await decompressYaz0ToBytes(new Blob([yaz0]));
		expect(Array.from(out)).toEqual([
			0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x44, 0x45, 0x46, 0x47,
		]);
	});

	it('decodes a long (3-byte) back-reference', async () => {
		const prefix = new Uint8Array(20);
		for (let i = 0; i < prefix.length; i++) prefix[i] = i + 1;
		const yaz0 = makeYaz0WithBackref({
			prefix,
			offset: 20,
			length: 0x12, // exactly the threshold (forces 3-byte form)
			uncompressedSize: prefix.length + 0x12,
		});
		const out = await decompressYaz0ToBytes(new Blob([yaz0]));
		const expected = new Uint8Array(prefix.length + 0x12);
		expected.set(prefix, 0);
		// Back-ref offset=20 length=0x12 starting at pos=20: copies bytes [0..18) of prefix.
		expected.set(prefix.subarray(0, 0x12), prefix.length);
		expect(out).toEqual(expected);
	});

	it('handles overlapping (run-length) back-references', async () => {
		// Classic RLE trick: emit 1 byte, then back-ref offset=1 length=10.
		// Should produce 11 copies of that byte.
		const prefix = new Uint8Array([0x5a]); // 'Z'
		const yaz0 = makeYaz0WithBackref({
			prefix,
			offset: 1,
			length: 10,
			uncompressedSize: 11,
		});
		const out = await decompressYaz0ToBytes(new Blob([yaz0]));
		expect(out.length).toBe(11);
		for (let i = 0; i < 11; i++) expect(out[i]).toBe(0x5a);
	});
});

describe('decompressYaz0 error handling', () => {
	it('throws on truncated payload', async () => {
		const yaz0 = makeYaz0Literal(new Uint8Array([1, 2, 3, 4]));
		// Cut off after the flag byte, before the literals.
		const truncated = yaz0.subarray(0, 17);
		await expect(
			decompressYaz0ToBytes(new Blob([truncated])),
		).rejects.toThrow(/Truncated/);
	});

	it('throws on bad magic', async () => {
		const buf = new Uint8Array(20);
		await expect(
			decompressYaz0ToBytes(new Blob([buf])),
		).rejects.toThrow(/magic/);
	});
});
