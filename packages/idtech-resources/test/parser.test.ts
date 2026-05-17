/**
 * Tests for `@tootallnate/idtech-resources`.
 *
 * Real `.resources` archives are part of commercial games and not
 * committed. Instead we build the smallest valid archive in-memory
 * per test — exercise of the parser is just as thorough, and the
 * test corpus stays self-contained.
 */

import { describe, expect, it } from 'vitest';

import {
	isIdTechResources,
	parseIdTechResources,
	RESOURCE_FILE_MAGIC,
} from '../src/index.js';

/** Build a Blob containing a synthetic .resources archive. */
function buildArchive(
	files: Array<{ name: string; body: Uint8Array }>,
): Blob {
	const encoder = new TextEncoder();
	const HEADER = 12;
	// Layout: header, then concatenated file bodies, then table.
	let dataLen = 0;
	const bodies: Array<{
		name: string;
		nameBytes: Uint8Array;
		offset: number;
		body: Uint8Array;
	}> = [];
	for (const f of files) {
		const nameBytes = encoder.encode(f.name);
		bodies.push({
			name: f.name,
			nameBytes,
			offset: HEADER + dataLen,
			body: f.body,
		});
		dataLen += f.body.length;
	}

	const tableOffset = HEADER + dataLen;
	// Build the table.
	let tableLen = 4; // numFiles
	for (const b of bodies) tableLen += 4 + b.nameBytes.length + 4 + 4;

	const total = HEADER + dataLen + tableLen;
	const buf = new Uint8Array(total);
	const view = new DataView(buf.buffer);

	// Header — all BE.
	view.setUint32(0, RESOURCE_FILE_MAGIC, false);
	view.setInt32(4, tableOffset, false);
	view.setInt32(8, tableLen, false);

	// File bodies.
	for (const b of bodies) buf.set(b.body, b.offset);

	// Table.
	let p = tableOffset;
	view.setInt32(p, bodies.length, false); // numFiles BE
	p += 4;
	for (const b of bodies) {
		view.setInt32(p, b.nameBytes.length, true); // filenameLen LE
		p += 4;
		buf.set(b.nameBytes, p);
		p += b.nameBytes.length;
		view.setInt32(p, b.offset, false); // offset BE
		p += 4;
		view.setInt32(p, b.body.length, false); // length BE
		p += 4;
	}

	return new Blob([buf]);
}

describe('isIdTechResources', () => {
	it('returns true for the 4-byte magic', async () => {
		const blob = new Blob([new Uint8Array([0xd0, 0x00, 0x00, 0x0d, 1, 2, 3, 4])]);
		expect(await isIdTechResources(blob)).toBe(true);
	});

	it('returns false for non-matching bytes', async () => {
		expect(
			await isIdTechResources(new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x00])])),
		).toBe(false);
	});

	it('returns false for blobs shorter than the magic', async () => {
		expect(await isIdTechResources(new Blob([new Uint8Array([0xd0, 0])]))).toBe(false);
	});
});

describe('parseIdTechResources', () => {
	it('round-trips a single tiny file', async () => {
		const body = new TextEncoder().encode('hello world');
		const arc = buildArchive([{ name: 'greeting.txt', body }]);
		const parsed = await parseIdTechResources(arc);
		expect(parsed.numFiles).toBe(1);
		expect(parsed.entries[0].name).toBe('greeting.txt');
		expect(parsed.entries[0].size).toBe(body.length);
		const out = new Uint8Array(await parsed.entries[0].data.arrayBuffer());
		expect(out).toEqual(body);
	});

	it('walks multiple entries in declaration order', async () => {
		const files = [
			{ name: 'materials/a.mtr', body: new Uint8Array([1, 2, 3]) },
			{ name: 'maps/b.map', body: new Uint8Array([4, 5, 6, 7]) },
			{ name: 'scripts/c.script', body: new Uint8Array([8]) },
		];
		const arc = buildArchive(files);
		const parsed = await parseIdTechResources(arc);
		expect(parsed.numFiles).toBe(3);
		expect(parsed.entries.map((e) => e.name)).toEqual(
			files.map((f) => f.name),
		);
		for (let i = 0; i < files.length; i++) {
			const out = new Uint8Array(
				await parsed.entries[i].data.arrayBuffer(),
			);
			expect(out, `entry ${i}`).toEqual(files[i].body);
		}
	});

	it('exposes the table offset / length / numFiles fields', async () => {
		const arc = buildArchive([
			{ name: 'x', body: new Uint8Array([1, 2, 3, 4]) },
			{ name: 'y', body: new Uint8Array([5, 6]) },
		]);
		const parsed = await parseIdTechResources(arc);
		expect(parsed.numFiles).toBe(2);
		expect(parsed.tableOffset).toBe(12 + 4 + 2); // header + 4 + 2 bytes of body data
		// Table is: u32 numFiles + 2 entries (4 + 1 + 4 + 4 each) = 4 + 26 = 30 bytes
		expect(parsed.tableLength).toBe(4 + (4 + 1 + 4 + 4) * 2);
	});

	it('preserves non-ASCII filenames (UTF-8)', async () => {
		const name = 'maps/héllo_世界.map';
		const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const arc = buildArchive([{ name, body }]);
		const parsed = await parseIdTechResources(arc);
		expect(parsed.entries[0].name).toBe(name);
	});

	it('rejects blobs that are too small for the header', async () => {
		await expect(
			parseIdTechResources(new Blob([new Uint8Array(8)])),
		).rejects.toThrow(/too small/i);
	});

	it('rejects a wrong magic', async () => {
		const bad = new Uint8Array(16);
		new DataView(bad.buffer).setUint32(0, 0xdeadbeef, false);
		await expect(parseIdTechResources(new Blob([bad]))).rejects.toThrow(/magic/i);
	});

	it('rejects a tableOffset past the end of the archive', async () => {
		const bad = new Uint8Array(16);
		const v = new DataView(bad.buffer);
		v.setUint32(0, RESOURCE_FILE_MAGIC, false);
		v.setInt32(4, 0x7fffffff, false); // tableOffset way past EOF
		v.setInt32(8, 4, false);
		await expect(parseIdTechResources(new Blob([bad]))).rejects.toThrow(/past end/i);
	});

	it('handles zero-length entries (offset is still set)', async () => {
		const arc = buildArchive([
			{ name: 'empty', body: new Uint8Array(0) },
			{ name: 'after', body: new Uint8Array([1]) },
		]);
		const parsed = await parseIdTechResources(arc);
		expect(parsed.entries[0].size).toBe(0);
		expect(parsed.entries[0].data.size).toBe(0);
		expect(parsed.entries[1].size).toBe(1);
	});

	it('rejects entries whose body runs past the archive', async () => {
		// Build a legitimate-looking archive, then corrupt one entry's length.
		const arc = buildArchive([{ name: 'x', body: new Uint8Array([1, 2, 3]) }]);
		const buf = new Uint8Array(await arc.arrayBuffer());
		// First entry's length is the last int32 of the table.
		const lenOff = buf.length - 4;
		new DataView(buf.buffer).setInt32(lenOff, 0x7fffffff, false);
		await expect(
			parseIdTechResources(new Blob([buf])),
		).rejects.toThrow(/past end/i);
	});
});
