import { deflateRawSync } from 'node:zlib';
import { parseIso9660, readIsoFile } from '@tootallnate/iso9660';
import { describe, expect, it } from 'vitest';
import { isPbp, parsePbp, parsePsisoToc, parseSfo } from '../src/index.js';
import { Aes128, isPgd } from '../src/pgd.js';

const RAW = 2352;

function sfo(entries: [string, string | number][]): Uint8Array {
	const keys = entries.map(([k]) => k + '\0').join('');
	const keyTable = 20 + entries.length * 16;
	const data: number[] = [];
	const index: number[] = [];
	let keyOff = 0;
	for (const [k, v] of entries) {
		const bytes = typeof v === 'number' ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255] : [...new TextEncoder().encode(v + '\0')];
		const e = new Uint8Array(16);
		const dv = new DataView(e.buffer);
		dv.setUint16(0, keyOff, true);
		dv.setUint16(2, typeof v === 'number' ? 0x0404 : 0x0204, true);
		dv.setUint32(4, bytes.length, true);
		dv.setUint32(8, bytes.length, true);
		dv.setUint32(12, data.length, true);
		index.push(...e);
		data.push(...bytes);
		keyOff += k.length + 1;
	}
	const dataTable = (keyTable + keys.length + 3) & ~3;
	const out = new Uint8Array(dataTable + data.length);
	const dv = new DataView(out.buffer);
	out.set([0, 0x50, 0x53, 0x46], 0);
	dv.setUint32(4, 0x0101, true);
	dv.setUint32(8, keyTable, true);
	dv.setUint32(12, dataTable, true);
	dv.setUint32(16, entries.length, true);
	out.set(index, 20);
	out.set(new TextEncoder().encode(keys), keyTable);
	out.set(data, dataTable);
	return out;
}

/** 32 raw Mode 2 sectors: PVD at 16, root directory at 18 with HELLO.TXT at 19. */
function rawDisc(): Uint8Array {
	const img = new Uint8Array(32 * RAW);
	const user = (s: number) => img.subarray(s * RAW + 24, s * RAW + 24 + 2048);
	for (let s = 0; s < 32; s++) img[s * RAW + 15] = 2;
	const pvd = user(16);
	pvd.set([1, 0x43, 0x44, 0x30, 0x30, 0x31, 1]);
	const rec = (lba: number, size: number, name: string, dir: boolean) => {
		const b = new Uint8Array(34 + name.length + (name.length % 2 === 0 ? 1 : 0));
		const dv = new DataView(b.buffer);
		b[0] = b.length;
		dv.setUint32(2, lba, true);
		dv.setUint32(10, size, true);
		b[25] = dir ? 2 : 0;
		b[32] = name.length;
		for (let i = 0; i < name.length; i++) b[33 + i] = name.charCodeAt(i);
		return b;
	};
	pvd.set(rec(18, 2048, '\0', true), 156);
	const root = user(18);
	const self = rec(18, 2048, '\0', true);
	const file = rec(19, 5, 'HELLO.TXT;1', false);
	root.set(self, 0);
	root.set(file, self.length);
	user(19).set(new TextEncoder().encode('hello'));
	return img;
}

