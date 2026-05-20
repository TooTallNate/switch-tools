/*
 * HCA cipher tables.
 *
 * HCA's per-block cipher is a static 256-entry byte substitution
 * table — every byte of the encoded block is passed through the
 * table to recover the plaintext block. The table itself is
 * generated from the file's `ciph` header type and (for type 56)
 * a 64-bit key.
 *
 *   type 0   identity (no encryption)
 *   type 1   static obfuscation table (no key)
 *   type 56  key-derived table (the most common form in real
 *            shipping titles)
 *
 * Ported from kohos/CriTools (MIT) — https://github.com/kohos/CriTools
 */

/**
 * The HCA cipher type. Stored as a u16 in the `ciph` header.
 * Type 0 = plain, 1 = static obfuscation, 56 = key-derived.
 */
export type CiphType = 0 | 1 | 56;

/**
 * Build the 256-entry HCA cipher substitution table for the
 * given type and (for type 56) the two 32-bit halves of the
 * 64-bit key. The output `table` array — which must be
 * `>= 256` long — is filled in place.
 *
 * Returns `true` on success and `false` for an unrecognised
 * cipher type.
 */
export function initCiphTable(
	table: Uint8Array,
	type: number,
	key1: number = 0,
	key2: number = 0,
): boolean {
	if (table.length < 0x100) {
		throw new RangeError(`initCiphTable: table must be >= 256 bytes`);
	}
	if (type === 0) {
		// Identity.
		for (let i = 0; i < 0x100; i++) table[i] = i;
		return true;
	}
	if (type === 1) {
		// Static obfuscation table — same for every type-1 HCA.
		let v = 0;
		for (let i = 1; i < 0xff; i++) {
			v = (v * 13 + 11) & 0xff;
			if (v === 0 || v === 0xff) v = (v * 13 + 11) & 0xff;
			table[i] = v;
		}
		table[0] = 0;
		table[0xff] = 0xff;
		return true;
	}
	if (type === 56) {
		// Key-derived table. Mirrors CriTools' `initCiphTable(t=56,
		// key1, key2)` exactly — `key1` is the low 32 bits, `key2`
		// the high 32 bits of the 64-bit key, both unsigned.
		let k1 = key1 >>> 0;
		let k2 = key2 >>> 0;
		const t1 = new Uint8Array(8);
		if (k1 === 0) k2 = (k2 - 1) >>> 0;
		k1 = (k1 - 1) >>> 0;
		for (let i = 0; i < 7; i++) {
			t1[i] = k1 & 0xff;
			// k1 = (k1 >>> 8) | ((k2 << 24) & 0xFFFFFFFF)
			k1 = ((k1 >>> 8) | ((k2 << 24) >>> 0)) >>> 0;
			k2 = (k2 >>> 8) >>> 0;
		}
		const t2 = new Uint8Array([
			t1[1]!,
			t1[1]! ^ t1[6]!,
			t1[2]! ^ t1[3]!,
			t1[2]!,
			t1[2]! ^ t1[1]!,
			t1[3]! ^ t1[4]!,
			t1[3]!,
			t1[3]! ^ t1[2]!,
			t1[4]! ^ t1[5]!,
			t1[4]!,
			t1[4]! ^ t1[3]!,
			t1[5]! ^ t1[6]!,
			t1[5]!,
			t1[5]! ^ t1[4]!,
			t1[6]! ^ t1[1]!,
			t1[6]!,
		]);
		const t3 = new Uint8Array(0x100);
		const t31 = new Uint8Array(0x10);
		const t32 = new Uint8Array(0x10);
		createTable56(t31, t1[0]!);
		let k = 0;
		for (let i = 0; i < 0x10; i++) {
			createTable56(t32, t2[i]!);
			const v = (t31[i]! << 4) & 0xff;
			for (let j = 0; j < 0x10; j++) {
				t3[k++] = v | t32[j]!;
			}
		}
		let j = 1;
		let v = 0;
		for (let i = 0; i < 0x100; i++) {
			v = (v + 0x11) & 0xff;
			const a = t3[v]!;
			if (a !== 0 && a !== 0xff) table[j++] = a;
		}
		table[0] = 0;
		table[0xff] = 0xff;
		return true;
	}
	return false;
}

function createTable56(r: Uint8Array, keyByte: number): void {
	const mul = ((keyByte & 1) << 3) | 5;
	const add = (keyByte & 0xe) | 1;
	let key = (keyByte >>> 4) & 0xff;
	for (let i = 0; i < 0x10; i++) {
		key = (key * mul + add) & 0xf;
		r[i] = key;
	}
}

/**
 * In-place block decrypt. Each byte `b` is replaced with
 * `table[b]`. For a type-0 cipher this is a no-op (the table
 * is the identity).
 */
export function decryptBlock(table: Uint8Array, block: Uint8Array): void {
	for (let i = 0; i < block.length; i++) {
		block[i] = table[block[i]!]!;
	}
}

/**
 * Combine the user-provided 64-bit HCA key with the per-AWB
 * `awbKey` (a 16-bit "subkey" that AWB containers tack on top
 * of the file-level key). For standalone HCAs `awbKey` is 0
 * and this returns the input unchanged.
 *
 * Matches CriTools' formula:
 *   key = (key * ((awbKey << 16) | ((~awbKey & 0xFFFF) + 2))) mod 2^64
 */
export function combineAwbKey(key: bigint, awbKey: number): bigint {
	if (!awbKey) return key & 0xffffffffffffffffn;
	const aw = BigInt(awbKey & 0xffff);
	const lo = BigInt((((~awbKey & 0xffff) + 2) & 0xffff) >>> 0);
	const mul = (aw << 16n) | lo;
	return (key * mul) & 0xffffffffffffffffn;
}

/**
 * Split a 64-bit BigInt key into the two unsigned 32-bit halves
 * (`[lo, hi]`) used by {@link initCiphTable} for type-56.
 */
export function splitKey64(key: bigint): [number, number] {
	const masked = key & 0xffffffffffffffffn;
	const lo = Number(masked & 0xffffffffn) >>> 0;
	const hi = Number((masked >> 32n) & 0xffffffffn) >>> 0;
	return [lo, hi];
}
