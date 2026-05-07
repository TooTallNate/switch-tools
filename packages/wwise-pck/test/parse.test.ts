import { describe, expect, it } from 'vitest';
import { parseAkpk, isAkpk, AKPK_MAGIC } from '../src/index.js';

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts.
 */

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

describe('synthetic AKPK — larger N entries', () => {
	/**
	 * Build a synthetic AKPK with N streamed entries to exercise the
	 * binary-search code path on a non-trivial table. Same shape as
	 * the minimal builder but with a parametrised entry count.
	 */
	function buildSyntheticN(n: number): Uint8Array {
		const langName = new TextEncoder().encode('sfx');
		const langMap = new Uint8Array(4 + 8 + langName.length + 1);
		const lmDv = new DataView(langMap.buffer);
		lmDv.setUint32(0, 1, true);
		lmDv.setUint32(4, 12, true);
		lmDv.setUint32(8, 0, true);
		langMap.set(langName, 12);

		const sbTable = new Uint8Array(4);
		const streamTable = new Uint8Array(4 + n * 20);
		const stDv = new DataView(streamTable.buffer);
		stDv.setUint32(0, n, true);
		const extTable = new Uint8Array(4);

		const headerBody =
			(0x1c - 8) +
			langMap.byteLength +
			sbTable.byteLength +
			streamTable.byteLength +
			extTable.byteLength;
		const totalHeader = 8 + headerBody;

		// Each entry gets a 4-byte payload at totalHeader + i*4.
		for (let i = 0; i < n; i++) {
			const eo = 4 + i * 20;
			stDv.setUint32(eo, 0x10000000 + i, true); // id
			stDv.setUint32(eo + 4, 1, true); // blockSize
			stDv.setUint32(eo + 8, 4, true); // size
			stDv.setUint32(eo + 12, totalHeader + i * 4, true); // dataOff
			stDv.setUint32(eo + 16, 0, true); // langIdx
		}

		const totalSize = totalHeader + n * 4;
		const out = new Uint8Array(totalSize);
		const prelude = new Uint8Array(0x1c);
		const pDv = new DataView(prelude.buffer);
		prelude[0] = 0x41; prelude[1] = 0x4b; prelude[2] = 0x50; prelude[3] = 0x4b;
		pDv.setUint32(4, headerBody, true);
		pDv.setUint32(8, 1, true);
		pDv.setUint32(12, langMap.byteLength, true);
		pDv.setUint32(16, sbTable.byteLength, true);
		pDv.setUint32(20, streamTable.byteLength, true);
		pDv.setUint32(24, extTable.byteLength, true);

		out.set(prelude, 0);
		out.set(langMap, 0x1c);
		out.set(sbTable, 0x1c + langMap.byteLength);
		out.set(streamTable, 0x1c + langMap.byteLength + sbTable.byteLength);
		out.set(extTable, 0x1c + langMap.byteLength + sbTable.byteLength + streamTable.byteLength);
		// Fill each entry's 4 bytes with a deterministic pattern.
		for (let i = 0; i < n; i++) {
			const off = totalHeader + i * 4;
			out[off] = (i >> 0) & 0xff;
			out[off + 1] = (i >> 8) & 0xff;
			out[off + 2] = 0xab;
			out[off + 3] = 0xcd;
		}
		return out;
	}

	it('parses 1000 streamed entries with correct ids + sizes', async () => {
		const bytes = buildSyntheticN(1000);
		const parsed = await parseAkpk(blob(bytes));
		expect(parsed.streamedFiles.length).toBe(1000);
		expect(parsed.streamedFiles[0].id).toBe(0x10000000);
		expect(parsed.streamedFiles[999].id).toBe(0x10000000 + 999);
		// Spot-check a middle entry's data payload.
		const mid = await parsed.streamedFiles[500].data.arrayBuffer();
		const midBytes = new Uint8Array(mid);
		expect(midBytes[0]).toBe(500 & 0xff);
		expect(midBytes[1]).toBe((500 >> 8) & 0xff);
		expect(midBytes[2]).toBe(0xab);
		expect(midBytes[3]).toBe(0xcd);
	});
});
