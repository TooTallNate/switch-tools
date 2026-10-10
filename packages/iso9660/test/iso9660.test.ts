import { describe, expect, it } from 'vitest';
import {
	blobSectorReader,
	cddaToWav,
	detectIsoImage,
	entryDataSize,
	isCddaEntry,
	isRawEntry,
	msfToLba,
	parseIso9660,
	RAW_SECTOR_SIZE,
	readIsoFile,
	USER_SECTOR_SIZE,
	XA_CDDA,
	XA_FORM1,
	XA_FORM2,
	XA_INTERLEAVED,
} from '../src/index.js';

interface Rec {
	name: string;
	lba: number;
	size: number;
	dir?: boolean;
	xa?: number;
}

function record(r: Rec): Uint8Array {
	const name = r.name === '.' ? '\0' : r.name === '..' ? '\x01' : r.name;
	const nameLen = name.length;
	const pad = nameLen % 2 === 0 ? 1 : 0;
	const len = 33 + nameLen + pad + (r.xa !== undefined ? 14 : 0);
	const b = new Uint8Array(len + (len & 1));
	const dv = new DataView(b.buffer);
	b[0] = b.length;
	dv.setUint32(2, r.lba, true);
	dv.setUint32(6, r.lba, false);
	dv.setUint32(10, r.size, true);
	dv.setUint32(14, r.size, false);
	b[25] = r.dir ? 2 : 0;
	b[32] = nameLen;
	for (let i = 0; i < nameLen; i++) b[33 + i] = name.charCodeAt(i);
	if (r.xa !== undefined) {
		const su = 33 + nameLen + pad;
		dv.setUint16(su + 4, r.xa, false);
		b[su + 6] = 0x58; // 'X'
		b[su + 7] = 0x41; // 'A'
		b[su + 8] = 1; // file number
	}
	return b;
}

function directory(records: Rec[]): Uint8Array {
	const out = new Uint8Array(USER_SECTOR_SIZE);
	let p = 0;
	for (const r of records) {
		const rec = record(r);
		out.set(rec, p);
		p += rec.length;
	}
	return out;
}

/** A cooked (2048-byte sector) image: README.TXT, DATA/A.BIN, MOVIE.STR (XA), TRACK.DA (CD-DA). */
function buildCooked(): Uint8Array {
	const sectors = 40;
	const img = new Uint8Array(sectors * USER_SECTOR_SIZE);
	const at = (s: number) => s * USER_SECTOR_SIZE;
	const pvd = img.subarray(at(16), at(17));
	pvd.set([1, 0x43, 0x44, 0x30, 0x30, 0x31, 1]);
	pvd.set(new TextEncoder().encode('PLAYSTATION'.padEnd(32)), 8);
	pvd.set(new TextEncoder().encode('TESTDISC'.padEnd(32)), 40);
	new DataView(pvd.buffer, pvd.byteOffset).setUint32(80, sectors, true);
	pvd.set(record({ name: '.', lba: 20, size: USER_SECTOR_SIZE, dir: true }), 156);
	img.set(
		directory([
			{ name: '.', lba: 20, size: USER_SECTOR_SIZE, dir: true },
			{ name: '..', lba: 20, size: USER_SECTOR_SIZE, dir: true },
			{ name: 'DATA', lba: 21, size: USER_SECTOR_SIZE, dir: true, xa: XA_FORM1 | 0x8000 },
			{ name: 'MOVIE.STR;1', lba: 23, size: 2 * USER_SECTOR_SIZE, xa: XA_FORM2 | XA_INTERLEAVED },
			{ name: 'README.TXT;1', lba: 22, size: 5, xa: XA_FORM1 },
			{ name: 'TRACK.DA;1', lba: 30, size: 4 * USER_SECTOR_SIZE, xa: XA_CDDA },
		]),
		at(20),
	);
	img.set(
		directory([
			{ name: '.', lba: 21, size: USER_SECTOR_SIZE, dir: true },
			{ name: '..', lba: 20, size: USER_SECTOR_SIZE, dir: true },
			{ name: 'A.BIN;1', lba: 25, size: 3000 },
		]),
		at(21),
	);
	img.set(new TextEncoder().encode('hello'), at(22));
	img.fill(0x41, at(25), at(25) + 3000);
	return img;
}

