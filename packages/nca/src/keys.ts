/**
 * Key file parser and key derivation for Nintendo Switch NCA.
 *
 * Parses "prod.keys" format files (key = hex_value) and derives
 * encryption keys using the Nintendo key derivation chain.
 *
 * Reference: hacbrewpack/extkeys.c, hacbrewpack/pki.c
 */

import { aesEcbEncrypt, aesEcbDecrypt } from './crypto.js';

const MAX_KEYGENS = 0x20;

/**
 * Parsed keyset containing all keys needed for NCA operations.
 */
export interface KeySet {
	/** 32-byte header key for AES-XTS NCA header encryption */
	headerKey: Uint8Array;
	/** Key area encryption keys [keygeneration][type: 0=application, 1=ocean, 2=system] */
	keyAreaKeys: Uint8Array[][];
}

/**
 * Full keyset with all intermediate keys for derivation.
 */
interface FullKeySet {
	secureBootKey: Uint8Array;
	tsecKey: Uint8Array;
	tsecRootKek: Uint8Array;
	tsecAuthSignatures: Uint8Array[];
	tsecRootKeys: Uint8Array[];
	keyblobKeySources: Uint8Array[];
	keyblobKeys: Uint8Array[];
	keyblobMacKeySources: Uint8Array;
	keyblobMacKeys: Uint8Array[];
	encryptedKeyblobs: Uint8Array[];
	keyblobs: Uint8Array[];
	masterKekSources: Uint8Array[];
	masterKeks: Uint8Array[];
	masterKeySource: Uint8Array;
	masterKeys: Uint8Array[];
	keyAreaKeyApplicationSource: Uint8Array;
	keyAreaKeyOceanSource: Uint8Array;
	keyAreaKeySystemSource: Uint8Array;
	aesKekGenerationSource: Uint8Array;
	aesKeyGenerationSource: Uint8Array;
	titlekekSource: Uint8Array;
	headerKekSource: Uint8Array;
	headerKeySource: Uint8Array;
	headerKey: Uint8Array;
	keyAreaKeys: Uint8Array[][];
	package1Kek: Uint8Array;
	package1MacKek: Uint8Array;
	package1MacKeys: Uint8Array[];
	package1Keys: Uint8Array[];
	package2KeySource: Uint8Array;
	package2Keys: Uint8Array[];
	titlekeks: Uint8Array[];
	sdCardKekSource: Uint8Array;
	sdCardKeySources: Uint8Array[];
	sdCardKeys: Uint8Array[];
}

function isZero(data: Uint8Array): boolean {
	for (let i = 0; i < data.length; i++) {
		if (data[i] !== 0) return false;
	}
	return true;
}

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

/**
 * Parse a key file in "key = hex_value" format (e.g., prod.keys).
 */
export function parseKeyFile(content: string): Map<string, string> {
	const keys = new Map<string, string>();

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
			continue;
		}

		// Split on '=' or ','
		const sepIdx = trimmed.indexOf('=');
		if (sepIdx === -1) continue;

		const key = trimmed.substring(0, sepIdx).trim().toLowerCase();
		const value = trimmed
			.substring(sepIdx + 1)
			.trim()
			.toLowerCase();

		if (key && value) {
			keys.set(key, value);
		}
	}

	return keys;
}

/**
 * Load a keyset from a parsed key file map.
 */
