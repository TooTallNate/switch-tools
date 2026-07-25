import { describe, it, expect } from 'vitest';
import {
	APPLOADER_OFFSET,
	BOOT_SIZE,
	FST_ENTRY_SIZE,
	GCM_MAGIC,
	dolSizeFromHeader,
	flattenFiles,
	isGcm,
	parseFst,
	parseGcm,
	parseGcmHeader,
	type DiscReader,
} from '../src/index.js';

const w32 = (b: Uint8Array, o: number, v: number) => {
	b[o] = (v >>> 24) & 0xff;
	b[o + 1] = (v >>> 16) & 0xff;
	b[o + 2] = (v >>> 8) & 0xff;
	b[o + 3] = v & 0xff;
};
const wstr = (b: Uint8Array, o: number, s: string) => {
	for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
};

/** A node in the tree a fixture should produce. */
interface Node {
	name: string;
	children?: Node[];
	size?: number;
	offset?: number;
}

/**
 * Serialise a directory tree into an FST.
 *
 * Directories store the index one past their last descendant, so the
 * writer has to lay entries out depth-first and back-fill that value
 * once the subtree is known — the same shape the reader unwinds.
 */
function buildFst(root: Node[]): Uint8Array {
	interface Flat {
		isDir: boolean;
		/** Byte offset of this entry's name in the string table. */
		nameOffset: number;
		a: number;
		b: number;
	}
	const flat: Flat[] = [{ isDir: true, nameOffset: 0, a: 0, b: 0 }];

	// Intern names up front so the string table's size is known before
	// the output buffer is allocated.
	const names: string[] = [];
	const nameOffsets = new Map<string, number>();
	let nameCursor = 0;
	const internName = (n: string): number => {
		const existing = nameOffsets.get(n);
		if (existing !== undefined) return existing;
		const at = nameCursor;
		nameOffsets.set(n, at);
		names.push(n);
		nameCursor += n.length + 1;
		return at;
	};

	const emit = (nodes: Node[], parentIndex: number) => {
		for (const n of nodes) {
			const index = flat.length;
			const nameOffset = internName(n.name);
			if (n.children) {
				flat.push({ isDir: true, nameOffset, a: parentIndex, b: 0 });
				emit(n.children, index);
				// Back-fill: one past the last descendant.
				flat[index].b = flat.length;
			} else {
				flat.push({
					isDir: false,
					nameOffset,
					a: n.offset ?? 0x1000,
					b: n.size ?? 0,
				});
			}
		}
	};
	emit(root, 0);
	// The root's second field is the total entry count.
	flat[0].b = flat.length;

	const stringBytes: number[] = [];
	for (const n of names) {
		for (let i = 0; i < n.length; i++) stringBytes.push(n.charCodeAt(i));
		stringBytes.push(0);
	}

	const out = new Uint8Array(flat.length * FST_ENTRY_SIZE + stringBytes.length);
	flat.forEach((e, i) => {
		const o = i * FST_ENTRY_SIZE;
		out[o] = e.isDir ? 1 : 0;
		const nameOffset = i === 0 ? 0 : e.nameOffset;
		out[o + 1] = (nameOffset >>> 16) & 0xff;
		out[o + 2] = (nameOffset >>> 8) & 0xff;
		out[o + 3] = nameOffset & 0xff;
		w32(out, o + 4, e.a);
		w32(out, o + 8, e.b);
	});
	out.set(stringBytes, flat.length * FST_ENTRY_SIZE);
	return out;
}

/** Build a whole fake disc image around an FST. */
function buildDisc(tree: Node[], opts: { title?: string; id?: string } = {}) {
	const fst = buildFst(tree);
	const fstOffset = 0x10000;
	const dolOffset = 0x8000;
	const size = fstOffset + fst.length + 0x1000;
	const disc = new Uint8Array(size);

	wstr(disc, 0, opts.id ?? 'GZLE01');
	disc[6] = 0; // disc number
	disc[7] = 2; // version
	w32(disc, 0x1c, GCM_MAGIC);
	wstr(disc, 0x20, opts.title ?? 'TEST DISC TITLE');
	w32(disc, 0x420, dolOffset);
	w32(disc, 0x424, fstOffset);
	w32(disc, 0x428, fst.length);
	w32(disc, 0x42c, fst.length);
	w32(disc, 0x430, 0x20000);
	w32(disc, 0x434, 0x1000);
	disc.set(fst, fstOffset);

	// Apploader: size at 0x14, trailer at 0x18.
	w32(disc, APPLOADER_OFFSET + 0x14, 0x100);
	w32(disc, APPLOADER_OFFSET + 0x18, 0x20);

	// A DOL with one text section: offset 0x100, size 0x200.
	w32(disc, dolOffset + 0, 0x100);
	w32(disc, dolOffset + 0x90, 0x200);

	return { disc, fst, fstOffset };
}

const readerFor = (disc: Uint8Array): DiscReader => async (offset, length) => {
	const out = new Uint8Array(length);
	out.set(disc.subarray(offset, Math.min(disc.length, offset + length)));
	return out;
};

