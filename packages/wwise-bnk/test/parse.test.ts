import { describe, expect, it } from 'vitest';
import { parseBnk, isBnk, BKHD_MAGIC, isKnownBnkChunkId } from '../src/index.js';

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts.
 */

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
}

/** Build a 4-char + size + payload chunk. */
function buildChunk(id: string, payload: Uint8Array): Uint8Array {
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

describe('BKHD magic', () => {
	it('exports the expected ASCII magic', () => {
		expect(BKHD_MAGIC).toBe('BKHD');
	});
	it('isBnk recognises BKHD prefix', async () => {
		expect(await isBnk(blob(new TextEncoder().encode('BKHD....')))).toBe(true);
		expect(await isBnk(blob(new TextEncoder().encode('AKPK....')))).toBe(false);
		expect(await isBnk(blob(new Uint8Array(2)))).toBe(false);
	});
	it('isKnownBnkChunkId tags known chunks', () => {
		expect(isKnownBnkChunkId('BKHD')).toBe(true);
		expect(isKnownBnkChunkId('DIDX')).toBe(true);
		expect(isKnownBnkChunkId('DATA')).toBe(true);
		expect(isKnownBnkChunkId('HIRC')).toBe(true);
		expect(isKnownBnkChunkId('XXXX')).toBe(false);
	});
});

describe('synthetic BNK', () => {
	it('parses a hand-built bank with one WEM', async () => {
		// BKHD: ver=140, bankId=0xCAFEBABE, langId=0, headerSize=0
		const bkhdPayload = new Uint8Array(16);
		const bdv = new DataView(bkhdPayload.buffer);
		bdv.setUint32(0, 140, true);
		bdv.setUint32(4, 0xcafebabe, true);
		bdv.setUint32(8, 0, true);
		bdv.setUint32(12, 0, true);

		// DIDX: one entry — wem_id, off=0, size=4
		const didxPayload = new Uint8Array(12);
		const ddv = new DataView(didxPayload.buffer);
		ddv.setUint32(0, 0xdeadbeef, true);
		ddv.setUint32(4, 0, true);
		ddv.setUint32(8, 4, true);

		// DATA: 4 bytes
		const dataPayload = new Uint8Array([0x11, 0x22, 0x33, 0x44]);

		const out = concat(
			buildChunk('BKHD', bkhdPayload),
			buildChunk('DIDX', didxPayload),
			buildChunk('DATA', dataPayload),
		);

		const parsed = await parseBnk(blob(out));
		expect(parsed.header.version).toBe(140);
		expect(parsed.header.bankId).toBe(0xcafebabe);
		expect(parsed.chunks.map((c) => c.id)).toEqual(['BKHD', 'DIDX', 'DATA']);
		expect(parsed.wems.length).toBe(1);
		expect(parsed.wems[0].id).toBe(0xdeadbeef);
		expect(parsed.wems[0].size).toBe(4);
		const wemBytes = new Uint8Array(await parsed.wems[0].data.arrayBuffer());
		expect(Array.from(wemBytes)).toEqual([0x11, 0x22, 0x33, 0x44]);
	});

	it('parses a HIRC-only init bank with no embedded WEMs', async () => {
		const bkhdPayload = new Uint8Array(16);
		new DataView(bkhdPayload.buffer).setUint32(0, 140, true);
		const hircPayload = new Uint8Array([0, 0, 0, 0]); // 0 objects
		const out = concat(buildChunk('BKHD', bkhdPayload), buildChunk('HIRC', hircPayload));

		const parsed = await parseBnk(blob(out));
		expect(parsed.chunks.map((c) => c.id)).toEqual(['BKHD', 'HIRC']);
		expect(parsed.wems.length).toBe(0);
	});

	it('parses a multi-WEM bank with non-contiguous data offsets', async () => {
		// 3 WEMs, scattered in the DATA chunk.
		const bkhdPayload = new Uint8Array(16);
		new DataView(bkhdPayload.buffer).setUint32(0, 140, true);

		// 3 DIDX entries pointing at DATA payload offsets 0, 16, 36.
		// WEM 0: 8 bytes, WEM 1: 16 bytes (with padding), WEM 2: 12 bytes.
		const didxPayload = new Uint8Array(36);
		const ddv = new DataView(didxPayload.buffer);
		ddv.setUint32(0, 0x1111, true);
		ddv.setUint32(4, 0, true);
		ddv.setUint32(8, 8, true);
		ddv.setUint32(12, 0x2222, true);
		ddv.setUint32(16, 16, true);
		ddv.setUint32(20, 16, true);
		ddv.setUint32(24, 0x3333, true);
		ddv.setUint32(28, 36, true);
		ddv.setUint32(32, 12, true);

		const dataPayload = new Uint8Array(48);
		// Fill with deterministic bytes per region.
		for (let i = 0; i < 8; i++) dataPayload[i] = 0xaa;
		for (let i = 16; i < 32; i++) dataPayload[i] = 0xbb;
		for (let i = 36; i < 48; i++) dataPayload[i] = 0xcc;

		const out = concat(
			buildChunk('BKHD', bkhdPayload),
			buildChunk('DIDX', didxPayload),
			buildChunk('DATA', dataPayload),
		);

		const parsed = await parseBnk(blob(out));
		expect(parsed.wems.length).toBe(3);
		expect(parsed.wems[0].id).toBe(0x1111);
		expect(parsed.wems[1].id).toBe(0x2222);
		expect(parsed.wems[2].id).toBe(0x3333);
		expect(parsed.wems[0].size).toBe(8);
		expect(parsed.wems[1].size).toBe(16);
		expect(parsed.wems[2].size).toBe(12);

		// Verify each WEM payload is the right region.
		const w0 = new Uint8Array(await parsed.wems[0].data.arrayBuffer());
		expect(w0.every((b) => b === 0xaa)).toBe(true);
		const w1 = new Uint8Array(await parsed.wems[1].data.arrayBuffer());
		expect(w1.every((b) => b === 0xbb)).toBe(true);
		const w2 = new Uint8Array(await parsed.wems[2].data.arrayBuffer());
		expect(w2.every((b) => b === 0xcc)).toBe(true);
	});

	it('handles the BKHD-DIDX-DATA-HIRC chunk ordering common in audio banks', async () => {
		const bkhdPayload = new Uint8Array(16);
		new DataView(bkhdPayload.buffer).setUint32(0, 140, true);
		const didxPayload = new Uint8Array(12);
		const ddv = new DataView(didxPayload.buffer);
		ddv.setUint32(0, 0xabcdef00, true);
		ddv.setUint32(4, 0, true);
		ddv.setUint32(8, 4, true);
		const dataPayload = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
		const hircPayload = new Uint8Array(8); // 0 objects + padding

		const out = concat(
			buildChunk('BKHD', bkhdPayload),
			buildChunk('DIDX', didxPayload),
			buildChunk('DATA', dataPayload),
			buildChunk('HIRC', hircPayload),
		);

		const parsed = await parseBnk(blob(out));
		expect(parsed.chunks.map((c) => c.id)).toEqual(['BKHD', 'DIDX', 'DATA', 'HIRC']);
		expect(parsed.wems.length).toBe(1);
		// Verify the WEM payload is the embedded "RIFF" magic.
		const w = new Uint8Array(await parsed.wems[0].data.arrayBuffer());
		expect(String.fromCharCode(...w)).toBe('RIFF');
	});

	it('rejects non-BNK input', async () => {
		await expect(parseBnk(blob(new TextEncoder().encode('NOPE')))).rejects.toThrow();
	});

	it('rejects too-small input', async () => {
		await expect(parseBnk(blob(new Uint8Array(8)))).rejects.toThrow();
	});
});
