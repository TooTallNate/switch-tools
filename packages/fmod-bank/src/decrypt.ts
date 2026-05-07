/**
 * FMOD Studio bank XOR decryption.
 *
 * For each byte X in the encrypted region, the decrypted byte is:
 *
 *     reverseBitsInByte(X) ^ key[i % keyLen]
 *
 * where `reverseBitsInByte` swaps the high and low nibbles AND
 * reverses bit order *within* each nibble — equivalently: reverse
 * all 8 bits (bit 7 ↔ bit 0, bit 6 ↔ bit 1, …). This matches the
 * FMODBankDecryptor reference implementation:
 *
 *     reversed = fourbitreverse[X >> 4] | (fourbitreverse[X & 0xF] << 4)
 *
 * — and is exactly the same as `((b * 0x0202020202n & 0x010884422010n) % 1023)`.
 *
 * The encryption key is rotated, but Wwise/FMOD's `studio_loadbank`
 * docs note the key only "begins rotating" after any leading NUL
 * padding inside the SND chunk — so callers must skip past that
 * padding before applying the keystream from index 0.
 */

import { extractEncryptedSnd, type EncryptedSnd } from './extract.js';
import type { ParsedFmodBank } from './parse.js';

export interface KnownBankKey {
	/** Game / title where this key is documented. */
	game: string;
	/** UTF-8 encryption password. */
	key: string;
}

/**
 * Reverse all 8 bits of a byte. Equivalent to ww2ogg/FMODBankDecryptor's
 * 4-bit-reverse-within-each-nibble + nibble-swap.
 */
export function reverseBitsInByte(b: number): number {
	b = ((b >> 1) & 0x55) | ((b & 0x55) << 1);
	b = ((b >> 2) & 0x33) | ((b & 0x33) << 2);
	b = ((b >> 4) & 0x0f) | ((b & 0x0f) << 4);
	return b & 0xff;
}

/**
 * Decrypt the SND chunk's payload bytes (after stripping any leading
 * NUL padding) using `key`. Modifies the buffer in place.
 *
 * `encryptedBytes` should already have the leading NULs trimmed —
 * pass the slice starting at the actual encrypted region.
 *
 * Returns the same buffer for chaining.
 */
export function decryptBankSndPayload(
	encryptedBytes: Uint8Array,
	key: string,
): Uint8Array {
	const keyBytes = new TextEncoder().encode(key);
	const keyLen = keyBytes.length;
	if (keyLen === 0) throw new Error('decryptBankSndPayload: empty key');
	for (let i = 0; i < encryptedBytes.length; i++) {
		encryptedBytes[i] = reverseBitsInByte(encryptedBytes[i]) ^ keyBytes[i % keyLen];
	}
	return encryptedBytes;
}

/** Result of `tryKnownKeysAndDecrypt`. */
export interface DecryptResult {
	/** The decrypted FSB5 bytes (starts with `FSB5` magic), or null if no key matched. */
	fsb5: Uint8Array | null;
	/** The key that worked, or null. */
	matchedKey: KnownBankKey | null;
	/** Whether the bank actually appeared encrypted (false = plaintext FSB5 was already there). */
	wasEncrypted: boolean;
}

/**
 * Auto-detect the encryption key for a bank by trying every entry
 * in `KNOWN_BANK_KEYS` (and `extraKeys` if provided) until one
 * produces an `FSB5` magic. Cheap because we only need to decrypt
 * the first 4 bytes per attempt.
 *
 * If the bank's SND payload already starts with `FSB5` (after the
 * NUL padding skip), returns `wasEncrypted: false` and the bytes
 * verbatim.
 *
 * Returns null `fsb5` + null `matchedKey` if no key works.
 */
