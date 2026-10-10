/**
 * XDVDFS — the Xbox / Xbox 360 disc filesystem.
 *
 * The game partition starts with a volume descriptor at sector 32:
 *
 *   char[20] "MICROSOFT*XBOX*MEDIA"
 *   u32      root directory sector
 *   u32      root directory size
 *   u64      FILETIME
 *   …        (1992 bytes)
 *   char[20] "MICROSOFT*XBOX*MEDIA"
 *
 * Each directory is a table of entries organised as a binary search
 * tree (by name): u16 left / u16 right child offsets (in 4-byte units,
 * 0 = none), u32 start sector, u32 size, u8 attributes (0x10 =
 * directory), u8 name length, name bytes — 4-byte aligned, 0xFF padding.
 *
 * The partition sits at offset 0 in extract-xiso images, and at a fixed
 * offset in full redump images (XGD1 0x18300000, XGD2 0xFD90000, XGD3
 * 0x2080000), after the video partition.
 */

export const XDVDFS_MAGIC = 'MICROSOFT*XBOX*MEDIA';
const SECTOR = 2048;
const VOLUME_SECTOR = 32;
const ATTR_DIRECTORY = 0x10;

/** Candidate game-partition offsets: extract-xiso, then XGD1/2/3 redumps. */
export const XDVDFS_PARTITION_OFFSETS = [0, 0x18300000, 0xfd90000, 0x2080000];

export interface XisoEntry {
	/** `/`-separated path from the root, no leading slash. */
	path: string;
	name: string;
	isDirectory: boolean;
	/** Absolute byte offset in the image (files only). */
	offset: number;
	size: number;
}

export interface ParsedXiso {
	/** Byte offset of the game partition within the image. */
	partitionOffset: number;
	entries: XisoEntry[];
}

const td = new TextDecoder('latin1');

function hasMagic(bytes: Uint8Array): boolean {
	return td.decode(bytes.subarray(0, 20)) === XDVDFS_MAGIC;
}

/** Find the game partition, or `null` if `blob` isn't an XDVDFS image. */
export async function findXdvdfsPartition(blob: Blob): Promise<number | null> {
	for (const base of XDVDFS_PARTITION_OFFSETS) {
		const at = base + VOLUME_SECTOR * SECTOR;
		if (at + 20 > blob.size) continue;
		const head = new Uint8Array(await blob.slice(at, at + 20).arrayBuffer());
		if (hasMagic(head)) return base;
	}
	return null;
}

export async function isXiso(blob: Blob): Promise<boolean> {
	return (await findXdvdfsPartition(blob)) !== null;
}

/** Parse every file and directory in an XDVDFS image. */
export async function parseXiso(blob: Blob, partitionOffset?: number): Promise<ParsedXiso> {
	const base = partitionOffset ?? (await findXdvdfsPartition(blob));
	if (base === null) throw new Error('Not an Xbox disc image (no XDVDFS volume descriptor)');
	const vd = new Uint8Array(await blob.slice(base + VOLUME_SECTOR * SECTOR, base + (VOLUME_SECTOR + 1) * SECTOR).arrayBuffer());
	if (!hasMagic(vd)) throw new Error('XDVDFS volume descriptor magic missing');
	const dv = new DataView(vd.buffer, vd.byteOffset, vd.byteLength);
	const rootSector = dv.getUint32(20, true);
	const rootSize = dv.getUint32(24, true);

	const entries: XisoEntry[] = [];
	const seen = new Set<number>();
	const readDir = async (sector: number, size: number, prefix: string, depth: number): Promise<void> => {
		if (size === 0 || depth > 64 || seen.has(sector)) return;
		seen.add(sector);
		const start = base + sector * SECTOR;
		if (start + size > blob.size) throw new Error(`XDVDFS directory at sector ${sector} runs past the image`);
		const table = new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
		const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
		const subdirs: { sector: number; size: number; path: string }[] = [];
		const stack = [0];
		const visited = new Set<number>();
		while (stack.length) {
			const off = stack.pop()!;
			if (visited.has(off) || off + 14 > table.length) continue;
			visited.add(off);
			const left = tv.getUint16(off, true);
			const right = tv.getUint16(off + 2, true);
			if (left === 0xffff && right === 0xffff) continue; // padding
			const entrySector = tv.getUint32(off + 4, true);
			const entrySize = tv.getUint32(off + 8, true);
			const attr = table[off + 12]!;
			const nameLen = table[off + 13]!;
			if (off + 14 + nameLen > table.length) continue;
			const name = td.decode(table.subarray(off + 14, off + 14 + nameLen));
			const path = prefix ? `${prefix}/${name}` : name;
			if (attr & ATTR_DIRECTORY) {
				entries.push({ path, name, isDirectory: true, offset: base + entrySector * SECTOR, size: 0 });
				subdirs.push({ sector: entrySector, size: entrySize, path });
			} else {
				entries.push({ path, name, isDirectory: false, offset: base + entrySector * SECTOR, size: entrySize });
			}
			if (left) stack.push(left * 4);
			if (right) stack.push(right * 4);
		}
		for (const d of subdirs) await readDir(d.sector, d.size, d.path, depth + 1);
	};
	await readDir(rootSector, rootSize, '', 0);
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { partitionOffset: base, entries };
}
