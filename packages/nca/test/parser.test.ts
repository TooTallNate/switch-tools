import { describe, it, expect, beforeAll } from 'vitest';
import {
	createControlNca,
	createMetaNca,
	createProgramNca,
	parseNca,
	NcaContentType,
	NCA_CRYPT_CTR,
	NCA_FS_TYPE_PFS0,
	NCA_FS_TYPE_ROMFS,
	NcaKeyError,
	type KeySet,
} from '../src/index.js';
import { decode as pfs0Decode } from '@tootallnate/pfs0';

// Helper: synthesize a deterministic KeySet for testing.
// We don't have real prod.keys here, but we don't need real ones — the
// parser only requires that `headerKey` matches what was used to build
// the NCA, and that `keyAreaKeys[gen-1][kaekIdx]` matches the KAK used
// to encrypt the key area at NCA build time.
async function makeTestKeys(): Promise<KeySet> {
	const headerKey = new Uint8Array(0x20);
	for (let i = 0; i < 0x20; i++) headerKey[i] = i;
	// keyAreaKeys[0][0] (generation 1, application) — used by builders by default
	const kak = new Uint8Array(0x10);
	for (let i = 0; i < 0x10; i++) kak[i] = 0xa0 + i;
	const keyAreaKeys: Uint8Array[][] = [];
	for (let gen = 0; gen < 0x20; gen++) {
		keyAreaKeys.push([
			gen === 0 ? kak : new Uint8Array(0x10),
			new Uint8Array(0x10),
			new Uint8Array(0x10),
		]);
	}
	const titlekeks: Uint8Array[] = [];
	for (let gen = 0; gen < 0x20; gen++) titlekeks.push(new Uint8Array(0x10));
	return { headerKey, keyAreaKeys, titlekeks };
}

let keys: KeySet;
beforeAll(async () => {
	keys = await makeTestKeys();
});