export async function tryKnownKeysAndDecrypt(
	parsed: ParsedFmodBank,
	source: Blob,
	extraKeys: ReadonlyArray<KnownBankKey> = [],
): Promise<DecryptResult> {
	const enc = await extractEncryptedSnd(parsed, source);
	if (!enc) return { fsb5: null, matchedKey: null, wasEncrypted: false };

	// Already plaintext?
	if (looksLikeFsb5(enc.encryptedBytes)) {
		return {
			fsb5: enc.encryptedBytes,
			matchedKey: null,
			wasEncrypted: false,
		};
	}

	// Try each known key. Cheap pre-check: decrypt only the first
	// 4 bytes and compare against "FSB5" magic.
	for (const candidate of [...extraKeys, ...KNOWN_BANK_KEYS]) {
		if (probeKey(enc, candidate.key)) {
			// Decrypt the full payload in a copy to avoid clobbering.
			const out = enc.encryptedBytes.slice();
			decryptBankSndPayload(out, candidate.key);
			if (looksLikeFsb5(out)) {
				return { fsb5: out, matchedKey: candidate, wasEncrypted: true };
			}
		}
	}
	return { fsb5: null, matchedKey: null, wasEncrypted: true };
}

/** True if the first 4 bytes spell `FSB5`. */
function looksLikeFsb5(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x46 &&
		bytes[1] === 0x53 &&
		bytes[2] === 0x42 &&
		bytes[3] === 0x35
	);
}

/** Cheap key probe — decrypt only the first 4 bytes and check the magic. */
function probeKey(enc: EncryptedSnd, key: string): boolean {
	const keyBytes = new TextEncoder().encode(key);
	const target = [0x46, 0x53, 0x42, 0x35];
	for (let i = 0; i < 4; i++) {
		const dec = reverseBitsInByte(enc.encryptedBytes[i]) ^ keyBytes[i % keyBytes.length];
		if (dec !== target[i]) return false;
	}
	return true;
}

// =============================================================
// KNOWN BANK KEYS — sourced from CUE4Parse (Apache 2.0),
// FMODBankDecryptor (MIT), vgmstream (ISC). Game→key mapping
// updated as new games are documented.
// =============================================================

