import { describe, it, expect } from 'vitest';
import { parseXci } from '../src/index.js';

const HEAD_MAGIC_BYTES = new Uint8Array([0x48, 0x45, 0x41, 0x44]); // "HEAD"

/**
 * Build a minimal HFS0 partition containing the given named entries, each
 * with empty contents.
 */
function makeEmptyHfs0(entries: string[]): Uint8Array {
	const enc = new TextEncoder();
	const SIZEOF_HEADER = 0x10;
	const SIZEOF_FILE_ENTRY = 0x40;

	const names = entries.map((n) => enc.encode(n));
	const stringTableSize =
		Math.ceil(
			(names.reduce((s, n) => s + n.length + 1, 0) + 0x1f) / 0x20,
		) * 0x20;
	const fileTableSize = entries.length * SIZEOF_FILE_ENTRY;
	const totalHeaderArea = SIZEOF_HEADER + fileTableSize + stringTableSize;

	const buf = new Uint8Array(totalHeaderArea); // empty data follows
	const view = new DataView(buf.buffer);

	// Magic "HFS0"
	buf[0] = 0x48;
	buf[1] = 0x46;
	buf[2] = 0x53;
	buf[3] = 0x30;
	view.setUint32(0x4, entries.length, true);
	view.setUint32(0x8, stringTableSize, true);
	// 0xC: padding

	// Each file entry: offset=0, size=0, nameOffset increments
	let nameOffset = 0;
	for (let i = 0; i < entries.length; i++) {
		const off = SIZEOF_HEADER + i * SIZEOF_FILE_ENTRY;
		view.setBigUint64(off + 0x00, 0n, true); // data_offset
		view.setBigUint64(off + 0x08, 0n, true); // data_size
		view.setUint32(off + 0x10, nameOffset, true);
		view.setUint32(off + 0x14, 0, true); // hash_size
		// 0x18: u64 padding (zeros)
		// 0x20: 0x20-byte hash (zeros — no data anyway)
		nameOffset += names[i].length + 1;
	}

	// String table
	const stringTableStart = SIZEOF_HEADER + fileTableSize;
	let cursor = stringTableStart;
	for (const n of names) {
		buf.set(n, cursor);
		cursor += n.length + 1; // null terminator already zero
	}

	return buf;
}

/**
 * Build a synthetic minimal XCI image. The CardHeader is essentially a
 * placeholder — only the magic at the configured offset is meaningful.
 *
 * The root HFS0 lists a single "secure" partition whose data is itself a
 * minimal (empty) HFS0.
 */
function makeMinimalXci(opts: { withKeyArea: boolean }): Uint8Array {
	const headerOffset = opts.withKeyArea ? 0x1100 : 0x100;
	const hfs0RootOffset = opts.withKeyArea ? 0x10000 : 0xf000;

	// Build the root HFS0 with one entry that points to an inner empty HFS0.
	const innerHfs0 = makeEmptyHfs0([]); // an empty HFS0 (0 files, valid)
	// We reuse makeEmptyHfs0 for the root and then overwrite the secure entry's
	// data offset/size to point at the inner HFS0 placed after it.
	const enc = new TextEncoder();
	const SIZEOF_HEADER = 0x10;
	const SIZEOF_FILE_ENTRY = 0x40;
	const name = enc.encode('secure');
	const stringTableSize = 0x20; // padded
	const fileTableSize = SIZEOF_FILE_ENTRY;
	const rootHeaderArea = SIZEOF_HEADER + fileTableSize + stringTableSize;

	const root = new Uint8Array(rootHeaderArea + innerHfs0.length);
	const rootView = new DataView(root.buffer);
	root[0] = 0x48;
	root[1] = 0x46;
	root[2] = 0x53;
	root[3] = 0x30; // "HFS0"
	rootView.setUint32(0x4, 1, true); // 1 file
	rootView.setUint32(0x8, stringTableSize, true);
	// File entry
	rootView.setBigUint64(SIZEOF_HEADER + 0x00, 0n, true); // data offset (relative to data area start)
	rootView.setBigUint64(SIZEOF_HEADER + 0x08, BigInt(innerHfs0.length), true);
	rootView.setUint32(SIZEOF_HEADER + 0x10, 0, true); // name offset
	// String table
	root.set(name, SIZEOF_HEADER + fileTableSize);
	// Inner HFS0
	root.set(innerHfs0, rootHeaderArea);

	// Build the full XCI: zeros up to headerOffset, magic, zeros, then root HFS0
	const xci = new Uint8Array(hfs0RootOffset + root.length);
	xci.set(new Uint8Array([0x48, 0x45, 0x41, 0x44]), headerOffset); // "HEAD"
	xci.set(root, hfs0RootOffset);
	return xci;
}

