/**
 * AES-128-XTS encryption/decryption using Web Crypto.
 *
 * Supports Nintendo's big-endian tweak format, where the sector number
 * is stored as a big-endian 128-bit value (opposite of the IEEE P1619
 * standard which uses little-endian).
 *
 * Implementation uses Web Crypto's AES-CBC with a zero IV to perform
 * single-block AES-ECB operations, then builds the XTS mode on top.
 */

const BLOCK_SIZE = 16;
const ZERO_IV = new Uint8Array(BLOCK_SIZE);

/**
 * Import a raw AES-128 key for use with AES-CBC (used to emulate ECB).
 */
async function importKey(
	rawKey: ArrayBuffer | Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, [
		'encrypt',
		'decrypt',
	]);
}

/**
 * Encrypt a single 16-byte block using AES-ECB (emulated via AES-CBC with zero IV).
 * AES-CBC with a zero IV and a single block is equivalent to AES-ECB for that block.
 * Web Crypto's AES-CBC adds PKCS7 padding, so the output is 32 bytes — we take only the first 16.
 */
async function ecbEncryptBlock(
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
 * Decrypt a single 16-byte block using AES-ECB (emulated via AES-CBC with zero IV).
 *
 * Strategy: Construct a 2-block CBC ciphertext [C0, C1] such that when decrypted
 * with IV=0, the first plaintext block P0 = AES-ECB-Decrypt(C0) and the second
 * block P1 has valid PKCS7 padding (16 bytes of 0x10).
 *
 * In CBC decrypt: P0 = AES-Decrypt(C0) XOR IV = AES-Decrypt(C0) (since IV=0)
 *                 P1 = AES-Decrypt(C1) XOR C0
 *
 * For P1 to be valid PKCS7 padding: we need AES-Decrypt(C1) = padding XOR C0
 * So C1 = AES-Encrypt(padding XOR C0) = AES-Encrypt(padding XOR block)
 */
async function ecbDecryptBlock(
	key: CryptoKey,
	block: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	// PKCS7 padding for a full block: 16 bytes of 0x10
	const padding = new Uint8Array(BLOCK_SIZE);
	padding.fill(0x10);

	// XOR padding with the ciphertext block (C0)
	const paddingXorBlock = new Uint8Array(BLOCK_SIZE);
	for (let i = 0; i < BLOCK_SIZE; i++) {
		paddingXorBlock[i] = padding[i] ^ block[i];
	}

	// C1 = AES-ECB-Encrypt(padding XOR block)
	const c1 = await ecbEncryptBlock(key, paddingXorBlock, crypto);

	// Construct [C0=block, C1] and CBC-decrypt with IV=0
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
 * Multiply a value in GF(2^128) by the primitive element alpha (x).
 * This is the standard XTS doubling operation.
 *
 * The multiplication is performed on the 16-byte value interpreted as a
 * little-endian polynomial in GF(2^128) with the irreducible polynomial
 * x^128 + x^7 + x^2 + x + 1 (0x87 reduction).
 *
 * Operates in-place on the provided buffer.
 */
function gf128Mul(block: Uint8Array): void {
	let carry = 0;
	for (let i = 0; i < BLOCK_SIZE; i++) {
		const nextCarry = (block[i] >> 7) & 1;
		block[i] = ((block[i] << 1) | carry) & 0xff;
		carry = nextCarry;
	}
	// If there was a carry out, XOR with the reduction polynomial
	if (carry) {
		block[0] ^= 0x87;
	}
}

/**
 * XOR two 16-byte blocks, storing the result in `dst`.
 */
function xorBlocks(dst: Uint8Array, a: Uint8Array, b: Uint8Array): void {
	for (let i = 0; i < BLOCK_SIZE; i++) {
		dst[i] = a[i] ^ b[i];
	}
}

/**
 * Generate the Nintendo big-endian tweak value for a given sector number.
 *
 * Nintendo stores the sector number as a big-endian 128-bit value,
 * which is the opposite of the IEEE P1619 standard (little-endian).
 *
 * This matches the C implementation:
 * ```c
 * static void get_tweak(unsigned char *tweak, size_t sector) {
 *     for (int i = 0xF; i >= 0; i--) {
 *         tweak[i] = (unsigned char)(sector & 0xFF);
 *         sector >>= 8;
 *     }
 * }
 * ```
 */
function getNintendoTweak(sector: number): Uint8Array {
	const tweak = new Uint8Array(BLOCK_SIZE);
	let s = sector;
	for (let i = 0xf; i >= 0; i--) {
		tweak[i] = s & 0xff;
		s = Math.floor(s / 256); // Avoid issues with bitwise ops on large numbers
	}
	return tweak;
}

/**
 * Encrypt data using AES-128-XTS with Nintendo's big-endian tweak.
 *
 * @param key - 32-byte key (first 16 bytes = data key K1, last 16 bytes = tweak key K2)
 * @param data - Data to encrypt (must be a multiple of `sectorSize`)
 * @param sectorSize - Size of each sector in bytes (typically 0x200 for NCA headers)
 * @param startSector - Starting sector number (default: 0)
 * @param crypto - Optional Crypto implementation (defaults to globalThis.crypto)
 * @returns Encrypted data
 */
export async function encrypt(
	key: ArrayBuffer | Uint8Array,
	data: ArrayBuffer | Uint8Array,
	sectorSize: number,
	startSector = 0,
	crypto: Crypto = globalThis.crypto
): Promise<ArrayBuffer> {
	const keyBytes = new Uint8Array(key);
	if (keyBytes.length !== 32) {
		throw new Error(`AES-XTS key must be 32 bytes, got ${keyBytes.length}`);
	}

	const dataBytes = new Uint8Array(data);
	if (dataBytes.length % sectorSize !== 0) {
		throw new Error('Data length must be a multiple of sector size');
	}
	if (sectorSize % BLOCK_SIZE !== 0) {
		throw new Error('Sector size must be a multiple of 16');
	}

	const k1 = await importKey(keyBytes.subarray(0, 16), crypto);
	const k2 = await importKey(keyBytes.subarray(16, 32), crypto);

	const output = new Uint8Array(dataBytes.length);
	const blocksPerSector = sectorSize / BLOCK_SIZE;
	const tempBlock = new Uint8Array(BLOCK_SIZE);

	for (
		let sectorOffset = 0;
		sectorOffset < dataBytes.length;
		sectorOffset += sectorSize
	) {
		const sector = startSector + sectorOffset / sectorSize;

		// Compute the initial tweak: T = AES-ECB-Encrypt(K2, tweak_value)
		const tweakValue = getNintendoTweak(sector);
		const T = await ecbEncryptBlock(k2, tweakValue, crypto);

		for (let j = 0; j < blocksPerSector; j++) {
			const blockOffset = sectorOffset + j * BLOCK_SIZE;
			const plainBlock = dataBytes.subarray(
				blockOffset,
				blockOffset + BLOCK_SIZE
			);

			// PP = P XOR T
			xorBlocks(tempBlock, plainBlock, T);

			// CC = AES-ECB-Encrypt(K1, PP)
			const encrypted = await ecbEncryptBlock(k1, tempBlock, crypto);

			// C = CC XOR T
			xorBlocks(
				output.subarray(blockOffset, blockOffset + BLOCK_SIZE),
				encrypted,
				T
			);

			// T = T * alpha in GF(2^128)
			gf128Mul(T);
		}
	}

	return output.buffer;
}

/**
 * Decrypt data using AES-128-XTS with Nintendo's big-endian tweak.
 *
 * @param key - 32-byte key (first 16 bytes = data key K1, last 16 bytes = tweak key K2)
 * @param data - Data to decrypt (must be a multiple of `sectorSize`)
 * @param sectorSize - Size of each sector in bytes (typically 0x200 for NCA headers)
 * @param startSector - Starting sector number (default: 0)
 * @param crypto - Optional Crypto implementation (defaults to globalThis.crypto)
 * @returns Decrypted data
 */
export async function decrypt(
	key: ArrayBuffer | Uint8Array,
	data: ArrayBuffer | Uint8Array,
	sectorSize: number,
	startSector = 0,
	crypto: Crypto = globalThis.crypto
): Promise<ArrayBuffer> {
	const keyBytes = new Uint8Array(key);
	if (keyBytes.length !== 32) {
		throw new Error(`AES-XTS key must be 32 bytes, got ${keyBytes.length}`);
	}

	const dataBytes = new Uint8Array(data);
	if (dataBytes.length % sectorSize !== 0) {
		throw new Error('Data length must be a multiple of sector size');
	}
	if (sectorSize % BLOCK_SIZE !== 0) {
		throw new Error('Sector size must be a multiple of 16');
	}

	const k1 = await importKey(keyBytes.subarray(0, 16), crypto);
	const k2 = await importKey(keyBytes.subarray(16, 32), crypto);

	const output = new Uint8Array(dataBytes.length);
	const blocksPerSector = sectorSize / BLOCK_SIZE;
	const tempBlock = new Uint8Array(BLOCK_SIZE);

	for (
		let sectorOffset = 0;
		sectorOffset < dataBytes.length;
		sectorOffset += sectorSize
	) {
		const sector = startSector + sectorOffset / sectorSize;

		// Compute the initial tweak: T = AES-ECB-Encrypt(K2, tweak_value)
		const tweakValue = getNintendoTweak(sector);
		const T = await ecbEncryptBlock(k2, tweakValue, crypto);

		for (let j = 0; j < blocksPerSector; j++) {
			const blockOffset = sectorOffset + j * BLOCK_SIZE;
			const cipherBlock = dataBytes.subarray(
				blockOffset,
				blockOffset + BLOCK_SIZE
			);

			// CC = C XOR T
			xorBlocks(tempBlock, cipherBlock, T);

			// PP = AES-ECB-Decrypt(K1, CC)
			const decrypted = await ecbDecryptBlock(k1, tempBlock, crypto);

			// P = PP XOR T
			xorBlocks(
				output.subarray(blockOffset, blockOffset + BLOCK_SIZE),
				decrypted,
				T
			);

			// T = T * alpha in GF(2^128)
			gf128Mul(T);
		}
	}

	return output.buffer;
}
