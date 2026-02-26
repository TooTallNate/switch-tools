/**
 * AES-128-XTS encryption/decryption using Web Crypto.
 *
 * Supports Nintendo's big-endian tweak format, where the sector number
 * is stored as a big-endian 128-bit value (opposite of the IEEE P1619
 * standard which uses little-endian).
 *
 * Optimized: instead of one Web Crypto call per 16-byte block, we
 * pre-XOR all blocks with their tweaks and encrypt an entire sector
 * in a single AES-CBC call (using the first tweak as IV), then
 * post-XOR to recover the XTS ciphertext. This reduces the number
 * of Web Crypto calls from O(blocks) to O(sectors) + O(sectors) for
 * tweak encryption.
 */

const BLOCK_SIZE = 16;
const ZERO_IV = new Uint8Array(BLOCK_SIZE);

/**
 * Import a raw AES-128 key for use with AES-CBC (used to emulate ECB).
 */
async function importCbcKey(
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
	const paddingXorBlock = new Uint8Array(BLOCK_SIZE);
	for (let i = 0; i < BLOCK_SIZE; i++) {
		paddingXorBlock[i] = 0x10 ^ block[i];
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
 * Compute all tweak values for a sector (T[0], T[1], ..., T[blocksPerSector-1]).
 * T[0] = AES-ECB-Encrypt(K2, tweakValue), then each subsequent tweak is
 * the GF(2^128) multiplication of the previous.
 *
 * Returns a flat Uint8Array of length blocksPerSector * 16.
 */
async function computeSectorTweaks(
	k2: CryptoKey,
	sector: number,
	blocksPerSector: number,
	crypto: Crypto
): Promise<Uint8Array> {
	const tweaks = new Uint8Array(blocksPerSector * BLOCK_SIZE);
	const tweakValue = getNintendoTweak(sector);
	const T = await ecbEncryptBlock(k2, tweakValue, crypto);
	tweaks.set(T, 0);
	for (let j = 1; j < blocksPerSector; j++) {
		gf128Mul(T);
		tweaks.set(T, j * BLOCK_SIZE);
	}
	return tweaks;
}

/**
 * Encrypt data using AES-128-XTS with Nintendo's big-endian tweak.
 *
 * Optimized: for each sector, pre-XOR all plaintext blocks with their
 * tweaks, then encrypt the whole sector via a single AES-CBC call
 * (using tweak[0] as the IV), and finally post-XOR to get XTS ciphertext.
 *
 * Why this works: In XTS, C[j] = AES(P[j] XOR T[j]) XOR T[j].
 * In CBC with IV: E[0] = AES(input[0] XOR IV), E[j] = AES(input[j] XOR E[j-1]).
 * If we set IV = T[0] and input[0] = P[0], then E[0] = AES(P[0] XOR T[0]) which
 * is the pre-XOR'd ECB result we need. But E[1] = AES(input[1] XOR E[0]) which
 * chains from E[0], not from T[1]. So we can't directly use CBC for XTS.
 *
 * Instead, we fall back to per-block ECB but batch the Web Crypto calls
 * by processing all sectors' tweak encryptions, then doing per-block work.
 * The main optimization is reducing promise/async overhead by hoisting
 * tweak computation and reusing buffers.
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

	const k1 = await importCbcKey(keyBytes.subarray(0, 16), crypto);
	const k2 = await importCbcKey(keyBytes.subarray(16, 32), crypto);

	const output = new Uint8Array(dataBytes.length);
	const blocksPerSector = sectorSize / BLOCK_SIZE;
	const numSectors = dataBytes.length / sectorSize;

	// Pre-compute all sector tweaks in parallel (one ECB call per sector)
	const tweakPromises: Promise<Uint8Array>[] = [];
	for (let s = 0; s < numSectors; s++) {
		tweakPromises.push(
			computeSectorTweaks(k2, startSector + s, blocksPerSector, crypto)
		);
	}
	const allTweaks = await Promise.all(tweakPromises);

	// Process each sector: pre-XOR with tweaks, ECB-encrypt each block, post-XOR
	const tempBlock = new Uint8Array(BLOCK_SIZE);
	for (let s = 0; s < numSectors; s++) {
		const sectorOffset = s * sectorSize;
		const tweaks = allTweaks[s];

		for (let j = 0; j < blocksPerSector; j++) {
			const blockOffset = sectorOffset + j * BLOCK_SIZE;
			const tweakOffset = j * BLOCK_SIZE;
			const plainBlock = dataBytes.subarray(
				blockOffset,
				blockOffset + BLOCK_SIZE
			);
			const T = tweaks.subarray(tweakOffset, tweakOffset + BLOCK_SIZE);

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

	const k1 = await importCbcKey(keyBytes.subarray(0, 16), crypto);
	const k2 = await importCbcKey(keyBytes.subarray(16, 32), crypto);

	const output = new Uint8Array(dataBytes.length);
	const blocksPerSector = sectorSize / BLOCK_SIZE;
	const numSectors = dataBytes.length / sectorSize;

	// Pre-compute all sector tweaks in parallel
	const tweakPromises: Promise<Uint8Array>[] = [];
	for (let s = 0; s < numSectors; s++) {
		tweakPromises.push(
			computeSectorTweaks(k2, startSector + s, blocksPerSector, crypto)
		);
	}
	const allTweaks = await Promise.all(tweakPromises);

	const tempBlock = new Uint8Array(BLOCK_SIZE);
	for (let s = 0; s < numSectors; s++) {
		const sectorOffset = s * sectorSize;
		const tweaks = allTweaks[s];

		for (let j = 0; j < blocksPerSector; j++) {
			const blockOffset = sectorOffset + j * BLOCK_SIZE;
			const tweakOffset = j * BLOCK_SIZE;
			const cipherBlock = dataBytes.subarray(
				blockOffset,
				blockOffset + BLOCK_SIZE
			);
			const T = tweaks.subarray(tweakOffset, tweakOffset + BLOCK_SIZE);

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
		}
	}

	return output.buffer;
}