export const KNOWN_BANK_KEYS: ReadonlyArray<KnownBankKey> = Object.freeze([
	{ game: "Godbreakers", key: "06U8A&w5#PnsW&GA" },
	{ game: "The Darkest Files", key: "JNM-zHdO49i_s)p&rG8`a:{)GMI6O*U:Jq\"1E8k0\u00a3%O*AyxXFL" },
	{ game: "PAPERHEAD EP0", key: "666Paperhead999" },
	{ game: "Delverium Demo", key: "D3lv3rium FTW!" },
	{ game: "Mr. Nomad Demo", key: "vanillaicecream" },
	{ game: "Double Fine Productions", key: "DFm3t4lFTW" },
	{ game: "DJ Hero 2 (X360)", key: "nos71RiT" },
	{ game: "N++ (PC?)", key: "H$#FJa%7gRZZOlxLiN50&g5Q" },
	{ game: "Slightly Mad Studios (Project CARS, World of Speed)", key: "sTOoeJXI2LjK8jBMOk8h5IDRNZl3jq3I" },
	{ game: "Ghost in the Shell: First Assault (PC)", key: "%lAn2{Pi*Lhw3T}@7*!kV=?qS$@iNlJ" },
	{ game: "RevHeadz Engine Sounds (Mobile)", key: "1^7%82#&5$~/8sz" },
	{ game: "Dark Souls 3 (PC)", key: "FDPrVuT4fAFvdHJYAgyMzRF4EcBAnKg" },
	{ game: "Need for Speed Shift 2 Unleashed (PC)", key: "p&oACY^c4LK5C2v^x5nIO6kg5vNH$tlj" },
	{ game: "Mortal Kombat X/XL (PC)", key: "996164B5FC0F402983F61F220BB51DC6" },
	{ game: "Mirror War: Reincarnation of Holiness (PC)", key: "logicsounddesignmwsdev" },
	{ game: "Xian Xia Chuan (PC)", key: "gat@tcqs2010" },
	{ game: "Critter Crunch / Superbrothers: Sword & Sworcery (PC)", key: "j1$Mk0Libg3#apEr42mo" },
	{ game: "Cyphers", key: "@kdj43nKDN^k*kj3ndf02hd95nsl(NJG" },
	{ game: "Xuan Dou Zhi Wang / King of Combat", key: "Xiayuwu69252.Sonicli81223#$*@*0" },
	{ game: "Ji Feng Zhi Ren / Kritika Online", key: "kri_tika_5050_" },
	{ game: "Invisible Inc. (PC?)", key: "mint78run52" },
	{ game: "Guitar Hero 3", key: "5atu6w4zaw" },
	{ game: "Supreme Commander 2 (PC)", key: "B2A7BB00" },
	{ game: "Cookie Run: Ovenbreak", key: "ghfxhslrghfxhslr" },
	{ game: "Monster Jam (PS2)", key: "truck/impact/carbody" },
	{ game: "Sekiro: Shadows Die Twice (PC)", key: "G0KTrWjS9syqF7vVD6RaVXlFD91gMgkC" },
	{ game: "SCP: Unity (PC)", key: "BasicEncryptionKey" },
	{ game: "Worms Rumble Beta (PC)", key: "FXnTffGJ9LS855Gc" },
	{ game: "Bubble Fighter (PC)", key: "qjvkeoqkrdhkdckd" },
	{ game: "Fall Guys (PC) ~2021-11", key: "p@4_ih*srN:UJk&8" },
	{ game: "Fall Guys (PC) ~2022-07", key: ",&.XZ8]fLu%caPF+" },
	{ game: "Fall Guys (PC) ~2023-05", key: "^*4[hE>K]x90Vj" },
	{ game: "Achilles: Legends Untold (PC)", key: "Achilles_0_15_DpG" },
	{ game: "Cult of the Lamb Demo (PC)", key: "4FB8CC894515617939F4E1B7D50972D27213B8E6" },
	{ game: "Signalis (PC)", key: "X3EK%Bbga-%Y9HZZ%gkc*C512*$$DhRxWTGgjUG@=rUD" },
	{ game: "Ash Echoes beta (Android)", key: "281ad163160cfc16f9a22c6755a64fad" },
	{ game: "Afterimage demo (PC)", key: "Aurogon666" },
	{ game: "Blanc (PC/Switch)", key: "IfYouLikeThosesSoundsWhyNotRenumerateTheir2Authors?" },
	{ game: "Nishuihan Mobile (Android)", key: "L36nshM520" },
	{ game: "Forza Motorsport (PC)", key: "Forza2!" },
	{ game: "JDM: Japanese Drift Master (PC)", key: "cbfjZTlUPaZI" },
	{ game: "Ys Online: The Call of Solum (PC)", key: "tkdnsem000" },
	{ game: "Test Drive: Ferrari Racing Legends (PC)", key: "4DxgpNV3pQLPD6GT7g9Gf6eWU7SXutGQ" },
	{ game: "Hello Kitty: Island Adventure (iOS)", key: "AjaxIsTheGoodestBoy" },
	{ game: "Rivals of Aether 2 (PC)", key: "resoforce" },
	{ game: "Final Fantasy XV: War for Eos (Android)", key: "3cfe772db5b55b806541d3faf894020e" },
	{ game: "Forza Motorsport 2023 (PC)", key: "aj#$kLucf2lh}eqh" },
	{ game: "AirRider CrazyRacing (PC)", key: "dpdjeoqkr" },
	{ game: "Wanderstop (PC)", key: "weareAbsolutelyUnsure2018" },
	{ game: "UNBEATABLE Demo (PC)", key: ".xW3uXQ8q79yunvMjL6nahLXts9esEXX2VgetuPCxdLrAjUUbZAmB7R*A6KjW24NU_8ifMZ8TC4Qk@_oEsjsK2QLpAaG-Fy!wYKP" },
	{ game: "Rennsport (PC)", key: ",H9}:p?`bRlQG5_yJ\"\"/L,X_{:=Gs1" },
	{ game: "Gunner, HEAT, PC! (PC)", key: "K50j8B2H4pVUfzt7yxfTprg9wdr9zIH6" },
	{ game: "Duet Night Abyss (PC) beta", key: "Panshen666" },
]);
