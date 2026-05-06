import { describe, it, expect } from 'vitest';
import { isNso, parseHeader, hex, NsoFlag } from '../src/index.js';

/**
 * Build a synthetic NSO0 blob. The compressed segment payloads are
 * irrelevant for header-parsing tests; we just zero-fill them.
 */
function makeNso(opts: {
	textSize?: number;
	textFileSize?: number;
	rodataSize?: number;
	rodataFileSize?: number;
	dataSize?: number;
	dataFileSize?: number;
	bssSize?: number;
	flags?: number;
	moduleName?: string;
	moduleId?: Uint8Array;
	textHash?: Uint8Array;
}): Uint8Array {
	const enc = new TextEncoder();
	const moduleName = opts.moduleName ?? 'main';
	const nameBytes = enc.encode(moduleName + '\0');

	const textSize = opts.textSize ?? 0x1000;
	const textFileSize = opts.textFileSize ?? textSize;
	const rodataSize = opts.rodataSize ?? 0x800;
	const rodataFileSize = opts.rodataFileSize ?? rodataSize;
	const dataSize = opts.dataSize ?? 0x400;
	const dataFileSize = opts.dataFileSize ?? dataSize;
	const bssSize = opts.bssSize ?? 0x200;
	const flags = opts.flags ?? 0;
	const moduleId = opts.moduleId ?? new Uint8Array(0x20);
	const textHash = opts.textHash ?? new Uint8Array(0x20);

	const headerSize = 0x100;
	// Layout: header, then module name, then segment payloads
	const moduleNameOffset = headerSize;
	const textFileOffset = moduleNameOffset + nameBytes.length;
	const rodataFileOffset = textFileOffset + textFileSize;
	const dataFileOffset = rodataFileOffset + rodataFileSize;
	const totalSize = dataFileOffset + dataFileSize;

	const buf = new Uint8Array(totalSize);
	const view = new DataView(buf.buffer);

	// "NSO0"
	buf[0] = 0x4e;
	buf[1] = 0x53;
	buf[2] = 0x4f;
	buf[3] = 0x30;
	view.setUint32(0x04, 0, true); // version
	view.setUint32(0x08, 0, true); // reserved
	view.setUint32(0x0c, flags, true);
	view.setUint32(0x10, textFileOffset, true);
	view.setUint32(0x14, 0, true); // text mem offset
	view.setUint32(0x18, textSize, true);
	view.setUint32(0x1c, moduleNameOffset, true);
	view.setUint32(0x20, rodataFileOffset, true);
	view.setUint32(0x24, textSize, true); // rodata mem
	view.setUint32(0x28, rodataSize, true);
	view.setUint32(0x2c, nameBytes.length, true);
	view.setUint32(0x30, dataFileOffset, true);
	view.setUint32(0x34, textSize + rodataSize, true); // data mem
	view.setUint32(0x38, dataSize, true);
	view.setUint32(0x3c, bssSize, true);
	buf.set(moduleId, 0x40);
	view.setUint32(0x60, textFileSize, true);
	view.setUint32(0x64, rodataFileSize, true);
	view.setUint32(0x68, dataFileSize, true);
	// Embedded / dynstr / dynsym at fixed positions for easy assertions
	view.setUint32(0x88, 0x10, true);
	view.setUint32(0x8c, 0x20, true);
	view.setUint32(0x90, 0x30, true);
	view.setUint32(0x94, 0x40, true);
	view.setUint32(0x98, 0x70, true);
	view.setUint32(0x9c, 0x80, true);
	buf.set(textHash, 0xa0);

	// Module name + segment payloads (zero-filled)
	buf.set(nameBytes, moduleNameOffset);

	return buf;
}

describe('NSO parser', () => {
	it('detects NSO via magic sniff', async () => {
		const bytes = makeNso({});
		expect(await isNso(new Blob([bytes]))).toBe(true);
		expect(await isNso(new Blob([new Uint8Array(0x100)]))).toBe(false);
		expect(await isNso(new Blob([new Uint8Array(0x10)]))).toBe(false);
	});

	it('parses the header of a minimal uncompressed NSO', async () => {
		const moduleId = new Uint8Array(0x20);
		moduleId[0] = 0xab;
		moduleId[31] = 0xcd;
		const textHash = new Uint8Array(0x20).fill(0x42);
		const bytes = makeNso({
			textSize: 0x4000,
			rodataSize: 0x2000,
			dataSize: 0x800,
			bssSize: 0x100,
			moduleName: 'subsdk0',
			moduleId,
			textHash,
		});

		const parsed = await parseHeader(new Blob([bytes]));
		expect(parsed.magic).toBe('NSO0');
		expect(parsed.version).toBe(0);
		expect(parsed.flags).toBe(0);
		expect(parsed.usesZstd).toBe(false);
		expect(parsed.executeOnlyMemory).toBe(false);
		expect(parsed.moduleName).toBe('subsdk0');
		expect(parsed.moduleId[0]).toBe(0xab);
		expect(parsed.moduleId[31]).toBe(0xcd);
		expect(parsed.textSegment.size).toBe(0x4000);
		expect(parsed.textSegment.fileSize).toBe(0x4000);
		expect(parsed.textSegment.compressed).toBe(false);
		expect(parsed.textSegment.hashed).toBe(false);
		expect(parsed.textSegment.hash[0]).toBe(0x42);
		expect(parsed.rodataSegment.size).toBe(0x2000);
		expect(parsed.dataSegment.size).toBe(0x800);
		expect(parsed.bssSize).toBe(0x100);
		expect(parsed.dynStrOffset).toBe(0x30);
		expect(parsed.dynStrSize).toBe(0x40);
	});

	it('reports compression and hash flags per segment', async () => {
		const flags =
			NsoFlag.TextCompress |
			NsoFlag.DataCompress |
			NsoFlag.TextHash |
			NsoFlag.RoHash |
			NsoFlag.DataHash;
		const bytes = makeNso({ flags });
		const parsed = await parseHeader(new Blob([bytes]));
		expect(parsed.textSegment.compressed).toBe(true);
		expect(parsed.rodataSegment.compressed).toBe(false);
		expect(parsed.dataSegment.compressed).toBe(true);
		expect(parsed.textSegment.hashed).toBe(true);
		expect(parsed.rodataSegment.hashed).toBe(true);
		expect(parsed.dataSegment.hashed).toBe(true);
	});

	it('reports zstd / execute-only-memory flags', async () => {
		const bytes = makeNso({
			flags: NsoFlag.UseZbicCompression | NsoFlag.ExecuteOnlyMemory,
		});
		const parsed = await parseHeader(new Blob([bytes]));
		expect(parsed.usesZstd).toBe(true);
		expect(parsed.executeOnlyMemory).toBe(true);
	});

	it('rejects a blob that does not start with the NSO0 magic', async () => {
		const bad = new Uint8Array(0x100);
		bad[0] = 0x4e; // 'N'
		bad[1] = 0x52; // 'R' — wrong
		bad[2] = 0x4f;
		bad[3] = 0x30;
		await expect(parseHeader(new Blob([bad]))).rejects.toThrow(/Not an NSO/);
	});

	it('rejects a blob that is too small to hold a header', async () => {
		await expect(
			parseHeader(new Blob([new Uint8Array(0x10)])),
		).rejects.toThrow(/too small/);
	});

	it('hex() encodes bytes in lower-case', () => {
		expect(hex(new Uint8Array([0x00, 0xab, 0xcd, 0xff]))).toBe('00abcdff');
	});
});
