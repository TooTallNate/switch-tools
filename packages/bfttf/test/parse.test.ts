import { describe, it, expect } from 'vitest';
import {
	BFTTF_MAGIC,
	isBfttf,
	parseBfttf,
	OBFUSCATION_KEY,
} from '../src/index.js';

/**
 * Build a synthetic BFTTF/BFOTF blob from an in-memory TTF / OTF payload.
 *
 * Wire layout:
 *   bytes 0..3 = scrambledMagic (LE u32 tag identifying the variant)
 *   bytes 4..7 = totalFileSize XOR'd against the body key (BE u32)
 *   bytes 8..  = payload, each 4-byte chunk XOR'd against the body key
 *                with BE u32 read/write semantics.
 *
 * `scrambledMagic = BFTTF_MAGIC ^ OBFUSCATION_KEY` for the system-font
 * variant (which is what {@link BFTTF_MAGIC} and {@link OBFUSCATION_KEY}
 * are wired up for). Other variants would use different tag / key pairs.
 */
function makeBfttf(
	payload: Uint8Array,
	scrambledMagic: number = (BFTTF_MAGIC ^ OBFUSCATION_KEY) >>> 0,
	key: number = OBFUSCATION_KEY,
): Uint8Array {
	const out = new Uint8Array(8 + payload.length);
	const view = new DataView(out.buffer);
	const totalSize = out.length;
	// Tag (LE)
	view.setUint32(0, scrambledMagic, true);
	// Size (BE), XOR'd
	view.setUint32(4, (totalSize ^ key) >>> 0, false);
	// Body: BE u32 reads, XOR, BE u32 writes
	const aligned = payload.length - (payload.length % 4);
	for (let i = 0; i < aligned; i += 4) {
		const w =
			(payload[i] << 24) |
			(payload[i + 1] << 16) |
			(payload[i + 2] << 8) |
			payload[i + 3];
		view.setUint32(8 + i, (w ^ key) >>> 0, false);
	}
	// Tail bytes pass through unchanged
	for (let i = aligned; i < payload.length; i++) out[8 + i] = payload[i];
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
	it('recognises a system-key BFTTF by its tag', async () => {
		const bfttf = makeBfttf(makeTinyTtf());
		expect(await isBfttf(new Blob([bfttf as BlobPart]))).toBe(true);
	});

	it("recognises Wonder's BFOTF variant by its tag", async () => {
		// Tag 0x1a879bd9 uses body key 0xa6018502
		const bfttf = makeBfttf(makeTinyOtf(), 0x1a879bd9, 0xa6018502);
		expect(await isBfttf(new Blob([bfttf as BlobPart]))).toBe(true);
	});

	it("recognises the third-party variant by its tag", async () => {
		const bfttf = makeBfttf(makeTinyTtf(), 0xc1de68f3, 0x8cf1c8d9);
		expect(await isBfttf(new Blob([bfttf as BlobPart]))).toBe(true);
	});

	it('rejects an arbitrary blob', async () => {
		const buf = new Uint8Array(64);
		for (let i = 0; i < buf.length; i++) buf[i] = i;
		expect(await isBfttf(new Blob([buf as BlobPart]))).toBe(false);
	});

	it('rejects an undersized blob', async () => {
		expect(await isBfttf(new Blob([new Uint8Array(2) as BlobPart]))).toBe(false);
	});
});

describe('parseBfttf', () => {
	it('round-trips a tiny TTF', async () => {
		const ttf = makeTinyTtf();
		const bfttf = makeBfttf(ttf);
		const parsed = await parseBfttf(new Blob([bfttf as BlobPart]));
		expect(parsed.format).toBe('ttf');
		expect(parsed.size).toBe(ttf.length);
		expect(parsed.headerSizeOk).toBe(true);
		const got = new Uint8Array(await parsed.font.arrayBuffer());
		expect(Array.from(got)).toEqual(Array.from(ttf));
		expect(parsed.font.type).toBe('font/ttf');
	});

	it('round-trips an OTF (Wonder/Echoes-of-Wisdom variant)', async () => {
		const otf = makeTinyOtf();
		const bfotf = makeBfttf(otf, 0x1a879bd9, 0xa6018502);
		const parsed = await parseBfttf(new Blob([bfotf as BlobPart]));
		expect(parsed.format).toBe('otf');
		expect(parsed.font.type).toBe('font/otf');
		const got = new Uint8Array(await parsed.font.arrayBuffer());
		expect(Array.from(got.slice(0, 4))).toEqual([0x4f, 0x54, 0x54, 0x4f]);
	});

	it('still surfaces a payload when the sfnt magic is unknown', async () => {
		const junk = new Uint8Array(28);
		junk[0] = 0x42; // 'B' — not a real sfnt magic
		const parsed = await parseBfttf(new Blob([makeBfttf(junk) as BlobPart]));
		expect(parsed.format).toBe('unknown');
		expect(parsed.font.type).toBe('application/octet-stream');
		expect(parsed.size).toBe(junk.length);
	});

	it('throws on a blob that is too small for a header', async () => {
		await expect(parseBfttf(new Blob([new Uint8Array(4) as BlobPart]))).rejects.toThrow(
			/too small/,
		);
	});

	it('throws when the scrambled-magic tag is not one of the known variants', async () => {
		const bad = new Uint8Array(40);
		// Set an unknown tag; the rest is zeros which won't matter.
		const v = new DataView(bad.buffer);
		v.setUint32(0, 0xdeadbeef, true);
		await expect(parseBfttf(new Blob([bad as BlobPart]))).rejects.toThrow(
			/not a recognised/i,
		);
	});

	it('still parses payloads whose length is not a multiple of 4 (trailing bytes left as-is)', async () => {
		// Construct a 30-byte "TTF" so payload length isn't 4-byte aligned.
		// The deobfuscator should XOR the first 28 bytes (7 full words) and
		// leave the last 2 bytes alone, matching the wire format.
		const ttf = new Uint8Array(30);
		ttf[0] = 0x00;
		ttf[1] = 0x01;
		ttf[2] = 0x00;
		ttf[3] = 0x00; // sfnt magic
		ttf[28] = 0xab;
		ttf[29] = 0xcd; // un-XOR'd trailers
		const wire = makeBfttf(ttf);
		// makeBfttf already only XOR's the aligned portion, so this just
		// reuses the same wire format. Verify that the parser comes out
		// with bytes intact.
		const parsed = await parseBfttf(new Blob([wire as BlobPart]));
		const got = new Uint8Array(await parsed.font.arrayBuffer());
		expect(got[28]).toBe(0xab);
		expect(got[29]).toBe(0xcd);
		expect(got[0]).toBe(0x00);
		expect(got[3]).toBe(0x00);
	});
});
