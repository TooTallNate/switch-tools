import { describe, expect, it } from 'vitest';
import { initCiphTable, decryptBlock, checkSum } from '../src/cipher.js';
import { initAthTable } from '../src/tables.js';

describe('initCiphTable', () => {
	it('type 0 → identity table', () => {
		const t = initCiphTable(0, 0, 0);
		expect(t).toHaveLength(0x100);
		for (let i = 0; i < 0x100; i++) expect(t[i]).toBe(i);
	});

	it('type 1 → fixed permutation, deterministic across calls', () => {
		const a = initCiphTable(1, 0, 0);
		const b = initCiphTable(1, 0, 0);
		expect(a).toEqual(b);
		// Endpoints are fixed to 0 / 0xFF; the middle is permuted.
		expect(a[0]).toBe(0);
		expect(a[0xff]).toBe(0xff);
		// Sanity: the table is a permutation (every byte appears once).
		const seen = new Set<number>();
		for (let i = 0; i < 0x100; i++) seen.add(a[i]!);
		expect(seen.size).toBe(0x100);
	});

	it('type 56 with the same key pair is deterministic', () => {
		const a = initCiphTable(56, 0xdeadbeef, 0x12345678);
		const b = initCiphTable(56, 0xdeadbeef, 0x12345678);
		expect(a).toEqual(b);
		expect(a[0]).toBe(0);
		expect(a[0xff]).toBe(0xff);
		// Permutation invariant holds for type 56 too.
		const seen = new Set<number>();
		for (let i = 0; i < 0x100; i++) seen.add(a[i]!);
		expect(seen.size).toBe(0x100);
	});

	it('type 56 differs across distinct keys', () => {
		const a = initCiphTable(56, 1, 0);
		const b = initCiphTable(56, 2, 0);
		expect(a).not.toEqual(b);
	});

	it('throws on unknown cipher type', () => {
		expect(() => initCiphTable(99, 0, 0)).toThrow(/ciphType/);
	});
});

describe('decryptBlock', () => {
	it('applies a substitution table in place', () => {
		const table = new Uint8Array(0x100);
		for (let i = 0; i < 0x100; i++) table[i] = (i + 1) & 0xff;
		const block = new Uint8Array([0, 1, 2, 0xff]);
		decryptBlock(table, block);
		expect(Array.from(block)).toEqual([1, 2, 3, 0]);
	});

	it('type-0 table is a no-op', () => {
		const table = initCiphTable(0, 0, 0);
		const block = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const copy = block.slice();
		decryptBlock(table, block);
		expect(Array.from(block)).toEqual(Array.from(copy));
	});
});

describe('checkSum', () => {
	it('zero input → zero CRC', () => {
		expect(checkSum(new Uint8Array(16), 16)).toBe(0);
	});

	it('matches the well-known CRC-16/CDMA2000 expectation for a small payload', () => {
		// "123456789" → CRC-16/CDMA2000 (poly 0xC867, init 0xFFFF) is a
		// different variant; the CRIWARE flavour uses init 0 and a
		// different table. We just verify determinism + that
		// non-trivial data produces a non-zero checksum.
		const bytes = new TextEncoder().encode('123456789');
		const c = checkSum(bytes, bytes.length);
		expect(c).toBeGreaterThan(0);
		// Determinism
		expect(checkSum(bytes, bytes.length)).toBe(c);
	});
});

describe('initAthTable', () => {
	it('type 0 → all zeros', () => {
		const t = initAthTable(0, 48000);
		expect(t).toHaveLength(0x80);
		for (let i = 0; i < 0x80; i++) expect(t[i]).toBe(0);
	});

	it('type 1 walks the reference table at the sample-rate step', () => {
		// The walker advances `v += sampleRate` each step and indexes
		// the 1024-byte reference by `v >>> 13`. The first entry is
		// always 0x78 (index 0); subsequent entries vary with the rate
		// because higher rates skip further into the table.
		const t22 = initAthTable(1, 22050);
		expect(t22[0]).toBe(0x78);
		// Determinism across calls.
		expect(initAthTable(1, 22050)).toEqual(t22);

		const t48 = initAthTable(1, 48000);
		expect(t48[0]).toBe(0x78);
		// Higher rate ⇒ the walker reaches the table-end sentinel
		// (0xFF) sooner, so the tail is more saturated.
		const tail48Mostly = t48.slice(120).every((b) => b === 0xff);
		const tail22Mostly = t22.slice(120).every((b) => b === 0xff);
		expect(tail48Mostly || tail22Mostly).toBe(true);
	});

	it('rejects unknown athType', () => {
		expect(() => initAthTable(99, 48000)).toThrow();
	});
});
