import { describe, expect, it } from 'vitest';
import {
	parseFmodBank,
	isFmodBank,
	BANK_RIFF_MAGIC,
	BANK_FORM_TYPE,
	reverseBitsInByte,
	tryKnownKeysAndDecrypt,
	extractFsb5FromBank,
	KNOWN_BANK_KEYS,
} from '../src/index.js';

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts.
 *
 * The {@link KNOWN_BANK_KEYS} list ships with the package as
 * reference data sourced from BSD/Apache/ISC-licensed OSS projects
 * (CUE4Parse, FMODBankDecryptor, vgmstream); we test against it
 * by *constructing* synthetic encrypted banks using one of those
 * keys and verifying round-trip extraction.
 */

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
}

/** Build a 4-char + size-LE + payload chunk. */
function buildChunk(id: string, payload: Uint8Array): Uint8Array {
	if (id.length !== 4) throw new Error('chunk id must be 4 chars');
	const out = new Uint8Array(8 + payload.length);
	new TextEncoder().encodeInto(id, out);
	new DataView(out.buffer).setUint32(4, payload.length, true);
	out.set(payload, 8);
	return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((a, c) => a + c.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

/**
 * Build a minimal valid synthetic FSB5 file (just the header — no
 * sample table, no name table, no data) for use as the SND chunk
 * payload. The parser only needs the magic bytes for the
 * decryption probe to succeed.
 */
function buildMinimalFsb5(): Uint8Array {
	const out = new Uint8Array(60);
	out.set([0x46, 0x53, 0x42, 0x35], 0); // "FSB5"
	new DataView(out.buffer).setUint32(4, 1, true); // version=1
	// rest of the header is zero-filled, which is fine for our
	// "extract returns FSB5 starting bytes" assertion.
	return out;
}

/**
 * Encrypt FSB5 bytes using FMOD's per-byte XOR scheme:
 *   encrypted[i] = reverse(plain[i] ^ key[i % keyLen])
 * — the inverse of the decryptor's
 *   plain[i] = reverse(encrypted[i]) ^ key[i % keyLen].
 */
function encryptFsb5Payload(plain: Uint8Array, key: string): Uint8Array {
	const out = new Uint8Array(plain.length);
	const keyBytes = new TextEncoder().encode(key);
	for (let i = 0; i < plain.length; i++) {
		out[i] = reverseBitsInByte(plain[i] ^ keyBytes[i % keyBytes.length]);
	}
	return out;
}

/**
 * Build a synthetic FMOD bank wrapping the given SND payload.
 * Layout: RIFF/FEV header, FMT chunk, minimal LIST(PROJ), minimal
 * SNDH metadata, then the SND chunk with two leading NUL padding
 * bytes (a common FMOD pattern, exercises the padding-skip logic).
 */
function buildSyntheticBank(sndPayload: Uint8Array, sndPadding = 2): Uint8Array {
	// FMT chunk: 8 bytes of placeholder format/version data.
	const fmtChunk = buildChunk('FMT ', new Uint8Array(8));
	// LIST(PROJ) with a tiny BNKI sub-chunk.
	const bnkiChunk = buildChunk('BNKI', new Uint8Array(32));
	const listPayload = concat(new TextEncoder().encode('PROJ'), bnkiChunk);
	const listChunk = buildChunk('LIST', listPayload);
	// SNDH: 12-byte payload (flags + offset + size).
	const sndhPayload = new Uint8Array(12);
	new DataView(sndhPayload.buffer).setUint32(8, sndPayload.length, true);
	const sndhChunk = buildChunk('SNDH', sndhPayload);
	// SND chunk: padding + payload.
	const sndPayloadWithPadding = new Uint8Array(sndPadding + sndPayload.length);
	sndPayloadWithPadding.set(sndPayload, sndPadding);
	const sndChunk = buildChunk('SND ', sndPayloadWithPadding);

	const body = concat(fmtChunk, listChunk, sndhChunk, sndChunk);
	// RIFF wrapper: "RIFF" + size + "FEV " + body.
	const out = new Uint8Array(12 + body.length);
	new TextEncoder().encodeInto('RIFF', out);
	new DataView(out.buffer).setUint32(4, 4 + body.length, true);
	new TextEncoder().encodeInto('FEV ', out.subarray(8));
	out.set(body, 12);
	return out;
}

describe('basic constants + helpers', () => {
	it('exposes magic + form-type', () => {
		expect(BANK_RIFF_MAGIC).toBe('RIFF');
		expect(BANK_FORM_TYPE).toBe('FEV ');
	});

	it('isFmodBank checks both RIFF and FEV', async () => {
		const ok = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x46, 0x45, 0x56, 0x20,
		]);
		expect(await isFmodBank(blob(ok))).toBe(true);
		const noFev = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
		]);
		expect(await isFmodBank(blob(noFev))).toBe(false);
	});

	it('reverseBitsInByte is its own inverse and matches reference', () => {
		// Sample table values from the FMODBankDecryptor reference (BSD-licensed).
		expect(reverseBitsInByte(0x00)).toBe(0x00);
		expect(reverseBitsInByte(0x01)).toBe(0x80);
		expect(reverseBitsInByte(0x02)).toBe(0x40);
		expect(reverseBitsInByte(0x80)).toBe(0x01);
		expect(reverseBitsInByte(0xff)).toBe(0xff);
		expect(reverseBitsInByte(0xa5)).toBe(0xa5); // palindrome
		// Check round-trip for every byte value.
		for (let i = 0; i < 256; i++) {
			expect(reverseBitsInByte(reverseBitsInByte(i))).toBe(i);
		}
	});

	it('exposes 50+ known keys with documented game attributions', () => {
		expect(KNOWN_BANK_KEYS.length).toBeGreaterThan(50);
		// Every entry must have a non-empty game name + key.
		for (const e of KNOWN_BANK_KEYS) {
			expect(e.game.length).toBeGreaterThan(0);
			expect(e.key.length).toBeGreaterThan(0);
		}
	});
});