/** Same image as raw Mode 2 sectors (sync, header, subheader, user data at 24). */
function toRaw(cooked: Uint8Array): Uint8Array {
	const n = cooked.length / USER_SECTOR_SIZE;
	const raw = new Uint8Array(n * RAW_SECTOR_SIZE);
	for (let i = 0; i < n; i++) {
		const o = i * RAW_SECTOR_SIZE;
		raw.set([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0], o);
		raw[o + 15] = 2;
		raw[o + 18] = raw[o + 22] = 0x08;
		raw.set(cooked.subarray(i * USER_SECTOR_SIZE, (i + 1) * USER_SECTOR_SIZE), o + 24);
	}
	return raw;
}

describe('iso9660', () => {
	it('detects cooked and raw images', async () => {
		const cooked = buildCooked();
		expect(await detectIsoImage(new Blob([cooked]))).toBe(USER_SECTOR_SIZE);
		expect(await detectIsoImage(new Blob([toRaw(cooked)]))).toBe(RAW_SECTOR_SIZE);
		expect(await detectIsoImage(new Blob([new Uint8Array(40 * 2048)]))).toBeNull();
	});

	it('parses the directory tree with XA attributes', async () => {
		const reader = blobSectorReader(new Blob([buildCooked()]), USER_SECTOR_SIZE);
		const iso = await parseIso9660(reader);
		expect(iso).toMatchObject({ systemId: 'PLAYSTATION', volumeId: 'TESTDISC', volumeSectors: 40 });
		expect(iso.entries.map((e) => [e.path, e.isDirectory])).toEqual([
			['DATA', true],
			['DATA/A.BIN', false],
			['MOVIE.STR', false],
			['README.TXT', false],
			['TRACK.DA', false],
		]);
		const movie = iso.entries.find((e) => e.name === 'MOVIE.STR')!;
		expect(isRawEntry(movie)).toBe(true);
		expect(isCddaEntry(iso.entries.find((e) => e.name === 'TRACK.DA')!)).toBe(true);
		expect(isRawEntry(iso.entries.find((e) => e.name === 'README.TXT')!)).toBe(false);
	});

	it('reads user data from cooked and raw images, raw sectors for XA files', async () => {
		const cooked = buildCooked();
		for (const [bytes, size] of [
			[cooked, USER_SECTOR_SIZE],
			[toRaw(cooked), RAW_SECTOR_SIZE],
		] as const) {
			const reader = blobSectorReader(new Blob([bytes]), size);
			const iso = await parseIso9660(reader);
			const get = (n: string) => iso.entries.find((e) => e.path === n)!;
			expect(new TextDecoder().decode(await readIsoFile(reader, get('README.TXT')))).toBe('hello');
			const a = await readIsoFile(reader, get('DATA/A.BIN'));
			expect(a.length).toBe(3000);
			expect(a.every((b) => b === 0x41)).toBe(true);
			const movie = await readIsoFile(reader, get('MOVIE.STR'));
			expect(movie.length).toBe(entryDataSize(get('MOVIE.STR'), reader));
			expect(movie.length).toBe(size === RAW_SECTOR_SIZE ? 2 * RAW_SECTOR_SIZE : 2 * USER_SECTOR_SIZE);
		}
	});

	it('wraps CD-DA sectors as 44.1 kHz stereo WAV', () => {
		const wav = cddaToWav(new Uint8Array(RAW_SECTOR_SIZE));
		const dv = new DataView(wav.buffer);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
		expect([dv.getUint16(22, true), dv.getUint32(24, true), dv.getUint32(40, true)]).toEqual([2, 44100, RAW_SECTOR_SIZE]);
	});

	it('converts MSF addresses', () => {
		expect(msfToLba(0, 2, 0)).toBe(0);
		expect(msfToLba(34, 32, 22)).toBe(155272);
	});
});