describe('parseGcmHeader', () => {
	it('reads identity and layout fields', () => {
		const { disc } = buildDisc([], { id: 'GALE01', title: 'SUPER GAME' });
		const h = parseGcmHeader(disc.subarray(0, BOOT_SIZE));
		expect(h.gameId).toBe('GALE01');
		expect(h.gameCode).toBe('GALE');
		expect(h.makerCode).toBe('01');
		expect(h.version).toBe(2);
		expect(h.title).toBe('SUPER GAME');
		expect(h.magicValid).toBe(true);
		expect(h.fstOffset).toBe(0x10000);
	});

	it('flags a missing magic', () => {
		const { disc } = buildDisc([]);
		w32(disc, 0x1c, 0);
		expect(parseGcmHeader(disc.subarray(0, BOOT_SIZE)).magicValid).toBe(false);
		expect(isGcm(disc)).toBe(false);
	});

	it('throws on a truncated header', () => {
		expect(() => parseGcmHeader(new Uint8Array(16))).toThrow(/boot header/i);
	});
});

describe('parseFst', () => {
	it('parses a flat list of files', () => {
		const fst = buildFst([
			{ name: 'a.bin', size: 10, offset: 0x100 },
			{ name: 'b.bin', size: 20, offset: 0x200 },
		]);
		const entries = parseFst(fst);
		expect(entries.map((e) => e.name)).toEqual(['a.bin', 'b.bin']);
		expect(entries[0]).toMatchObject({ size: 10, offset: 0x100, isDirectory: false });
		expect(entries[1].size).toBe(20);
	});

	it('nests directories and builds full paths', () => {
		const fst = buildFst([
			{
				name: 'dir',
				children: [
					{ name: 'inner.bin', size: 5 },
					{ name: 'sub', children: [{ name: 'deep.bin', size: 7 }] },
				],
			},
			{ name: 'root.bin', size: 3 },
		]);
		const entries = parseFst(fst);
		expect(entries.map((e) => e.name)).toEqual(['dir', 'root.bin']);
		const dir = entries[0];
		expect(dir.isDirectory).toBe(true);
		expect(dir.children.map((c) => c.name)).toEqual(['inner.bin', 'sub']);
		expect(dir.children[0].path).toBe('dir/inner.bin');
		const sub = dir.children[1];
		expect(sub.children[0].path).toBe('dir/sub/deep.bin');
		expect(sub.children[0].size).toBe(7);
	});

	it('handles an empty filesystem', () => {
		expect(parseFst(buildFst([]))).toEqual([]);
	});

	it('returns nothing for garbage rather than throwing', () => {
		expect(parseFst(new Uint8Array(4))).toEqual([]);
		const absurd = new Uint8Array(64);
		w32(absurd, 8, 0xffffff); // implausible entry count
		expect(parseFst(absurd)).toEqual([]);
	});

	it('does not run past the string table', () => {
		const fst = buildFst([{ name: 'x.bin', size: 1 }]);
		// Truncate mid-string-table.
		const truncated = fst.subarray(0, fst.length - 2);
		expect(() => parseFst(truncated)).not.toThrow();
	});
});

describe('dolSizeFromHeader', () => {
	it('takes the furthest section extent', () => {
		const dol = new Uint8Array(0x100);
		w32(dol, 0, 0x100); // text0 offset
		w32(dol, 0x90, 0x200); // text0 size
		w32(dol, 4, 0x400); // text1 offset
		w32(dol, 0x94, 0x100); // text1 size -> ends at 0x500
		expect(dolSizeFromHeader(dol)).toBe(0x500);
	});

	it('ignores empty sections and short input', () => {
		expect(dolSizeFromHeader(new Uint8Array(0x100))).toBe(0x100);
		expect(dolSizeFromHeader(new Uint8Array(4))).toBe(0);
	});
});

describe('parseGcm', () => {
	it('reads header, filesystem and derived sizes', async () => {
		const { disc } = buildDisc([
			{ name: 'opening.bnr', size: 6496, offset: 0x30000 },
			{
				name: 'audio',
				children: [
					{ name: 'a.afc', size: 1000 },
					{ name: 'b.afc', size: 2000 },
				],
			},
		]);
		const result = await parseGcm(readerFor(disc));
		expect(result.header.gameId).toBe('GZLE01');
		expect(result.entries.length).toBe(2);
		expect(result.fileCount).toBe(3);
		expect(result.totalFileSize).toBe(6496 + 1000 + 2000);
		expect(result.apploaderSize).toBe(0x20 + 0x100 + 0x20);
		expect(result.dolSize).toBe(0x300);
	});

	it('rejects a disc with no magic', async () => {
		const { disc } = buildDisc([]);
		w32(disc, 0x1c, 0);
		await expect(parseGcm(readerFor(disc))).rejects.toThrow(/magic/i);
	});

	it('rejects a disc declaring no filesystem', async () => {
		const { disc } = buildDisc([]);
		w32(disc, 0x428, 0); // fstSize
		await expect(parseGcm(readerFor(disc))).rejects.toThrow(/filesystem/i);
	});
});

describe('flattenFiles', () => {
	it('collects files depth first and skips directories', () => {
		const entries = parseFst(
			buildFst([
				{ name: 'top.bin', size: 1 },
				{
					name: 'd',
					children: [
						{ name: 'x.bin', size: 2 },
						{ name: 'e', children: [{ name: 'y.bin', size: 3 }] },
					],
				},
			]),
		);
		const files = flattenFiles(entries);
		expect(files.map((f) => f.path)).toEqual([
			'top.bin',
			'd/x.bin',
			'd/e/y.bin',
		]);
		expect(files.every((f) => !f.isDirectory)).toBe(true);
	});
});
