import { describe, it, expect } from 'vitest';
import { adler32, decryptDrp, drpVersion, encryptDrp, findLiteralTable, inflateLiterals, parseDrp, readDrpPart } from '../src/index.js';

/** LSB-first bit writer, enough for a fixed-Huffman DEFLATE block. */
class Bits {
	bytes: number[] = [];
	private cur = 0;
	private n = 0;
	put(value: number, count: number) {
		for (let i = 0; i < count; i++) {
			this.cur |= ((value >> i) & 1) << this.n;
			if (++this.n === 8) {
				this.bytes.push(this.cur);
				this.cur = 0;
				this.n = 0;
			}
		}
	}
	/** Huffman codes go in MSB-first. */
	code(code: number, len: number) {
		for (let i = len - 1; i >= 0; i--) this.put((code >> i) & 1, 1);
	}
	finish() {
		if (this.n) this.bytes.push(this.cur);
		return Uint8Array.from(this.bytes);
	}
}

function fixedLiteral(b: Bits, v: number) {
	if (v < 144) b.code(0x30 + v, 8);
	else b.code(0x190 + v - 144, 9);
}

/**
 * The modified zlib's output for `plain`: literals pre-adjusted by the
 * table, then a back-reference that copies the (already adjusted) output.
 */
function encodeLiterals(plain: Uint8Array, table: Uint8Array, key: number, repeat: number) {
	const b = new Bits();
	b.put(1, 1); // final
	b.put(1, 2); // fixed Huffman
	for (const p of plain) {
		fixedLiteral(b, (p + table[key]!) & 0xff);
		key = (key + 1) & 0xff;
	}
	// Length 3 (code 257), distance `plain.length` (needs extra bits for > 4).
	b.code(1, 7);
	const d = plain.length; // 5..6 → dist code 4, 1 extra bit
	b.code(4, 5);
	b.put(d - 5, 1);
	void repeat;
	b.code(0, 7); // end of block
	return b.finish();
}

describe('version 5 inflate', () => {
	it('adjusts literals but not back-references, and checks Adler-32', () => {
		const table = new Uint8Array(256).map((_, i) => (i * 37) & 0x3f);
		const plain = new TextEncoder().encode('Pokkn');
		const key = 200;
		const deflated = encodeLiterals(plain, table, key, 3);
		const expected = new Uint8Array([...plain, ...plain.subarray(0, 3)]);
		const ad = adler32(expected);
		const withTrailer = new Uint8Array([...deflated, ad >>> 24, (ad >>> 16) & 255, (ad >>> 8) & 255, ad & 255]);
		expect(inflateLiterals(withTrailer, 8, { table, key }, { verify: true })).toEqual(expected);
		// A short size peeks at the head.
		expect(inflateLiterals(withTrailer, 2, { table, key })).toEqual(plain.subarray(0, 2));
		// The wrong table fails the trailer check.
		expect(() => inflateLiterals(withTrailer, 8, { table: new Uint8Array(256), key }, { verify: true })).toThrow(/Adler/);
	});
});

describe('version 5 DRP', () => {
	it('round-trips both encryption layers and finds entries after the stub', () => {
		// A version 5 seed: (seed >> 14) & 0xF === 5.
		const seed = (5 << 14) | 0x12340001;
		const out = new Uint8Array(0x80 + 0x60 + 0x20);
		const dv = new DataView(out.buffer);
		dv.setInt16(0x14, 5, false);
		dv.setInt16(0x16, 1, false);
		dv.setUint32(0x1c, seed >>> 0, false);
		out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0x60);
		dv.setUint32(0x68, 0xdeadbeef, false);
		dv.setUint32(0x70, 0x60, false);
		const e = 0x80;
		out.set(new TextEncoder().encode('location_en'), e);
		dv.setInt32(e + 0x44, 0x60 + 0x20, false);
		dv.setInt16(e + 0x4a, 1, false);
		for (let k = 0; k < 4; k++) dv.setInt32(e + 0x50 + k * 4, 0x20, false);
		dv.setUint32(e + 0x60, 12, false); // stored part, 12 bytes
		out.set(new TextEncoder().encode('hello, drp 5'), e + 0x64);
		expect(drpVersion(out)).toBe(5);

		const enc = encryptDrp(out);
		expect(enc.subarray(0x80)).not.toEqual(out.subarray(0x80));
		const dec = decryptDrp(enc);
		expect(dec).toEqual(out);
		const drp = parseDrp(dec);
		expect(drp.version).toBe(5);
		expect(drp.entries[0]!.name).toBe('location_en');
		expect(new TextDecoder().decode(readDrpPart(dec, drp.entries[0]!, drp.entries[0]!.parts[0]!))).toBe('hello, drp 5');
	});

	it('finds the literal table through the adrp / ldr / ldrb pattern', () => {
		const image = new Uint8Array(0x4000);
		const dv = new DataView(image.buffer);
		const at = 0x10;
		const put = (i: number, w: number) => dv.setUint32(at + i * 4, w >>> 0, true);
		// adrp x9, page 0x2000 (from page 0): imm = 2.
		put(0, 0x90000000 | (2 << 29) | 9);
		put(1, 0xf9400000 | (8 << 10) | (9 << 5) | 9); // ldr x9, [x9, #64]
		put(2, 0x39400000 | (0x70 << 10) | (19 << 5) | 10); // ldrb w10, [x19, #0x70]
		put(3, 0x38606800 | (10 << 16) | (9 << 5) | 9); // ldrb w9, [x9, x10]
		dv.setBigUint64(0x2040, 0x3000n, true);
		const table = new Uint8Array(256).map((_, i) => i & 0x3f);
		image.set(table, 0x3000);
		expect(findLiteralTable(image)).toEqual(table);
		expect(findLiteralTable(new Uint8Array(0x100))).toBeNull();
	});
});
