import { describe, it, expect } from 'vitest';
import {
	buildPfs0,
	createPfs0HashTable,
	calculatePfs0MasterHash,
} from '../src/pfs0.js';

describe('PFS0 builder', () => {
	it('should build a valid PFS0 with magic header', () => {
		const result = buildPfs0([
			{ name: 'hello.txt', data: new TextEncoder().encode('hello') },
		]);

		const view = new DataView(result.buffer);
		expect(view.getUint32(0x00, true)).toBe(0x30534650); // "PFS0"
		expect(view.getUint32(0x04, true)).toBe(1); // 1 file
	});

	it('should align string table to 0x20 bytes', () => {
		const result = buildPfs0([{ name: 'a', data: new Uint8Array(1) }]);

		const view = new DataView(result.buffer);
		const stringTableSize = view.getUint32(0x08, true);
		expect(stringTableSize % 0x20).toBe(0);
	});

	it('should store file data correctly', () => {
		const data = new TextEncoder().encode('test data');
		const result = buildPfs0([{ name: 'test', data }]);

		const view = new DataView(result.buffer);
		const numFiles = view.getUint32(0x04, true);
		const stringTableSize = view.getUint32(0x08, true);
		const dataStart = 0x10 + numFiles * 0x18 + stringTableSize;

		const extracted = result.subarray(dataStart, dataStart + data.length);
		expect(new TextDecoder().decode(extracted)).toBe('test data');
	});

	it('should handle multiple files', () => {
		const result = buildPfs0([
			{ name: 'file1', data: new Uint8Array([1, 2, 3]) },
			{ name: 'file2', data: new Uint8Array([4, 5]) },
			{ name: 'file3', data: new Uint8Array([6]) },
		]);

		const view = new DataView(result.buffer);
		expect(view.getUint32(0x04, true)).toBe(3); // 3 files
	});
});

describe('PFS0 hash table', () => {
	it('should create a hash table with correct number of hashes', async () => {
		const data = new Uint8Array(0x20000); // 128KB
		for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

		const { hashTable, hashTableSize, pfs0Offset } =
			await createPfs0HashTable(data, 0x10000); // 64KB blocks

		// 128KB / 64KB = 2 blocks = 2 hashes = 64 bytes
		expect(hashTableSize).toBe(64);
		// pfs0Offset should be padded to 0x200
		expect(pfs0Offset % 0x200).toBe(0);
		expect(pfs0Offset).toBeGreaterThanOrEqual(hashTableSize);
	});

	it('should calculate a deterministic master hash', async () => {
		const data = new Uint8Array(0x1000);
		for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

		const { hashTable, hashTableSize } = await createPfs0HashTable(
			data,
			0x1000
		);

		const masterHash1 = await calculatePfs0MasterHash(
			hashTable,
			hashTableSize
		);
		const masterHash2 = await calculatePfs0MasterHash(
			hashTable,
			hashTableSize
		);

		expect(
			Array.from(masterHash1)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
		).toBe(
			Array.from(masterHash2)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
		);
	});
});
