/*
 * @tootallnate/hca — pure-TypeScript decoder for CRI Middleware's
 * High Compression Audio (HCA) codec.
 *
 * Ported from vgmstream's clHCA (ISC license, by nyaga / kode54 /
 * bnnm). See README + LICENSE.
 */

/**
 * Build the per-stream cipher byte-substitution table.
 *
 *   - **0**: identity (file unencrypted)
 *   - **1**: fixed permutation seeded by a small recurrence
 *   - **56**: derived from a 64-bit per-file key
 *
 * For type 56 we accept the key as `(key1, key2)` where `key1` holds
 * the low 32 bits and `key2` the high 32 bits. Use
 * `deriveSubkey(...)` from `header.ts` to mix in an AWB subkey.
 */
export function initCiphTable(
	type: number,
	key1: number,
	key2: number,
): Uint8Array {
	const table = new Uint8Array(0x100);
	if (type === 0) {
		for (let i = 0; i < 0x100; i++) table[i] = i;
		return table;
	}
	if (type === 1) {
		// keyless static permutation
		let v = 0;
		for (let i = 1; i < 0xff; i++) {
			v = (v * 13 + 11) & 0xff;
			if (v === 0 || v === 0xff) v = (v * 13 + 11) & 0xff;
			table[i] = v;
		}
		table[0] = 0;
		table[0xff] = 0xff;
		return table;
	}
	if (type === 56) {
		// Treat (key2:key1) as a 64-bit keycode. C does `if(keycode!=0)
		// keycode--`. We carry the borrow across the 32-bit halves.
		if (!(key1 === 0 && key2 === 0)) {
			if (key1 === 0) {
				key2 = (key2 - 1) >>> 0;
				key1 = 0xffffffff;
			} else {
				key1 = (key1 - 1) >>> 0;
			}
		}
		const kc = new Uint8Array(8);
		for (let r = 0; r < 7; r++) {
			kc[r] = key1 & 0xff;
			// rotate right by 8 bits over 64-bit value
			const lowFromHigh = (key2 & 0xff) << 24;
			key1 = ((key1 >>> 8) | lowFromHigh) >>> 0;
			key2 = (key2 >>> 8) >>> 0;
		}
		const seed = new Uint8Array(16);
		seed[0x00] = kc[1]!;
		seed[0x01] = (kc[1]! ^ kc[6]!) & 0xff;
		seed[0x02] = (kc[2]! ^ kc[3]!) & 0xff;
		seed[0x03] = kc[2]!;
		seed[0x04] = (kc[2]! ^ kc[1]!) & 0xff;
		seed[0x05] = (kc[3]! ^ kc[4]!) & 0xff;
		seed[0x06] = kc[3]!;
		seed[0x07] = (kc[3]! ^ kc[2]!) & 0xff;
		seed[0x08] = (kc[4]! ^ kc[5]!) & 0xff;
		seed[0x09] = kc[4]!;
		seed[0x0a] = (kc[4]! ^ kc[3]!) & 0xff;
		seed[0x0b] = (kc[5]! ^ kc[6]!) & 0xff;
		seed[0x0c] = kc[5]!;
		seed[0x0d] = (kc[5]! ^ kc[4]!) & 0xff;
		seed[0x0e] = (kc[6]! ^ kc[1]!) & 0xff;
		seed[0x0f] = kc[6]!;
		const base = new Uint8Array(0x100);
		const baseR = new Uint8Array(16);
		const baseC = new Uint8Array(16);
		init56CreateTable(baseR, kc[0]!);
		for (let r = 0; r < 16; r++) {
			init56CreateTable(baseC, seed[r]!);
			const nb = (baseR[r]! << 4) & 0xff;
			for (let c = 0; c < 16; c++) {
				base[r * 16 + c] = nb | baseC[c]!;
			}
		}
		// final shuffle table
		let x = 0;
		let pos = 1;
		for (let i = 0; i < 0x100; i++) {
			x = (x + 17) & 0xff;
			if (base[x] !== 0 && base[x] !== 0xff) {
				table[pos++] = base[x]!;
			}
		}
		table[0] = 0;
		table[0xff] = 0xff;
		return table;
	}
	throw new Error(`HCA: unsupported ciphType ${type}`);
}

function init56CreateTable(out: Uint8Array, key: number): void {
	const mul = ((key & 1) << 3) | 5;
	const add = (key & 0xe) | 1;
	let k = key >>> 4;
	for (let i = 0; i < 16; i++) {
		k = (k * mul + add) & 0xf;
		out[i] = k;
	}
}

/** Apply the cipher table to a block in place (idempotent w.r.t. the table). */
export function decryptBlock(table: Uint8Array, block: Uint8Array): void {
	for (let i = 0; i < block.length; i++) {
		block[i] = table[block[i]!]!;
	}
}

