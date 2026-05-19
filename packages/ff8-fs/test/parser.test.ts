import { describe, it, expect } from 'vitest';
import { parseFf8Triplet, FI_ENTRY_SIZE } from '../src/index.js';

/**
 * Build a synthetic FFVIII triplet with N raw entries. Useful
 * for round-trip testing without LZSS in the picture.
 */
async function makeTriplet(entries: { path: string; data: Uint8Array }[]) {
	// Concatenate payload into a single .fs buffer.
	const fsParts: Uint8Array[] = [];
	let fsLen = 0;
	for (const e of entries) {
		fsParts.push(e.data);
		fsLen += e.data.length;
	}
	const fs = new Uint8Array(fsLen);
	let off = 0;
	const fiBytes = new Uint8Array(entries.length * FI_ENTRY_SIZE);
	const view = new DataView(fiBytes.buffer);
	for (let i = 0; i < entries.length; i++) {
		fs.set(entries[i]!.data, off);
		view.setUint32(i * FI_ENTRY_SIZE + 0, entries[i]!.data.length, true);
		view.setUint32(i * FI_ENTRY_SIZE + 4, off, true);
		view.setUint32(i * FI_ENTRY_SIZE + 8, 0, true); // raw
		off += entries[i]!.data.length;
	}
	const fl = new TextEncoder().encode(
		entries.map((e) => e.path).join('\r\n') + '\r\n',
	);
	return {
		fl: new Blob([fl]),
		fi: new Blob([fiBytes]),
		fs: new Blob([fs]),
	};
}

describe('parseFf8Triplet', () => {
	it('parses a synthetic two-entry archive (raw)', async () => {
		const data0 = new Uint8Array([1, 2, 3, 4]);
		const data1 = new Uint8Array([0xa, 0xb, 0xc, 0xd, 0xe]);
		const trip = await makeTriplet([
			{ path: 'c:\\ff8\\data\\eng\\foo.dat', data: data0 },
			{ path: 'c:\\ff8\\data\\eng\\bar.dat', data: data1 },
		]);
		const arc = await parseFf8Triplet(trip.fl, trip.fi, trip.fs);
		expect(arc.entries).toHaveLength(2);
		expect(arc.entries[0]!.path).toBe('c:\\ff8\\data\\eng\\foo.dat');
		expect(arc.entries[0]!.pathNormalised).toBe('c:/ff8/data/eng/foo.dat');
		expect(arc.entries[0]!.basename).toBe('foo.dat');
		expect(arc.entries[0]!.uncompressedSize).toBe(4);
		expect(arc.entries[1]!.uncompressedSize).toBe(5);
		expect(arc.entries[1]!.offsetInFs).toBe(4);

		const got0 = await arc.entries[0]!.read(trip.fs);
		expect(Array.from(got0)).toEqual([1, 2, 3, 4]);
		const got1 = await arc.entries[1]!.read(trip.fs);
		expect(Array.from(got1)).toEqual([0xa, 0xb, 0xc, 0xd, 0xe]);
	});

	it('rejects mismatched path / entry counts', async () => {
		const trip = await makeTriplet([
			{ path: 'a', data: new Uint8Array([1]) },
		]);
		// Tamper with .fl to introduce a second path.
		const flText = new TextEncoder().encode('a\r\nb\r\n');
		await expect(
			parseFf8Triplet(new Blob([flText]), trip.fi, trip.fs),
		).rejects.toThrow(/declares 2 paths but .fi declares 1/);
	});

	it('rejects .fi files not aligned to entry size', async () => {
		const fi = new Blob([new Uint8Array(13)]);
		const fl = new Blob([new TextEncoder().encode('x')]);
		const fs = new Blob([new Uint8Array(1)]);
		await expect(parseFf8Triplet(fl, fi, fs)).rejects.toThrow(
			/not a multiple of/,
		);
	});

	it('decodes per-entry compression flags', async () => {
		const trip = await makeTriplet([
			{ path: 'a', data: new Uint8Array([1, 2, 3]) },
			{ path: 'b', data: new Uint8Array([4, 5, 6]) },
		]);
		// Manually flip second entry's compressionFlag → unknown.
		const fiBytes = new Uint8Array(await trip.fi.arrayBuffer());
		const v = new DataView(fiBytes.buffer);
		v.setUint32(FI_ENTRY_SIZE + 8, 42, true);
		const arc = await parseFf8Triplet(
			trip.fl,
			new Blob([fiBytes]),
			trip.fs,
		);
		expect(arc.entries[0]!.compressionFlag).toBe(0);
		expect(arc.entries[1]!.compressionFlag).toBe(42);
		await expect(arc.entries[1]!.read(trip.fs)).rejects.toThrow(
			/Unknown compressionFlag 42/,
		);
	});
});
