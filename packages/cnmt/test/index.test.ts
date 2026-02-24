import { describe, it, expect } from 'vitest';
import { build, ContentType, MetaType } from '../src/index.js';

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('CNMT builder', () => {
	it('should build a CNMT with correct header', () => {
		const titleId = 0x0100000000001000n;
		const fakeHash = new Uint8Array(32);
		for (let i = 0; i < 32; i++) fakeHash[i] = i;
		const fakeNcaId = fakeHash.subarray(0, 16);

		const cnmt = build({
			titleId,
			contentRecords: [
				{
					hash: fakeHash,
					ncaId: fakeNcaId,
					size: 0x100000,
					type: ContentType.Program,
				},
				{
					hash: fakeHash,
					ncaId: fakeNcaId,
					size: 0x80000,
					type: ContentType.Control,
				},
			],
		});

		const view = new DataView(cnmt);
		const bytes = new Uint8Array(cnmt);

		// Header (0x20 bytes)
		expect(view.getBigUint64(0x00, true)).toBe(titleId);
		expect(view.getUint32(0x08, true)).toBe(0); // title_version
		expect(view.getUint8(0x0c)).toBe(MetaType.Application);
		expect(view.getUint16(0x0e, true)).toBe(0x10); // extended_header_size
		expect(view.getUint16(0x10, true)).toBe(2); // content_entry_count

		// Extended header (0x10 bytes starting at 0x20)
		expect(view.getBigUint64(0x20, true)).toBe(titleId + 0x800n); // patch_title_id

		// Content record 0 (at offset 0x30, 0x38 bytes)
		expect(view.getUint8(0x30 + 0x36)).toBe(ContentType.Program);

		// Content record 1 (at offset 0x30 + 0x38 = 0x68)
		expect(view.getUint8(0x68 + 0x36)).toBe(ContentType.Control);

		// Total size = 0x20 (header) + 0x10 (ext header) + 2 * 0x38 (records) + 0x20 (digest)
		expect(cnmt.byteLength).toBe(0x20 + 0x10 + 2 * 0x38 + 0x20);
	});

	it('should store NCA size as 6-byte little-endian', () => {
		const fakeHash = new Uint8Array(32).fill(0xab);
		const fakeNcaId = fakeHash.subarray(0, 16);
		const size = 0x0102030405; // 5-byte value

		const cnmt = build({
			titleId: 0x0100000000001000n,
			contentRecords: [
				{
					hash: fakeHash,
					ncaId: fakeNcaId,
					size,
					type: ContentType.Program,
				},
			],
		});

		const view = new DataView(cnmt);
		const recordOffset = 0x30; // header + ext header

		// Read the 6-byte size at record + 0x30
		const low = view.getUint32(recordOffset + 0x30, true);
		const high = view.getUint16(recordOffset + 0x34, true);
		const reconstructed = low + high * 0x100000000;
		expect(reconstructed).toBe(size);
	});

	it('should end with a 0x20-byte zero digest', () => {
		const fakeHash = new Uint8Array(32).fill(0xff);
		const fakeNcaId = fakeHash.subarray(0, 16);

		const cnmt = build({
			titleId: 0x0100000000001000n,
			contentRecords: [
				{
					hash: fakeHash,
					ncaId: fakeNcaId,
					size: 100,
					type: ContentType.Program,
				},
			],
		});

		const bytes = new Uint8Array(cnmt);
		const digest = bytes.subarray(bytes.length - 0x20);
		expect(bytesToHex(digest)).toBe('00'.repeat(0x20));
	});
});