describe('synthetic plaintext bank', () => {
	it('parses the RIFF/FEV chunk tree and exposes SNDH metadata', async () => {
		const bank = buildSyntheticBank(buildMinimalFsb5(), /* padding */ 0);
		const parsed = await parseFmodBank(blob(bank));
		expect(parsed.formType).toBe('FEV ');
		const ids = parsed.chunks.map((c) => c.id);
		expect(ids).toContain('FMT ');
		expect(ids).toContain('LIST');
		expect(ids).toContain('SNDH');
		expect(ids).toContain('SND ');
		// LIST recurses
		const list = parsed.chunks.find((c) => c.id === 'LIST');
		expect(list?.listFormType).toBe('PROJ');
		expect(list!.children.map((c) => c.id)).toContain('BNKI');
		// SNDH metadata extracted
		expect(parsed.sndh).not.toBeNull();
		expect(parsed.sndh!.fsbSize).toBe(60); // matches our minimal FSB5
	});

	it('extracts FSB5 from a plaintext (unencrypted) bank', async () => {
		const bank = buildSyntheticBank(buildMinimalFsb5(), 0);
		const blanc = blob(bank);
		const parsed = await parseFmodBank(blanc);
		const result = await extractFsb5FromBank(parsed, blanc);
		expect(result).not.toBeNull();
		expect(result!.wasEncrypted).toBe(false);
		expect(result!.matchedKey).toBeNull();
		expect(result!.fsb5).not.toBeNull();
		expect(String.fromCharCode(...result!.fsb5!.subarray(0, 4))).toBe('FSB5');
	});

	it('skips leading NUL padding bytes before the FSB5 payload', async () => {
		const bank = buildSyntheticBank(buildMinimalFsb5(), /* padding */ 16);
		const parsed = await parseFmodBank(blob(bank));
		const result = await extractFsb5FromBank(parsed, blob(bank));
		expect(result!.paddingBytes).toBe(16);
		expect(String.fromCharCode(...result!.fsb5!.subarray(0, 4))).toBe('FSB5');
	});
});

describe('synthetic encrypted bank', () => {
	it('round-trips encryption: encrypt → auto-detect-key → decrypt → original FSB5', async () => {
		// Pick any key from the list; we use the test's first entry to
		// make this deterministic + minimal.
		const knownKey = KNOWN_BANK_KEYS[0];
		const fsb5 = buildMinimalFsb5();
		// Sanity: encrypting and decrypting locally with the same key
		// must round-trip to the input.
		const encrypted = encryptFsb5Payload(fsb5, knownKey.key);
		// The decryptor's inverse: reverse(encrypted) ^ key = fsb5.
		const roundTrip = new Uint8Array(encrypted.length);
		const keyBytes = new TextEncoder().encode(knownKey.key);
		for (let i = 0; i < encrypted.length; i++) {
			roundTrip[i] = reverseBitsInByte(encrypted[i]) ^ keyBytes[i % keyBytes.length];
		}
		expect(Array.from(roundTrip)).toEqual(Array.from(fsb5));

		// Now wrap the encrypted FSB5 in a bank and verify the
		// auto-detection path picks the right key.
		const bank = buildSyntheticBank(encrypted, /* padding */ 0);
		const blanc = blob(bank);
		const parsed = await parseFmodBank(blanc);
		const result = await tryKnownKeysAndDecrypt(parsed, blanc);
		expect(result.wasEncrypted).toBe(true);
		expect(result.matchedKey).not.toBeNull();
		expect(result.matchedKey!.game).toBe(knownKey.game);
		expect(result.fsb5).not.toBeNull();
		expect(String.fromCharCode(...result.fsb5!.subarray(0, 4))).toBe('FSB5');
		// Full payload should match the original.
		expect(Array.from(result.fsb5!)).toEqual(Array.from(fsb5));
	});

	it('returns null match when no known key works', async () => {
		const fsb5 = buildMinimalFsb5();
		// Encrypt with a key that's intentionally NOT in KNOWN_BANK_KEYS.
		const encrypted = encryptFsb5Payload(fsb5, 'this-is-not-a-real-game-key-xyz!!!');
		const bank = buildSyntheticBank(encrypted, 0);
		const blanc = blob(bank);
		const parsed = await parseFmodBank(blanc);
		const result = await tryKnownKeysAndDecrypt(parsed, blanc);
		expect(result.wasEncrypted).toBe(true);
		expect(result.matchedKey).toBeNull();
		expect(result.fsb5).toBeNull();
	});

	it('handles a `extraKeys` argument for callers with private keys', async () => {
		const customKey = 'my-private-key-abc';
		const fsb5 = buildMinimalFsb5();
		const encrypted = encryptFsb5Payload(fsb5, customKey);
		const bank = buildSyntheticBank(encrypted, 0);
		const blanc = blob(bank);
		const parsed = await parseFmodBank(blanc);
		const result = await tryKnownKeysAndDecrypt(parsed, blanc, [
			{ game: 'Test Game', key: customKey },
		]);
		expect(result.wasEncrypted).toBe(true);
		expect(result.matchedKey?.game).toBe('Test Game');
		expect(result.fsb5).not.toBeNull();
		expect(String.fromCharCode(...result.fsb5!.subarray(0, 4))).toBe('FSB5');
	});
});
