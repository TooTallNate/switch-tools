/**
 * Cryptographic utilities for NCA construction using Web Crypto.
 *
 * Provides AES-128-ECB (emulated via AES-CBC), AES-128-CTR, and SHA-256.
 */

const BLOCK_SIZE = 16;
const ZERO_IV = new Uint8Array(BLOCK_SIZE);

/**
 * Import a raw AES key for AES-CBC usage (to emulate ECB or for direct CBC).
 */
export async function importAesCbcKey(
	rawKey: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, [
		'encrypt',
		'decrypt',
	]);
}

/**
 * Import a raw AES key for AES-CTR usage.
 */
export async function importAesCtrKey(
	rawKey: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', rawKey, { name: 'AES-CTR' }, false, [
		'encrypt',
	]);
}

/**
 * Encrypt a single 16-byte block using AES-ECB (emulated via AES-CBC with zero IV).
 */
export async function aesEcbEncryptBlock(
	key: CryptoKey,
	block: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const result = await crypto.subtle.encrypt(
		{ name: 'AES-CBC', iv: ZERO_IV },
		key,
		block
	);
	return new Uint8Array(result, 0, BLOCK_SIZE);
}

/**
 * Decrypt a single 16-byte block using AES-ECB (emulated via AES-CBC).
 */
export async function aesEcbDecryptBlock(
	key: CryptoKey,
	block: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	// XOR PKCS7 padding (0x10 for a full block) with the ciphertext block
	const paddingXorBlock = new Uint8Array(BLOCK_SIZE);
	for (let i = 0; i < BLOCK_SIZE; i++) {
		paddingXorBlock[i] = 0x10 ^ block[i];
	}

	const c1 = await aesEcbEncryptBlock(key, paddingXorBlock, crypto);

	const cbcCiphertext = new Uint8Array(BLOCK_SIZE * 2);
	cbcCiphertext.set(block, 0);
	cbcCiphertext.set(c1, BLOCK_SIZE);

	const result = await crypto.subtle.decrypt(
		{ name: 'AES-CBC', iv: ZERO_IV },
		key,
		cbcCiphertext
	);
	return new Uint8Array(result, 0, BLOCK_SIZE);
}

/**
 * AES-128-ECB encrypt multiple 16-byte blocks.
 */
export async function aesEcbEncrypt(
	rawKey: Uint8Array,
	data: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const key = await importAesCbcKey(rawKey, crypto);
	const output = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += BLOCK_SIZE) {
		const block = data.subarray(i, i + BLOCK_SIZE);
		const encrypted = await aesEcbEncryptBlock(key, block, crypto);
		output.set(encrypted, i);
	}
	return output;
}

/**
 * AES-128-ECB decrypt multiple 16-byte blocks.
 * In hacbrewpack, ECB decrypt is used extensively for key derivation.
 */
export async function aesEcbDecrypt(
	rawKey: Uint8Array,
	data: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const key = await importAesCbcKey(rawKey, crypto);
	const output = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += BLOCK_SIZE) {
		const block = data.subarray(i, i + BLOCK_SIZE);
		const decrypted = await aesEcbDecryptBlock(key, block, crypto);
		output.set(decrypted, i);
	}
	return output;
}

/**
 * AES-128-CTR encrypt (or decrypt, since CTR is symmetric).
 */
export async function aesCtrEncrypt(
	rawKey: Uint8Array,
	data: Uint8Array,
	counter: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const key = await importAesCtrKey(rawKey, crypto);
	const result = await crypto.subtle.encrypt(
		{
			name: 'AES-CTR',
			counter: counter,
			length: 128, // Counter occupies all 128 bits
		},
		key,
		data
	);
	return new Uint8Array(result);
}

/**
 * Build the AES-CTR initial counter for an NCA section.
 *
 * High 8 bytes: reversed section_ctr from the FS header
 * Low 8 bytes: byte_offset >> 4, big-endian
 */
export function buildNcaCtr(
	sectionCtr: Uint8Array,
	byteOffset: number
): Uint8Array {
	const ctr = new Uint8Array(16);
	let ctrOfs = Math.floor(byteOffset / 16);

	for (let j = 0; j < 8; j++) {
		ctr[j] = sectionCtr[7 - j];
		ctr[15 - j] = ctrOfs & 0xff;
		ctrOfs = Math.floor(ctrOfs / 256);
	}

	return ctr;
}

/**
 * Update the low 8 bytes of an NCA CTR for a new offset.
 */
export function updateNcaCtr(ctr: Uint8Array, byteOffset: number): void {
	let ofs = Math.floor(byteOffset / 16);
	for (let j = 0; j < 8; j++) {
		ctr[15 - j] = ofs & 0xff;
		ofs = Math.floor(ofs / 256);
	}
}

/**
 * SHA-256 hash.
 */
export async function sha256(
	data: Uint8Array | ArrayBuffer,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const hash = await crypto.subtle.digest('SHA-256', data);
	return new Uint8Array(hash);
}