describe('parseXci', () => {
	it('parses a trimmed XCI (magic at 0x100, HFS0 root at 0xF000)', async () => {
		const bytes = makeMinimalXci({ withKeyArea: false });
		const blob = new Blob([bytes]);
		const xci = await parseXci(blob);
		expect(xci.partitions.length).toBe(1);
		expect(xci.partitions[0].name).toBe('secure');
		expect(xci.files).toBe(xci.partitions[0].files);
	});

	it('parses a full XCI (magic at 0x1100, HFS0 root at 0x10000)', async () => {
		const bytes = makeMinimalXci({ withKeyArea: true });
		const blob = new Blob([bytes]);
		const xci = await parseXci(blob);
		expect(xci.partitions.length).toBe(1);
		expect(xci.partitions[0].name).toBe('secure');
	});

	it('rejects a non-XCI blob with a useful error', async () => {
		const bytes = new Uint8Array(0x20000);
		// All zeros — no "HEAD" magic anywhere.
		const blob = new Blob([bytes]);
		await expect(parseXci(blob)).rejects.toThrow(/Not an XCI/);
	});

	it('rejects a too-small blob', async () => {
		const bytes = new Uint8Array(0x50);
		const blob = new Blob([bytes]);
		await expect(parseXci(blob)).rejects.toThrow(/Not an XCI/);
	});

	it('rejects an XCI without a secure partition', async () => {
		// Build an XCI whose root HFS0 lists only "update" (no "secure")
		const enc = new TextEncoder();
		const SIZEOF_HEADER = 0x10;
		const SIZEOF_FILE_ENTRY = 0x40;
		const name = enc.encode('update');
		const stringTableSize = 0x20;
		const root = new Uint8Array(SIZEOF_HEADER + SIZEOF_FILE_ENTRY + stringTableSize);
		const rv = new DataView(root.buffer);
		root[0] = 0x48; root[1] = 0x46; root[2] = 0x53; root[3] = 0x30;
		rv.setUint32(0x4, 1, true);
		rv.setUint32(0x8, stringTableSize, true);
		rv.setBigUint64(SIZEOF_HEADER + 0x00, 0n, true);
		rv.setBigUint64(SIZEOF_HEADER + 0x08, BigInt(SIZEOF_HEADER), true);
		// Inner empty HFS0 placed at offset 0 of the root's data area
		const inner = new Uint8Array(SIZEOF_HEADER);
		inner[0] = 0x48; inner[1] = 0x46; inner[2] = 0x53; inner[3] = 0x30;
		const dataAreaStart = SIZEOF_HEADER + SIZEOF_FILE_ENTRY + stringTableSize;
		const rootWithData = new Uint8Array(dataAreaStart + inner.length);
		rootWithData.set(root);
		root.set(name, SIZEOF_HEADER + SIZEOF_FILE_ENTRY);
		rootWithData.set(root);
		rootWithData.set(inner, dataAreaStart);

		const xci = new Uint8Array(0xf000 + rootWithData.length);
		xci.set([0x48, 0x45, 0x41, 0x44], 0x100);
		xci.set(rootWithData, 0xf000);
		await expect(parseXci(new Blob([xci]))).rejects.toThrow(/secure/);
	});
});
