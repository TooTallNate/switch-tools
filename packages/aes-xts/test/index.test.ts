import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../src/index.js';

// Test vectors generated using Node.js crypto with identical key/tweak settings
const TEST_KEY = hexToBytes(
	'00112233445566778899aabbccddeeffaabbccddeeff00112233445566778899'
);

const SECTOR_0_EXPECTED =
	'7575d42fde6b2f7190ff26861970b889b0f7d93951047e4913017c4a6dd4a1cc';

const SECTOR_1_EXPECTED =
	'd573fc38797f8affbe2bd3b104b0ef085667c568fed42c7773f8e936e780d1f5';

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function makeTestData(size: number): Uint8Array {
	const data = new Uint8Array(size);
	for (let i = 0; i < size; i++) data[i] = i & 0xff;
	return data;
}

describe('AES-128-XTS with Nintendo big-endian tweak', () => {
	describe('encrypt', () => {
		it('should encrypt a single sector (sector 0)', async () => {
			const plain = makeTestData(512);
			const ct = new Uint8Array(await encrypt(TEST_KEY, plain, 512, 0));
			expect(bytesToHex(ct.subarray(0, 32))).toBe(SECTOR_0_EXPECTED);
		});

		it('should encrypt with correct sector 1 tweak', async () => {
			const plain = makeTestData(512);
			const ct = new Uint8Array(await encrypt(TEST_KEY, plain, 512, 1));
			expect(bytesToHex(ct.subarray(0, 32))).toBe(SECTOR_1_EXPECTED);
		});

		it('should encrypt multiple sectors', async () => {
			const plain = makeTestData(1024);
			const ct = new Uint8Array(await encrypt(TEST_KEY, plain, 512, 0));
			// First 512 bytes = sector 0 ciphertext
			expect(bytesToHex(ct.subarray(0, 32))).toBe(SECTOR_0_EXPECTED);
			// Second 512 bytes = sector 1 ciphertext
			expect(bytesToHex(ct.subarray(512, 544))).toBe(SECTOR_1_EXPECTED);
		});
	});

	describe('decrypt', () => {
		it('should round-trip encrypt/decrypt', async () => {
			const plain = makeTestData(512);
			const ct = await encrypt(TEST_KEY, plain, 512, 0);
			const decrypted = new Uint8Array(
				await decrypt(TEST_KEY, ct, 512, 0)
			);
			expect(bytesToHex(decrypted)).toBe(bytesToHex(plain));
		});

		it('should round-trip multiple sectors', async () => {
			const plain = makeTestData(1024);
			const ct = await encrypt(TEST_KEY, plain, 512, 0);
			const decrypted = new Uint8Array(
				await decrypt(TEST_KEY, ct, 512, 0)
			);
			expect(bytesToHex(decrypted)).toBe(bytesToHex(plain));
		});

		it('should round-trip with non-zero start sector', async () => {
			const plain = makeTestData(512);
			const ct = await encrypt(TEST_KEY, plain, 512, 5);
			const decrypted = new Uint8Array(
				await decrypt(TEST_KEY, ct, 512, 5)
			);
			expect(bytesToHex(decrypted)).toBe(bytesToHex(plain));
		});
	});

	describe('NCA header size (0xC00 = 3072 bytes, sector size 0x200)', () => {
		it('should encrypt/decrypt NCA-header-sized data', async () => {
			const data = makeTestData(0xc00);
			const ct = await encrypt(TEST_KEY, data, 0x200, 0);
			const decrypted = new Uint8Array(
				await decrypt(TEST_KEY, ct, 0x200, 0)
			);
			expect(bytesToHex(decrypted)).toBe(bytesToHex(data));
		});
	});

	describe('validation', () => {
		it('should reject non-32-byte keys', async () => {
			const plain = makeTestData(512);
			await expect(
				encrypt(new Uint8Array(16), plain, 512)
			).rejects.toThrow('32 bytes');
		});

		it('should reject data not aligned to sector size', async () => {
			const plain = makeTestData(500);
			await expect(encrypt(TEST_KEY, plain, 512)).rejects.toThrow(
				'multiple of sector size'
			);
		});
	});
});
