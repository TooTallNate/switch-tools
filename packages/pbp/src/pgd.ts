/**
 * PGD decryption (PSP "AMCTRL" / BBMac + BBCipher), as used for the
 * encrypted PSISOIMG header of official PlayStation (PS1 Classics)
 * EBOOTs.
 *
 * A PGD is `\0PGD`, key index, DRM type, a 0x30-byte encrypted
 * header (data size, block size, data offset at 0x44 / 0x48 / 0x4C
 * once decrypted), MACs at 0x60 / 0x70 / 0x80, then the encrypted
 * data at 0x90. The per-game version key normally comes from the
 * PSP's license (KEYS.BIN), but it can also be recovered from the
 * MAC at 0x70.
 *
 * Only DRM type 1 (KIRK commands 4 / 7 with fixed key slots) is
 * implemented; it's what PS1 Classics use. Ported from libkirk's
 * amctrl.c (tpu, Hykem) as used by psxtract.
 */

// prettier-ignore
const SBOX = new Uint8Array([
	0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
	0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
	0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
	0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
	0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
	0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
	0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
	0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]);
const INV_SBOX = (() => {
	const t = new Uint8Array(256);
	for (let i = 0; i < 256; i++) t[SBOX[i]] = i;
	return t;
})();

const xtime = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
function mul(a: number, b: number): number {
	let r = 0;
	while (b) {
		if (b & 1) r ^= a;
		a = xtime(a);
		b >>= 1;
	}
	return r;
}