function loadKeySet(keys: Map<string, string>): FullKeySet {
	const get = (name: string, size: number): Uint8Array => {
		const hex = keys.get(name);
		if (hex) return hexToBytes(hex);
		return new Uint8Array(size);
	};

	const getIndexed = (
		baseName: string,
		count: number,
		size: number
	): Uint8Array[] => {
		const result: Uint8Array[] = [];
		for (let i = 0; i < count; i++) {
			const hex = i.toString(16).padStart(2, '0');
			result.push(get(`${baseName}_${hex}`, size));
		}
		return result;
	};

	return {
		secureBootKey: get('secure_boot_key', 0x10),
		tsecKey: get('tsec_key', 0x10),
		tsecRootKek: get('tsec_root_kek', 0x10),
		tsecAuthSignatures: getIndexed(
			'tsec_auth_signature',
			MAX_KEYGENS,
			0x10
		),
		tsecRootKeys: new Array(MAX_KEYGENS)
			.fill(null)
			.map(() => new Uint8Array(0x10)),
		keyblobKeySources: getIndexed('keyblob_key_source', 0x6, 0x10),
		keyblobKeys: getIndexed('keyblob_key', MAX_KEYGENS, 0x10),
		keyblobMacKeySources: get('keyblob_mac_key_source', 0x10),
		keyblobMacKeys: getIndexed('keyblob_mac_key', MAX_KEYGENS, 0x10),
		encryptedKeyblobs: getIndexed('encrypted_keyblob', 0x6, 0xb0),
		keyblobs: getIndexed('keyblob', 0x6, 0x90),
		masterKekSources: getIndexed('master_kek_source', MAX_KEYGENS, 0x10),
		masterKeks: getIndexed('master_kek', MAX_KEYGENS, 0x10),
		masterKeySource: get('master_key_source', 0x10),
		masterKeys: getIndexed('master_key', MAX_KEYGENS, 0x10),
		keyAreaKeyApplicationSource: get(
			'key_area_key_application_source',
			0x10
		),
		keyAreaKeyOceanSource: get('key_area_key_ocean_source', 0x10),
		keyAreaKeySystemSource: get('key_area_key_system_source', 0x10),
		aesKekGenerationSource: get('aes_kek_generation_source', 0x10),
		aesKeyGenerationSource: get('aes_key_generation_source', 0x10),
		titlekekSource: get('titlekek_source', 0x10),
		headerKekSource: get('header_kek_source', 0x10),
		headerKeySource: get('header_key_source', 0x20),
		headerKey: get('header_key', 0x20),
		keyAreaKeys: (() => {
			const result: Uint8Array[][] = [];
			for (let i = 0; i < MAX_KEYGENS; i++) {
				const hex = i.toString(16).padStart(2, '0');
				result.push([
					get(`key_area_key_application_${hex}`, 0x10),
					get(`key_area_key_ocean_${hex}`, 0x10),
					get(`key_area_key_system_${hex}`, 0x10),
				]);
			}
			return result;
		})(),
		package1Kek: get('package1_key_kek', 0x10),
		package1MacKek: get('package1_mac_kek', 0x10),
		package1MacKeys: getIndexed('package1_mac_key', MAX_KEYGENS, 0x10),
		package1Keys: getIndexed('package1_key', MAX_KEYGENS, 0x10),
		package2KeySource: get('package2_key_source', 0x10),
		package2Keys: getIndexed('package2_key', MAX_KEYGENS, 0x10),
		titlekeks: getIndexed('titlekek', MAX_KEYGENS, 0x10),
		sdCardKekSource: get('sd_card_kek_source', 0x10),
		sdCardKeySources: (() => {
			const result: Uint8Array[] = [];
			result.push(get('sd_card_nca_key_source', 0x20));
			result.push(get('sd_card_save_key_source', 0x20));
			return result;
		})(),
		sdCardKeys: [new Uint8Array(0x20), new Uint8Array(0x20)],
	};
}

/**
 * Generate a Key Encryption Key (KEK).
 * Matches hacbrewpack/pki.c generate_kek().
 */
async function generateKek(
	src: Uint8Array,
	masterKey: Uint8Array,
	kekSeed: Uint8Array,
	keySeed: Uint8Array | null,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const kek = await aesEcbDecrypt(masterKey, kekSeed, crypto);
	const srcKek = await aesEcbDecrypt(kek, src, crypto);
	if (keySeed) {
		return aesEcbDecrypt(srcKek, keySeed, crypto);
	}
	return srcKek;
}

/**
 * Derive keys from a full keyset (replicates pki_derive_keys).
 */
