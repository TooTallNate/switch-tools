import { describe, it, expect } from 'vitest';
import {
	BFSAR_MAGIC,
	STRG_MAGIC,
	INFO_MAGIC,
	FILE_MAGIC,
	isBfsar,
	parseBfsar,
	extForMagic,
} from '../src/index.js';

/**
 * Real-world test fixture: BotW's `Sound/DummySound.bfsar`. It's
 * 2204 bytes — small enough to inline as base64 — and exercises
 * every code path the parser cares about: a string table with six
 * entries, all five non-file info tables (sound × 2, soundGroup × 1,
 * waveArchive × 1, group × 1, player × 1, files × 4), three
 * inline internal files (`FWSD`, `FWAR`, `FGRP`), and one external
 * file (the `STRM_DUMMY` track that points at
 * `stream/dummy.dspadpcm.bfstm`).
 */
const DUMMY_SOUND_BFSAR_BASE64 =
	'RlNBUv/+QAAAAwIAnAgAAAMAAAAAIAAAQAAAAKABAAABIAAA4AEAAMACAAACIAAAoAQAAPwDAAAAAAAAAAAAAFNUUkegAQAAACQAABAAAAABJAAApAAAAAYAAAABHwAATAAAAAsAAAABHwAAVwAAAAoAAAABHwAAYQAAAA0AAAABHwAAbgAAAAsAAAABHwAAeQAAAAwAAAABHwAAhQAAAA8AAABTVFJNX0RVTU1ZAFdTRF9EVU1NWQBXU0RTRVRfRFVNTVkAV0FSQ19EVU1NWQBHUk9VUF9EVU1NWQBQTEFZRVJfREVGQVVMVAAIAAAACwAAAAEA/////////////wAAAAAAAAABAQD/////////////AQAAAAEAAAEAAAUABgAAAAoAAAD//////////wEA/////////////wIAAAAAAAACAAAcAAMAAAABAAAA//////////8BAP////////////8FAAAAAAAABAAABgAFAAAAAAAAAP//////////AQD/////////////BAAAAAAAAAYAAAMABwAAAAIAAAD//////////wEA/////////////wMAAAAAAAAFAAALAAkAAAAEAAAA//////////8AAAAAAAAAAAAAAAAAAAAASU5GT8ACAAAAIQAAQAAAAAQhAABEAQAAASEAAIwBAAADIQAAkAEAAAUhAACsAQAAAiEAAMQBAAAGIQAA4AEAAAsiAACcAgAAAgAAAAAiAAAUAAAAACIAALAAAAADAAAAAAAABH8AAAABIgAAPAAAAAcBAIAAAAAAAQAAAEAAAAAsAAAAAAAAAA8AAAAAAAA/AQAAAAAAAAABAAEAAQEAACQAAAAAAIA/DyIAAFgAAAAAAAAA//////////8BAAAADiIAAAwAAAB/QAAAAAEAABgAAAAPIgAAIAAAAEAAAAABAAAAAAAAAH8AAAAAAAAAfwAAAAAAAAAAAAAAAAAABH8AAAACIgAARAAAAAcBAoABAAAAAAAAAEAAAAAwAAAAAAAAAAAAAAAPAAAAAAAAPwEAAAAAAAAAAAAAAAAAAAABAAAAAQAAAEAAAAABAAAABCIAAAwAAAABAAABAQAAAQABAAAgAAAABSIAACgAAAABAAAAAgAAAAEAAAAAAAAAAAEAAAwAAAAAAAAAAQAAAAAAAAUAAAAAAQAAAAciAAAMAAAAAQAAAAAAAAABAAAAAwAAAAEAAAAIIgAADAAAAAIAAAABAAAABAAAAAEAAAAJIgAADAAAAIAAAAADAAAABQAAAAAAAAAEAAAACiIAACQAAAAKIgAATAAAAAoiAABwAAAACiIAAJQAAAAMIgAADAAAAAAAAAAAHwAAGAAAANwAAAAAAQAAFAAAAAEAAAAAAAAGDCIAAAwAAAAAAAAAAB8AABgBAAAAAgAAAAEAABQAAAAAAAAADCIAAAwAAAAAAAAAAAAAABgDAADcAAAAAAEAABQAAAAAAAAADSIAAAwAAAAAAAAAc3RyZWFtL2R1bW15LmRzcGFkcGNtLmJmc3RtAAAAAAAIAAgAEABAAEAAAQAAAAAAAAAAAAAAAABGSUxF/AMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEZXU0T//iAAAAEBANwAAAABAAAAAGgAACAAAAC8AAAASU5GT7wAAAAAAQAAEAAAAAEBAAAcAAAAAQAAAAAAAAUAAAAAAQAAAABJAAAMAAAAAUkAABgAAAABAQAASAAAAAEBAAB4AAAABwMAAEAAAAAAAIA/QAAAABgAAAAgAAAAfwMAAAAAAAAAAAAACAAAAH9/f39/AAAAAQAAAANJAAAMAAAAAAAAAAgAAAABAAAABEkAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAJJAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABGV0FS//5AAAAAAQAAAgAAAgAAAABoAABAAAAAIAAAAAFoAABgAAAAoAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAASU5GTyAAAAABAAAAAB8AABgAAACAAQAAAAAAAAAAAABGSUxFoAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEZXQVb//kAAAAIBAIABAAACAAAAAHAAAEAAAABAAAAAAXAAAIAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAABJTkZPQAAAAAEBAACAuwAAAAAAAGAAAAAAAAAAAQAAAABxAAAMAAAAAB8AADgAAAAAAAAA/////wAAAAAAAAAAREFUQQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArAFQA+YEZgbLBw0JKAoWC9MLXQyxDM0MsQxdDNMLFgsoCg0JywdmBuYEUAOsAQAAVP6w/Br7mvk1+PP22PXq9C30o/NP8zPzT/Oj8y306vTY9fP2Nfia+Rr7sPxU/gAArAFQA+YEZgbLBw0JKAoWC9MLXQyxDM0MsQxdDNMLFgsoCg0JywdmBuYEUAOsAQAAVP6w/Br7mvk1+PP22PXq9C30o/NP8zPzT/Oj8y306vTY9fP2Nfia+Rr7sPxU/kZHUlD//kAAAAABANwAAAADAAAAAHgAAEAAAABAAAAAAXgAAIAAAABAAAAAAngAAMAAAAAcAAAAAAAAAAAAAABJTkZPQAAAAAEAAAAAeQAADAAAAAAAAAAAAAAA//////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARklMRUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAElORlgcAAAAAQAAAAF5AAAMAAAAAAAAAgIAAAA=';