/** Minimal AES-128 block cipher (ECB, one block at a time). */
export class Aes128 {
	private rk = new Uint8Array(176);
	constructor(key: Uint8Array) {
		const rk = this.rk;
		rk.set(key.subarray(0, 16));
		let rcon = 1;
		for (let i = 16; i < 176; i += 4) {
			let t0 = rk[i - 4], t1 = rk[i - 3], t2 = rk[i - 2], t3 = rk[i - 1];
			if (i % 16 === 0) {
				const tmp = t0;
				t0 = SBOX[t1] ^ rcon;
				t1 = SBOX[t2];
				t2 = SBOX[t3];
				t3 = SBOX[tmp];
				rcon = xtime(rcon);
			}
			rk[i] = rk[i - 16] ^ t0;
			rk[i + 1] = rk[i - 15] ^ t1;
			rk[i + 2] = rk[i - 14] ^ t2;
			rk[i + 3] = rk[i - 13] ^ t3;
		}
	}
	encrypt(input: Uint8Array): Uint8Array {
		const s = input.slice(0, 16);
		const rk = this.rk;
		for (let i = 0; i < 16; i++) s[i] ^= rk[i];
		for (let round = 1; round <= 10; round++) {
			for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
			// ShiftRows (column-major state)
			let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
			t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
			t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
			if (round < 10) {
				for (let c = 0; c < 16; c += 4) {
					const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
					s[c] = xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3;
					s[c + 1] = a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3;
					s[c + 2] = a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3;
					s[c + 3] = xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3);
				}
			}
			for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
		}
		return s;
	}
	decrypt(input: Uint8Array): Uint8Array {
		const s = input.slice(0, 16);
		const rk = this.rk;
		for (let i = 0; i < 16; i++) s[i] ^= rk[160 + i];
		for (let round = 9; round >= 0; round--) {
			// InvShiftRows
			let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
			t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
			t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
			for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
			for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
			if (round > 0) {
				for (let c = 0; c < 16; c += 4) {
					const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
					s[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
					s[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
					s[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
					s[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
				}
			}
		}
		return s;
	}
}

const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
const KIRK_KEYS: Record<number, Uint8Array> = {
	0x38: hex('12468d7e1c42209bba5426835eb03303'),
	0x39: hex('c43bb6d653ee67493ea95fbc0ced6f8a'),
	0x3a: hex('2cc3cf8c2878a5a663e2af2d715e86ba'),
	0x63: hex('9c9b1372f8c640cf1c62f5d592ddb582'),
};
const AMCTRL_KEY1 = hex('e350ed1d910a1fd029bb1c3ef34077fb');
const AMCTRL_KEY2 = hex('135fa47cab395ba476b8cca98f3a0445');
const AMCTRL_KEY3 = hex('678d7fa32a9ca0d1508ad8385e4b017e');

const ciphers = new Map<number, Aes128>();
const kirk = (slot: number) => {
	let c = ciphers.get(slot);
	if (!c) ciphers.set(slot, (c = new Aes128(KIRK_KEYS[slot])));
	return c;
};

const xor = (a: Uint8Array, b: Uint8Array) => a.map((v, i) => v ^ b[i]);

/** CMAC subkey doubling in GF(2^128). */
function dbl(b: Uint8Array): Uint8Array {
	const out = new Uint8Array(16);
	for (let i = 0; i < 15; i++) out[i] = ((b[i] << 1) | (b[i + 1] >> 7)) & 0xff;
	out[15] = ((b[15] << 1) ^ (b[0] & 0x80 ? 0x87 : 0)) & 0xff;
	return out;
}

/** sceDrmBBMacFinal without a version key: AES-CMAC (slot 0x38) ⊕ AMCTRL key 1. */
function bbmacRaw(data: Uint8Array): Uint8Array {
	const aes = kirk(0x38);
	const k1 = dbl(aes.encrypt(new Uint8Array(16)));
	const blocks = Math.max(1, Math.ceil(data.length / 16));
	let state: Uint8Array = new Uint8Array(16);
	for (let b = 0; b < blocks - 1; b++) state = aes.encrypt(xor(state, data.subarray(b * 16, b * 16 + 16)));
	const last = new Uint8Array(16);
	const tail = data.subarray((blocks - 1) * 16);
	last.set(tail);
	let k = k1;
	if (tail.length < 16) {
		last[tail.length] = 0x80;
		k = dbl(k1);
	}
	return xor(aes.encrypt(xor(xor(state, last), k)), AMCTRL_KEY1);
}

/** Recover the version key from the MAC at 0x70 (what psxtract does without KEYS.BIN). */
function versionKeyFromMac(pgd: Uint8Array, macType: number): Uint8Array {
	const raw = bbmacRaw(pgd.subarray(0, 0x70));
	let mac: Uint8Array = pgd.slice(0x70, 0x80);
	if (macType === 3) mac = kirk(0x63).decrypt(mac);
	return xor(raw, kirk(0x38).decrypt(mac));
}

/** True when `key` produces the MAC stored at 0x70. */
function checkVersionKey(pgd: Uint8Array, macType: number, key: Uint8Array): boolean {
	const expected = kirk(0x38).encrypt(xor(bbmacRaw(pgd.subarray(0, 0x70)), key));
	let mac: Uint8Array = pgd.slice(0x70, 0x80);
	if (macType === 3) mac = kirk(0x63).decrypt(mac);
	return expected.every((v, i) => v === mac[i]);
}

/** BBCipher type 1 / mode 2: XOR `data` in place with the counter keystream. */
function bbcipher(data: Uint8Array, headerKey: Uint8Array, versionKey: Uint8Array): void {
	const t = xor(kirk(0x39).decrypt(xor(xor(headerKey, versionKey), AMCTRL_KEY3)), AMCTRL_KEY2);
	const aes = kirk(0x63);
	const ctr = new Uint8Array(16);
	ctr.set(t.subarray(0, 12));
	const dv = new DataView(ctr.buffer);
	let prev: Uint8Array = new Uint8Array(16);
	for (let o = 0, n = 1; o < data.length; o += 16, n++) {
		dv.setUint32(12, n, true);
		const ks = xor(aes.decrypt(ctr), prev);
		for (let i = 0; i < 16 && o + i < data.length; i++) data[o + i] ^= ks[i];
		prev = ctr.slice();
	}
}

export class PgdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PgdError';
	}
}

export function isPgd(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x50 && bytes[2] === 0x47 && bytes[3] === 0x44;
}

/**
 * Decrypt a PGD block and return its payload. `versionKey` (16 bytes,
 * e.g. from KEYS.BIN) is optional: without it the key is recovered
 * from the header MAC.
 */
export function decryptPgd(input: Uint8Array, versionKey?: Uint8Array): Uint8Array {
	if (!isPgd(input) || input.length < 0x90) throw new PgdError('Not a PGD block');
	const pgd = input.slice();
	const dv = new DataView(pgd.buffer);
	const keyIndex = dv.getUint32(4, true);
	const drmType = dv.getUint32(8, true);
	if (drmType !== 1) throw new PgdError(`Unsupported PGD DRM type ${drmType}`);
	const macType = keyIndex > 1 ? 3 : 1;
	let vkey: Uint8Array;
	if (versionKey && versionKey.some((b) => b !== 0)) {
		if (!checkVersionKey(pgd, macType, versionKey)) throw new PgdError('The version key (KEYS.BIN) does not match this PGD');
		vkey = versionKey;
	} else {
		vkey = versionKeyFromMac(pgd, macType);
	}
	// Header: 0x30 bytes at 0x30, keyed by 0x10.
	const header = pgd.subarray(0x30, 0x60);
	bbcipher(header, pgd.slice(0x10, 0x20), vkey);
	const dataSize = dv.getUint32(0x44, true);
	const blockSize = dv.getUint32(0x48, true);
	const dataOffset = dv.getUint32(0x4c, true);
	const alignSize = (dataSize + 15) & ~15;
	if (!blockSize || dataOffset + alignSize > pgd.length) throw new PgdError('PGD header did not decrypt (wrong key?)');
	const data = pgd.subarray(dataOffset, dataOffset + alignSize);
	bbcipher(data, pgd.slice(0x30, 0x40), vkey);
	return data.slice(0, dataSize);
}
