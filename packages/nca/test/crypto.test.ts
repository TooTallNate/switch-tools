import { describe, it, expect } from 'vitest';
import {
	aesEcbEncrypt,
	aesEcbDecrypt,
	aesCtrEncrypt,
	sha256,
	buildNcaCtr,
	updateNcaCtr,
} from '../src/crypto.js';
import crypto from 'node:crypto';

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

describe('AES-128-ECB', () => {
	it('should encrypt and decrypt a single block', async () => {
		const key = new Uint8Array(16).fill(0x42);
		const plaintext = new Uint8Array(16);
		for (let i = 0; i < 16; i++) plaintext[i] = i;

		const ct = await aesEcbEncrypt(key, plaintext);
		expect(ct.length).toBe(16);
		expect(bytesToHex(ct)).not.toBe(bytesToHex(plaintext));

		const decrypted = await aesEcbDecrypt(key, ct);
		expect(bytesToHex(decrypted)).toBe(bytesToHex(plaintext));
	});

	it('should match Node.js crypto ECB encryption', async () => {
		const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
		const plain = Buffer.alloc(16);
		for (let i = 0; i < 16; i++) plain[i] = i;

		// Node.js reference
		const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
		cipher.setAutoPadding(false);
		const nodeResult = Buffer.concat([
			cipher.update(plain),
			cipher.final(),
		]);

		// Our implementation
		const ourResult = await aesEcbEncrypt(
			new Uint8Array(key),
			new Uint8Array(plain)
		);

		expect(bytesToHex(ourResult)).toBe(nodeResult.toString('hex'));
	});

	it('should encrypt multiple blocks', async () => {
		const key = new Uint8Array(16).fill(0x11);
		const data = new Uint8Array(64);
		for (let i = 0; i < 64; i++) data[i] = i;

		const ct = await aesEcbEncrypt(key, data);
		const decrypted = await aesEcbDecrypt(key, ct);
		expect(bytesToHex(decrypted)).toBe(bytesToHex(data));
	});
});

describe('AES-128-CTR', () => {
	it('should encrypt and decrypt (CTR is symmetric)', async () => {
		const key = new Uint8Array(16).fill(0x33);
		const counter = new Uint8Array(16);
		counter[15] = 1;
		const plain = new Uint8Array(48);
		for (let i = 0; i < 48; i++) plain[i] = i;

		const ct = await aesCtrEncrypt(key, plain, counter);
		expect(ct.length).toBe(48);

		const decrypted = await aesCtrEncrypt(key, ct, counter);
		expect(bytesToHex(decrypted)).toBe(bytesToHex(plain));
	});
});

describe('SHA-256', () => {
	it('should hash empty data', async () => {
		const hash = await sha256(new Uint8Array(0));
		expect(bytesToHex(hash)).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
	});

	it('should hash "hello"', async () => {
		const data = new TextEncoder().encode('hello');
		const hash = await sha256(data);
		expect(bytesToHex(hash)).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
		);
	});
});

describe('NCA CTR builder', () => {
	it('should build a correct initial CTR', () => {
		// Section CTR: [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]
		const sectionCtr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]);

		// Byte offset 0xC00 (NCA header size, first section start)
		const ctr = buildNcaCtr(sectionCtr, 0xc00);

		// High 8 bytes: reversed section_ctr
		expect(ctr[0]).toBe(0); // sectionCtr[7]
		expect(ctr[1]).toBe(0); // sectionCtr[6]
		expect(ctr[2]).toBe(0); // sectionCtr[5]
		expect(ctr[3]).toBe(0); // sectionCtr[4]
		expect(ctr[4]).toBe(1); // sectionCtr[3]
		expect(ctr[5]).toBe(0); // sectionCtr[2]
		expect(ctr[6]).toBe(0); // sectionCtr[1]
		expect(ctr[7]).toBe(0); // sectionCtr[0]

		// Low 8 bytes: 0xC00 >> 4 = 0xC0 = 192, big-endian
		expect(ctr[15]).toBe(0xc0);
		expect(ctr[14]).toBe(0);
	});

	it('should update CTR for new offset', () => {
		const ctr = new Uint8Array(16);
		ctr[0] = 0xaa; // High bytes should be preserved

		updateNcaCtr(ctr, 0x10000);
		// 0x10000 >> 4 = 0x1000 = 4096
		// Big-endian in low 8 bytes: byte[15]=0x00, byte[14]=0x10, byte[13]=0x00, ...
		expect(ctr[0]).toBe(0xaa); // preserved
		expect(ctr[14]).toBe(0x10);
		expect(ctr[15]).toBe(0x00);
	});
});