/** A popstation-style PBP: SFO, PNG icon, PSISOIMG with two raw-deflated blocks and a TOC. */
function buildPbp(): Uint8Array {
	const disc = rawDisc();
	const blocks = [0, 1].map((k) => deflateRawSync(disc.subarray(k * 16 * RAW, (k + 1) * 16 * RAW)));
	const psar = new Uint8Array(0x100000 + blocks.reduce((n, b) => n + b.length, 0));
	const dv = new DataView(psar.buffer);
	psar.set(new TextEncoder().encode('PSISOIMG0000'), 0);
	psar.set(new TextEncoder().encode('_SLUS_00001'), 0x400);
	// TOC: A0 (first track 1), A1 (last track 1), A2 (lead-out 00:02:32 → LBA 32), track 1 at 00:02:00.
	psar.set([0x41, 0, 0xa0, 0, 0, 0, 0, 0x01, 0x20, 0], 0x800);
	psar.set([0x41, 0, 0xa1, 0, 0, 0, 0, 0x01, 0, 0], 0x80a);
	psar.set([0x41, 0, 0xa2, 0, 0, 0, 0, 0x00, 0x02, 0x32], 0x814);
	psar.set([0x41, 0, 0x01, 0, 0, 0, 0, 0x00, 0x02, 0x00], 0x81e);
	let off = 0;
	blocks.forEach((b, k) => {
		dv.setUint32(0x4000 + k * 32, off, true);
		dv.setUint16(0x4000 + k * 32 + 4, b.length, true);
		psar.set(b, 0x100000 + off);
		off += b.length;
	});
	const sections = [sfo([['TITLE', 'Test Game'], ['DISC_ID', 'SLUS00001'], ['BOOTABLE', 1]]), Uint8Array.of(0x89, 0x50, 0x4e, 0x47), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), psar];
	const total = 0x28 + sections.reduce((n, s) => n + s.length, 0);
	const out = new Uint8Array(total);
	const ov = new DataView(out.buffer);
	out.set([0, 0x50, 0x42, 0x50], 0);
	ov.setUint32(4, 0x10000, true);
	let p = 0x28;
	sections.forEach((s, i) => {
		ov.setUint32(8 + i * 4, p, true);
		out.set(s, p);
		p += s.length;
	});
	return out;
}

describe('pbp', () => {
	it('parses sections, PARAM.SFO and a popstation disc', async () => {
		const bytes = buildPbp();
		expect(isPbp(bytes)).toBe(true);
		const pbp = await parsePbp(new Blob([bytes]));
		expect(pbp.sfo).toEqual({ TITLE: 'Test Game', DISC_ID: 'SLUS00001', BOOTABLE: 1 });
		expect(pbp.sections.filter((s) => s.size).map((s) => s.name)).toEqual(['PARAM.SFO', 'ICON0.PNG', 'DATA.PSAR']);
		expect(pbp.discErrors).toEqual([]);
		expect(pbp.discs).toHaveLength(1);
		const [disc] = pbp.discs;
		expect(disc).toMatchObject({ gameId: 'SLUS_00001', sectorCount: 32, encrypted: false });
		expect(disc.tracks).toEqual([{ number: 1, audio: false, lba: 0, sectors: 32 }]);
		const iso = await parseIso9660(disc.reader);
		const hello = iso.entries.find((e) => e.name === 'HELLO.TXT')!;
		expect(new TextDecoder().decode(await readIsoFile(disc.reader, hello))).toBe('hello');
	});

	it('reads sectors across block boundaries', async () => {
		const pbp = await parsePbp(new Blob([buildPbp()]));
		const raw = await pbp.discs[0].reader.read(15, 2);
		expect(raw.length).toBe(2 * RAW);
		expect([...raw.subarray(RAW + 24, RAW + 30)]).toEqual([1, 0x43, 0x44, 0x30, 0x30, 0x31]);
	});

	it('parses SFO and TOC tables', () => {
		expect(parseSfo(sfo([['CATEGORY', 'ME']]))).toEqual({ CATEGORY: 'ME' });
		const toc = new Uint8Array(40);
		toc.set([0x41, 0, 0x01, 0, 0, 0, 0, 0x00, 0x02, 0x00], 0);
		toc.set([0x01, 0, 0x02, 0, 0, 0, 0, 0x34, 0x32, 0x22], 10);
		toc.set([0x01, 0, 0xa2, 0, 0, 0, 0, 0x34, 0x34, 0x22], 20);
		expect(parsePsisoToc(toc).tracks).toEqual([
			{ number: 1, audio: false, lba: 0, sectors: 155272 },
			{ number: 2, audio: true, lba: 155272, sectors: 150 },
		]);
	});

	it('rejects non-PBP data', async () => {
		await expect(parsePbp(new Blob([new Uint8Array(64)]))).rejects.toThrow(/Not a PBP/);
		expect(isPgd(Uint8Array.of(0, 0x50, 0x47, 0x44))).toBe(true);
	});

	it('implements AES-128 (FIPS-197 appendix C.1)', () => {
		const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
		const aes = new Aes128(hex('000102030405060708090a0b0c0d0e0f'));
		const ct = aes.encrypt(hex('00112233445566778899aabbccddeeff'));
		expect(Buffer.from(ct).toString('hex')).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
		expect(Buffer.from(aes.decrypt(ct)).toString('hex')).toBe('00112233445566778899aabbccddeeff');
	});
});
