/**
 * PlatinumGames `.pkz` package (Bayonetta 3, Astral Chain): a flat list
 * of named, individually compressed files, usually DAT / DTT archives.
 *
 * Layout (little-endian), from Kerilk's `Astral Chain pkz.bt` and
 * `pkz.rb` in bayonetta_tools and checked on Bayonetta 3:
 *
 *   0x00 'pkzl'
 *   0x04 u32  version (0x00020000)
 *   0x08 u64  total file size
 *   0x10 u32  file count
 *   0x14 u32  offset of the file table
 *   0x18 u32  size of the name table (follows the file table)
 *   0x1c u32  data alignment (0x1000)
 *
 *   file table, 32 bytes per file:
 *     u32 name offset (into the name table), u32 flags (0x10 seen on
 *         stored entries)
 *     u64 decompressed size
 *     u64 data offset (absolute)
 *     u64 compressed size
 *
 * The name table starts with the compressor's name (`OodleKraken` on
 * Bayonetta 3, `ZStandard` on Astral Chain) followed by NUL-terminated
 * paths such as `pl/pl3031.dat`. Each file is one compressed stream;
 * a file whose compressed size equals its size is stored.
 */

export interface PkzEntry {
	index: number;
	/** Path inside the package, e.g. `pl/pl3031.dat`. */
	name: string;
	/** High word of the name field; 0x10 on some stored entries. */
	flags: number;
	size: number;
	offset: number;
	compressedSize: number;
}

export interface Pkz {
	/** Compressor name from the name table: `OodleKraken`, `ZStandard`, … */
	compression: string;
	entries: PkzEntry[];
}

export const PKZ_MAGIC = 'pkzl';

export function isPkz(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x70 && head[1] === 0x6b && head[2] === 0x7a && head[3] === 0x6c;
}

/** Bytes needed to parse the header and tables: read 0x20 first, then this many. */
export function pkzHeaderSize(head: Uint8Array): number {
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const count = dv.getUint32(0x10, true);
	const table = dv.getUint32(0x14, true);
	const names = dv.getUint32(0x18, true);
	return table + count * 32 + names;
}

/** Parse a PKZ's header + file table + name table (see {@link pkzHeaderSize}). */
export function parsePkz(bytes: Uint8Array): Pkz {
	if (!isPkz(bytes)) throw new Error('Not a PKZ (missing "pkzl" magic)');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = dv.getUint32(0x10, true);
	const table = dv.getUint32(0x14, true);
	const nameTable = table + count * 32;
	const nameLen = dv.getUint32(0x18, true);
	if (count > 1_000_000 || nameTable + nameLen > bytes.length) throw new Error('PKZ header is truncated');
	const cstr = (o: number) => {
		let e = o;
		while (e < bytes.length && bytes[e] !== 0) e++;
		return new TextDecoder().decode(bytes.subarray(o, e));
	};
	const entries: PkzEntry[] = [];
	for (let i = 0; i < count; i++) {
		const b = table + i * 32;
		entries.push({
			index: i,
			name: cstr(nameTable + dv.getUint32(b, true)),
			flags: dv.getUint32(b + 4, true),
			size: Number(dv.getBigUint64(b + 8, true)),
			offset: Number(dv.getBigUint64(b + 16, true)),
			compressedSize: Number(dv.getBigUint64(b + 24, true)),
		});
	}
	return { compression: cstr(nameTable), entries };
}

/** Whether an entry is stored (no compression). */
export function pkzEntryStored(e: PkzEntry): boolean {
	return e.compressedSize === e.size;
}
