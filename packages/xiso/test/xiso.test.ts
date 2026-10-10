import { describe, expect, it } from 'vitest';
import { findXdvdfsPartition, isXiso, parseXiso, XDVDFS_MAGIC } from '../src/index.js';

const SECTOR = 2048;

interface Entry {
	name: string;
	sector: number;
	size: number;
	dir?: boolean;
	left?: number;
	right?: number;
}

/** Serialise one directory table (entries at 4-byte aligned offsets). */
function dirTable(entries: Entry[]): { bytes: Uint8Array; offsets: number[] } {
	const offsets: number[] = [];
	let pos = 0;
	for (const e of entries) {
		offsets.push(pos);
		pos += (14 + e.name.length + 3) & ~3;
	}
	const bytes = new Uint8Array(SECTOR).fill(0xff);
	const dv = new DataView(bytes.buffer);
	entries.forEach((e, i) => {
		const o = offsets[i];
		dv.setUint16(o, e.left ? offsets[e.left] / 4 : 0, true);
		dv.setUint16(o + 2, e.right ? offsets[e.right] / 4 : 0, true);
		dv.setUint32(o + 4, e.sector, true);
		dv.setUint32(o + 8, e.size, true);
		bytes[o + 12] = e.dir ? 0x10 : 0x20;
		bytes[o + 13] = e.name.length;
		for (let k = 0; k < e.name.length; k++) bytes[o + 14 + k] = e.name.charCodeAt(k);
	});
	return { bytes, offsets };
}

/** Build a tiny XDVDFS image: `default.xbe`, `maps/ui.map`, `readme.txt`. */
function buildImage(partition = 0): Uint8Array {
	const img = new Uint8Array(partition + 40 * SECTOR);
	const at = (sector: number) => partition + sector * SECTOR;
	const vd = at(32);
	for (let i = 0; i < 20; i++) {
		img[vd + i] = XDVDFS_MAGIC.charCodeAt(i);
		img[vd + 0x7ec + i] = XDVDFS_MAGIC.charCodeAt(i);
	}
	const vdv = new DataView(img.buffer);
	vdv.setUint32(vd + 20, 33, true); // root sector
	vdv.setUint32(vd + 24, SECTOR, true);
	// Root: binary tree "maps" → left "default.xbe", right "readme.txt".
	const root = dirTable([
		{ name: 'maps', sector: 34, size: SECTOR, dir: true, left: 1, right: 2 },
		{ name: 'default.xbe', sector: 35, size: 4 },
		{ name: 'readme.txt', sector: 36, size: 5 },
	]);
	img.set(root.bytes, at(33));
	img.set(dirTable([{ name: 'ui.map', sector: 37, size: 3 }]).bytes, at(34));
	img.set(new TextEncoder().encode('XBEH'), at(35));
	img.set(new TextEncoder().encode('hello'), at(36));
	img.set(new TextEncoder().encode('map'), at(37));
	return img;
}

describe('xiso', () => {
	it('parses an extract-xiso image (partition at 0)', async () => {
		const blob = new Blob([buildImage()]);
		expect(await isXiso(blob)).toBe(true);
		const parsed = await parseXiso(blob);
		expect(parsed.partitionOffset).toBe(0);
		expect(parsed.entries.map((e) => [e.path, e.isDirectory, e.size])).toEqual([
			['default.xbe', false, 4],
			['maps', true, 0],
			['maps/ui.map', false, 3],
			['readme.txt', false, 5],
		]);
		const readme = parsed.entries.find((e) => e.name === 'readme.txt')!;
		expect(await blob.slice(readme.offset, readme.offset + readme.size).text()).toBe('hello');
	});

	it('finds the game partition of a redump image', async () => {
		const blob = new Blob([buildImage(0x2080000)]);
		expect(await findXdvdfsPartition(blob)).toBe(0x2080000);
		const parsed = await parseXiso(blob);
		const map = parsed.entries.find((e) => e.path === 'maps/ui.map')!;
		expect(await blob.slice(map.offset, map.offset + map.size).text()).toBe('map');
	});

	it('rejects non-XDVDFS data', async () => {
		const blob = new Blob([new Uint8Array(64 * SECTOR)]);
		expect(await isXiso(blob)).toBe(false);
		await expect(parseXiso(blob)).rejects.toThrow(/Not an Xbox disc image/);
	});
});