// =====================================================================
// CRC-16 (CRIWARE flavour). Polynomial table from clHCA's
// `hcacommon_crc_mask_table[]`. `init = 0`, no reflection.
// =====================================================================

const CRC16_TABLE = new Uint16Array([
	0x0000, 0x8005, 0x800f, 0x000a, 0x801b, 0x001e, 0x0014, 0x8011, 0x8033,
	0x0036, 0x003c, 0x8039, 0x0028, 0x802d, 0x8027, 0x0022, 0x8063, 0x0066,
	0x006c, 0x8069, 0x0078, 0x807d, 0x8077, 0x0072, 0x0050, 0x8055, 0x805f,
	0x005a, 0x804b, 0x004e, 0x0044, 0x8041, 0x80c3, 0x00c6, 0x00cc, 0x80c9,
	0x00d8, 0x80dd, 0x80d7, 0x00d2, 0x00f0, 0x80f5, 0x80ff, 0x00fa, 0x80eb,
	0x00ee, 0x00e4, 0x80e1, 0x00a0, 0x80a5, 0x80af, 0x00aa, 0x80bb, 0x00be,
	0x00b4, 0x80b1, 0x8093, 0x0096, 0x009c, 0x8099, 0x0088, 0x808d, 0x8087,
	0x0082, 0x8183, 0x0186, 0x018c, 0x8189, 0x0198, 0x819d, 0x8197, 0x0192,
	0x01b0, 0x81b5, 0x81bf, 0x01ba, 0x81ab, 0x01ae, 0x01a4, 0x81a1, 0x01e0,
	0x81e5, 0x81ef, 0x01ea, 0x81fb, 0x01fe, 0x01f4, 0x81f1, 0x81d3, 0x01d6,
	0x01dc, 0x81d9, 0x01c8, 0x81cd, 0x81c7, 0x01c2, 0x0140, 0x8145, 0x814f,
	0x014a, 0x815b, 0x015e, 0x0154, 0x8151, 0x8173, 0x0176, 0x017c, 0x8179,
	0x0168, 0x816d, 0x8167, 0x0162, 0x8123, 0x0126, 0x012c, 0x8129, 0x0138,
	0x813d, 0x8137, 0x0132, 0x0110, 0x8115, 0x811f, 0x011a, 0x810b, 0x010e,
	0x0104, 0x8101, 0x8303, 0x0306, 0x030c, 0x8309, 0x0318, 0x831d, 0x8317,
	0x0312, 0x0330, 0x8335, 0x833f, 0x033a, 0x832b, 0x032e, 0x0324, 0x8321,
	0x0360, 0x8365, 0x836f, 0x036a, 0x837b, 0x037e, 0x0374, 0x8371, 0x8353,
	0x0356, 0x035c, 0x8359, 0x0348, 0x834d, 0x8347, 0x0342, 0x03c0, 0x83c5,
	0x83cf, 0x03ca, 0x83db, 0x03de, 0x03d4, 0x83d1, 0x83f3, 0x03f6, 0x03fc,
	0x83f9, 0x03e8, 0x83ed, 0x83e7, 0x03e2, 0x83a3, 0x03a6, 0x03ac, 0x83a9,
	0x03b8, 0x83bd, 0x83b7, 0x03b2, 0x0390, 0x8395, 0x839f, 0x039a, 0x838b,
	0x038e, 0x0384, 0x8381, 0x0280, 0x8285, 0x828f, 0x028a, 0x829b, 0x029e,
	0x0294, 0x8291, 0x82b3, 0x02b6, 0x02bc, 0x82b9, 0x02a8, 0x82ad, 0x82a7,
	0x02a2, 0x82e3, 0x02e6, 0x02ec, 0x82e9, 0x02f8, 0x82fd, 0x82f7, 0x02f2,
	0x02d0, 0x82d5, 0x82df, 0x02da, 0x82cb, 0x02ce, 0x02c4, 0x82c1, 0x8243,
	0x0246, 0x024c, 0x8249, 0x0258, 0x825d, 0x8257, 0x0252, 0x0270, 0x8275,
	0x827f, 0x027a, 0x826b, 0x026e, 0x0264, 0x8261, 0x0220, 0x8225, 0x822f,
	0x022a, 0x823b, 0x023e, 0x0234, 0x8231, 0x8213, 0x0216, 0x021c, 0x8219,
	0x0208, 0x820d, 0x8207, 0x0202,
]);

/**
 * CRIWARE CRC-16 over `data[0..size)`. The trailing 2 bytes of every
 * HCA header/block are the CRC; running CRC over the whole block
 * including the trailing CRC bytes is a self-check (yields 0).
 */
export function checkSum(data: Uint8Array, size: number): number {
	let sum = 0;
	for (let i = 0; i < size; i++) {
		sum =
			((sum << 8) & 0xffff) ^
			CRC16_TABLE[((sum >>> 8) ^ data[i]!) & 0xff]!;
	}
	return sum;
}
