import { describe, it, expect } from 'vitest';
import { build, IVFC_HASH_BLOCK_SIZE, IVFC_HEADER_SIZE } from '../src/index.js';

const HASH_SIZE = 0x20;

/** Read the level-6 (data) `hash_data_size` recorded in an IVFC header. */
function dataLevelHashDataSize(header: ArrayBuffer): number {
	const view = new DataView(header);
	// 6 level headers, each 0x18 bytes, starting at 0x10. The data level is
	// the last one (index 5).
	const entryOffset = 0x10 + 5 * 0x18;
	return Number(view.getBigUint64(entryOffset + 0x08, true));
}

function masterHash(header: ArrayBuffer): Uint8Array {
	return new Uint8Array(header.slice(0xc0, 0xc0 + HASH_SIZE));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

describe('IVFC build', () => {
	it('records the *unpadded* RomFS size as level-6 hash_data_size', async () => {
		// A realistic control RomFS that does not end on a block boundary:
		// 3 full blocks + a partial block. This is exactly the case that, when
		// recorded with the padded size, makes the Home Menu icon spin forever.
		const originalSize = 3 * IVFC_HASH_BLOCK_SIZE + 6852;
		const paddedSize =
			originalSize +
			(IVFC_HASH_BLOCK_SIZE - (originalSize % IVFC_HASH_BLOCK_SIZE));

		const padded = new Uint8Array(paddedSize);
		for (let i = 0; i < originalSize; i++) padded[i] = (i * 7 + 1) & 0xff;
		// bytes [originalSize, paddedSize) stay zero (the on-disk padding)

		const result = await build(padded, globalThis.crypto, originalSize);

		expect(result.header.byteLength).toBe(IVFC_HEADER_SIZE);
		// The key assertion: the recorded data size must be the *logical*
		// (unpadded) RomFS size, not the padded buffer length.
		expect(dataLevelHashDataSize(result.header)).toBe(originalSize);
		expect(dataLevelHashDataSize(result.header)).not.toBe(paddedSize);
	});

	it('defaults hash_data_size to the buffer length when no originalSize is given', async () => {
		const data = new Uint8Array(2 * IVFC_HASH_BLOCK_SIZE);
		const result = await build(data, globalThis.crypto);
		expect(dataLevelHashDataSize(result.header)).toBe(data.length);
	});

	it('hashes the final (partial) data block padded to the block size', async () => {
		// The last data block must be hashed as a full, zero-padded block —
		// this matches hacbrewpack, which zero-pads the RomFS on disk before
		// computing the IVFC levels.
		const originalSize = IVFC_HASH_BLOCK_SIZE + 100;
		const padded = new Uint8Array(2 * IVFC_HASH_BLOCK_SIZE);
		for (let i = 0; i < originalSize; i++) padded[i] = (i + 3) & 0xff;

		const result = await build(padded, globalThis.crypto, originalSize);

		// level5 is the hash table of the data level; it's the last entry in
		// `levels` (levels are stored top-down: level1..level5).
		const level5 = result.levels[result.levels.length - 1];
		const storedLastHash = level5.subarray(HASH_SIZE, HASH_SIZE * 2);

		const fullPaddedBlock = padded.subarray(
			IVFC_HASH_BLOCK_SIZE,
			2 * IVFC_HASH_BLOCK_SIZE
		);
		const expected = await sha256(fullPaddedBlock);
		expect([...storedLastHash]).toEqual([...expected]);
	});

	it('master hash equals SHA-256 of level 1', async () => {
		const originalSize = IVFC_HASH_BLOCK_SIZE + 1;
		const padded = new Uint8Array(2 * IVFC_HASH_BLOCK_SIZE);
		padded[0] = 0xaa;
		const result = await build(padded, globalThis.crypto, originalSize);
		const expected = await sha256(result.levels[0]);
		expect([...masterHash(result.header)]).toEqual([...expected]);
	});
});