async function deriveKeys(
	ks: FullKeySet,
	crypto: Crypto = globalThis.crypto
): Promise<void> {
	// Derive keyblob keys (for firmware < 6.2.0)
	for (let i = 0; i < 6; i++) {
		if (isZero(ks.secureBootKey) || isZero(ks.tsecKey)) continue;
		if (isZero(ks.keyblobKeySources[i])) continue;

		let tmp = await aesEcbDecrypt(
			ks.tsecKey,
			ks.keyblobKeySources[i],
			crypto
		);
		tmp = await aesEcbDecrypt(ks.secureBootKey, tmp, crypto);
		ks.keyblobKeys[i].set(tmp);

		if (isZero(ks.keyblobMacKeySources)) continue;
		const macKey = await aesEcbDecrypt(
			ks.keyblobKeys[i],
			ks.keyblobMacKeySources,
			crypto
		);
		ks.keyblobMacKeys[i].set(macKey);
	}

	// Decrypt keyblobs
	for (let i = 0; i < 6; i++) {
		if (isZero(ks.keyblobKeys[i]) || isZero(ks.keyblobMacKeys[i])) continue;
		if (isZero(ks.encryptedKeyblobs[i])) continue;

		// Skip CMAC verification for simplicity — just decrypt
		// (hacbrewpack verifies but continues on failure)

		// AES-CTR decrypt the keyblob
		const { aesCtrEncrypt } = await import('./crypto.js');
		const iv = ks.encryptedKeyblobs[i].slice(0x10, 0x20);
		const decrypted = await aesCtrEncrypt(
			ks.keyblobKeys[i],
			ks.encryptedKeyblobs[i].subarray(0x20),
			iv,
			crypto
		);
		ks.keyblobs[i].set(decrypted.subarray(0, 0x90));
	}

	// Extract package1 keys and master KEKs from keyblobs
	for (let i = 0; i < 6; i++) {
		if (!isZero(ks.keyblobs[i].subarray(0x80, 0x90))) {
			ks.package1Keys[i].set(ks.keyblobs[i].subarray(0x80, 0x90));
		}
		if (!isZero(ks.keyblobs[i].subarray(0, 0x10))) {
			ks.masterKeks[i].set(ks.keyblobs[i].subarray(0, 0x10));
		}
	}

	// Derive 6.2.0+ keys
	for (let i = 6; i < MAX_KEYGENS; i++) {
		if (isZero(ks.tsecAuthSignatures[i - 6])) continue;

		if (!isZero(ks.tsecRootKek)) {
			const rootKey = await aesEcbEncrypt(
				ks.tsecRootKek,
				ks.tsecAuthSignatures[i - 6],
				crypto
			);
			ks.tsecRootKeys[i - 6].set(rootKey);
		}
	}

	for (let i = 6; i < MAX_KEYGENS; i++) {
		if (isZero(ks.tsecRootKeys[i - 6])) continue;
		if (isZero(ks.masterKekSources[i])) continue;

		const masterKek = await aesEcbDecrypt(
			ks.tsecRootKeys[i - 6],
			ks.masterKekSources[i],
			crypto
		);
		ks.masterKeks[i].set(masterKek);
	}

	// Derive master keys
	for (let i = 0; i < MAX_KEYGENS; i++) {
		if (isZero(ks.masterKeySource) || isZero(ks.masterKeks[i])) continue;

		const masterKey = await aesEcbDecrypt(
			ks.masterKeks[i],
			ks.masterKeySource,
			crypto
		);
		ks.masterKeys[i].set(masterKey);
	}

	// Derive key area keys, titlekeks, header key from master keys
	for (let i = 0; i < MAX_KEYGENS; i++) {
		if (isZero(ks.masterKeys[i])) continue;

		// Key Area Encryption Keys
		if (!isZero(ks.keyAreaKeyApplicationSource)) {
			const kak = await generateKek(
				ks.keyAreaKeyApplicationSource,
				ks.masterKeys[i],
				ks.aesKekGenerationSource,
				ks.aesKeyGenerationSource,
				crypto
			);
			ks.keyAreaKeys[i][0].set(kak);
		}
		if (!isZero(ks.keyAreaKeyOceanSource)) {
			const kak = await generateKek(
				ks.keyAreaKeyOceanSource,
				ks.masterKeys[i],
				ks.aesKekGenerationSource,
				ks.aesKeyGenerationSource,
				crypto
			);
			ks.keyAreaKeys[i][1].set(kak);
		}
		if (!isZero(ks.keyAreaKeySystemSource)) {
			const kak = await generateKek(
				ks.keyAreaKeySystemSource,
				ks.masterKeys[i],
				ks.aesKekGenerationSource,
				ks.aesKeyGenerationSource,
				crypto
			);
			ks.keyAreaKeys[i][2].set(kak);
		}

		// Titlekek
		if (!isZero(ks.titlekekSource)) {
			const tk = await aesEcbDecrypt(
				ks.masterKeys[i],
				ks.titlekekSource,
				crypto
			);
			ks.titlekeks[i].set(tk);
		}

		// Package2 key
		if (!isZero(ks.package2KeySource)) {
			const pk2 = await aesEcbDecrypt(
				ks.masterKeys[i],
				ks.package2KeySource,
				crypto
			);
			ks.package2Keys[i].set(pk2);
		}

		// Header key (only from master key 0)
		if (
			i === 0 &&
			!isZero(ks.headerKekSource) &&
			!isZero(ks.headerKeySource)
		) {
			const headerKek = await generateKek(
				ks.headerKekSource,
				ks.masterKeys[i],
				ks.aesKekGenerationSource,
				ks.aesKeyGenerationSource,
				crypto
			);
			const hk = await aesEcbDecrypt(
				headerKek,
				ks.headerKeySource,
				crypto
			);
			ks.headerKey.set(hk);
		}
	}
}

/**
 * Initialize and derive a keyset from a key file string.
 *
 * @param keyFileContent - Contents of a prod.keys file
 * @param crypto - Optional Crypto implementation
 * @returns KeySet with header_key and key_area_keys derived
 */
export async function initializeKeySet(
	keyFileContent: string,
	crypto: Crypto = globalThis.crypto
): Promise<KeySet> {
	const keyMap = parseKeyFile(keyFileContent);
	const fullKs = loadKeySet(keyMap);

	// Derive all keys
	await deriveKeys(fullKs, crypto);

	return {
		headerKey: fullKs.headerKey,
		keyAreaKeys: fullKs.keyAreaKeys,
	};
}
