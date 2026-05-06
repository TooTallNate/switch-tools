import { describe, it, expect } from 'vitest';
import {
	BFTTF_MAGIC,
	isBfttf,
	parseBfttf,
	OBFUSCATION_KEY,
} from '../src/index.js';

function bswap32(v: number): number {
	return (
		(((v & 0xff000000) >>> 24) |
			((v & 0x00ff0000) >>> 8) |
			((v & 0x0000ff00) << 8) |
			((v & 0x000000ff) << 24)) >>>
		0
	);
}

/**
 * Build a synthetic BFTTF blob from an in-memory TTF payload.
 *
 * Wire layout (each u32 stored LE on disk):
 *   u32[0] = MAGIC ^ KEY
 *   u32[1] = bswap32(payloadSize) ^ KEY        ← the size is byte-reversed
 *   payload word i = ttfWord(i) ^ KEY          ← payload words are LE
 */
function makeBfttf(ttf: Uint8Array, magic = BFTTF_MAGIC): Uint8Array {
	const out = new Uint8Array(8 + ttf.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, (magic ^ OBFUSCATION_KEY) >>> 0, true);
	view.setUint32(4, (bswap32(ttf.length) ^ OBFUSCATION_KEY) >>> 0, true);
	for (let i = 0; i < ttf.length; i += 4) {
		const w =
			(ttf[i] | 0) |
			((ttf[i + 1] | 0) << 8) |
			((ttf[i + 2] | 0) << 16) |
			((ttf[i + 3] | 0) << 24);
		view.setUint32(8 + i, (w ^ OBFUSCATION_KEY) >>> 0, true);
	}
	return out;
}

/**
 * Build a tiny but valid-shaped TTF table directory: sfnt magic +
 * `numTables=1`, plus a single zero-filled table entry. Just enough
 * for the format-sniffer to recognize it as TTF.
 */
function makeTinyTtf(): Uint8Array {
	const out = new Uint8Array(28); // 12 byte directory header + 16 byte entry
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x00010000, false); // sfnt = TrueType
	view.setUint16(4, 1, false); // numTables
	view.setUint16(6, 0x10, false); // searchRange
	view.setUint16(8, 0, false); // entrySelector
	view.setUint16(10, 0, false); // rangeShift
	// One zeroed-out 16-byte table entry follows
	return out;
}

function makeTinyOtf(): Uint8Array {
	const out = new Uint8Array(28);
	out[0] = 0x4f; // 'O'
	out[1] = 0x54; // 'T'
	out[2] = 0x54; // 'T'
	out[3] = 0x4f; // 'O'
	const view = new DataView(out.buffer);
	view.setUint16(4, 1, false); // numTables
	return out;
}

describe('isBfttf', () => {
	it('recognises a valid BFTTF by its magic', async () => {
		const bfttf = makeBfttf(makeTinyTtf());
		expect(await isBfttf(new Blob([bfttf]))).toBe(true);
	});

	it('rejects an arbitrary blob', async () => {
		const buf = new Uint8Array(64);
		for (let i = 0; i < buf.length; i++) buf[i] = i;
		expect(await isBfttf(new Blob([buf]))).toBe(false);
	});

	it('rejects an undersized blob', async () => {
		expect(await isBfttf(new Blob([new Uint8Array(2)]))).toBe(false);
	});
});

describe('parseBfttf', () => {
	it('round-trips a tiny TTF', async () => {
		const ttf = makeTinyTtf();
		const bfttf = makeBfttf(ttf);
		const parsed = await parseBfttf(new Blob([bfttf]));
		expect(parsed.format).toBe('ttf');
		expect(parsed.size).toBe(ttf.length);
		expect(parsed.headerSizeOk).toBe(true);
		const got = new Uint8Array(await parsed.font.arrayBuffer());
		expect(Array.from(got)).toEqual(Array.from(ttf));
		expect(parsed.font.type).toBe('font/ttf');
	});

	it('detects an OTF payload', async () => {
		const otf = makeTinyOtf();
		const parsed = await parseBfttf(new Blob([makeBfttf(otf)]));
		expect(parsed.format).toBe('otf');
		expect(parsed.font.type).toBe('font/otf');
	});

	it('still surfaces a payload when the sfnt magic is unknown', async () => {
		const junk = new Uint8Array(28);
		junk[0] = 0x42; // 'B' — not a real sfnt magic
		const parsed = await parseBfttf(new Blob([makeBfttf(junk)]));
		expect(parsed.format).toBe('unknown');
		expect(parsed.font.type).toBe('application/octet-stream');
		expect(parsed.size).toBe(junk.length);
	});

	it('throws on a blob that is too small for a header', async () => {
		await expect(parseBfttf(new Blob([new Uint8Array(4)]))).rejects.toThrow(
			/too small/,
		);
	});

	it('still parses payloads whose length is not a multiple of 4 (trailing bytes left as-is)', async () => {
		// Construct a 30-byte "TTF" so payload length isn't 4-byte aligned.
		// The deobfuscator should XOR the first 28 bytes (7 full words) and
		// leave the last 2 bytes alone, matching the wire format.
		const ttf = new Uint8Array(30);
		ttf[0] = 0x00; ttf[1] = 0x01; ttf[2] = 0x00; ttf[3] = 0x00; // sfnt magic
		ttf[28] = 0xab; ttf[29] = 0xcd; // un-XOR'd trailers
		// Wire format: header + XOR'd first 28 bytes + raw last 2 bytes
		const wire = new Uint8Array(8 + 30);
		const view = new DataView(wire.buffer);
		view.setUint32(0, BFTTF_MAGIC ^ OBFUSCATION_KEY, true);
		view.setUint32(4, (bswap32(30) ^ OBFUSCATION_KEY) >>> 0, true); // bswapped size
		for (let i = 0; i < 28; i += 4) {
			const w =
				ttf[i] | (ttf[i + 1] << 8) | (ttf[i + 2] << 16) | (ttf[i + 3] << 24);
			view.setUint32(8 + i, (w ^ OBFUSCATION_KEY) >>> 0, true);
		}
		wire[8 + 28] = 0xab;
		wire[8 + 29] = 0xcd;
		const parsed = await parseBfttf(new Blob([wire]));
		const got = new Uint8Array(await parsed.font.arrayBuffer());
		expect(got[28]).toBe(0xab);
		expect(got[29]).toBe(0xcd);
		expect(got[0]).toBe(0x00);
		expect(got[3]).toBe(0x00);
	});
});
