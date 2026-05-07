import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAkpk, isAkpk, AKPK_MAGIC } from '../src/index.js';

const SAMPLE_DIR = '/tmp/samples/pck';
const LOOSE = resolve(SAMPLE_DIR, 'pla__LooseMedia.pck');
const DEFAULT_HEAD = resolve(SAMPLE_DIR, 'pla__Default-head128k.bin');

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
}

describe('AKPK magic', () => {
	it('exports the expected ASCII magic', () => {
		expect(AKPK_MAGIC).toBe('AKPK');
	});
	it('isAkpk recognises both LE and BE variants', async () => {
		expect(await isAkpk(blob(new TextEncoder().encode('AKPK....')))).toBe(true);
		expect(await isAkpk(blob(new TextEncoder().encode('KPKA....')))).toBe(true);
		expect(await isAkpk(blob(new TextEncoder().encode('NOPE....')))).toBe(false);
		expect(await isAkpk(blob(new Uint8Array([0x41, 0x4b])))).toBe(false);
	});
	it('rejects garbage', async () => {
		const bytes = new Uint8Array(32);
		await expect(parseAkpk(blob(bytes))).rejects.toThrow();
	});
});

describe('synthetic AKPK', () => {
	function buildSynthetic(): Uint8Array {
		// One language ("sfx"), zero soundbanks, two streamed entries.
		const langCount = 1;
		const langName = new TextEncoder().encode('sfx');
		const langMap = new Uint8Array(4 + 8 + langName.length + 1);
		const lmDv = new DataView(langMap.buffer);
		lmDv.setUint32(0, langCount, true); // count
		// nameOff is relative to the langMap base (start of `count`),
		// so name placed at byte 12 of the langMap means nameOff = 12.
		lmDv.setUint32(4, 12, true); // nameOff = 12
		lmDv.setUint32(8, 0, true); // langId
		langMap.set(langName, 12);
		// langMap byte 12+3 = NUL (already 0)

		const sbTable = new Uint8Array(4); // count=0

		const streamCount = 2;
		const streamTable = new Uint8Array(4 + streamCount * 20);
		const stDv = new DataView(streamTable.buffer);
		stDv.setUint32(0, streamCount, true);
		// Entry 0: id=0xCAFEBABE, size=4, dataOff=will fix below
		stDv.setUint32(4, 0xcafebabe, true);
		stDv.setUint32(8, 1, true); // blockSize
		stDv.setUint32(12, 4, true); // size
		// dataOff filled in after we know header size
		// Entry 1: id=0xDEADBEEF, size=8
		stDv.setUint32(24, 0xdeadbeef, true);
		stDv.setUint32(28, 1, true);
		stDv.setUint32(32, 8, true);

		const extTable = new Uint8Array(4); // count=0

		// Real Wwise's headerSize covers everything from after the
		// 8-byte (magic+size) prelude up to the end of all four
		// sub-tables — i.e. the prelude's six u32 fields plus the
		// langMap/sbTable/streamTable/extTable bytes.
		const headerBody =
			(0x1c - 8) + // remaining prelude fields after magic+size
			langMap.byteLength +
			sbTable.byteLength +
			streamTable.byteLength +
			extTable.byteLength;
		const prelude = new Uint8Array(0x1c);
		const pDv = new DataView(prelude.buffer);
		prelude[0] = 0x41; prelude[1] = 0x4b; prelude[2] = 0x50; prelude[3] = 0x4b; // AKPK
		pDv.setUint32(4, headerBody, true);
		pDv.setUint32(8, 1, true); // version
		pDv.setUint32(12, langMap.byteLength, true);
		pDv.setUint32(16, sbTable.byteLength, true);
		pDv.setUint32(20, streamTable.byteLength, true);
		pDv.setUint32(24, extTable.byteLength, true);

		const totalHeader = 8 + headerBody;
		const wem0Off = totalHeader;
		const wem1Off = totalHeader + 4;

		// Patch dataOff fields
		stDv.setUint32(16, wem0Off, true);
		stDv.setUint32(36, wem1Off, true);

		const out = new Uint8Array(totalHeader + 4 + 8);
		out.set(prelude, 0);
		out.set(langMap, 0x1c);
		out.set(sbTable, 0x1c + langMap.byteLength);
		out.set(streamTable, 0x1c + langMap.byteLength + sbTable.byteLength);
		out.set(extTable, 0x1c + langMap.byteLength + sbTable.byteLength + streamTable.byteLength);
		out.set([0x11, 0x22, 0x33, 0x44], wem0Off);
		out.set([0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc], wem1Off);
		return out;
	}

	it('parses a minimal hand-built AKPK', async () => {
		const bytes = buildSynthetic();
		const parsed = await parseAkpk(blob(bytes));
		expect(parsed.endian).toBe('little');
		expect(parsed.version).toBe(1);
		expect(parsed.languageMap).toEqual([{ index: 0, name: 'sfx', id: 0 }]);
		expect(parsed.soundbanks.length).toBe(0);
		expect(parsed.streamedFiles.length).toBe(2);
		expect(parsed.streamedFiles[0].id).toBe(0xcafebabe);
		expect(parsed.streamedFiles[0].size).toBe(4);
		expect(parsed.streamedFiles[1].id).toBe(0xdeadbeef);
		expect(parsed.streamedFiles[1].size).toBe(8);
		const w0 = new Uint8Array(await parsed.streamedFiles[0].data.arrayBuffer());
		expect(Array.from(w0)).toEqual([0x11, 0x22, 0x33, 0x44]);
	});
});

describe.runIf(existsSync(LOOSE))('LooseMedia.pck (PLA, empty)', () => {
	it('parses headers with all-empty tables', async () => {
		const bytes = readFileSync(LOOSE);
		const parsed = await parseAkpk(blob(new Uint8Array(bytes)));
		expect(parsed.version).toBe(1);
		expect(parsed.languageMap[0].name).toBe('sfx');
		expect(parsed.soundbanks.length).toBe(0);
		expect(parsed.streamedFiles.length).toBe(0);
	});
});

describe.runIf(existsSync(DEFAULT_HEAD))('Default.pck head (PLA, 128 KB)', () => {
	it('parses 5,471 streamed entries from the header dump', async () => {
		const bytes = readFileSync(DEFAULT_HEAD);
		// We have 128 KB which fits the entire 109 KB header + a few KB of
		// payload. Header parsing fully succeeds; data Blobs for entries
		// pointing past 128 KB will be truncated/empty (acceptable here).
		const parsed = await parseAkpk(blob(new Uint8Array(bytes)));
		expect(parsed.version).toBe(1);
		expect(parsed.streamedFiles.length).toBe(5471);
		expect(parsed.streamedFiles[0].id).toBe(0x0000f2cb);
		expect(parsed.streamedFiles[0].size).toBe(22007);
		expect(parsed.streamedFiles[0].dataOffset).toBe(0x1aba4);
		expect(parsed.languageMap[0].name).toBe('sfx');
	});
});
