import { describe, it, expect } from 'vitest';
import { isBea, parseBea, BEA_MAGIC } from '../src/index.js';

/**
 * Minimal BEA writer used only for tests. Lays out: header (0x48) →
 * asset-pointer array → ASST blocks → string pool → payloads, with
 * the metadata size at 0x1C covering everything before the first
 * payload. Payloads are stored as-is; the `compressionType` field is
 * written verbatim so tests can exercise the interpretation.
 */
function writeBea(
	archiveName: string,
	files: { name: string; data: Uint8Array; compressionType?: number; uncompressedSize?: number }[],
): Uint8Array {
	const enc = new TextEncoder();
	const arrayOffset = 0x48;
	const asstOffset = arrayOffset + files.length * 8;
	const strOffset = asstOffset + files.length * 0x30;
	const strings = [archiveName, ...files.map((f) => f.name)].map((s) => enc.encode(s));
	const stringOffsets: number[] = [];
	let cur = strOffset;
	for (const s of strings) {
		stringOffsets.push(cur);
		cur += 2 + s.length + 1;
		cur = (cur + 1) & ~1;
	}
	const metadataSize = (cur + 7) & ~7;
	const dataOffsets: number[] = [];
	let dataCur = metadataSize;
	for (const f of files) {
		dataOffsets.push(dataCur);
		dataCur = (dataCur + f.data.length + 7) & ~7;
	}
	const out = new Uint8Array(dataCur);
	const dv = new DataView(out.buffer);
	out.set(enc.encode('SCNE'), 0);
	dv.setUint32(0x08, 0x00010100, true);
	dv.setUint16(0x0c, 0xfeff, true);
	out[0x0e] = 4;
	dv.setUint32(0x18, metadataSize - 8, true);
	dv.setUint32(0x1c, metadataSize, true);
	dv.setUint16(0x20, files.length, true);
	dv.setBigUint64(0x28, BigInt(arrayOffset), true);
	dv.setBigUint64(0x40, BigInt(stringOffsets[0]), true);
	strings.forEach((s, i) => {
		dv.setUint16(stringOffsets[i], s.length, true);
		out.set(s, stringOffsets[i] + 2);
	});
	files.forEach((f, i) => {
		const a = asstOffset + i * 0x30;
		dv.setBigUint64(arrayOffset + i * 8, BigInt(a), true);
		out.set(enc.encode('ASST'), a);
		dv.setUint32(a + 0x04, 0x30, true);
		dv.setUint32(a + 0x08, 0x30, true);
		dv.setUint16(a + 0x10, f.compressionType ?? 0, true);
		dv.setUint16(a + 0x12, 2, true);
		dv.setUint32(a + 0x14, f.data.length, true);
		dv.setUint32(a + 0x18, f.uncompressedSize ?? f.data.length, true);
		dv.setBigUint64(a + 0x20, BigInt(dataOffsets[i]), true);
		dv.setBigUint64(a + 0x28, BigInt(stringOffsets[i + 1]), true);
		out.set(f.data, dataOffsets[i]);
	});
	return out;
}

const blobOf = (b: Uint8Array) => new Blob([b as BlobPart]);

describe('BEA', () => {
	it('exposes the magic', () => {
		expect(BEA_MAGIC).toBe('SCNE');
	});

	it('detects the magic', async () => {
		const bytes = writeBea('x', []);
		expect(await isBea(blobOf(bytes))).toBe(true);
		expect(await isBea(blobOf(new Uint8Array([0x46, 0x52, 0x45, 0x53])))).toBe(false);
		expect(await isBea(blobOf(new Uint8Array(2)))).toBe(false);
	});

	it('parses header and entries', async () => {
		const a = new Uint8Array([1, 2, 3, 4, 5]);
		const b = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 9, 9]);
		const bytes = writeBea('object~obj03_coin', [
			{ name: 'object/obj03_coin/model/obj03_coin.fmdb', data: a },
			{
				name: 'object/obj03_coin/model/textures_object/obj03_coin.bntx',
				data: b,
				compressionType: 2,
				uncompressedSize: 1234,
			},
		]);
		const parsed = await parseBea(blobOf(bytes));
		expect(parsed.name).toBe('object~obj03_coin');
		expect(parsed.version).toEqual({ major: 1, minor: 1, patch: 0, raw: 0x00010100 });
		expect(parsed.alignmentExponent).toBe(4);
		expect(parsed.entries).toHaveLength(2);

		const [e0, e1] = parsed.entries;
		expect(e0.name).toBe('object/obj03_coin/model/obj03_coin.fmdb');
		expect(e0.compression).toBe('none');
		expect(e0.storedSize).toBe(5);
		expect(new Uint8Array(await e0.data.arrayBuffer())).toEqual(a);

		expect(e1.name).toBe('object/obj03_coin/model/textures_object/obj03_coin.bntx');
		expect(e1.compression).toBe('zstd');
		expect(e1.compressionType).toBe(2);
		expect(e1.uncompressedSize).toBe(1234);
		expect(e1.alignmentExponent).toBe(2);
		expect(new Uint8Array(await e1.data.arrayBuffer())).toEqual(b);
	});

	it('flags unknown compression types', async () => {
		const bytes = writeBea('x', [{ name: 'a.bin', data: new Uint8Array(4), compressionType: 7 }]);
		const parsed = await parseBea(blobOf(bytes));
		expect(parsed.entries[0].compression).toBe('unknown');
	});

	it('rejects bad magic', async () => {
		const bytes = writeBea('x', []);
		bytes[0] = 0x58;
		await expect(parseBea(blobOf(bytes))).rejects.toThrow(/bad magic/);
	});

	it('rejects corrupt ASST blocks', async () => {
		const bytes = writeBea('x', [{ name: 'a.bin', data: new Uint8Array(4) }]);
		const asst = Number(new DataView(bytes.buffer).getBigUint64(0x48, true));
		bytes[asst] = 0x58;
		await expect(parseBea(blobOf(bytes))).rejects.toThrow(/ASST/);
	});

	it('rejects payloads past end of file', async () => {
		const bytes = writeBea('x', [{ name: 'a.bin', data: new Uint8Array(4) }]);
		const asst = Number(new DataView(bytes.buffer).getBigUint64(0x48, true));
		new DataView(bytes.buffer).setUint32(asst + 0x14, 0xffff, true);
		await expect(parseBea(blobOf(bytes))).rejects.toThrow(/past end/);
	});
});