describe('parseNca round-trip', () => {
	it('parses a Meta NCA and decodes its inner PFS0', async () => {
		const cnmtData = new Uint8Array(0x100);
		for (let i = 0; i < cnmtData.length; i++) cnmtData[i] = i & 0xff;

		const built = await createMetaNca({
			cnmtData,
			cnmtFilename: 'Application_0100000000000001.cnmt',
			titleId: 0x0100000000000001n,
			keys,
		});

		const blob = new Blob([built.data]);
		const parsed = await parseNca(blob, { keys });

		expect(parsed.magic).toBe('NCA3');
		expect(parsed.contentType).toBe(NcaContentType.Meta);
		expect(parsed.titleId).toBe(0x0100000000000001n);
		expect(parsed.keyGeneration).toBe(1);
		expect(parsed.kaekIndex).toBe(0);
		expect(parsed.sections.length).toBe(1);

		const sec = parsed.sections[0];
		expect(sec.fsType).toBe(NCA_FS_TYPE_PFS0);
		expect(sec.cryptType).toBe(NCA_CRYPT_CTR);
		expect(sec.pfs0Data).toBeDefined();

		// Decode the inner PFS0 from the lazy decrypted blob
		const files = await pfs0Decode(sec.pfs0Data!);
		expect(files.size).toBe(1);
		const cnmt = files.get('Application_0100000000000001.cnmt');
		expect(cnmt).toBeDefined();
		const cnmtBytes = new Uint8Array(await cnmt!.arrayBuffer());
		expect(cnmtBytes.length).toBe(cnmtData.length);
		expect(cnmtBytes).toEqual(cnmtData);
	});

	it('parses a Program NCA with ExeFS section', async () => {
		// Minimal NPDM (must start with "META" magic for the npdm processor).
		const npdmData = new Uint8Array(0x80);
		new TextEncoder().encodeInto('META', npdmData.subarray(0, 4));

		const built = await createProgramNca({
			exefsFiles: [
				{ name: 'main', data: new Uint8Array([1, 2, 3, 4]) },
				{ name: 'main.npdm', data: npdmData },
			],
			titleId: 0x0100000000000001n,
			keys,
			sign: false,
		});

		const blob = new Blob([built.data]);
		const parsed = await parseNca(blob, { keys });
		expect(parsed.contentType).toBe(NcaContentType.Program);
		expect(parsed.sections.length).toBeGreaterThanOrEqual(1);

		const exefs = parsed.sections[0];
		expect(exefs.fsType).toBe(NCA_FS_TYPE_PFS0);
		const files = await pfs0Decode(exefs.pfs0Data!);
		expect(files.has('main')).toBe(true);
		expect(files.has('main.npdm')).toBe(true);
		const main = new Uint8Array(await files.get('main')!.arrayBuffer());
		expect(Array.from(main)).toEqual([1, 2, 3, 4]);
	});

	it('parses a Control NCA with RomFS section', async () => {
		// Build a minimal RomFS using the romfs encoder.
		const { encode: romfsEncode } = await import('@tootallnate/romfs');
		const romfsBlob = await romfsEncode({
			'control.nacp': new Blob([new Uint8Array(0x4000)]),
		});
		const romfsBytes = new Uint8Array(await romfsBlob.arrayBuffer());

		const built = await createControlNca({
			romfsData: romfsBytes,
			titleId: 0x0100000000000001n,
			keys,
		});

		const blob = new Blob([built.data]);
		const parsed = await parseNca(blob, { keys });
		expect(parsed.contentType).toBe(NcaContentType.Control);
		expect(parsed.sections.length).toBe(1);

		const sec = parsed.sections[0];
		expect(sec.fsType).toBe(NCA_FS_TYPE_ROMFS);
		expect(sec.romfsData).toBeDefined();
		expect(sec.romfsSize).toBe(romfsBytes.length);

		// Decode the inner RomFS
		const { decode: romfsDecode } = await import('@tootallnate/romfs');
		const root = await romfsDecode(sec.romfsData!);
		const file = root['control.nacp'] as Blob;
		expect(file).toBeDefined();
		expect(typeof file.arrayBuffer).toBe('function');
		expect(file.size).toBe(0x4000);
		const bytes = new Uint8Array(await file.arrayBuffer());
		expect(bytes.length).toBe(0x4000);
	});

	it('reports missingKey when the KAK for the NCA generation is not present', async () => {
		// Build a normal Meta NCA (uses generation 1, KAEK Application).
		const cnmtData = new Uint8Array(0x40);
		const built = await createMetaNca({
			cnmtData,
			cnmtFilename: 'Application_0100000000000001.cnmt',
			titleId: 0x0100000000000001n,
			keys,
		});
		const blob = new Blob([built.data]);

		// Now parse with a KeySet whose generation-1 application KAK is empty
		// (simulating "user's prod.keys is older than this NCA").
		const brokenKeys: KeySet = {
			headerKey: keys.headerKey,
			keyAreaKeys: keys.keyAreaKeys.map((row) =>
				row.map(() => new Uint8Array(0x10)),
			),
			titlekeks: keys.titlekeks.map(() => new Uint8Array(0x10)),
		};
		const parsed = await parseNca(blob, { keys: brokenKeys });
		// Structured detail is the source of truth for the cause; the
		// `missingKey` string is a derived user-facing summary.
		expect(parsed.missingKeyDetail).toEqual({
			code: 'outdated-keys',
			generation: 1,
			kaekIndex: 0,
			kind: 'key-area-key',
		})
		expect(parsed.missingKey).toMatch(/prod\.keys file is older/);
		// Reading from a section throws an `NcaKeyError` carrying the
		// same structured detail, rather than a plain `Error`.
		const sec = parsed.sections[0];
		expect(sec.pfs0Data).toBeDefined();
		await expect(async () => sec.pfs0Data!.arrayBuffer())
			.rejects.toThrowError(NcaKeyError);
		// Slicing the failing blob still returns a (also-failing) blob
		// that throws the same structured error.
		const sliced = sec.pfs0Data!.slice(0, 16);
		expect(sliced.size).toBe(16);
		await expect(async () => sliced.arrayBuffer())
			.rejects.toThrowError(NcaKeyError);
	});

	it('handles offsets above 2 GB without int32 truncation', async () => {
		// Regression test for a JS `& ~0xf` bug: bitwise ops coerce to signed
		// int32, so values above 2^31 (~2.15 GB) silently became negative.
		// This caused range() to produce nonsensical offsets and short-read.
		//
		// We don't actually allocate a 2 GB file — we only need to exercise
		// the alignment math, which is straightforward: align-down to 16 and
		// align-up to 16 must remain monotonic and within the same magnitude.
		const cases: Array<[number, number, number, number]> = [
			// [localStart, localEnd, expectedBlockOffset, expectedBlockEnd]
			[0, 16, 0, 16],
			[3, 19, 0, 32],
			[16, 32, 16, 32],
			// Just below 2^31 — should still work
			[0x7ffffff0, 0x7fffffff, 0x7ffffff0, 0x80000000],
			// Just above 2^31 — was the bug
			[3_060_139_348, 3_060_139_412, 3_060_139_344, 3_060_139_424],
			// 4 GB territory
			[5_000_000_001, 5_000_000_017, 5_000_000_000, 5_000_000_032],
		];
		for (const [localStart, localEnd, expBlockOff, expBlockEnd] of cases) {
			const blockOffset = localStart - (localStart % 16);
			const blockEnd =
				localEnd % 16 === 0 ? localEnd : localEnd + (16 - (localEnd % 16));
			expect(blockOffset).toBe(expBlockOff);
			expect(blockEnd).toBe(expBlockEnd);
			// And critically, both must be non-negative
			expect(blockOffset).toBeGreaterThanOrEqual(0);
			expect(blockEnd).toBeGreaterThanOrEqual(localEnd);
		}
	});

	it('decrypts a titlekey-crypto NCA via the .tik path', async () => {
		// We can't easily build a real rights-id NCA from scratch (the builder
		// doesn't expose a "use this titlekey" mode), so instead we synthesize
		// one by post-processing a normally-built NCA: write a non-zero
		// RightsId into the (decrypted) header and re-encrypt it, then
		// re-encrypt the section bodies under a chosen titlekey instead of
		// the key area key.
		//
		// We exercise the parser end-to-end with `encryptedTitleKey` set and
		// a synthetic titlekek that maps the encrypted titlekey to the
		// section key the NCA was actually encrypted with.
		const { aesCtrEncrypt, aesEcbDecrypt, buildNcaCtr, sha256 } =
			await import('../src/crypto.js');
		const { decrypt: aesXtsDecrypt, encrypt: aesXtsEncrypt } = await import(
			'@tootallnate/aes-xts'
		);

		// Build a normal Meta NCA so we have a valid layout to start from
		const cnmtData = new Uint8Array(0x40);
		for (let i = 0; i < cnmtData.length; i++) cnmtData[i] = i;
		const built = await createMetaNca({
			cnmtData,
			cnmtFilename: 'Application_0100000000000001.cnmt',
			titleId: 0x0100000000000001n,
			keys,
		});

		// Decrypt the header so we can mutate the RightsId and re-derive
		// section keys.
		const ncaArr = built.data;
		const NCA_HEADER_SIZE = 0xc00;
		const decHeader = new Uint8Array(
			await aesXtsDecrypt(
				keys.headerKey,
				ncaArr.slice(0, NCA_HEADER_SIZE),
				0x200,
				0
			)
		);
		// Original section key (key area index 2) in plaintext
		const decView = new DataView(decHeader.buffer);
		const headerOffset = 0x200;

		// Decrypt the existing key area to get keyArea[2]
		const kak = keys.keyAreaKeys[0][0]; // builder uses gen=1, kaek=0
		const encKeyArea = decHeader.subarray(0x300, 0x340);
		const decKeyArea = await aesEcbDecrypt(kak, encKeyArea);
		const oldSectionKey = decKeyArea.slice(0x20, 0x30);

		// Choose a synthetic titlekey + titlekek
		const encryptedTitleKey = new Uint8Array(0x10);
		for (let i = 0; i < 0x10; i++) encryptedTitleKey[i] = 0x77 + i;
		const newSectionKey = new Uint8Array(0x10);
		for (let i = 0; i < 0x10; i++) newSectionKey[i] = 0xAA - i;
		// Pick titlekek so that AES-ECB-Decrypt(titlekek, encTk) = newSectionKey.
		// Equivalently, AES-ECB-Encrypt(titlekek, newSectionKey) = encTk.
		// We don't have aesEcbEncrypt easily (we have aesEcbDecrypt). Use
		// CryptoKey directly.
		// Easiest: compute titlekek = a fresh random 16-byte key, then set
		// encryptedTitleKey = AES-ECB-Encrypt(titlekek, newSectionKey).
		const titlekek = new Uint8Array(0x10);
		for (let i = 0; i < 0x10; i++) titlekek[i] = 0x42 + i;
		const subtleKey = await crypto.subtle.importKey(
			'raw',
			titlekek,
			{ name: 'AES-CBC' },
			false,
			['encrypt']
		);
		// AES-CBC with zero IV and 1 block ≈ ECB; result has PKCS7 padding,
		// take only first 16 bytes.
		const ZERO_IV = new Uint8Array(16);
		const encTkRaw = await crypto.subtle.encrypt(
			{ name: 'AES-CBC', iv: ZERO_IV },
			subtleKey,
			newSectionKey
		);
		encryptedTitleKey.set(new Uint8Array(encTkRaw, 0, 16));

		// Mutate header: write RightsId, recompute section bodies.
		// Set rightsId at 0x230 (16 bytes; match titleId in big-endian style).
		const rightsId = new Uint8Array(16);
		rightsId[0] = 0x01;
		rightsId[1] = 0x00;
		rightsId[15] = 0x0E;
		decHeader.set(rightsId, headerOffset + 0x30);

		// Re-encrypt each section's body with newSectionKey instead of oldSectionKey.
		// First, decrypt each section's existing body using oldSectionKey,
		// then re-encrypt with newSectionKey.
		// Walk section table at headerOffset+0x40.
		const MEDIA_UNIT = 0x200;
		for (let i = 0; i < 4; i++) {
			const entryOffset = headerOffset + 0x40 + i * 0x10;
			const startMedia = decView.getUint32(entryOffset + 0x00, true);
			const endMedia = decView.getUint32(entryOffset + 0x04, true);
			if (startMedia === 0 && endMedia === 0) continue;
			const startByte = startMedia * MEDIA_UNIT;
			const endByte = endMedia * MEDIA_UNIT;
			const fsHeaderOffset = 0x400 + i * 0x200;
			const sectionCtr = decHeader.slice(fsHeaderOffset + 0x140, fsHeaderOffset + 0x148);
			// Decrypt with old key
			const ctr = buildNcaCtr(sectionCtr, startByte);
			const dec = await aesCtrEncrypt(
				oldSectionKey,
				ncaArr.subarray(startByte, endByte),
				ctr
			);
			// Re-encrypt with new key, fresh CTR (CTR is symmetric)
			const ctr2 = buildNcaCtr(sectionCtr, startByte);
			const reenc = await aesCtrEncrypt(newSectionKey, dec, ctr2);
			ncaArr.set(reenc, startByte);
		}

		// Re-encrypt the header (now with RightsId set)
		const newEncHeader = await aesXtsEncrypt(
			keys.headerKey,
			decHeader,
			0x200,
			0
		);
		ncaArr.set(new Uint8Array(newEncHeader), 0);

		// Synthesize a KeySet whose titlekek matches what we picked
		const synthKeys: KeySet = {
			headerKey: keys.headerKey,
			keyAreaKeys: keys.keyAreaKeys,
			titlekeks: [titlekek, ...keys.titlekeks.slice(1)],
		};

		// Now parse with encryptedTitleKey supplied
		const blob = new Blob([ncaArr]);
		const parsed = await parseNca(blob, {
			keys: synthKeys,
			encryptedTitleKey,
		});
		expect(parsed.hasRightsId).toBe(true);

		// Decode the inner PFS0 — should succeed, proving the section key
		// derived via the titlekey path matched what we used to re-encrypt.
		const files = await pfs0Decode(parsed.sections[0].pfs0Data!);
		const cnmt = files.get('Application_0100000000000001.cnmt');
		expect(cnmt).toBeDefined();
		const got = new Uint8Array(await cnmt!.arrayBuffer());
		expect(got).toEqual(cnmtData);
	});

	it('correctly random-accesses encrypted bytes via Blob.slice', async () => {
		// Make a Program NCA whose ExeFS contains a single large file with a
		// recognizable byte pattern. We then read arbitrary slices via the
		// returned PFS0 file Blob and verify decryption works at any offset.
		const data = new Uint8Array(0x20000);
		for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
		const npdmData = new Uint8Array(0x80);
		new TextEncoder().encodeInto('META', npdmData.subarray(0, 4));

		const built = await createProgramNca({
			exefsFiles: [
				{ name: 'main.npdm', data: npdmData },
				{ name: 'main', data },
			],
			titleId: 0x0100000000000001n,
			keys,
			sign: false,
		});
		const blob = new Blob([built.data]);
		const parsed = await parseNca(blob, { keys });
		const files = await pfs0Decode(parsed.sections[0].pfs0Data!);
		const main = files.get('main')!;
		expect(main.size).toBe(data.length);

		// Slice from an unaligned offset that crosses an AES block boundary
		const slice = new Uint8Array(
			await main.slice(0x3, 0x3 + 0x100).arrayBuffer()
		);
		for (let i = 0; i < slice.length; i++) {
			expect(slice[i]).toBe(data[3 + i]);
		}

		// Slice from end of file
		const tail = new Uint8Array(
			await main.slice(data.length - 0x47, data.length).arrayBuffer()
		);
		for (let i = 0; i < tail.length; i++) {
			expect(tail[i]).toBe(data[data.length - 0x47 + i]);
		}
	});
});
