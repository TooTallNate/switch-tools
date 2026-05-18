import { describe, it, expect } from 'vitest';
import { parseLgp, isLgp, LgpParseError } from '../src/index.js';

/**
 * Hand-build a minimal LGP archive containing one tiny file
 * named `hello.txt` with the bytes "world". Used to exercise
 * the parser without committing a binary fixture.
 *
 * Layout (sizes in parens):
 *   header (16)
 *   TOC (27 × 1 = 27)
 *   hash table (3600)
 *   path table header (2: u16 path group count = 0)
 *   file header (24: name + size)
 *   file content (5: "world")
 *   footer (14: "FINAL FANTASY7")
 */
function makeMinimalLgp(): Uint8Array {
	const HEADER_SIZE = 16;
	const TOC_ENTRY_SIZE = 27;
	const HASH_TABLE_SIZE = 3600;
	const PATH_TABLE_HEADER = 2;
	const FILE_HEADER_SIZE = 24;
	const FILE_DATA_SIZE = 5;
	const FOOTER_SIZE = 14;

	const tocStart = HEADER_SIZE;
	const hashTableStart = tocStart + TOC_ENTRY_SIZE;
	const pathTableStart = hashTableStart + HASH_TABLE_SIZE;
	const fileHeaderStart = pathTableStart + PATH_TABLE_HEADER;
	const fileContentStart = fileHeaderStart + FILE_HEADER_SIZE;
	const footerStart = fileContentStart + FILE_DATA_SIZE;
	const total = footerStart + FOOTER_SIZE;

	const out = new Uint8Array(total);
	const v = new DataView(out.buffer);
	const enc = new TextEncoder();

	// Header
	out.set(enc.encode('\0\0SQUARESOFT'), 0);
	v.setUint16(0x0c, 1, true); // file count

	// TOC: one entry
	const name = 'hello.txt';
	out.set(enc.encode(name), tocStart);
	v.setUint32(tocStart + 20, fileHeaderStart, true); // offset
	out[tocStart + 24] = 14; // file type
	v.setUint16(tocStart + 25, 0, true); // path group (root)

	// Hash table — leave zeros; parser doesn't depend on it for
	// sequential reads.

	// Path table header — 0 groups.
	v.setUint16(pathTableStart, 0, true);

	// File header
	out.set(enc.encode(name), fileHeaderStart);
	v.setUint32(fileHeaderStart + 20, FILE_DATA_SIZE, true);

	// File content
	out.set(enc.encode('world'), fileContentStart);

	// Footer
	out.set(enc.encode('FINAL FANTASY7'), footerStart);

	return out;
}

describe('isLgp', () => {
	it('returns true for a valid LGP buffer', () => {
		const bytes = makeMinimalLgp();
		expect(isLgp(bytes)).toBe(true);
	});

	it('returns false for non-LGP buffers', () => {
		expect(isLgp(new Uint8Array(0))).toBe(false);
		expect(isLgp(new TextEncoder().encode('Hello, world!'))).toBe(false);
		// Trailing bytes match SQUARESOFT but not at offset 2
		const off = new Uint8Array(16);
		off.set(new TextEncoder().encode('  SQUARESOFT'), 0);
		expect(isLgp(off)).toBe(false);
	});
});

describe('parseLgp', () => {
	it('parses the minimal fixture and yields one entry', async () => {
		const bytes = makeMinimalLgp();
		const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
		const parsed = await parseLgp(blob);
		expect(parsed.fileCount).toBe(1);
		expect(parsed.hasFooter).toBe(true);
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0]!.baseName).toBe('hello.txt');
		expect(parsed.entries[0]!.directory).toBe('');
		expect(parsed.entries[0]!.name).toBe('hello.txt');
		expect(parsed.entries[0]!.size).toBe(5);
	});

	it('reads lazy file content via Blob.slice', async () => {
		const bytes = makeMinimalLgp();
		const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
		const parsed = await parseLgp(blob);
		const body = await parsed.entries[0]!.data.arrayBuffer();
		expect(new TextDecoder().decode(body)).toBe('world');
	});

	it('throws LgpParseError for non-LGP input', async () => {
		const blob = new Blob([new TextEncoder().encode('not an LGP')]);
		await expect(parseLgp(blob)).rejects.toBeInstanceOf(LgpParseError);
	});

	it('throws LgpParseError for tiny truncated buffers', async () => {
		const blob = new Blob([new Uint8Array(8)]);
		await expect(parseLgp(blob)).rejects.toBeInstanceOf(LgpParseError);
	});

	it('returns an empty entry list for fileCount=0', async () => {
		// Header says 0 files; everything else still has to be
		// present (the parser reads enough bytes to validate the
		// magic + version).
		const out = new Uint8Array(16 + 14);
		const v = new DataView(out.buffer);
		const enc = new TextEncoder();
		out.set(enc.encode('\0\0SQUARESOFT'), 0);
		v.setUint16(0x0c, 0, true);
		out.set(enc.encode('FINAL FANTASY7'), 16);
		const blob = new Blob([out.slice().buffer as ArrayBuffer]);
		const parsed = await parseLgp(blob);
		expect(parsed.fileCount).toBe(0);
		expect(parsed.entries).toHaveLength(0);
	});
});
