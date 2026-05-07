import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBnk, isBnk, BKHD_MAGIC, isKnownBnkChunkId } from '../src/index.js';

const SAMPLE_DIR = '/tmp/samples/bnk';
const ADEMO = resolve(SAMPLE_DIR, 'pla__ADEMO.bnk');
const BGM = resolve(SAMPLE_DIR, 'pla__BGM.bnk');
const ME = resolve(SAMPLE_DIR, 'pla__ME.bnk');
const BATTLE = resolve(SAMPLE_DIR, 'pla__BATTLE_SYSTEM.bnk');
const INIT = resolve(SAMPLE_DIR, 'pla__Init.bnk');

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
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
		// BKHD (16 bytes payload: ver=140, bankId=0xCAFEBABE, langId=0, headerSize=0)
		const bkhd = new Uint8Array(8 + 16);
		new TextEncoder().encodeInto('BKHD', bkhd);
		new DataView(bkhd.buffer).setUint32(4, 16, true);
		new DataView(bkhd.buffer).setUint32(8, 140, true);
		new DataView(bkhd.buffer).setUint32(12, 0xcafebabe, true);
		new DataView(bkhd.buffer).setUint32(16, 0, true);
		new DataView(bkhd.buffer).setUint32(20, 0, true);

		// DIDX: one entry pointing into DATA at offset 0, size 4
		const didx = new Uint8Array(8 + 12);
		new TextEncoder().encodeInto('DIDX', didx);
		new DataView(didx.buffer).setUint32(4, 12, true);
		new DataView(didx.buffer).setUint32(8, 0xdeadbeef, true); // wem id
		new DataView(didx.buffer).setUint32(12, 0, true); // off
		new DataView(didx.buffer).setUint32(16, 4, true); // size

		// DATA: 4-byte WEM payload
		const data = new Uint8Array(8 + 4);
		new TextEncoder().encodeInto('DATA', data);
		new DataView(data.buffer).setUint32(4, 4, true);
		data.set([0x11, 0x22, 0x33, 0x44], 8);

		// Stitch.
		const out = new Uint8Array(bkhd.length + didx.length + data.length);
		out.set(bkhd, 0);
		out.set(didx, bkhd.length);
		out.set(data, bkhd.length + didx.length);

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

	it('rejects non-BNK input', async () => {
		await expect(parseBnk(blob(new TextEncoder().encode('NOPE')))).rejects.toThrow();
	});
});

describe.runIf(existsSync(ADEMO))('ADEMO.bnk (PLA, HIRC-only)', () => {
	it('parses a HIRC-only bank with no embedded WEMs', async () => {
		const bytes = readFileSync(ADEMO);
		const parsed = await parseBnk(blob(new Uint8Array(bytes)));
		expect(parsed.chunks.map((c) => c.id)).toContain('BKHD');
		expect(parsed.chunks.map((c) => c.id)).toContain('HIRC');
		expect(parsed.chunks.find((c) => c.id === 'DIDX')).toBeUndefined();
		expect(parsed.wems.length).toBe(0);
	});
});

describe.runIf(existsSync(BGM))('BGM.bnk (PLA, mixed Opus/Vorbis)', () => {
	it('parses 2 embedded WEMs plus HIRC', async () => {
		const bytes = readFileSync(BGM);
		const parsed = await parseBnk(blob(new Uint8Array(bytes)));
		expect(parsed.chunks.map((c) => c.id)).toEqual(['BKHD', 'DIDX', 'DATA', 'HIRC']);
		expect(parsed.wems.length).toBe(2);
		// First WEM payload starts with "RIFF"
		const first = new Uint8Array(await parsed.wems[0].data.slice(0, 4).arrayBuffer());
		expect(String.fromCharCode(...first)).toBe('RIFF');
	});
});

describe.runIf(existsSync(BATTLE))('BATTLE_SYSTEM.bnk (PLA, 159 SFX)', () => {
	it('parses 159 embedded WEMs', async () => {
		const bytes = readFileSync(BATTLE);
		const parsed = await parseBnk(blob(new Uint8Array(bytes)));
		expect(parsed.wems.length).toBe(159);
		// Spot-check first ID seen during probing
		expect(parsed.wems[0].id).toBe(0x0016d39e);
	});
});

describe.runIf(existsSync(ME))('ME.bnk (PLA, music events)', () => {
	it('parses 3 embedded WEMs', async () => {
		const bytes = readFileSync(ME);
		const parsed = await parseBnk(blob(new Uint8Array(bytes)));
		expect(parsed.wems.length).toBe(3);
	});
});

describe.runIf(existsSync(INIT))('Init.bnk (PLA, init bank)', () => {
	it('parses init-bank chunks (no WEMs)', async () => {
		const bytes = readFileSync(INIT);
		const parsed = await parseBnk(blob(new Uint8Array(bytes)));
		const ids = parsed.chunks.map((c) => c.id);
		expect(ids[0]).toBe('BKHD');
		expect(parsed.wems.length).toBe(0);
	});
});
