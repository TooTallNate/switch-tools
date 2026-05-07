import { describe, it, expect } from 'vitest';
import {
	GFPAK_MAGIC,
	GfpakCompression,
	isGfpak,
	parseGfpak,
} from '../src/index.js';

/**
 * Build a minimal GFPAK with a single uncompressed file. Used for
 * happy-path tests of the header / folder / file-info walk;
 * compressed-entry coverage relies on the parser being exercised
 * end-to-end via the nx-archive app's manual workflow.
 */
function buildMinimalGfpak(payload: Uint8Array, fileHash: bigint, folderHash: bigint) {
	const enc = new TextEncoder();
	const fileCount = 1;
	const folderCount = 1;
	// Layout we'll emit:
	//   0x00..0x2F: header (48 bytes)
	//   0x30..0x47: folder array entry (16 + 16 = 32 bytes for one folder
	//               with one file)
	//   0x50..0x57: hash array (1 × u64)
	//   0x58..0x6F: file info (24 bytes)
	//   0x70..    : payload
	const headerSize = 0x30;
	const folderSize = 32;
	const hashArraySize = 8;
	const fileInfoSize = 24;
	const payloadOffset = headerSize + folderSize + hashArraySize + fileInfoSize;
	const total = payloadOffset + payload.length;
	const buf = new Uint8Array(total);
	const v = new DataView(buf.buffer);
	// Header
	buf.set(enc.encode(GFPAK_MAGIC), 0);
	v.setUint32(0x08, 0x100, true); // version
	v.setUint32(0x0c, 0, true);
	v.setUint32(0x10, fileCount, true);
	v.setUint32(0x14, folderCount, true);
	v.setBigUint64(0x18, BigInt(headerSize + folderSize + hashArraySize), true); // fileInfoOffset
	v.setBigUint64(0x20, BigInt(headerSize + folderSize), true); // hashArrayOffset
	v.setBigUint64(0x28, BigInt(headerSize), true); // folderArrayOffset
	// Folder
	v.setBigUint64(headerSize + 0, folderHash, true);
	v.setUint32(headerSize + 8, 1, true); // file count
	v.setUint32(headerSize + 12, 0xcc, true); // padding
	v.setBigUint64(headerSize + 16, fileHash, true);
	v.setUint32(headerSize + 24, 0, true); // file index
	v.setUint32(headerSize + 28, 0xcc, true); // padding
	// Hash array
	v.setBigUint64(headerSize + folderSize, fileHash, true);
	// File info
	const fi = headerSize + folderSize + hashArraySize;
	v.setUint16(fi + 0, 9, true); // level
	v.setUint16(fi + 2, GfpakCompression.None, true);
	v.setUint32(fi + 4, payload.length, true);
	v.setUint32(fi + 8, payload.length, true);
	v.setUint32(fi + 12, 0xcc, true);
	v.setBigUint64(fi + 16, BigInt(payloadOffset), true);
	// Payload
	buf.set(payload, payloadOffset);
	return buf;
}

describe('isGfpak', () => {
	it('detects the magic', async () => {
		const buf = buildMinimalGfpak(new Uint8Array(4), 1n, 2n);
		expect(await isGfpak(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects unrelated blobs', async () => {
		expect(
			await isGfpak(new Blob([new Uint8Array([0x47, 0x46, 0x4c, 0x58])])),
		).toBe(false);
		expect(await isGfpak(new Blob([]))).toBe(false);
	});
});

describe('parseGfpak', () => {
	it('parses a minimal single-entry archive', async () => {
		// Use a SARC-magic payload so the sniffer picks up a known format.
		const payload = new Uint8Array([0x53, 0x41, 0x52, 0x43, 0x14, 0x00, 0xff, 0xfe, 0x00, 0x00, 0x00, 0x00]);
		const buf = buildMinimalGfpak(payload, 0xaabbccddeeff0011n, 0x1234567890abcdefn);
		const parsed = await parseGfpak(new Blob([buf as BlobPart]));
		expect(parsed.fileCount).toBe(1);
		expect(parsed.folderCount).toBe(1);
		expect(parsed.folders[0].hash).toBe(0x1234567890abcdefn);
		expect(parsed.entries[0].pathHash).toBe(0xaabbccddeeff0011n);
		expect(parsed.entries[0].fileHash).toBe(0xaabbccddeeff0011n);
		expect(parsed.entries[0].folderHash).toBe(0x1234567890abcdefn);
		expect(parsed.entries[0].compression).toBe(GfpakCompression.None);
		expect(parsed.entries[0].decompressedSize).toBe(payload.length);
		expect(parsed.entries[0].innerMagic).toBe('SARC');
		expect(parsed.entries[0].innerExt).toBe('sarc');
	});

	it('decompresses an uncompressed entry via getData', async () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const buf = buildMinimalGfpak(payload, 1n, 2n);
		const parsed = await parseGfpak(new Blob([buf as BlobPart]));
		const data = await parsed.entries[0].getData();
		expect(data.size).toBe(payload.length);
		const bytes = new Uint8Array(await data.arrayBuffer());
		expect(Array.from(bytes)).toEqual(Array.from(payload));
	});

	it('throws for Oodle-compressed entries when extracted', async () => {
		const payload = new Uint8Array([1, 2, 3, 4]);
		const buf = buildMinimalGfpak(payload, 1n, 2n);
		// Patch compression type to Oodle.
		const v = new DataView(buf.buffer);
		const fi = 0x30 + 32 + 8;
		v.setUint16(fi + 2, GfpakCompression.Oodle, true);
		const parsed = await parseGfpak(new Blob([buf as BlobPart]));
		await expect(parsed.entries[0].getData()).rejects.toThrow(/Oodle/);
	});

	it('throws on bad magic', async () => {
		const buf = new Uint8Array(0x30);
		await expect(parseGfpak(new Blob([buf as BlobPart]))).rejects.toThrow(
			/GFPAK magic/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseGfpak(new Blob([]))).rejects.toThrow(/too small/);
	});
});

describe('GFPAK_MAGIC export', () => {
	it('matches the on-disk value', () => {
		expect(GFPAK_MAGIC).toBe('GFLXPACK');
	});
});