function decodeBase64(b64: string): Uint8Array {
	// Vitest runs in Node, so Buffer is available; but be friendly to
	// browser-targeted test environments by using `atob` when present.
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

const dummySoundBytes = decodeBase64(DUMMY_SOUND_BFSAR_BASE64);

describe('isBfsar', () => {
	it('detects the magic', async () => {
		expect(await isBfsar(new Blob([dummySoundBytes as BlobPart]))).toBe(true);
	});
	it('rejects non-BFSAR blobs', async () => {
		expect(
			await isBfsar(new Blob([new Uint8Array([0x42, 0x41, 0x52, 0x53])])),
		).toBe(false);
		expect(await isBfsar(new Blob([]))).toBe(false);
	});
});

describe('parseBfsar (DummySound.bfsar)', () => {
	it('parses the header', async () => {
		const parsed = await parseBfsar(new Blob([dummySoundBytes as BlobPart]));
		expect(parsed.endian).toBe('little');
		expect(parsed.version).toBe(0x00020300);
		expect(parsed.fileSize).toBe(2204);
		expect(parsed.blockCount).toBe(3);
	});

	it('decodes the string table', async () => {
		const parsed = await parseBfsar(new Blob([dummySoundBytes as BlobPart]));
		expect(parsed.strings).toEqual([
			'STRM_DUMMY',
			'WSD_DUMMY',
			'WSDSET_DUMMY',
			'WARC_DUMMY',
			'GROUP_DUMMY',
			'PLAYER_DEFAULT',
		]);
	});

	it('counts items per info table', async () => {
		const parsed = await parseBfsar(new Blob([dummySoundBytes as BlobPart]));
		expect(parsed.counts).toEqual({
			sounds: 2,
			soundGroups: 1,
			banks: 0,
			waveArchives: 1,
			groups: 1,
			players: 1,
			files: 4,
		});
	});

	it('lists named internal files with their inner magic', async () => {
		const parsed = await parseBfsar(new Blob([dummySoundBytes as BlobPart]));
		expect(parsed.internalFiles).toHaveLength(3);
		const byName = Object.fromEntries(
			parsed.internalFiles.map((f) => [f.name, f]),
		);
		expect(byName['WSD_DUMMY']).toMatchObject({
			innerMagic: 'FWSD',
			innerExt: 'bfwsd',
			location: 'inline',
			soundKind: 'wave',
			nameSource: 'sound',
		});
		expect(byName['WARC_DUMMY']).toMatchObject({
			innerMagic: 'FWAR',
			innerExt: 'bfwar',
			location: 'inline',
			nameSource: 'waveArchive',
		});
		expect(byName['GROUP_DUMMY']).toMatchObject({
			innerMagic: 'FGRP',
			innerExt: 'bfgrp',
			location: 'inline',
			nameSource: 'group',
		});
	});

	it('exposes lazy Blob slices for internal files', async () => {
		const parsed = await parseBfsar(new Blob([dummySoundBytes as BlobPart]));
		const wsd = parsed.internalFiles.find((f) => f.name === 'WSD_DUMMY');
		expect(wsd?.data).toBeInstanceOf(Blob);
		expect(wsd?.data?.size).toBe(wsd?.size);
		const bytes = new Uint8Array(await wsd!.data!.arrayBuffer());
		expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe(
			'FWSD',
		);
	});

	it('lists external file references with paths', async () => {
		const parsed = await parseBfsar(new Blob([dummySoundBytes as BlobPart]));
		expect(parsed.externalFiles).toHaveLength(1);
		expect(parsed.externalFiles[0]).toMatchObject({
			name: 'STRM_DUMMY',
			path: 'stream/dummy.dspadpcm.bfstm',
		});
	});
});

describe('parseBfsar error cases', () => {
	it('throws on bad magic', async () => {
		const bad = new Uint8Array(64);
		bad[0] = 0x42;
		bad[1] = 0x41;
		bad[2] = 0x52;
		bad[3] = 0x53;
		await expect(parseBfsar(new Blob([bad as BlobPart]))).rejects.toThrow(
			/BFSAR magic/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseBfsar(new Blob([]))).rejects.toThrow(/too small/);
	});

	it('throws on bogus BOM', async () => {
		const bad = dummySoundBytes.slice();
		bad[4] = 0xaa;
		bad[5] = 0xbb;
		await expect(parseBfsar(new Blob([bad as BlobPart]))).rejects.toThrow(
			/byte-order mark/,
		);
	});
});

describe('extForMagic', () => {
	it('maps known BFSAR inner magics to standard extensions', () => {
		expect(extForMagic('FSTM')).toBe('bfstm');
		expect(extForMagic('FWAV')).toBe('bfwav');
		expect(extForMagic('FSTP')).toBe('bfstp');
		expect(extForMagic('FWAR')).toBe('bfwar');
		expect(extForMagic('FBNK')).toBe('bfbnk');
		expect(extForMagic('FSEQ')).toBe('bfseq');
		expect(extForMagic('FGRP')).toBe('bfgrp');
		expect(extForMagic('FWSD')).toBe('bfwsd');
	});
	it("falls back to 'bin' for unknown magics", () => {
		expect(extForMagic(null)).toBe('bin');
		expect(extForMagic('XXXX')).toBe('bin');
	});
});

describe('exported magic strings', () => {
	it('match the on-disk values', () => {
		expect(BFSAR_MAGIC).toBe('FSAR');
		expect(STRG_MAGIC).toBe('STRG');
		expect(INFO_MAGIC).toBe('INFO');
		expect(FILE_MAGIC).toBe('FILE');
	});
});
