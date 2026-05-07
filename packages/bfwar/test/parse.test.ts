import { describe, it, expect } from 'vitest';
import { isBfwar, parseBfwar, BFWAR_MAGIC } from '../src/index.js';

/**
 * Build a minimal little-endian BFWAR with N inline "FWAV-like"
 * payloads. Each inner payload here is just `'FWAV'` magic
 * followed by `payloadSize - 4` filler bytes — enough to verify
 * the parser walks the file table correctly without recreating a
 * full BFWAV (the BFWAV parser has its own tests).
 */
function buildMinimalBfwar(payloads: { fillByte: number; size: number }[]) {
	const enc = new TextEncoder();
	const HEADER_SIZE = 0x40;
	const INFO_HEADER = 0x0c; // magic + size + count
	const PER_ENTRY = 0x0c; // SizedReference
	const infoSize = align(INFO_HEADER + payloads.length * PER_ENTRY, 0x20);
	const fileBlockHeader = 0x08;

	// Lay out file payloads with 0x20 alignment per Citric writer.
	const fileEntries: { offsetRel: number; size: number }[] = [];
	let curRel = 0;
	for (const p of payloads) {
		fileEntries.push({ offsetRel: curRel, size: p.size });
		curRel = align(curRel + p.size, 0x20);
	}
	const filePayloadBytes = curRel;
	const fileBlockSize = align(fileBlockHeader + filePayloadBytes, 0x20);

	const infoOffset = HEADER_SIZE;
	const fileOffset = HEADER_SIZE + infoSize;
	const fileSize = fileOffset + fileBlockSize;
	const out = new Uint8Array(fileSize);
	const v = new DataView(out.buffer);

	// Header
	out.set(enc.encode(BFWAR_MAGIC), 0);
	out[4] = 0xff; out[5] = 0xfe; // BOM = LE
	v.setUint16(6, HEADER_SIZE, true);
	v.setUint32(8, 0x00010000, true); // version
	v.setUint32(0x0c, fileSize, true);
	v.setUint16(0x10, 2, true); // num blocks
	// Block table
	v.setUint16(0x14, 0x6800, true); // INFO id
	v.setInt32(0x18, infoOffset, true);
	v.setUint32(0x1c, infoSize, true);
	v.setUint16(0x20, 0x6801, true); // FILE id
	v.setInt32(0x24, fileOffset, true);
	v.setUint32(0x28, fileBlockSize, true);

	// INFO
	out.set(enc.encode('INFO'), infoOffset + 0x00);
	v.setUint32(infoOffset + 0x04, infoSize, true);
	v.setUint32(infoOffset + 0x08, payloads.length, true);
	for (let i = 0; i < payloads.length; i++) {
		const eo = infoOffset + 0x0c + i * 0x0c;
		v.setUint16(eo + 0x00, 0x1f00, true);
		v.setInt32(eo + 0x04, fileEntries[i].offsetRel, true);
		v.setUint32(eo + 0x08, fileEntries[i].size, true);
	}

	// FILE
	out.set(enc.encode('FILE'), fileOffset + 0x00);
	v.setUint32(fileOffset + 0x04, fileBlockSize, true);
	for (let i = 0; i < payloads.length; i++) {
		const start = fileOffset + 0x08 + fileEntries[i].offsetRel;
		out.set(enc.encode('FWAV'), start);
		for (let k = 4; k < payloads[i].size; k++) {
			out[start + k] = payloads[i].fillByte;
		}
	}

	return out;
}

function align(n: number, a: number): number {
	return (n + a - 1) & ~(a - 1);
}

describe('isBfwar', () => {
	it('detects the magic', async () => {
		const buf = buildMinimalBfwar([{ fillByte: 0xaa, size: 64 }]);
		expect(await isBfwar(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects non-BFWAR blobs', async () => {
		expect(
			await isBfwar(new Blob([new Uint8Array([0x46, 0x53, 0x41, 0x52])])),
		).toBe(false);
	});
});

describe('parseBfwar', () => {
	it('walks a multi-entry archive and exposes Blob slices', async () => {
		const payloads = [
			{ fillByte: 0xaa, size: 64 },
			{ fillByte: 0xbb, size: 96 },
			{ fillByte: 0xcc, size: 32 },
		];
		const buf = buildMinimalBfwar(payloads);
		const parsed = await parseBfwar(new Blob([buf as BlobPart]));
		expect(parsed.endian).toBe('little');
		expect(parsed.entries).toHaveLength(3);
		// Check each entry's bytes match the payload's fill byte.
		for (let i = 0; i < parsed.entries.length; i++) {
			const e = parsed.entries[i];
			expect(e.size).toBe(payloads[i].size);
			expect(e.innerMagic).toBe('FWAV');
			const bytes = new Uint8Array(await e.data.arrayBuffer());
			expect(bytes.length).toBe(payloads[i].size);
			expect(bytes[0]).toBe(0x46); // 'F'
			// Filler region (after the 4-byte magic) should be the fill.
			expect(bytes[4]).toBe(payloads[i].fillByte);
			expect(bytes[bytes.length - 1]).toBe(payloads[i].fillByte);
		}
	});

	it('throws on bad magic', async () => {
		const buf = new Uint8Array(0x40);
		await expect(parseBfwar(new Blob([buf as BlobPart]))).rejects.toThrow(
			/BFWAR magic/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseBfwar(new Blob([]))).rejects.toThrow(/too small/);
	});
});
